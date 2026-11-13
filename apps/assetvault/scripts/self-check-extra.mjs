// AssetVault 自检的扩展检查组，由 scripts/self-check.mjs 注入 api / report / group / log 后调用。
// 主脚本仍是唯一入口；这里只放「纯本地、只读、不碰写接口」的补充判据。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolveUserPaths} from '../server/data-dir.mjs';

export const G = {
  server: '[1/15] 服务与进程',
  preview: '[2/15] 3D 预览（静态）',
  previewMatrix: '[3/15] 3D 预览矩阵',
  platform: '[4/15] 平台连通',
  linkRoute: '[5/15] 链接解析',
  download: '[6/15] 下载链路',
  display: '[7/15] 展示能力矩阵',
  runtime: '[8/15] 运行时能力',
  regression: '[9/15] 关键回归',
  storage: '[10/15] 数据库与资产存储',
  credentials: '[11/15] 认证与平台凭证',
  downloadsDeep: '[12/15] 下载子系统深度',
};

// 只挑与自检主题直接相关的回归守卫；全量 npm test 太慢，不进默认流程。
export const REGRESSION_FILES = [
  'test/library-preview-stage.test.js',
  'test/library-gallery.test.js',
  'test/library-masonry.test.js',
  'test/library-downloads.test.js',
  'test/library-downloads-snapshot.test.js',
  'test/library-process-lock.test.js',
  'test/library-image-store.test.js',
  'test/library-ai-settings.test.js',
];

const PAIRS = [
  ['dist/library/app.js', 'sketchfab-exporter-tauri/src/app.js'],
  ['dist/library/index.html', 'sketchfab-exporter-tauri/src/index.html'],
];

/** build:library 会同时写 dist/library 和 tauri/src，两份必须逐字节一致。
 *  只写一份是踩过的坑（Tauri 的 frontendDist 指向自己的 src/）。 */
export function artifactIssues(root) {
  const problems = [];
  for (const [a, b] of PAIRS) {
    const A = path.join(root, a), B = path.join(root, b);
    if (!fs.existsSync(A) || !fs.existsSync(B)) { problems.push(`${a} / ${b} 缺一份`); continue; }
    if (!fs.readFileSync(A).equals(fs.readFileSync(B))) problems.push(`${a} 与 tauri 副本不一致`);
  }
  return problems;
}

/** 用户脚本是另一条产品线，用 npm run verify 独立校验；build:library 修不了它。 */
export function verifyUserScript(root) {
  if (!fs.existsSync(path.join(root, 'dist/sketchfab-exporter.user.js')))
    return {ok: false, detail: '缺 dist/sketchfab-exporter.user.js'};
  const r = spawnSync(process.execPath, ['scripts/verify-build.mjs'],
    {cwd: root, encoding: 'utf8', timeout: 60_000});
  return r.status === 0
    ? {ok: true, detail: String(r.stdout || '').trim().slice(-110)}
    : {ok: false, detail: String(r.stderr || r.stdout || r.error || '').trim().slice(-160)};
}

/** 组 1 补充：health 完整字段 / CSP 全白名单 / 端口记录 / 产物完整性。 */
export function checkServerExtras(ctx) {
  const {report, root, base, cspInfo} = ctx;
  const h = cspInfo?.health || {};
  const s = h.storage || {};
  const abi = String(s.nodeAbi || '');
  const abiOk = !abi || abi === String(process.versions.modules);
  report(abiOk ? 'OK' : 'FAIL', 'SQLite ABI',
    `nodeAbi ${abi || '?'} / 当前 ${process.versions.modules} · ${abiOk ? '匹配' : '不匹配，原生模块会加载失败'}`);
  const degraded = s.catalog && s.catalog !== 'db';
  report(degraded ? 'WARN' : 'OK', '存储引擎',
    `${s.engine || '?'} · catalog ${s.catalog || '?'} / writer ${s.writer || '?'}${degraded ? ' · 已退化到文件存储' : ''}`);
  report(h.mode === 'local' ? 'OK' : 'WARN', '运行模式',
    `mode ${h.mode || '?'} · engine ${h.engine || '?'}（engine 是固定标识，不是降级信号）`);

  const csp = cspInfo?.csp || '';
  const serverSrc = fs.readFileSync(path.join(root, 'server/library.mjs'), 'utf8');
  const frameDecl = serverSrc.match(/const FRAME_HOSTS=\[([^\]]+)\]/)?.[1] || '';
  const hosts = [...frameDecl.matchAll(/'([^']+)'/g)].map(m => m[1]);
  const missingHosts = hosts.filter(host => !csp.includes(host));
  const directives = ["frame-src 'self'", "'wasm-unsafe-eval'", "connect-src 'self'", "frame-ancestors 'none'"]
    .filter(d => !csp.includes(d));
  report(!missingHosts.length && !directives.length ? 'OK' : 'FAIL', 'CSP 完整白名单',
    `frame-src 放行 ${hosts.length - missingHosts.length}/${hosts.length} 个域名`
    + (missingHosts.length ? ` · 缺 ${missingHosts.join('、')}` : '')
    + (directives.length ? ` · 缺指令 ${directives.join('、')}` : ''));

  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(path.join(resolveUserPaths().dataDir, 'server-port.json'), 'utf8')).port; }
  catch {}
  const live = (() => { try { return new URL(base).port; } catch { return ''; } })();
  report(saved && String(saved) !== String(live) ? 'WARN' : 'OK', '端口记录',
    saved ? `server-port.json 记 ${saved} · 实际监听 ${live || '?'}${String(saved) !== String(live) ? ' · 旧记录，启动器可能指错进程' : ''}`
      : '没有历史端口记录');

  const parity = artifactIssues(root);
  report(parity.length ? 'FAIL' : 'OK', '产物双份一致',
    parity.length ? parity.join('；') : `dist/library 与 tauri/src 逐字节一致（${PAIRS.length} 对）`);
  const us = verifyUserScript(root);
  report(us.ok ? 'OK' : 'WARN', '用户脚本完整性',
    us.ok ? us.detail : `${us.detail} · 需 npm run build && npm run verify（不是 build:library）`);
}

