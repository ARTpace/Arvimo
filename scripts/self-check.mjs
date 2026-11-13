// AssetVault 一键自检（开发向）：服务与进程 / 3D 预览（静态）/ 3D 预览矩阵 / 平台连通 /
// 链接解析 / 下载链路 / 展示能力矩阵 / 运行时能力 / 关键回归 / 数据库与资产存储 /
// 认证与平台凭证 / 下载子系统深度（共 12 组）。
//
// 检测完自动修复：默认跑完检查就执行白名单动作并复验一次，不需要确认、不等人。
// --dry-run 只列计划不执行；--no-fix 完全关闭修复阶段；这两个开关仅用于开发调试。
// 白名单只收「幂等、无歧义、可回滚、不改业务源码」的动作：
//   重建前端产物、平台探针失败自动退避重试一次、静态断言 FAIL 时重建并复验。
// 站点持续拒绝 / 依赖缺失 / CDN 等比档位 / info.json 来源凭证一律不自动改，只记结论。
// 用数据目录里的机器令牌（X-AV-Token）绕过登录闸门，和 CLI / 设置页走同一条本机通道。
//
//   node scripts/self-check.mjs                    检测 + 自动修复 + 自动复验（默认）
//   node scripts/self-check.mjs --dry-run         只列修复计划，不执行
//   node scripts/self-check.mjs --no-fix          纯检测，不进入修复阶段
//   node scripts/self-check.mjs --all             连通测试连图站一起跑（慢，部分站点要登录）
//   node scripts/self-check.mjs --skip-platforms  跳过平台连通探测（3D 预览矩阵也只留路由守卫）
//   node scripts/self-check.mjs --skip-display   展示能力只做源码静态检查
//   node scripts/self-check.mjs --skip-tests     跳过关键回归子集（默认跑，约 3 秒）
//   node scripts/self-check.mjs --json           只输出结构化 JSON（给脚本 / CI 消费）
//   node scripts/self-check.mjs --port=4179 / --url=http://127.0.0.1:7764
//
// 退出码：0 = 无致命项；1 = 有 FAIL（便于脚本 / 定时任务接着处理）。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveUserPaths} from '../server/data-dir.mjs';
import {G, artifactIssues, checkServerExtras, checkRuntime, checkRegression,
  checkStorageIntegrity, checkCredentials, checkDownloadsDeep, checkPreviewMatrix,
  checkLinkRouting} from './self-check-extra.mjs';
import {SERVER_VERSION} from '../server/capabilities.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const all = argv.includes('--all');
const skipPlatforms = argv.includes('--skip-platforms');
const skipDisplay = argv.includes('--skip-display');
const skipTests = argv.includes('--skip-tests');
const jsonMode = argv.includes('--json');
const fixMode = !argv.includes('--no-fix');           // 默认就修，--no-fix 才关掉
const apply = fixMode && !argv.includes('--dry-run'); // --dry-run 只列计划（--fix/--apply 兼容旧调用，无需再传）
const explicitUrl = arg('url') || (arg('port') ? `http://127.0.0.1:${arg('port')}` : '');

const token = (() => {
  // ADR-13：账号/令牌住在库外面（多个资源库共用一个账号），老数据目录留作退路。
  const paths = resolveUserPaths();
  for (const file of [path.join(paths.accountsDir, 'auth-token'), path.join(paths.dataDir, 'auth-token')]) {
    try { const value = fs.readFileSync(file, 'utf8').trim(); if (value) return value; } catch { /* 继续找下一处 */ }
  }
  return '';
})();
const HEADERS = {'X-SFX-Local': '1', ...(token ? {'X-AV-Token': token} : {})};

