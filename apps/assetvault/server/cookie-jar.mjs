// 域名 cookie 仓库。
//
// 为什么需要它：站酷的作品页、500px 的原图、Pinterest 的私有画板这一类内容，
// 服务器只认「浏览器跑过挑战 / 用户登录过」的状态。浏览器拿到的 cookie 是明文（CDP 直读），
// 存到磁盘后，纯 HTTP 请求带上就能直接过 WAF —— 实测站酷作品页从 23KB 挑战页变成 505KB 真页面。
//
// 只存 cookie，不存任何账号密码；用户随时可以清掉。
import fs from 'node:fs';
import path from 'node:path';
import {resolveDataDir} from './data-dir.mjs';

/** 域名匹配：`.zcool.com.cn` 也算 `zcool.com.cn` 的子域。这里自带一份，避免反向依赖 cdp。 */
export function hostMatches(cookieDomain, host) {
  if (!cookieDomain || !host) return false;
  const d = String(cookieDomain).replace(/^\./, '').toLowerCase();
  const h = String(host).replace(/^\./, '').toLowerCase();
  return h === d || h.endsWith('.' + d);
}

// 常见的「主机名后缀本身就是一个域名」的情况，注册域要往下多取一段。
const MULTI_SUFFIX = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'co.jp', 'co.uk', 'com.au', 'com.br', 'co.kr', 'com.tw', 'com.hk', 'com.sg']);

/** 注册域（site key）：`www.zcool.com.cn` / `log.zcool.com.cn` / `zcool.com.cn` 都归到 `zcool.com.cn`。
 *  登录窗口同步 cookie 时用它做归属判断，不然浏览器自带的 bing / google cookie 也会被收进仓库。 */
export function siteKey(host) {
  const parts = String(host || '').replace(/^\./, '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return MULTI_SUFFIX.has(last2) ? parts.slice(-3).join('.') : last2;
}

const SERVER_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(SERVER_DIR, '..');

function dataDir() {
  return resolveDataDir(ROOT).dir;
}

export function cookieFile() {
  return path.join(dataDir(), 'browser', 'cookies.json');
}

/** 所有浏览器通道（--dump-dom 渲染、CDP 登录窗口、CDP 抓图）共用同一个 profile —— 
 *  cookie 才会在「渲染过一次挑战」和「纯 HTTP 请求」之间流通。同一时刻只能有一个进程用它。 */
export function browserProfileDir() {
  const dir = path.join(path.dirname(cookieFile()), 'profile');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 权限问题交给上层报 */ }
  return dir;
}

let cache = null;
let cacheMtime = 0;

function load() {
  const file = cookieFile();
  try {
    const st = fs.statSync(file);
    if (cache && st.mtimeMs === cacheMtime) return cache;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = Array.isArray(raw?.cookies) ? raw.cookies : [];
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    cache = cache || [];
    return cache;
  }
}

function persist(cookies) {
  const file = cookieFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { updatedAt: new Date().toISOString(), count: cookies.length, cookies };
  fs.writeFileSync(file, JSON.stringify(body), 'utf8');
  cache = cookies;
  try { cacheMtime = fs.statSync(file).mtimeMs; } catch { cacheMtime = 0; }
  return cookies;
}

function keyOf(c) {
  return `${c.domain}|${c.path || '/'}|${c.name}`;
}

function alive(c) {
  if (!c.expires || c.expires <= 0) return true;            // -1 / 0 = 会话 cookie
  return c.expires * 1000 > Date.now();
}

/** 把浏览器导出的 cookie 合并进仓库，返回 {added, updated, total}。 */
export function mergeCookies(list) {
  const incoming = (Array.isArray(list) ? list : []).filter((c) => c && c.name && c.domain);
  if (!incoming.length) return { added: 0, updated: 0, total: load().length };
  const map = new Map(load().map((c) => [keyOf(c), c]));
  let added = 0;
  let updated = 0;
  for (const c of incoming) {
    const k = keyOf(c);
    if (map.has(k)) updated++;
    else added++;
    map.set(k, {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: Number(c.expires) || 0,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite || '',
      at: Date.now(),
    });
  }
  const next = [...map.values()].filter(alive);
  persist(next);
  return { added, updated, total: next.length };
}