/** 平台连通 FAIL 的归因：把「网站拒绝访问」拆成登录态过期 / 免登录站点拦截 / WAF。 */
export function platformDiagnosis(failNames, session, platformsSrc, LABELS) {
  if (!failNames.length) return [];
  const hosts = (session?.cookies?.hosts || []);
  const lines = platformsSrc.split('\n');
  return failNames.map(name => {
    const id = Object.keys(LABELS).find(k => LABELS[k] === name);
    const line = lines.find(l => l.trim().startsWith(`${id}:{`)) || '';
    const free = /免登录/.test(line);
    const domains = [...line.matchAll(/'([a-z0-9.-]+\.[a-z]{2,})'/gi)].map(m => m[1].toLowerCase());
    const related = hosts.filter(c => domains.some(d => d.endsWith(c.domain) || c.domain.endsWith(d)));
    if (related.some(c => c.login === false) && !related.some(c => c.login === true))
      return `${name}：cookie ${related.length} 条但 login=false → 登录态过期，需在设置页重新登录`;
    if (related.some(c => c.login === true))
      return `${name}：已登录仍被拒 → 疑似 WAF / 风控`;
    if (free) return `${name}：免登录平台，无 cookie 依赖 → 站点侧拦截，不是登录态问题`;
    return `${name}：无相关 cookie 记录 → 站点侧或网络，本地不可修`;
  });
}

/** 组 6：登录态 / 资产索引基线 / 转换器 / AI 通道。全部 GET 只读。 */
export async function checkRuntime(ctx) {
  const {api, report, group, log, root, base, all, LABELS, runtimeNotes} = ctx;
  group(G.runtime);

  let session = null;
  try {
    session = (await api(`${base}/api/browser/session`, {timeout: 8000})).data;
    const hosts = session?.cookies?.hosts || [];
    report(session?.profileExists ? 'OK' : 'WARN', '浏览器会话',
      `profile ${session?.profileExists ? '存在' : '缺失'} · cookie ${session?.cookies?.total ?? 0} 条 / ${hosts.length} 个域 · 后台浏览器 ${session?.running ? '运行中' : '未启动'}`);
  } catch (e) { report('WARN', '浏览器会话', e.message); }

  const failures = ctx.findings.filter(f => f.level === 'FAIL' && f.group === G.platform).map(f => f.name);
  let platformsSrc = '';
  try { platformsSrc = fs.readFileSync(path.join(root, 'src/library/platforms.js'), 'utf8'); } catch {}
  const notes = platformDiagnosis(failures, session, platformsSrc, LABELS);
  runtimeNotes.push(...notes);
  const needLogin = notes.some(n => n.includes('登录态过期'));
  report(needLogin ? 'WARN' : 'OK', '登录态归因',
    notes.length ? notes.join('；').slice(0, 260) : '没有平台连通 FAIL，无需归因');

  try {
    const cat = (await api(`${base}/api/library/catalog/page?limit=1`, {timeout: 8000})).data;
    const state = (await api(`${base}/api/library-state`, {timeout: 8000})).data;
    const total = cat?.total;
    const recovered = Array.isArray(state?.recovered) ? state.recovered.length : 0;
    const ok = Number.isInteger(total) && total > 0 && state?.scanIndex !== false;
    report(ok ? 'OK' : 'WARN', '资产索引基线',
      `catalog total ${total ?? '?'} · scanIndex ${state?.scanIndex ?? '?'} · 恢复条目 ${recovered}`
      + (Number.isInteger(total) && total === 0 ? ' · 索引为空' : ''));
  } catch (e) { report('WARN', '资产索引基线', e.message); }

  for (const [name, ep, label] of [
    ['SBSAR 转换', '/api/substance/status', 'Substance 集成工具'],
    ['文档转换', '/api/doc/status', 'LibreOffice / 文档转换器'],
  ]) {
    try {
      const d = (await api(`${base}${ep}`, {timeout: 8000})).data;
      report(d?.available ? 'OK' : 'WARN', name,
        d?.available ? `${d.dir || d.path || '已就绪'}` : `${label} 未安装，相关预览不可用（不自动安装）`);
    } catch (e) { report('WARN', name, e.message); }
  }

  try {
    const a = (await api(`${base}/api/ai/settings`, {timeout: 8000})).data || {};
    report(a.enabled && a.hasKey ? 'OK' : 'WARN', 'AI 通道配置',
      `enabled=${a.enabled} · hasKey=${a.hasKey} · model=${a.model || '?'}`);
    if (all) {
      try {
        const t = await api(`${base}/api/ai/test`, {timeout: 30_000});
        report(t.ok && !t.data?.error ? 'OK' : 'WARN', 'AI 实调',
          t.ok ? `模型可达 · ${JSON.stringify(t.data).slice(0, 90)}` : `HTTP ${t.status} ${t.data?.error || ''}`);
      } catch (e) { report('WARN', 'AI 实调', e.message); }
    } else log('  （AI 实调要联网，加 --all 才测）');
  } catch (e) { report('WARN', 'AI 通道配置', e.message); }
}