const log = (...args) => { if (!jsonMode) console.info(...args); };
const results = {OK: 0, WARN: 0, FAIL: 0};
const findings = [];
let currentGroup = '';
const runtimeNotes = [];
function report(level, name, detail) {
  results[level]++;
  findings.push({level, group: currentGroup, name: name.trim(), detail: String(detail)});
  const tag = {OK: '[ OK ]', WARN: '[WARN]', FAIL: '[FAIL]'}[level];
  log(`  ${tag}  ${name.padEnd(22, ' ')} ${detail}`);
}
function group(title) { currentGroup = title; log(`\n${title}`); }

async function api(p, {method = 'GET', body, timeout = 15000} = {}) {
  const res = await fetch(p, {
    method,
    headers: {...HEADERS, ...(body ? {'Content-Type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return {status: res.status, ok: res.ok, data, headers: res.headers, text};
}

function fileInfo(rel) {
  try {
    const full = path.join(root, rel);
    const {size} = fs.statSync(full);
    return {exists: true, size, text: () => fs.readFileSync(full, 'utf8')};
  } catch { return {exists: false, size: 0, text: () => ''}; }
}

async function findServer() {
  if (explicitUrl) return explicitUrl.replace(/\/$/, '');
  const candidates = [Number(process.env.SFX_PORT || 4179)];
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(resolveUserPaths().dataDir, 'server-port.json'), 'utf8')).port;
    if (Number.isInteger(saved)) candidates.push(saved);
  } catch {}
  for (const port of [...new Set(candidates)]) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const r = await fetch(`${url}/api/health`, {signal: AbortSignal.timeout(1500)});
      if (r.ok) return url;
    } catch {}
  }
  return null;
}

async function checkServer(base) {
  group(G.server);
  let health;
  try { health = await api(`${base}/api/health`, {timeout: 5000}); }
  catch (e) { report('FAIL', '本地服务', `连不上：${e.message}`); return null; }
  const h = health.data || {};
  report(h?.name ? 'OK' : 'FAIL', '本地服务', h?.name ? `${h.version} · 引擎 ${h.engine}` : `HTTP ${health.status}`);
  report(h?.storage?.healthy === false ? 'FAIL' : 'OK', '资产索引',
    h?.storage ? `${h.storage.engine}/${h.storage.catalog} · ${h.storage.healthy ? '健康' : h.storage.reason}` : '无状态');
  if (!token) report('WARN', '机器令牌', '没读到 auth-token，需要登录的接口会返回 401');

  try {
    const caps = await api(`${base}/api/downloads/capabilities`, {timeout: 5000});
    const live = caps.data?.version || '';
    report(live === SERVER_VERSION ? 'OK' : 'FAIL', '进程版本一致',
      live === SERVER_VERSION ? `运行中与源码同为 ${live}` : `运行中 ${live || '?'} ≠ 源码 ${SERVER_VERSION}，需重启服务`);
  } catch (e) { report('FAIL', '进程版本一致', e.message); }

  try {
    const home = await api(`${base}/`, {timeout: 5000});
    const csp = home.headers.get('content-security-policy') || '';
    const hosts = ['sketchfab.com', 'artstation.com', 'releases.pbr.one'];
    const missing = hosts.filter(host => !csp.includes(host));
    report(home.ok && home.text.includes('preview-dialog') ? 'OK' : 'FAIL', '首页静态资源',
      `HTTP ${home.status}${home.text.includes('preview-dialog') ? ' · 预览弹窗已在页面里' : ' · 页面不是工作台'}`);
    return {csp, missing, health: h};
  } catch (e) { report('FAIL', '首页静态资源', e.message); return {csp: '', missing: [], health: h}; }
}