/** 给某个 URL / 主机名拼 Cookie 头。没有可用 cookie 时返回 ''。 */
export function cookieHeaderFor(value) {
  let host = '';
  try { host = typeof value === 'string' && /^https?:\/\//i.test(value) ? new URL(value).hostname : String(value || ''); }
  catch { return ''; }
  if (!host) return '';
  const pathname = (() => {
    try { return new URL(value).pathname || '/'; } catch { return '/'; }
  })();
  const picked = load()
    .filter((c) => alive(c) && hostMatches(c.domain, host))
    .filter((c) => !c.secure || /^https:\/\//i.test(String(value)))
    .filter((c) => {
      const p = c.path || '/';
      return p === '/' || pathname === p || (pathname.startsWith(p) && (p.endsWith('/') || pathname[p.length] === '/'));
    })
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length);
  if (!picked.length) return '';
  return picked.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ---- 登录态判定 ----
//
// 「有没有 cookie」不等于「登录了」：跑过一次 WAF 挑战、被统计脚本种几条偏好，都会留下 cookie。
// 站酷是最典型的坑 —— 匿名访客也有 `session`（base64 的 `{"currentUser":null}`），
// 只按条数判断就会把没登录的站标成「已登录」。
//
// 所以这里按站点**解 cookie 的值**：能判就返回 true/false，判不了返回 null，
// 前端据此显示「已登录」/「未登录」/「已存 cookie（未确认登录）」三种状态，绝不误报。
const base64Json = (value) => {
  try { return JSON.parse(Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch { return null; }
};
const jwtPayload = (value) => {
  const parts = String(value || '').split('.');
  return parts.length === 3 ? base64Json(parts[1]) : null;
};

const LOGIN_PROBES = Object.freeze({
  // 站酷：真正的登录凭证是 `.zcool.com.cn` 上的 `zcool_logon_new`，
  //   格式 `{userId}|||null||null|{yyyyMMddHHmmss}|{签名}` —— 未登录时没有这个 cookie，或首段是 0。
  //   注意 `www.` 上的 `session` 是 SSR 层的匿名会话，登录后照样是 `{"currentUser":null}`，
  //   拿它判断会一直显示「未登录」（2026-10-27 实测踩过）。
  'zcool.com.cn': (cookies) => {
    const logon = cookies.find((c) => c.name === 'zcool_logon_new');
    if (logon) {
      // 值里的分隔符是 URL 编码的 `%7C`，不先解码就切不开（实测：`25162242%7C%7C%7Cnull%7C…`）。
      let text = String(logon.value || '');
      try { text = decodeURIComponent(text); } catch { /* 已经是明文就原样用 */ }
      const uid = Number(text.split('|')[0]);
      return Number.isFinite(uid) && uid > 0;
    }
    const row = cookies.find((c) => c.name === 'session');
    if (!row) return null;
    const data = base64Json(row.value);
    if (!data || !('currentUser' in data)) return null;
    return Boolean(data.currentUser);
  },
  // 500px：`x-500px-access-token-prod` 是 JWT，登录后才带 sub（用户 id）+ iss:"u"。
  // 匿名访客只有 device-id，没有 access-token。
  // 小红书：登录后才有 web_session。匿名浏览只有 a1 / webId。
  'xiaohongshu.com': (cookies) => cookies.some((c) => c.name === 'web_session' && String(c.value || '').length > 8) ? true : null,
  // Flickr：登录后写 cookie_session。没有这条就还是访客。
  'flickr.com': (cookies) => cookies.some((c) => c.name === 'cookie_session' && String(c.value || '').length > 8) ? true : null,
  '500px.com': (cookies) => {
    const row = cookies.find((c) => c.name === 'x-500px-access-token-prod');
    if (!row) return null;
    const payload = jwtPayload(row.value);
    if (!payload) return null;
    return Boolean(payload.sub) && Number(payload.exp || 0) * 1000 > Date.now();
  },
});

/** 按注册域整体判一次登录态：cookie 会分散在 `www.` 和 `.` 两个域上，只看一行会漏。
 *  返回 true=确认已登录 / false=确认未登录 / null=这个站没有判据（前端只敢说「已存 cookie」）。 */
function probeLogin(key, all) {
  const probe = LOGIN_PROBES[key];
  if (!probe) return null;
  const list = all.filter((c) => siteKey(c.domain) === key);
  if (!list.length) return null;
  try { return probe(list); } catch { return null; }
}

/** 某站是不是真的登录了（null = 无法判定）。窗口关闭后、面板染色都用它。 */
export function loginStateFor(value) {
  let host = '';
  try { host = typeof value === 'string' && /^https?:\/\//i.test(value) ? new URL(value).hostname : String(value || ''); }
  catch { return null; }
  if (!host) return null;
  return probeLogin(siteKey(host), load().filter(alive));
}

/** 面板用：按站点分组统计，不暴露 cookie 的值（只给登录态与条数）。 */
export function cookieStats() {
  const all = load().filter(alive);
  const byHost = new Map();
  for (const c of all) {
    const d = String(c.domain || '').replace(/^\./, '');
    if (!byHost.has(d)) byHost.set(d, { domain: d, count: 0, updatedAt: 0 });
    const row = byHost.get(d);
    row.count++;
    row.updatedAt = Math.max(row.updatedAt, Number(c.at) || 0);
  }
  // 登录态按注册域算一次，再摊到每一行，前端 sameSite 聚合时直接取 login。
  const cache = new Map();
  for (const row of byHost.values()) {
    const key = siteKey(row.domain);
    if (!cache.has(key)) cache.set(key, probeLogin(key, all));
    row.site = key;
    row.login = cache.get(key);
  }
  const hosts = [...byHost.values()].sort((a, b) => b.count - a.count);
  return {
    total: all.length,
    hosts,
    updatedAt: (() => {
      try { return JSON.parse(fs.readFileSync(cookieFile(), 'utf8')).updatedAt || ''; } catch { return ''; }
    })(),
  };
}

/** 有没有某站点的 cookie（用来判断「这个站是否需要先登录」）。 */
export function hasCookiesFor(value) {
  return cookieHeaderFor(value) !== '';
}

/** 该站最早过期的 cookie 的时间戳（ms）。续期调度靠它：acw_tc 这类挑战 cookie 只活 30 分钟，
 *  过期后纯 HTTP 会立刻掉回挑战页。没有可用 cookie 时返回 0。 */
export function cookieExpiresFor(value) {
  let host = '';
  try {
    host = typeof value === 'string' && /^https?:\/\//i.test(value) ? new URL(value).hostname : String(value || '');
  } catch { return 0; }
  if (!host) return 0;
  const now = Date.now();
  let earliest = 0;
  for (const c of load().filter((x) => alive(x) && hostMatches(x.domain, host))) {
    const exp = Number(c.expires) * 1000;
    if (exp > now && (!earliest || exp < earliest)) earliest = exp;
  }
  return earliest;
}

export function clearCookies(domain = '') {
  if (!domain) { persist([]); return 0; }
  // 按注册域比：清 bing.com 要连带清掉 www.bing.com / .hm.baidu.com 这类子域写入的 cookie。
  const key = siteKey(domain);
  const before = load();
  const keep = before.filter((c) => siteKey(c.domain) !== key);
  persist(keep);
  return before.length - keep.length;
}