/** 组 7：跑关键回归子集，防「运行时全绿但源码回归」这种假象。 */
export function checkRegression(ctx) {
  const {report, group, log, root, skipTests} = ctx;
  group(G.regression);
  if (skipTests) { log('  跳过（--skip-tests）'); return; }
  const missing = REGRESSION_FILES.filter(f => !fs.existsSync(path.join(root, f)));
  if (missing.length) { report('FAIL', '关键回归子集', `缺少文件 ${missing.join(', ')}`); return; }
  // 必须逐个独立进程：downloads / process-lock 几个用例共享数据目录里的临时状态，
  // 多个文件放在同一个 node --test 里并发跑会随机踩到彼此（实测两次失败落在不同用例）。
  // 再加一层：失败就重跑该文件一次。这些用例全是确定性逻辑，偶发失败几乎都来自「本机服务
  // 正在跑 + 磁盘/DB 争抢」（同一文件单独跑稳定 16/16），重跑一次就分清是环境抖动还是真回归；
  // 第二次仍失败才计 FAIL，并把失败用例名带出来，别让人对着一个数字猜。
  let pass = 0, fail = 0;
  const bad = [];
  for (const file of REGRESSION_FILES) {
    let out = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = spawnSync(process.execPath, ['--test', file],
        {cwd: root, encoding: 'utf8', timeout: 90_000});
      out = `${r.stdout || ''}${r.stderr || ''}`;
      const p = Number(out.match(/^# pass (\d+)/m)?.[1] || 0);
      const f = Number(out.match(/^# fail (\d+)/m)?.[1] || 0);
      const ok = f === 0 && r.status === 0 && p > 0;
      if (ok || attempt === 1) { pass += p; fail += f; if (!ok) { const name = out.match(/^not ok \d+ - (.+)$/m)?.[1] || ''; bad.push(`${path.basename(file)}: ${f || 'exit ' + r.status}${name ? `（${name.slice(0, 44)}）` : ''}`); } break; }
    }
  }
  report(fail === 0 && bad.length === 0 && pass > 0 ? 'OK' : 'FAIL', '关键回归子集',
    `${pass} pass / ${fail} fail · ${REGRESSION_FILES.length} 个文件（逐个独立进程）`
    + (bad.length ? ` · 失败 ${bad.join('、')}` : ''));
}

/** 进程是否还活着：Windows 下 signal 0 是「存在性探测」。ESRCH=不存在；EPERM=存在但无权限（仍算存活）。 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

/** 目录可用字节数；Windows 走 wmic 兜底（statfsSync 部分版本在 win 上抛 ENOSYS）。拿不到返回 null。 */
function freeSpace(folder) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(folder);
      const bytes = (s.bavail ?? s.blocks) * (s.bsize ?? s.frsize ?? 1);
      if (Number.isFinite(bytes) && bytes > 0) return bytes;
    }
  } catch {}
  try {
    if (process.platform === 'win32') {
      const drive = path.resolve(folder)[0] + ':';
      const out = spawnSync('wmic', ['logicaldisk', 'where', `DeviceID="${drive}"`, 'get', 'FreeSpace', '/value'],
        {encoding: 'utf8', timeout: 8000});
      const m = String(out.stdout || '').match(/FreeSpace=(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch {}
  return null;
}

/** 组 8：数据库与资产存储。全部只读：PRAGMA integrity_check / 文件体检 / 陈旧锁 / 目录可写。 */
export async function checkStorageIntegrity(ctx) {
  const {report, group, root, base, api} = ctx;
  group(G.storage);

  // 活动数据目录：线上从下载快照推导（base/data），离线回退到脚本视角的 dataDir。
  // 脚本与运行中的服务可能解析到不同的 base（如打包版 com.assetvault.desktop），
  // 必须以「实际持有 library.db」的目录为准，否则会查到旧实例的库 / 锁。
  let dataDir = resolveUserPaths().dataDir;
  let downloadDir = resolveUserPaths().downloadDir;
  if (base) {
    try {
      const r = await api(`${base}/api/downloads`, {timeout: 8000});
      const df = r.data?.defaultFolder, sf = r.data?.settings?.folder;
      if (df || sf) {
        downloadDir = sf || df;                          // 实际下载目录（用户可能改过）
        const baseDir = path.dirname(df || sf);          // 服务端 base = base/downloads 的父
        const derived = path.join(baseDir, 'data');
        if (fs.existsSync(path.join(derived, 'library.db'))) dataDir = derived;
      }
    } catch {}
  }
  const dbFile = path.join(dataDir, 'library.db');

  let dbSize = 0, dbExists = false;
  try { const st = fs.statSync(dbFile); dbExists = true; dbSize = st.size; } catch {}
  report(dbExists && dbSize > 0 ? 'OK' : 'WARN', '数据库文件',
    dbExists ? `library.db ${(dbSize / 1024 / 1024).toFixed(2)} MB` : '找不到 library.db（首次运行前正常，非故障）');

  if (dbExists) {
    let integrity = 'unknown', count = -1;
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbFile, {readonly: true, fileMustExist: true});
      try {
        db.pragma('busy_timeout = 5000');
        const rows = db.prepare('PRAGMA integrity_check').all();
        integrity = rows.length === 1 && String(rows[0].integrity_check).toLowerCase() === 'ok' ? 'ok'
          : JSON.stringify(rows).slice(0, 200);
        try { count = db.prepare('SELECT COUNT(*) AS n FROM assets').get().n; } catch {}
      } finally { db.close(); }
    } catch (e) { integrity = `无法检测（${String(e.message).slice(0, 90)}）`; }
    report(integrity === 'ok' ? 'OK' : (integrity.startsWith('无法检测') ? 'WARN' : 'FAIL'), 'SQLite 完整性',
      integrity === 'ok' ? 'integrity_check 通过'
        : (Number.isInteger(count) && count >= 0 ? integrity + ` · assets=${count}` : integrity));
  }

  // 陈旧下载锁：持有进程已死且超过 60s，下次启动会回收（downloads.mjs 的 age<60000 判定）。
  const lockFile = path.join(dataDir, 'manager.lock');
  let lockBuf = null, lockInfo = null, lockAnomaly = '';
  try { lockBuf = fs.readFileSync(lockFile); } catch {}
  if (lockBuf && lockBuf.length && lockBuf.every(b => b === 0)) lockAnomaly = 'all-zero';
  if (!lockAnomaly) { try { lockInfo = JSON.parse(lockBuf.toString('utf8')); } catch { lockAnomaly = 'unparseable'; } }
  if (lockAnomaly) {
    report('WARN', '下载锁', lockAnomaly === 'all-zero'
      ? 'manager.lock 内容全零，疑似异常退出残留或瞬态写冲突，建议重启服务后观察'
      : 'manager.lock 内容异常，无法解析持有者，建议重启服务后观察');
  } else if (lockInfo && Number.isInteger(lockInfo.pid)) {
    const alive = pidAlive(lockInfo.pid);
    const ts = Number(lockInfo.ts || lockInfo.time || 0);
    const age = ts > 0 ? Date.now() - ts : 0;
    if (alive) report('OK', '下载锁', `manager.lock 由进程 ${lockInfo.pid} 持有（运行中，正常）`);
    else if (ts > 0 && age <= 60000) report('WARN', '下载锁', `manager.lock 持有进程 ${lockInfo.pid} 刚退出 ${Math.round(age / 1000)}s，先观察`);
    else report('WARN', '下载锁', `manager.lock 持有进程 ${lockInfo.pid} 已退出，陈旧锁（下次启动会回收/重建）`);
  } else if (fs.existsSync(lockFile)) {
    report('WARN', '下载锁', 'manager.lock 存在但内容异常，无法解析持有者');
  } else {
    report('OK', '下载锁', '无 manager.lock（下载管理器未运行或已正常释放）');
  }

  for (const [name, dir] of [['数据目录', dataDir], ['下载目录', downloadDir]]) {
    let ok = false, msg = '';
    try {
      fs.mkdirSync(dir, {recursive: true});
      const probe = path.join(dir, `.av-probe-${process.pid}`);
      fs.writeFileSync(probe, '1'); fs.unlinkSync(probe); ok = true;
    } catch (e) { msg = String(e.message).slice(0, 80); }
    report(ok ? 'OK' : 'FAIL', '存储目录可读写', ok ? `${name} ${dir}` : `${name} ${dir} 不可写：${msg}`);
  }
}

/** 组 9：认证闸门 + 平台凭证矩阵。闸门测试绕过默认头单独发请求；凭证矩阵复用 platforms.js 的域与免登录标记。 */
export async function checkCredentials(ctx) {
  const {report, group, root, base, api, LABELS, findings} = ctx;
  group(G.credentials);

  if (base) {
    const ep = `${base}/api/platforms`;
    let noAuth = 0, withToken = 0;
    // 前面几组刚打完一轮并发请求，回环连接偶发被重置（拿回 0 而不是 401），
    // 那不是越权也不是闸门坏，隔 300ms 重试一次再判。
    for (const wait of [0, 300]) {
      if (wait) await new Promise(r => setTimeout(r, wait));
      try { noAuth = (await fetch(ep, {signal: AbortSignal.timeout(5000)})).status; } catch { noAuth = 0; }
      if (noAuth) break;
    }
    try { const r = await api(ep, {timeout: 5000}); withToken = r.status; } catch { withToken = 0; }
    const gateMsg = noAuth === 200 ? ' · 未认证即可访问，存在越权风险'
      : (noAuth === 401 || noAuth === 403) ? ' · 未认证被拒，闸门正常'
      : ' · 未认证请求异常（无法测定闸门）';
    report((noAuth === 401 || noAuth === 403) ? 'OK' : (noAuth === 200 ? 'FAIL' : 'WARN'), '本地鉴权闸门',
      `无令牌 → HTTP ${noAuth} · 本地令牌通道 → HTTP ${withToken}` + gateMsg
      + (withToken !== 200 ? ' · 本地令牌通道异常（检查 auth-token）' : ''));
  } else {
    report('WARN', '本地鉴权闸门', '服务未运行，跳过实时闸门测试');
  }

  if (!base) { report('WARN', '平台凭证矩阵', '服务未运行，跳过（需浏览器会话与平台清单）'); return; }
  let session = null, enabled = {};
  try { session = (await api(`${base}/api/browser/session`, {timeout: 8000})).data; } catch {}
  try { enabled = (await api(`${base}/api/platforms`, {timeout: 5000})).data || {}; } catch {}
  let platformsSrc = '';
  try { platformsSrc = fs.readFileSync(path.join(root, 'src/library/platforms.js'), 'utf8'); } catch {}
  const loginMatch = platformsSrc.match(/PICTURE_LOGIN_SITES\s*=\s*new Set\(\[([^\]]+)\]/);
  const loginSet = new Set(loginMatch ? [...loginMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : []);
  const ids = Object.keys(enabled).filter(id => enabled[id] && (id in LABELS));
  const hosts = session?.cookies?.hosts || [];
  const platformFails = new Set(findings.filter(f => f.level === 'FAIL' && f.group === G.platform).map(f => f.name));
  let configured = 0, loginableNoCred = 0, needLoginFail = 0;
  for (const id of ids) {
    const line = platformsSrc.split('\n').find(l => l.trim().startsWith(`${id}:{`)) || '';
    const domains = [...line.matchAll(/'([a-z0-9.-]+\.[a-z]{2,})'/gi)].map(m => m[1].toLowerCase());
    const related = hosts.filter(c => domains.some(d => d.endsWith(c.domain) || c.domain.endsWith(d)));
    if (related.length) { configured++; report('OK', `凭证·${LABELS[id]}`, `已配置 ${related.length} 条相关 cookie`); }
    else if (loginSet.has(id)) {
      if (platformFails.has(LABELS[id])) { needLoginFail++; report('WARN', `凭证·${LABELS[id]}`, '需登录但无 cookie，且连通测试已失败，建议去设置页登录'); }
      else loginableNoCred++;
    }
  }
  report(needLoginFail === 0 ? 'OK' : 'WARN', '凭证覆盖',
    `启用 ${ids.length} 个 · 已配凭证 ${configured} 个域 · 可登录未配 ${loginableNoCred} 个（多数支持匿名访问，仅按需登录）`
    + (needLoginFail ? ` · 其中 ${needLoginFail} 个连通已失败，建议登录` : ''));
}

/** 组 10：下载子系统深度。设置接口可达 / 临时文件泄漏 / 磁盘空间阈值 / 并发数合理性。 */
export async function checkDownloadsDeep(ctx) {
  const {report, group, root, base, api} = ctx;
  group(G.downloadsDeep);
  if (!base) { report('WARN', '下载设置接口', '服务未运行，跳过下载子系统深度检查'); return; }

  let settings = null, defaultFolder = '';
  try {
    const r = await api(`${base}/api/downloads`, {timeout: 8000});
    settings = r.data?.settings || null;
    defaultFolder = r.data?.defaultFolder || '';
    const ok = settings && !settings.error;
    report(ok ? 'OK' : 'WARN', '下载设置可读',
      ok ? `concurrency=${settings.concurrency} · paused=${settings.paused} · folder=${settings.folder || defaultFolder || '?'}`
         : `读取失败：${String(settings?.error || `HTTP ${r.status}`).slice(0, 80)}`);
  } catch (e) { report('WARN', '下载设置可读', e.message); }

  const folder = settings?.folder || defaultFolder;
  if (!folder) { report('WARN', '临时文件扫描', '拿不到下载目录，跳过'); }
  else {
    let leak = [];
    try {
      const names = fs.readdirSync(folder);
      const re = /\.(part|tmp|crdownload|aria2|downloading)$/i;
      const now = Date.now();
      for (const n of names) {
        const fp = path.join(folder, n);
        let mtime = 0; try { mtime = fs.statSync(fp).mtimeMs; } catch {}
        if (re.test(n) && now - mtime > 60_000) leak.push(n);
      }
    } catch (e) { report('WARN', '临时文件扫描', `读取目录失败：${String(e.message).slice(0, 60)}`); }
    report(leak.length === 0 ? 'OK' : 'WARN', '临时文件泄漏',
      leak.length ? `${leak.length} 个残留（>60s 未动）：${leak.slice(0, 5).join('、')}${leak.length > 5 ? '…' : ''}`
                  : `下载目录无陈旧临时文件（${folder}）`);

    const free = freeSpace(folder);
    if (free === null) report('WARN', '磁盘空间', '无法检测可用空间（环境不支持 statfs 且 wmic 不可用）');
    else {
      const gb = free / 1024 ** 3;
      report(gb >= 2 ? 'OK' : 'WARN', '磁盘空间', `下载目录可用 ${gb.toFixed(1)} GB${gb < 2 ? ' · 低于 2GB 阈值，大文件易失败' : ''}`);
    }
  }

  const cl = Number(settings?.concurrency);
  report(Number.isInteger(cl) && cl >= 1 && cl <= 16 ? 'OK' : 'WARN', '并发下载数',
    Number.isInteger(cl) ? `concurrency=${cl}${cl > 16 ? ' · 偏高，可能压垮站点或被限流' : ''}` : '未配置 concurrency');
}

// ── [3/11] 3D 预览矩阵 ────────────────────────────────────────────────────────
// 组 2 只做静态断言（骨架 / 舞台切换 / CSP），历史上「ArtStation 3D 预览消失」这类事故
// 恰恰是静态断言全绿、路由却被改掉的形态：产物里 has3dScene 分支没了，组 2 照样 OK。
// 这里补两层：
//   ① 产物级路由守卫 —— 八条平台预览路径的调用点必须都在 dist（少一条就 FAIL，
//      因为那是「点开没反应」而非「降级」）；② 逐平台实测 —— 从搜索到可视化数据
//      真跑一遍，验证的是「预览能不能加载」而不只是「站点连不连得上」。
// 每条平台独立 try/catch：单个平台超时只影响自己那一行。
export async function checkPreviewMatrix(ctx) {
  const {report, group, root, base, api} = ctx;
  group(G.previewMatrix);

  // ① 产物里的预览路由（build:library 后的 app.js 才是真正跑的那份）
  const app = (() => { try { return fs.readFileSync(path.join(root, 'dist/library/app.js'), 'utf8'); } catch { return ''; } })();
  // 注意：build:library 会把同名 import 改写成 gltfPreview2 / artstationUI2 这类带序号的标识符
  // （同一产物里已有同名符号时），所以正则一律容忍尾随数字，别绑死变量名 —— 否则产物明明是对的
  // 也判缺失，这种假 FAIL 比没检测更糟。
  const ROUTES = [
    ['Sketchfab', /sketchfab\.com\/models\//],
    ['ArtStation', /has3dScene\(m\)\s*\?\s*artstationUI\d*\(\)\.openPreview/],
    ['ambientCG', /\/api\/ambientcg\/preview/],
    ['PolyHaven', /gltfPreview\d*\.load\(/],
    ['FreeStylized', /\.loadFreestylized\(/],
    ['SimReady', /\.loadSimready\(/],
    ['Polyfork', /openPolyforkPreview/],
    ['SBSAR', /\.loadSubstance\(/],
  ];
  const missing = app ? ROUTES.filter(([, re]) => !re.test(app)).map(([name]) => name) : ROUTES.map(([n]) => n);
  report(app && !missing.length ? 'OK' : 'FAIL', '预览路由覆盖',
    app ? `${ROUTES.length - missing.length}/${ROUTES.length} 条平台预览路径在产物里`
        + (missing.length ? ` · 缺失 ${missing.join('、')}（点开不会有画面）` : '')
        : 'dist/library/app.js 不存在，先跑 npm run build:library');

  if (!base) {
    report('WARN', '逐平台实测', ctx.skipLive ? '--skip-platforms：只做产物级路由守卫，不发起上游请求'
      : '服务未运行，跳过（路由守卫已覆盖静态部分）');
    return;
  }

  const fail = (name, e) => report('WARN', name, `实测异常：${String(e.message).slice(0, 80)}`);
  const firstModel = data => (data?.models || data?.items || [])[0] || null;

  // Sketchfab：iframe embed。走 v3 API 验证 viewerUrl —— 直接 GET embed 页拿到的只是
  // 一个几 KB 的壳，判不出模型是否真存在；v3 的 viewerUrl 则是 viewer 内部真正用的地址。
  try {
    const s = await api(`${base}/api/search`, {method: 'POST', body: {q: 'dragon'}, timeout: 60000});
    const uid = firstModel(s.data)?.uid;
    if (!uid) report('WARN', 'Sketchfab 实测', `搜索无结果 · ${String(s.data?.error || `HTTP ${s.status}`).slice(0, 60)}`);
    else {
      const url = `https://api.sketchfab.com/v3/models/${uid}`;
      const r = await api(`${base}/api/proxy?url=${encodeURIComponent(url)}`, {timeout: 30000});
      const viewer = typeof r.data === 'object' ? r.data?.viewerUrl : '';
      report(viewer ? 'OK' : 'WARN', 'Sketchfab 实测',
        viewer ? `模型 ${uid.slice(0, 8)}… embed 可解析` : `v3 未返回 viewerUrl（HTTP ${r.status}）`);
    }
  } catch (e) { fail('Sketchfab 实测', e); }

  // ArtStation：Marmoset Viewer。embedUrl 决定 iframe 能不能开，mviewUrl 决定能不能拿到
  // 原始 .mview（导出 3D 用）；两者都缺才是真坏，只缺 mview 属于「能看不能导」。
  try {
    const s = await api(`${base}/api/artstation/search`, {method: 'POST', body: {q: 'dragon', assetType: 'marmoset'}, timeout: 90000});
    const items = s.data?.models || [];
    const m = items.find(x => x.hasMarmoset) || null;
    if (!m) report('WARN', 'ArtStation 实测', `没有 hasMarmoset 结果（${items.length} 条）· ${String(s.data?.error || '').slice(0, 50)}`.trim());
    else {
      const url = m.artworkUrl || `https://www.artstation.com/artwork/${m.artId}`;
      const r = await api(`${base}/api/artstation/resolve`, {method: 'POST', body: {url}, timeout: 90000});
      const embed = r.data?.embedUrl || '';
      const mview = r.data?.mviewUrl || '';
      report(embed ? (mview ? 'OK' : 'WARN') : 'FAIL', 'ArtStation 实测',
        embed ? `embed ✓${mview ? ' · mview ✓' : ' · 缺 mview（只能看不能导）'}` : `resolve 没给 embedUrl：${String(r.data?.error || `HTTP ${r.status}`).slice(0, 60)}`);
    }
  } catch (e) { fail('ArtStation 实测', e); }

  // Poly Haven：本地 three.js 渲染，数据来自官方 files API 的 1K glTF。
  // 只要 gltf['1k'].gltf.url 在，前端就能取到几何 + 贴图整包。
  try {
    const s = await api(`${base}/api/polyhaven/search`, {method: 'POST', body: {q: 'chair', type: 'models'}, timeout: 60000});
    const id = firstModel(s.data)?.assetId;
    if (!id) report('WARN', 'PolyHaven 实测', `搜索无结果 · ${String(s.data?.error || `HTTP ${s.status}`).slice(0, 60)}`);
    else {
      const url = `https://api.polyhaven.com/files/${id}?type=models`;
      const r = await api(`${base}/api/proxy?url=${encodeURIComponent(url)}`, {timeout: 30000});
      const gltf = typeof r.data === 'object' ? r.data?.gltf?.['1k']?.gltf?.url : '';
      report(gltf ? 'OK' : 'WARN', 'PolyHaven 实测',
        gltf ? `${id} · 1K glTF 可取（本地渲染）` : `${id} 没有 1k glTF（HTTP ${r.status}）· 该资产预览会退到其它档位或失败`);
    }
  } catch (e) { fail('PolyHaven 实测', e); }

  // ambientCG：官方 PBR 查看器 iframe。viewerUrl 是 releases.pbr.one 的带参地址。
  try {
    const s = await api(`${base}/api/ambientcg/search`, {method: 'POST', body: {q: 'wood', type: 'material'}, timeout: 60000});
    const id = firstModel(s.data)?.assetId;
    if (!id) report('WARN', 'ambientCG 实测', `搜索无结果 · ${String(s.data?.error || `HTTP ${s.status}`).slice(0, 60)}`);
    else {
      const r = await api(`${base}/api/ambientcg/preview?id=${encodeURIComponent(id)}`, {timeout: 30000});
      const viewer = r.data?.viewerUrl || '';
      report(viewer ? 'OK' : 'WARN', 'ambientCG 实测',
        viewer ? `${id} · 官方查看器地址可解析` : `${id} 没有 viewerUrl（HTTP ${r.status}），开预览只会提示无交互预览`);
    }
  } catch (e) { fail('ambientCG 实测', e); }

  // FreeStylized：服务端解 ZIP，清单里每个文件再由前端取字节。
  try {
    const s = await api(`${base}/api/freestylized/search`, {method: 'POST', body: {q: '', type: 'models'}, timeout: 60000});
    const slug = firstModel(s.data)?.assetId;
    if (!slug) report('WARN', 'FreeStylized 实测', `搜索无结果 · ${String(s.data?.error || `HTTP ${s.status}`).slice(0, 60)}`);
    else {
      const r = await api(`${base}/api/freestylized/preview?slug=${encodeURIComponent(slug)}&type=models`, {timeout: 120000});
      const files = Array.isArray(r.data?.files) ? r.data.files.length : (r.data?.entries || []).length;
      report(r.data?.ok && files > 0 ? 'OK' : 'WARN', 'FreeStylized 实测',
        r.data?.ok && files > 0 ? `${slug} · 解包 ${files} 个文件（FBX/贴图）`
          : `${slug} 解包失败：${String(r.data?.error || `HTTP ${r.status}`).slice(0, 60)}`);
    }
  } catch (e) { fail('FreeStylized 实测', e); }

  // Polyfork：两条腿。module（生成器源码在浏览器里直跑，毫秒级）与 variant（服务端烘焙）。
  // module 返回 415 是**设计内降级**（生成器依赖不止 three），此时必须保证 variant 能出 glTF。
  try {
    const s = await api(`${base}/api/polyfork/search`, {method: 'POST', body: {q: ''}, timeout: 60000});
    const id = firstModel(s.data)?.assetId;
    if (!id) report('WARN', 'Polyfork 实测', `搜索无结果 · ${String(s.data?.error || `HTTP ${s.status}`).slice(0, 60)}`);
    else {
      const p = await api(`${base}/api/polyfork/params?id=${encodeURIComponent(id)}`, {timeout: 30000});
      const knobs = Array.isArray(p.data?.params) ? p.data.params.length : 0;
      const mod = await api(`${base}/api/polyfork/module?id=${encodeURIComponent(id)}`, {timeout: 60000});
      if (mod.status === 200) {
        report(knobs ? 'OK' : 'WARN', 'Polyfork 实测',
          knobs ? `${id} · ${knobs} 个参数 · 生成器源码可直跑` : `${id} 没有可调参数（参数面板会是空的）`);
      } else {
        // 退回服务端烘焙：真取一次二进制，确认能拿到 glTF 头（这就是 415 之后前端走的路）
        const v = await fetch(`${base}/api/polyfork/variant?id=${encodeURIComponent(id)}&p=%7B%7D`,
          {headers: ctx.headers || {}, signal: AbortSignal.timeout(180000)});
        const buf = Buffer.from(await v.arrayBuffer());
        const glb = buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'glTF';
        report(glb && knobs ? 'OK' : 'WARN', 'Polyfork 实测',
          glb ? `${id} · ${knobs} 个参数 · 源码 ${mod.status}→服务端烘焙 ${(buf.length / 1048576).toFixed(1)}MB glTF`
              : `${id} 烘焙失败（HTTP ${v.status}，${buf.length} 字节）`);
      }
    }
  } catch (e) { fail('Polyfork 实测', e); }

  // SimReady：USD 由服务端列清单，前端逐份取 USD/USDA 原文件。
  try {
    const s = await api(`${base}/api/simready/search`, {method: 'POST', body: {q: ''}, timeout: 60000});
    const id = firstModel(s.data)?.assetId;
    if (!id) report('WARN', 'SimReady 实测', `搜索无结果 · ${String(s.data?.error || `HTTP ${s.status}`).slice(0, 60)}`);
    else {
      const r = await api(`${base}/api/simready/preview?id=${encodeURIComponent(id)}`, {timeout: 60000});
      const entries = Array.isArray(r.data?.entries) ? r.data.entries.length : 0;
      report(entries > 0 && r.data?.root ? 'OK' : 'WARN', 'SimReady 实测',
        entries > 0 && r.data?.root ? `${id} · ${entries} 份 USD · 根 ${String(r.data.root).split('/').pop()}`
          : `${id} 没有可预览的 USD：${String(r.data?.error || `HTTP ${r.status}`).slice(0, 60)}`);
    }
  } catch (e) { fail('SimReady 实测', e); }

  // Substance：SBSAR 参数预览依赖本机 Substance 引擎（cook 出贴图再贴到球上）。
  try {
    const r = await api(`${base}/api/substance/status`, {timeout: 15000});
    const ok = r.data?.available === true;
    report(ok ? 'OK' : 'WARN', 'Substance 实测',
      ok ? `引擎可用 · ${String(r.data?.dir || '').split(/[\\/]/).pop() || '已安装'}`
         : `引擎不可用 → 已下载 SBSAR 的资产开预览只会提示先下载/无法调参（${String(r.data?.error || `HTTP ${r.status}`).slice(0, 50)}）`);
  } catch (e) { fail('Substance 实测', e); }
}

// ── [5/15] 链接解析 ─────────────────────────────────────────────────────────
// 搜索框既是搜索也是「粘贴链接」入口：粘进去的 URL 先经 routeLink() 归类，再决定走哪条通道
// （Marmoset 作品页 / 图站直达 / UI 元素 / 通用网页扫描）。这里是纯前端函数，不需要网络，
// 归错通道的后果是「粘了链接什么都没解析出来」——比报错更让人迷惑，所以直接 import 真实模块
// 跑用例，而不是拿正则去镜像源码（镜像会跟源码一起漂移，正是假绿的温床）。
export async function checkLinkRouting(ctx) {
  const {report, group, root, base, api, skipLive} = ctx;
  group(G.linkRoute);

  let P = null;
  try {
    P = await import(pathToFileURL(path.join(root, 'src/library/platforms.js')).href);
  } catch (e) {
    report('WARN', '链接归类规则', `无法加载 src/library/platforms.js：${String(e.message).slice(0, 70)}`);
  }

  if (P) {
    // 每条都带「为什么重要」——失败时能直接看出坏在哪类边界上
    const CASES = [
      ['https://www.artstation.com/artwork/eJ5PQD', 'artstation', 'ArtStation 作品页必须进 Marmoset 通道'],
      ['https://www.artstation.com/artist/foo', 'web', '作者页落回通用解析（只有作品页能进 Marmoset）'],
      ['https://sketchfab.com/3d-models/dragon-14ec4c0', 'sketchfab', '单模型页'],
      ['https://sketchfab.com/someuser', 'sketchfab-user', '作者页不能被当成普通页面'],
      ['https://sketchfab.com/models', 'sketchfab', '保留段 models 不能被当成作者名'],
      ['https://sketchfab.com/search?q=x', 'sketchfab', '搜索页不能被当成作者名'],
      ['https://sketchfab.com/collections/abc', 'sketchfab', '合集页不能被当成作者名'],
      ['https://sketchfab.com/a/b/c', 'sketchfab', '三段以上路径不算作者页'],
      ['https://wallhaven.cc/w/abc', 'wallhaven', '图站链接要直达图站解析'],
      ['https://uiverse.io/loader', 'uiverse', 'UI 元素通道'],
      ['', 'empty', '空输入只给提示，不能抛错'],
      ['abc', 'invalid', '不是完整网址'],
      ['ftp://a.com/x', 'invalid', '只收 http / https'],
    ];
    const wrong = [];
    for (const [url, want, why] of CASES) {
      let got;
      try { got = P.routeLink(url).id; } catch (e) { got = `抛出异常(${e.message})`; }
      if (got !== want) wrong.push(`${why}：期望 ${want}，实得 ${got}`);
    }
    report(wrong.length ? 'FAIL' : 'OK', '链接归类规则',
      wrong.length ? `${wrong.length}/${CASES.length} 条走错通道 · ${wrong.slice(0, 2).join('；')}`
        : `${CASES.length}/${CASES.length} 条进对通道（作品页 / 作者页 / 保留段 / 图站 / UI / 非 URL / 协议）`);

    // 站点覆盖：每加一个图站，若忘了在 LINK_ROUTES 补规则，粘它的链接会静默走通用网页扫描。
    const routeIds = new Set((P.LINK_ROUTES || []).map(r => r.id));
    const picIds = Object.keys(P.PICTURE_SITES || {});
    const uiIds = Object.keys(P.UI_SITES || {});
    const missing = [...picIds, ...uiIds].filter(id => !routeIds.has(id));
    report(missing.length ? 'FAIL' : 'OK', '站点链接覆盖',
      missing.length ? `${missing.length} 个站没有链接规则（粘链接会落到通用网页扫描）：${missing.slice(0, 6).join('、')}`
        : `${picIds.length} 个图站 + ${uiIds.length} 个 UI 站都有专属通道`);

    // 优先级：LINK_ROUTES 用 find 取第一个命中，所以「作者页」必须排在「Sketchfab 页面」前面，
    // 否则每个作者页都会被泛化规则吃掉 —— 结果区永远只写「链接解析结果」。
    const order = (P.LINK_ROUTES || []).map(r => r.id);
    const iUser = order.indexOf('sketchfab-user');
    const iPage = order.indexOf('sketchfab');
    report(iUser >= 0 && iPage >= 0 && iUser < iPage ? 'OK' : 'FAIL', '规则优先级',
      iUser < 0 || iPage < 0 ? '缺少 sketchfab / sketchfab-user 规则'
        : iUser < iPage ? '具体规则排在泛化前（作者页先命中），结果区才写得出「作者」'
        : `顺序反了（作者页 ${iUser} > 页面 ${iPage}）：所有作者页都会被当成普通页面`);
  }

  if (!base || skipLive) {
    report('WARN', '解析通道实测', skipLive ? '--skip-platforms：只跑归类规则，不发起上游请求'
      : '服务未运行，跳过（归类规则已覆盖纯逻辑部分）');
    return;
  }

  // 通用网页 / 单模型页：走 /api/scan。判「有没有解析出东西」，不判具体条目（外部页面会变）。
  try {
    const sample = 'https://sketchfab.com/3d-models/dragon-14ec4c0460c64065af1c6fd31f104344';
    const r = await api(`${base}/api/scan`, {method: 'POST', body: {url: sample}, timeout: 90000});
    const models = (r.data?.models || []).length;
    report(models ? 'OK' : 'WARN', '网页解析通道',
      models ? `${models} 条 · ${String(r.data?.source || '已解析').slice(0, 24)}`
        : `没解析出模型：${String(r.data?.warnings?.[0] || r.data?.error || `HTTP ${r.status}`).slice(0, 70)}`);
  } catch (e) { report('WARN', '网页解析通道', String(e.message).slice(0, 80)); }

  // UI 站：uiverse 的列表页解析（组 4 只测了它的搜索探针，通道不同）。
  // 站点侧拦截记 WARN 并说清楚，别让人以为链接解析坏了。
  try {
    const url = 'https://uiverse.io/loaders';
    const r = await api(`${base}/api/ui-site/resolve?platform=uiverse&url=${encodeURIComponent(url)}`, {timeout: 60000});
    const items = (r.data?.items || []).length;
    const err = String(r.data?.error || '');
    report(items ? 'OK' : 'WARN', 'UI 站通道',
      items ? `${items} 个 UI 元素`
        : `无条目：${err.slice(0, 50)}${/拒绝|blocked|登录/.test(err) ? ' · 站点侧拦截，不是链接解析坏' : ''}`);
  } catch (e) { report('WARN', 'UI 站通道', String(e.message).slice(0, 80)); }

  // 图站通道不在这里重抓：组 7 逐站取样走的就是同一个 picture-site/resolve，
  // 再跑一遍等于把十几个站的请求翻倍。
  report('OK', '图站通道', '由 [7/15] 展示能力矩阵逐站取样覆盖（端点同为 picture-site/resolve）');
}