function checkPreview(cspInfo) {
  group(G.preview);
  const html = fileInfo('dist/library/index.html');
  const app = fileInfo('dist/library/app.js');
  const gltf = fileInfo('dist/library/gltf-preview.js');
  const three = fileInfo('vendor/three/three.module.js');
  const htmlText = html.text();
  const appText = app.text();

  const skeleton = ['id="viewer"', 'id="viewer-canvas"', 'id="state"'].every(k => htmlText.includes(k));
  report(html.exists && skeleton ? 'OK' : 'FAIL', '预览弹窗骨架',
    skeleton ? 'canvas / iframe / state 三件套齐全' : 'index.html 缺元素，先跑 npm run build:library');

  // 这正是 2026-11-11 那个「一直正在加载模型…」的根因：iframe 默认 hidden，
  // 而 Sketchfab / ArtStation / ambientCG 路径不走 gltfPreview，必须自己放开舞台。
  const stageCalls = (appText.match(/showFrameStage\(\)/g) || []).length;
  const unhide = /frame\.hidden\s*=\s*false/.test(appText) || /stageFrame\.hidden\s*=\s*false/.test(appText);
  report(app.exists && stageCalls >= 3 && unhide ? 'OK' : 'FAIL', 'iframe 舞台切换',
    `${stageCalls} 处 showFrameStage · ${unhide ? '已放开 hidden' : '没有放开 iframe 的 hidden'}`);
  report(appText.includes('sketchfab.com/models/') ? 'OK' : 'FAIL', 'Sketchfab embed',
    appText.includes('sketchfab.com/models/') ? 'embed 地址拼接在产物里' : '产物里找不到 embed 拼接');

  const threeReady = gltf.exists && gltf.size > 100_000 && three.exists;
  report(threeReady ? 'OK' : 'FAIL', '本地 three 渲染',
    threeReady ? `gltf-preview.js ${(gltf.size / 1024 / 1024).toFixed(1)} MB · vendor/three 存在` : '产物或 three 模块缺失');

  const missing = cspInfo?.missing || [];
  report(!cspInfo?.csp || missing.length ? 'FAIL' : 'OK', 'CSP frame-src',
    !cspInfo?.csp ? '服务端没返回 CSP 头' : missing.length ? `未放行 ${missing.join(', ')}` : 'Sketchfab / ArtStation / PBR 查看器全部放行');
}

const LABELS = {
  sketchfab: 'Sketchfab', artstation: 'ArtStation', polyhaven: 'Poly Haven', ambientcg: 'ambientCG',
  simready: 'SimReady', polypizza: 'Poly Pizza', kenney: 'Kenney', freestylized: 'FreeStylized',
  polyfork: 'Polyfork', uiverse: 'Uiverse', pixiv: 'Pixiv', safebooru: 'Safebooru',
  yandere: 'Yande.re', konachan: 'Konachan', wallhaven: 'Wallhaven', civitai: 'Civitai',
  zcool: '站酷', designspiration: 'Designspiration', huaban: '花瓣', pinterest: 'Pinterest',
  pexels: 'Pexels', flickr: 'Flickr', '500px': '500px', xiaohongshu: '小红书',
};
const PICTURE = ['pixiv', 'safebooru', 'yandere', 'konachan', 'wallhaven', 'civitai', 'zcool',
  'designspiration', 'huaban', 'pinterest', 'pexels', 'flickr', '500px', 'xiaohongshu'];

