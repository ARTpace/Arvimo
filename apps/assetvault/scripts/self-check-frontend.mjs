// 自检第 13–15 组：前端产物与主题一致性 / 局域网共享 / 交互守卫与数据。
// 全部「静态断言 + 少量只读 GET」，不联网、不改业务代码，用来堵住这几类反复踩的坑：
//   ① 改了前端不重建 → 指纹没变，窗口吃旧文件；
//   ② 静态资源没缓存头 → WebView2 启发式缓存旧分块；
//   ③ 外观设置只对一部分面板生效（新加面板忘了挂 --av-*）；
//   ④ 局域网访客能写库（共享密码写着「只读」，代码里却没有总闸）；
//   ⑤ 框选串画布 / 缩略图被代理包坏 / 画板拖入失效 —— 修过又被改回去。
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const read = (root, rel) => {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
};
const sha8 = buf => createHash('sha1').update(buf).digest('hex').slice(0, 8);

/** 需要跟着主题走的面板：新加容器忘了挂 var(--av-*)，外观设置就会「只对一部分生效」。 */
const THEMED = [
  ['侧栏', '.sidebar'],
  ['筛选抽屉', '.filter-drawer-panel'],
  ['搜索面板', '#search-panel'],
  ['资产卡', '.model-card'],
  ['本地文件卡', '.local-file-card'],
  ['画板卡', '.bd-card'],
  ['弹窗', 'dialog'],
  ['设置页', '#settings-dialog'],
  ['选中条', '.selection-bar'],
  ['下载条', '.download-bar'],
  ['转换条', '.cv-bar'],
  ['toast', '.toast'],
];

/** 抽 CSS 规则（不处理嵌套，够用；嵌套的由回退窗口判断兜住）。 */
function cssRules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({selector: m[1].trim(), body: m[2]});
  return out;
}

export async function checkFrontendArtifacts({report, group, log, root, base}) {
  group('[13/15] 前端产物与主题');

  // A1 内容指纹：index.html 里的 ?v= 必须等于产物实际 sha1。不等 = 改了没跑 build:library。
  const distIndex = read(root, 'dist/library/index.html');
  const pairs = [['app.css', /app\.css\?v=([0-9a-f]{6,})/], ['app.js', /app\.js\?v=([0-9a-f]{6,})/]];
  const bad = [];
  for (const [name, re] of pairs) {
    const stamp = (distIndex.match(re) || [])[1] || '';
    let real = '';
    try { real = sha8(fs.readFileSync(path.join(root, 'dist/library', name))); } catch { bad.push(`${name} 产物缺失`); continue; }
    if (!stamp) bad.push(`${name} 引用没带 ?v=`);
    else if (stamp !== real) bad.push(`${name} 指纹 ${stamp} ≠ 实际 ${real}`);
  }
  report(bad.length ? 'FAIL' : 'OK', '资源指纹',
    bad.length ? `${bad.join('；')} → npm run build:library` : `app.css/app.js 指纹与产物 sha1 一致（${(distIndex.match(/app\.js\?v=([0-9a-f]+)/) || [])[1]}）`);

  // A2 缓存策略：.js/.css 每次校验、.html 不缓存。缺了就是「改了刷新不生效」。
  if (!base) report('WARN', '静态缓存头', '服务未运行，跳过');
  else {
    const probe = async (p) => {
      try { return (await fetch(`${base}${p}`, {signal: AbortSignal.timeout(5000)})).headers.get('cache-control') || ''; }
      catch { return ''; }
    };
    const css = await probe('/app.css'), html = await probe('/index.html'), chunk = await probe('/artflow-embed.js');
    // no-store / no-cache 都算合格（前者更严）；只有「缺头」或「带正数 max-age」才会吃旧文件。
    const stale = value => !value || /max-age=(?!0\b)\d+/.test(value);
    const issues = [];
    if (stale(css)) issues.push(`/app.css → ${css || '无 Cache-Control'}`);
    if (stale(html)) issues.push(`/index.html → ${html || '无 Cache-Control'}`);
    if (stale(chunk)) issues.push(`/artflow-embed.js → ${chunk || '无 Cache-Control'}`);
    report(issues.length ? 'FAIL' : 'OK', '静态缓存头',
      issues.length ? `${issues.join('；')} → 会在 WebView2 里吃旧文件`
        : `app.css ${css} · 分块 ${chunk} · index.html ${html}`);
  }

  // B2 变量闭环：css 用到但没人写的 --av-* → 那块永远透不出来。
  const css = read(root, 'src/library/app.css');
  const appearance = read(root, 'src/library/appearance.js');
  const used = new Set([...css.matchAll(/var\((--av-[a-z-]+)/g)].map(m => m[1]));
  const defined = new Set([...appearance.matchAll(/setProperty\('(--av-[a-z-]+)'/g)].map(m => m[1]));
  for (const m of css.matchAll(/(--av-[a-z-]+)\s*:/g)) defined.add(m[1]);
  const orphans = [...used].filter(v => !defined.has(v));
  report(orphans.length ? 'FAIL' : 'OK', '主题变量闭环',
    orphans.length ? `app.css 用了但没人定义：${orphans.join(' / ')}` : `${used.size} 个 --av-* 全部由 appearance.js 派生`);

  // B1 覆盖完整：面板清单里每一类都得挂上主题变量。
  const rules = cssRules(css);
  const missing = [];
  for (const [label, token] of THEMED) {
    const hit = rules.some(r => r.selector.includes(token) && r.body.includes('var(--av-'));
    if (hit) continue;
    // 嵌套在 @media 里时上面的正则抓不全，退回「token 附近 300 字内有 var(--av-」。
    const idx = css.indexOf(token);
    if (idx >= 0 && css.slice(Math.max(0, idx - 120), idx + 300).includes('var(--av-')) continue;
    missing.push(label);
  }
  report(missing.length ? 'FAIL' : 'OK', '面板主题覆盖',
    missing.length ? `没跟主题走：${missing.join(' / ')}` : `${THEMED.length} 类面板全部挂在 --av-* 上`);

  // B3 防回退：写死近黑背景的数量只该减不该增（新面板顺手写死颜色 = 又漏一处）。
  const nearBlack = (css.match(/background(?:-color)?:#0[0-9a-fA-F]{5}/g) || []).length;
  const BASELINE = 128;
  report(nearBlack > BASELINE + 12 ? 'WARN' : 'OK', '写死深色回归',
    `${nearBlack} 处 background:#0…（基线 ${BASELINE}）` + (nearBlack > BASELINE + 12 ? ' · 新增面板改用 var(--av-panel*)' : ''));
}

export async function checkLanSharing({report, group, log, root, base}) {
  group('[14/15] 局域网共享');
  const sharing = read(root, 'server/lan-sharing.mjs');
  const page = read(root, 'server/lan-login-page.mjs');

  // C1 访客只读总闸：共享密码写的是「只读权限」，代码里必须有一条统一的写保护，
  // 而不是靠每个端点各自记得判断（漏一个 = 访客能改主机资产库）。
  const blanket = /req\.method\s*!==\s*'GET'[\s\S]{0,400}?403/.test(sharing)
    && /lanVisitor|访客/.test(sharing);
  report(blanket ? 'OK' : 'FAIL', '访客只读总闸',
    blanket ? '非 GET 请求在会话校验后统一 403（登录/登出/AI 例外）'
      : '缺统一写保护：只有零散端点各自判断，访客可 POST/DELETE 改库');

  // C2 登录页单一来源：局域网页不许再内联 <style>，必须吃同一套静态资源。
  const issues = [];
  if (!page) issues.push('缺 server/lan-login-page.mjs');
  else {
    if (/<style[\s>]/i.test(page)) issues.push('模板里仍有内联 <style>');
    for (const asset of ['/login.css', '/login-backdrop.svg', '/login-peek.js'])
      if (!page.includes(asset)) issues.push(`没引用 ${asset}`);
  }
  for (const asset of ['login.css', 'login-peek.js', 'login-backdrop.svg'])
    if (!fs.existsSync(path.join(root, 'dist/library', asset))) issues.push(`产物缺 ${asset}`);
  report(issues.length ? 'FAIL' : 'OK', '登录页单一来源',
    issues.length ? issues.join('；') : '与本机登录页共用 login.css / 背景图 / 密码显隐脚本');

  // C2b 未登录也要能取到这几份静态资源，否则外面看到的是一张裸 HTML。
  const landAssets = (sharing.match(/LOGIN_ASSETS\s*=\s*new Set\(\[([^\]]+)\]/) || [])[1] || '';
  const allowed = ['/login.css', '/login-backdrop.svg', '/login-peek.js'].filter(a => !landAssets.includes(a));
  report(allowed.length ? 'FAIL' : 'OK', '登录资源放行', allowed.length ? `LOGIN_ASSETS 缺 ${allowed.join(' / ')}` : '三份登录资源均在未登录放行名单里');

  // C3 CSP 不许回退到 unsafe-inline：外链样式表 + 内联兜底会互相打架。
  const cspLine = (sharing.match(/Content-Security-Policy'\s*:\s*"([^"]+)"/) || [])[1] || '';
  const inline = /unsafe-inline/.test(cspLine);
  report(cspLine ? (inline ? 'WARN' : 'OK') : 'WARN', '局域网 CSP',
    cspLine ? (inline ? `仍含 unsafe-inline：${cspLine.slice(0, 70)}` : '样式/脚本/图片均限 self') : '没读到 CSP 常量');
}

export async function checkInteractionGuards({report, group, log, root, base, api}) {
  group('[15/15] 交互守卫与数据');
  const rangeSelect = read(root, 'src/library/range-select.js');
  const imageSrc = read(root, 'src/library/image-src.js');
  const boardDrop = read(root, 'src/library/board-drop.js');
  const dragOut = read(root, 'src/library/drag-out.js');
  const files = (() => { try { return fs.readdirSync(path.join(root, 'src/library')).filter(f => f.endsWith('.js')); } catch { return []; } })();

  // D1 框选不许串到画布（画布是 iframe，父文档收不到 pointerup → 框会留在屏幕上）。
  const d1 = [];
  if (!/onCanvas/.test(rangeSelect)) d1.push('缺 onCanvas 守卫');
  if (!/data-rs-hit/.test(rangeSelect)) d1.push('高亮应走 data-rs-hit 而非 class');
  if ((rangeSelect.match(/addEventListener\('pointerup'/g) || []).length < 2) d1.push('pointerup 未做 window+document 双层');
  report(d1.length ? 'FAIL' : 'OK', '框选不串画布', d1.length ? d1.join('；') : '画布路由守卫 / 双层 pointerup / data-rs-hit 均在');

  // D2 缩略图不许再被代理包一层：本地缩略图是 /api/local/thumb 相对地址，
  // 再套 /api/image?url= 会被图床白名单拒掉（卡片变成裂图）。判据只盯「碰本地缩略图却没写同源守卫」的文件。
  const GUARD = /\^\\\/\(\?!\\\/\)|isSameOriginImage|isLocalUrl|SAME_ORIGIN/;
  const risky = files.filter(f => f !== 'image-src.js' && (() => {
    const src = read(root, `src/library/${f}`);
    return src.includes('/api/local/thumb') && src.includes('/api/image?url=') && !GUARD.test(src);
  })());
  const hasThumbSrc = /export\s+function\s+thumbSrc|export\s+const\s+thumbSrc/.test(imageSrc);
  report(risky.length || !hasThumbSrc ? 'FAIL' : 'OK', '缩略图入口',
    risky.length ? `本地缩略图会被代理包坏（缺同源守卫）：${risky.join(' / ')}`
      : (hasThumbSrc ? '本地缩略图走同源直出，image-src.js::thumbSrc 为统一入口' : '缺 image-src.js::thumbSrc'));

  // D3 画板拖入：窗口内拖动让给站内拖放（app.js 的 deferNativeDrag），到边缘/按 Alt 才交给系统拖出。
  const d3 = [];
  const appJs = read(root, 'src/library/app.js');
  if (!/deferNativeDrag|internalDropOf/.test(dragOut)) d3.push('drag-out 缺「让位」钩子');
  if (!/deferNativeDrag/.test(appJs) && !/shiftKey/.test(appJs)) d3.push('app.js 没接让位判据');
  if (!/bd-drop-dock/.test(boardDrop)) d3.push('board-drop 缺落点条');
  report(d3.length ? 'FAIL' : 'OK', '画板拖入', d3.length ? d3.join('；') : '站内让位判据 + 落点条 + 拖出钩子齐备');

  // E1 库里 schema 版本要跟源码一致（迁移没跑全 = 筛选/索引悄悄失效）。
  // 版本记在 schema_migrations 表里（不是 PRAGMA user_version，那个一直是 0）。
  try {
    const {SUPPORTED_SCHEMA_VERSION} = await import('../server/library-schema.mjs');
    const snap = base ? await api(`${base}/api/downloads`, {timeout: 8000}) : null;
    const folder = snap?.data?.defaultFolder || snap?.data?.settings?.folder || '';
    const dataDir = folder ? path.resolve(folder, '..', 'data') : '';
    const dbFile = dataDir ? path.join(dataDir, 'library.db') : '';
    if (!dbFile || !fs.existsSync(dbFile)) report('WARN', '库 schema 版本', '找不到 library.db，跳过');
    else {
      const {default: Database} = await import('better-sqlite3');
      const db = new Database(dbFile, {readonly: true, fileMustExist: true});
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
      db.close();
      const actual = Number(row?.v || 0);
      const drifted = actual === 0 ? 'schema_migrations 为空 → 迁移没跑过' : actual !== SUPPORTED_SCHEMA_VERSION ? `落后 ${SUPPORTED_SCHEMA_VERSION - actual} 版 → 打开界面会自动补` : '';
      report(drifted ? 'FAIL' : 'OK', '库 schema 版本',
        `库 v${actual} · 源码 v${SUPPORTED_SCHEMA_VERSION}` + (drifted ? ` · ${drifted}` : ''));
    }
  } catch (e) {
    report('WARN', '库 schema 版本', `读不到（${e.message}）`);
  }
}