async function checkPlatforms(base) {
  group(G.platform);
  if (skipPlatforms) { log('  跳过（--skip-platforms）'); return; }
  let enabled = {};
  try { enabled = (await api(`${base}/api/platforms`, {timeout: 5000})).data || {}; }
  catch (e) { report('WARN', '平台清单', e.message); }
  const ids = Object.entries(enabled).filter(([, on]) => on).map(([id]) => id)
    .filter(id => all || !PICTURE.includes(id));
  const unknown = ids.filter(id => !(id in LABELS));
  const list = ids.filter(id => id in LABELS);
  if (unknown.length) log(`  （另有 ${unknown.join(', ')} 未列入探针表，跳过）`);
  if (!list.length) { report('WARN', '平台清单', '没有可测试的平台'); return; }

  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const id = list[cursor++];
      const started = Date.now();
      try {
        const r = await api(`${base}/api/platforms/test`, {method: 'POST', body: {id}, timeout: 60_000});
        const d = r.data || {};
        if (d.ok) report('OK', LABELS[id], `${Date.now() - started}ms · ${d.count} 条 · ${d.sample || ''}`.trim());
        else report('FAIL', LABELS[id], `${Date.now() - started}ms · ${d.error || `HTTP ${r.status}`}`);
      } catch (e) { report('FAIL', LABELS[id], `${Date.now() - started}ms · ${e.message}`); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

async function checkDownloads(base) {
  group(G.download);
  let snap;
  try { snap = (await api(`${base}/api/downloads`, {timeout: 8000})).data; }
  catch (e) { report('FAIL', '下载服务快照', e.message); return; }
  if (snap?.error) { report('FAIL', '下载服务快照', snap.error); return; }
  const jobs = Array.isArray(snap.jobs) ? snap.jobs : [];
  const failed = jobs.filter(j => j.state === 'failed').length;
  report(snap.folderStatus?.ok ? 'OK' : 'FAIL', '保存目录',
    `${snap.folderStatus?.folder || snap.settings?.folder || '?'} · ${snap.folderStatus?.message || snap.folderStatus?.code || ''}`);
  report(snap.storageError ? 'FAIL' : 'OK', '任务存储', snap.storageError || `正常 · ${jobs.length} 个任务 · 失败 ${failed}`);
  report(snap.browserAvailable ? 'OK' : 'FAIL', '后台浏览器可用',
    snap.browserAvailable ? '已就绪（Sketchfab 转换依赖它）' : '不可用，模型转换会直接失败');
  report(snap.fbxAvailable ? 'OK' : 'WARN', 'FBX 导出', snap.fbxAvailable ? '可用' : '不可用（只出 GLB）');
  if (snap.warning) report('WARN', '恢复校验', String(snap.warning).slice(0, 90));
  if (snap.settings?.paused) report('WARN', '下载队列', '当前处于暂停状态');

  try {
    const setup = (await api(`${base}/api/setup`, {timeout: 8000})).data;
    for (const item of setup?.items || []) {
      const level = item.state === 'ready' ? 'OK' : item.state === 'degraded' ? 'WARN' : 'FAIL';
      report(level, item.title, `${item.state} · ${String(item.detail || '').slice(0, 76)}`);
    }
  } catch (e) { report('WARN', '依赖准备', e.message); }

  try {
    const art = (await api(`${base}/api/artstation/health`, {timeout: 8000})).data;
    report('OK', '转换引擎', `mviewer ${art?.mviewer?.version || art?.version || '已装载'} · 出站 ${art?.outbound?.name || '默认'}`);
  } catch (e) { report('WARN', '转换引擎', e.message); }
}

// 图站取样地址，与 server/library.mjs 里 /api/platforms/test 的 PROBE_URLS 对齐。
const SAMPLE_URLS = {
  pixiv: 'https://www.pixiv.net/artworks/151233234',
  safebooru: 'https://safebooru.org/index.php?page=post&s=list&tags=landscape',
  yandere: 'https://yande.re/post?tags=touhou',
  konachan: 'https://konachan.net/post?tags=landscape',
  wallhaven: 'https://wallhaven.cc/search?q=nature',
  civitai: 'https://civitai.com/',
  zcool: 'https://www.zcool.com.cn/u/ZNjMyMjY0MDg=',
  designspiration: 'https://www.designspiration.com/',
  huaban: 'https://huaban.com/boards/102664553',
  pinterest: 'https://www.pinterest.com/search/pins/?q=nature',
  pexels: 'https://www.pexels.com/photo/4161958/',
  flickr: 'https://www.flickr.com/photos/nasa/',
  '500px': 'https://500px.com/kellan',
  xiaohongshu: 'https://www.xiaohongshu.com/explore',
};

/** 展示能力矩阵：哪些平台能真的排瀑布流，哪些切过去只是一堆等高方块。
 *  判据是真实条目数据，不是拍脑袋的清单：接口回的 width/height 覆盖率、比例种类数，
 *  以及缩略图 URL 是不是站方的方形裁切档（方档就算有原图宽高，画面依然是方的）。 */
async function checkDisplay(base) {
  group(G.display);
  const gv = fileInfo('src/library/gallery-view.js').text();
  const css = fileInfo('src/library/app.css').text();
  const lv = fileInfo('src/library/library-view.js').text();
  const cv = fileInfo('src/library/card-view.js').text();
  report(gv.includes('galleryAvailable') && gv.includes('displayGridClass') ? 'OK' : 'FAIL',
    '切换判据', gv.includes('galleryAvailable') ? '按钮显隐与视图生效共用 galleryActive' : 'gallery-view.js 缺判据');
  report(/\.gallery \.thumbnail\{[^}]*aspect-ratio:auto/.test(css) ? 'OK' : 'FAIL',
    '瀑布流 CSS', /\.gallery \.thumbnail\{[^}]*aspect-ratio:auto/.test(css) ? '已解除 1:1 锁定' : '缩略图仍被锁成 1:1');
  const fix = lv.includes('node.decode?.()') && lv.includes('node.videoWidth')
    && lv.includes('placeholder.style.aspectRatio') && lv.includes('itemRatio');
  report(fix ? 'OK' : 'FAIL', '比例纠正链',
    fix ? '原图比例优先 / img decode 兜底 / video loadedmetadata / 裂图占位保留比例'
      : '缺少「原图比例不被缩略图覆盖」或 lazy / video / 裂图的兜底');
  report(cv.includes('coverRendition') ? 'OK' : 'WARN', 'A 站等比封面',
    cv.includes('coverRendition') ? '画廊请求 small 等比档' : '未请求等比档，A 站封面是 square 裁切');

  let enabled = {};
  try { enabled = (await api(`${base}/api/platforms`, {timeout: 5000})).data || {}; }
  catch (e) { report('WARN', '平台清单', e.message); }

  // 3D / 材质平台：卡片封面本身就是平台给的方图，且条目不带宽高 → 网格没问题，瀑布流退化。
  const modelIds = Object.keys(enabled).filter(id => (id in LABELS) && !PICTURE.includes(id) && id !== 'uiverse');
  for (const id of modelIds) {
    const art = id === 'artstation';
    report(art ? 'OK' : 'WARN', LABELS[id], art
      ? '网格 OK · 瀑布流可用（small 等比档），但条目无预置宽高'
      : '网格 OK · 瀑布流退化成等高方块（封面为方图 / 无 width/height）');
  }
  if ('uiverse' in enabled) report('WARN', 'Uiverse', '网格 OK · 瀑布流固定 1:1（代码卡片封面是 Shadow DOM，CSS 锁死）');

  if (skipDisplay || !base) {
    log(`  （${!base ? '服务未运行' : '--skip-display'}：以上为源码静态检查，图站实时取样已跳过）`);
    return;
  }
  const sites = Object.entries(enabled).filter(([id, on]) => on && PICTURE.includes(id)).map(([id]) => id);
  let cursor = 0;
  const unsupported = [];
  const worker = async () => {
    while (cursor < sites.length) {
      const id = sites[cursor++];
      const sample = SAMPLE_URLS[id];
      if (!sample) { report('WARN', LABELS[id], '没有取样地址，跳过实时检查'); continue; }
      try {
        const q = `platform=${encodeURIComponent(id)}&limit=6&url=${encodeURIComponent(sample)}`;
        const r = await api(`${base}/api/picture-site/resolve?${q}`, {timeout: 20_000});
        const items = Array.isArray(r.data?.items) ? r.data.items : [];
        if (!items.length) { report('WARN', LABELS[id], `取样无条目 · ${String(r.data?.error || `HTTP ${r.status}`).slice(0, 60)}`); continue; }
        const sized = items.filter(it => Number(it.width) > 0 && Number(it.height) > 0);
        const ratios = new Set(sized.map(it => `${it.width}:${it.height}`));
        const square = items.filter(it => /square|_sq\b|\/sq[/.]/i.test(it.thumb || it.url || ''));
        const allSquare = square.length === items.length;
        const level = allSquare || !sized.length || ratios.size <= 1 ? 'WARN' : 'OK';
        if (level === 'WARN') unsupported.push(id);
        report(level, LABELS[id], `网格 OK · 瀑布流 ${sized.length}/${items.length} 带宽高 · ${ratios.size} 种比例`
          + (allSquare ? ' · 缩略图全是方档（需换等比档 URL）' : square.length ? ` · ${square.length} 张方档` : '')
          + (sized.length && ratios.size <= 1 ? ' · 比例单一（疑似兜底假值）' : ''));
      } catch (e) { report('WARN', LABELS[id], `取样失败 · ${e.message}`); unsupported.push(id); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  if (unsupported.length) log(`  瀑布流需要补课的平台：${unsupported.map(id => LABELS[id] || id).join('、')}`);
}

// ---- 修复计划：只自动做幂等重建，其余一律给人工建议 ----
function buildStale() {
  const parity = artifactIssues(root);
  if (parity.length) return {stale: true, reason: `产物双份不一致：${parity.join('；')}`};
  const built = ['dist/library/app.js', 'dist/library/index.html'].map(t => {
    try { return fs.statSync(path.join(root, t)).mtimeMs; } catch { return 0; }
  });
  if (built.some(t => !t)) return {stale: true, reason: '缺少 dist/library 构建产物'};
  let newest = 0, newestFile = '';
  const dir = path.join(root, 'src/library');
  for (const name of fs.readdirSync(dir)) {
    const st = fs.statSync(path.join(dir, name));
    if (st.isFile() && st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = name; }
  }
  // 1s 容差：构建脚本连写多个文件不会落在同一毫秒。
  const stale = newest > Math.min(...built) + 1000;
  return {stale, reason: stale ? `src/library/${newestFile} 比 dist/library 新` : ''};
}

function planFixes() {
  const fixes = [];
  const add = (o) => fixes.push({status: apply ? 'pending' : 'planned', ...o});
  // 预览矩阵的「路由覆盖」FAIL 也归这里：产物比源码旧时，缺的正是那条分支，重建即可。
  const previewFail = findings.filter(f => f.level === 'FAIL'
    && (f.group === G.preview || f.group === G.previewMatrix));
  const b = buildStale();
  if (b.stale || previewFail.length) add({id: 'build', auto: true, command: 'npm run build:library',
    reason: b.stale ? `${b.reason}（重建会同步 dist/library 与 tauri 前端两份产物）`
      : `3D 预览静态断言未过，重建产物并复验（${previewFail.map(f => f.name).join('、')}）`});
  if (previewFail.length) add({id: 'preview-source', auto: false, command: '',
    reason: '重建后仍有静态断言 FAIL 即为源码级回归，需开发修；重建产物不能替代修 bug'});
  if (findings.some(f => f.level === 'FAIL' && f.name === '进程版本一致')) add({id: 'restart', auto: false,
    command: '', reason: '运行中的服务版本落后于源码：不自动杀用户进程，记录待重启'});
  const restore = findings.find(f => f.level === 'WARN' && f.name === '恢复校验');
  if (restore) add({id: 'info-json', auto: false, command: '',
    reason: `${restore.detail} · info.json 的 images 清单是 bundle 的来源凭证（server/archive.mjs declaredImages），补录等于伪造来源，禁止自动修；保持 WARN`});
  const platformFail = findings.filter(f => f.level === 'FAIL' && f.group === G.platform);
  if (platformFail.length) {
    add({id: 'probe-retry', auto: true, command: 'POST /api/platforms/test ×1',
      reason: `${platformFail.length} 个平台连通失败（${platformFail.map(f => f.name).join('、')}），自动退避重试一次，消除偶发超时/WAF 假阳性`});
    add({id: 'platform', auto: false, command: '',
      reason: `${runtimeNotes.join('；') || '重试后仍失败的属站点拦截/登录态'} · 本地不可修，直接记录结论`});
  }
  const us = findings.find(f => f.name === '用户脚本完整性' && f.level !== 'OK');
  if (us) add({id: 'userscript', auto: false, command: 'npm run build && npm run verify',
    reason: '用户脚本产物校验未过，属另一条构建流水线（build:library 修不了），记录待修'});
  if (findings.some(f => f.name === '关键回归子集' && f.level === 'FAIL'))
    add({id: 'regression', auto: false, command: '',
      reason: '关键回归子集有失败用例，是源码级回归，不自动改代码'});
  const displayWarn = findings.filter(f => f.level === 'WARN' && f.group === G.display);
  if (displayWarn.length) add({id: 'display', auto: false, command: '',
    reason: `${displayWarn.length} 条展示能力 WARN（3D 平台方图封面 / 图站缺等比缩略图档），需逐站补 CDN 档位规则，不猜着改`});
  return fixes;
}

function applyBuildFix() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build:library'], {cwd: root, shell: true, encoding: 'utf8', timeout: 300_000});
  if (r.status !== 0) return {status: 'failed', output: String(r.stderr || r.stdout || r.error || '').slice(-400)};
  const app = fileInfo('dist/library/app.js').text();
  const verify = [
    ['showFrameStage', app.includes('showFrameStage')],
    ['itemRatio', app.includes('itemRatio')],
    ['videoWidth', app.includes('videoWidth')],
    ['parity', artifactIssues(root).length === 0],
  ];
  return {status: verify.every(([, ok]) => ok) ? 'applied' : 'applied-with-warning', verify};
}

/** 平台探针偶发超时/WAF 抖动会造成假 FAIL。退避重试一次，恢复的条目直接改回 OK 并重算汇总。 */
async function applyProbeRetry(base, failures) {
  if (!base || !failures.length) return {status: 'nothing-to-retry', recovered: [], stillFailing: []};
  const recovered = [];
  for (const f of failures) {
    const id = Object.keys(LABELS).find(k => LABELS[k] === f.name);
    if (!id) continue;
    await new Promise(r => setTimeout(r, 1200));
    try {
      const r = await api(`${base}/api/platforms/test`, {method: 'POST', body: {id}, timeout: 60_000});
      const d = r.data || {};
      if (d.ok) {
        recovered.push(f.name);
        f.level = 'OK';
        f.detail = `自动重试恢复 · ${d.count ?? '?'} 条`;
        f.repaired = true;
        results.FAIL--; results.OK++;
      }
    } catch { /* 仍失败 → 站点侧，交给 platform 项记结论 */ }
  }
  return {status: 'applied', recovered,
    stillFailing: failures.filter(f => f.level === 'FAIL').map(f => f.name)};
}

const base = await findServer();
log(`AssetVault 自检  ·  ${base || '服务未运行'}  ·  ${new Date().toLocaleString('zh-CN')}`);
if (!base) {
  log('\n本地服务没探到。先启动 AssetVault，再用 --url / --port 指过去。');
  log('离线静态检查照跑：');
  checkPreview({csp: '', missing: [], health: {}});
  await checkPreviewMatrix({report, group, log, root, base: null});
  await checkLinkRouting({report, group, log, root, base: null});
  await checkDisplay(null);
  checkRegression({report, group, log, root, skipTests});
  await checkStorageIntegrity({report, group, log, root, base: null});
  await checkCredentials({report, group, log, root, base: null, api, LABELS});
  await checkDownloadsDeep({report, group, log, root, base: null, api});
} else {
  const csp = (await checkServer(base)) || {csp: '', missing: [], health: {}};
  checkServerExtras({report, root, base, cspInfo: csp});
  checkPreview(csp);
  // 逐平台实测依赖上游站点，和平台连通同属网络组：--skip-platforms 时只留产物级路由守卫。
  await checkPreviewMatrix({report, group, log, root, base: skipPlatforms ? null : base, api, headers: HEADERS, skipLive: skipPlatforms});
  await checkPlatforms(base);
  // 链接解析：归类规则纯逻辑照跑；--skip-platforms 时不发起上游请求。
  await checkLinkRouting({report, group, log, root, base, api, skipLive: skipPlatforms});
  await checkDownloads(base);
  await checkDisplay(base);
  const ctx = {api, report, group, log, root, base, all, skipTests, LABELS, findings, runtimeNotes, headers: HEADERS};
  await checkRuntime(ctx);
  checkRegression(ctx);
  await checkStorageIntegrity(ctx);
  await checkCredentials(ctx);
  await checkDownloadsDeep(ctx);
}

const fixes = fixMode ? planFixes() : [];
if (fixMode) {
  group(`[修复] ${apply ? '自动执行 + 自动复验' : 'dry-run（只列计划）'}`);
  for (const f of fixes) log(`  ${f.auto ? '[AUTO]' : '[记录]'} ${f.id.padEnd(15)} ${f.reason}${f.command ? ' → ' + f.command : ''}`);
  if (!fixes.length) log('  没有需要自动修复的本地项。');
  if (apply) {
    const failures = findings.filter(f => f.level === 'FAIL' && f.group === G.platform);
    for (const f of fixes) {
      if (!f.auto) { f.status = 'recorded'; continue; }
      if (f.id === 'build') {
        Object.assign(f, applyBuildFix());
        // 重建确实修好的那份产物，把检测阶段的 FAIL 回写成 OK，避免 JSON 里出现「已修但还红」。
        // 3D 预览的静态断言 FAIL 不在这里回写：那可能是源码级 bug，重建产物不能替代修 bug。
        if (f.status === 'applied') for (const hit of findings.filter(x => x.level === 'FAIL' && x.name === '产物双份一致')) {
          hit.level = 'OK'; hit.repaired = true;
          hit.detail = '两份产物不一致 → 已自动重建并复验一致';
          results.FAIL--; results.OK++;
        }
      }
      else if (f.id === 'probe-retry') Object.assign(f, await applyProbeRetry(base, failures));
      else f.status = 'skipped';
    }
    const still = findings.filter(f => f.level === 'FAIL' && f.group === G.platform);
    const platformNote = fixes.find(f => f.id === 'platform');
    if (platformNote) {
      platformNote.status = still.length ? 'site-side' : 'not-needed';
      if (still.length) platformNote.reason = `重试后仍失败：${still.map(f => f.name).join('、')} · ${runtimeNotes.join('；') || '站点侧，本地不可修'}`;
    }
    log('\n自动修复结果：');
    for (const f of fixes) log(`  ${f.id.padEnd(15)} ${f.status}`
      + (f.verify ? ' · 复验 ' + f.verify.map(([k, v]) => `${k}:${v ? 'OK' : 'FAIL'}`).join(' / ') : '')
      + (f.recovered ? ` · 恢复 ${f.recovered.length} 个${f.stillFailing?.length ? ` · 仍失败 ${f.stillFailing.join('、')}` : ''}` : '')
      + (f.output ? ' · ' + f.output : ''));
    log('  已自动复验；白名单外的项直接记录结论，不等待确认。');
  }
}

if (jsonMode) {
  process.stdout.write(JSON.stringify({
    at: new Date().toISOString(), base, summary: {...results},
    mode: {fix: fixMode, apply, dryRun: fixMode && !apply}, findings, fixes,
  }, null, 2) + '\n');
} else {
  log(`\n结果：${results.OK} OK / ${results.WARN} WARN / ${results.FAIL} FAIL`
    + (apply ? ' · 已自动修复并复验' : ' · dry-run'));
}
process.exitCode = results.FAIL ? 1 : 0;
