// 浏览器会话管理：同一时间只留一个实例（同一个 profile 目录不能被两个进程同时用），
// 用一条串行链把所有调用排队，避免并发启动互相抢锁。
//
// 三种用途：
//   1. 登录       —— headed 窗口，用户手动登录，我们每 2.5 秒把 cookie 同步进 jar
//   2. 取 DOM     —— headless 渲染被 WAF / 客户端渲染挡住的页面
//   3. 兜底抓图   —— 监听 Network 响应，把页面真实加载过的图片地址全捞出来
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, killBrowser, openPageTarget } from './cdp.mjs';
import { cookieFile, mergeCookies, cookieStats, browserProfileDir, siteKey } from './cookie-jar.mjs';

const PROFILE_DIR = browserProfileDir();
const IDLE_MS = 90 * 1000;

let active = null;      // {mode, page, child, port, exe, startedAt, lastUsed}
let loginJob = null;    // {startedAt, url, platform, timer, closed}
let chain = Promise.resolve();

function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

function alive() {
  if (!active) return false;
  if (active.page?.closed) return false;
  if (active.child && active.child.exitCode !== null) return false;
  return true;
}

async function release() {
  if (!active) return;
  const cur = active;
  active = null;
  cur.page?.close();
  await killBrowser(cur.child, { grace: 2500 });
}

async function acquire(mode = 'headless') {
  if (alive() && active.mode === mode) {
    active.lastUsed = Date.now();
    return active;
  }
  await release();
  const b = await launchBrowser({ mode, profileDir: PROFILE_DIR });
  active = { ...b, startedAt: Date.now(), lastUsed: Date.now() };
  // headless 空闲自动回收，别让一个常驻 chrome 白占几百 MB
  const child = active.child;
  child.once('exit', () => {
    if (active?.child === child) active = null;
  });
  return active;
}

// 定时回收空闲的 headless 实例（登录窗口不回收，那是用户在用的）
const sweeper = setInterval(() => {
  if (!active || active.mode !== 'headless') return;
  if (Date.now() - active.lastUsed > IDLE_MS) release().catch(() => {});
}, 30 * 1000);
sweeper.unref?.();

/** 从浏览器导出 cookie 存入 jar。给了 `host` 就只收该站（含子域），
 *  免得把浏览器自带的 bing / google cookie 也一起收进仓库。 */
export async function syncCookies(page, { host = '' } = {}) {
  const target = page || (alive() ? active.page : null);
  if (!target) return { added: 0, updated: 0, total: 0, skipped: true };
  let list = await target.cookieHeader(null);
  if (host) {
    const key = siteKey(host);
    list = list.filter((c) => siteKey(c.domain) === key);
  }
  return mergeCookies(list);
}

/**
 * 打开一个可见的浏览器窗口让用户登录。
 * 窗口里每 2.5 秒同步一次 cookie，用户登录完直接关掉窗口即可，不需要点任何「完成」。
 */
export async function startLogin({ url, platform = '' } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('登录地址无效');
  if (loginJob && !loginJob.closed) {
    // 已有登录窗口 → 把它带到前台（重新导航到新地址）
    try {
      await loginJob.page.goto(url, { timeout: 20000 });
      loginJob.url = url;
      loginJob.platform = platform;
      return { ok: true, reused: true, url };
    } catch { /* 掉了就重开 */ }
  }
  await release();
  const b = await launchBrowser({ mode: 'headed', profileDir: PROFILE_DIR, timeout: 35000 });
  active = { ...b, startedAt: Date.now(), lastUsed: Date.now() };

  const job = { page: b.page, child: b.child, url, platform, startedAt: Date.now(), closed: false, synced: 0, timer: null };
  loginJob = job;

  const tick = async () => {
    if (job.closed) return;
    try {
      const key = siteKey(new URL(job.url).hostname);
      // 只收当前站点的 cookie：登录窗口顺手打开的 bing / 微软账号等 cookie 不该进仓库。
      const list = (await b.page.cookieHeader(null)).filter((c) => siteKey(c.domain) === key);
      if (list.length) { mergeCookies(list); job.synced = list.length; }
    } catch { /* 用户可能在切页面 */ }
  };
  job.timer = setInterval(tick, 2500);
  job.timer.unref?.();
  b.page.on('Page.frameNavigated', () => { tick().catch(() => {}); });

  b.child.once('exit', async () => {
    job.closed = true;
    clearInterval(job.timer);
    await tick().catch(() => {});
    if (loginJob === job) loginJob = null;
    if (active?.child === b.child) active = null;
  });

  await b.page.goto(url, { timeout: 25000 }).catch(() => {});
  return { ok: true, url, profile: PROFILE_DIR };
}

/** 登录窗口状态。 */
export function loginStatus() {
  if (!loginJob || loginJob.closed) return { open: false };
  return { open: true, url: loginJob.url, platform: loginJob.platform, synced: loginJob.synced, ms: Date.now() - loginJob.startedAt };
}

export async function closeLogin() {
  if (!loginJob || loginJob.closed) return { ok: true, open: false };
  const job = loginJob;
  // 关窗口时再补采一次，但只采这个登录站的域 —— 全量采会把 Edge 首页顺带访问的
  // bing.com cookie 一起存进仓库（实测关一次多出 13 条无关 cookie）。
  let host = '';
  try { host = new URL(job.url).hostname; } catch { /* 地址异常就只做全量兜底 */ }
  await syncCookies(job.page, { host }).catch(() => {});
  job.closed = true;
  clearInterval(job.timer);
  job.page?.close();
  await killBrowser(job.child, { grace: 2500 });
  loginJob = null;
  if (active?.child === job.child) active = null;
  return { ok: true, open: false };
}

/**
 * 用浏览器打开页面，取渲染后的 DOM + 网络里真实加载过的图片。
 * 这是「自动化网页抓原图」的兜底通道：不依赖任何站点的 HTML 结构假设，谁加载了什么就抓什么。
 */
export async function capturePage(url, { timeout = 25000, quiet = 1500, maxBytes = 40 } = {}) {
  return serialize(async () => {
    const b = await acquire('headless');
    const images = new Map();
    const off = b.page.on('Network.responseReceived', (p) => {
      const r = p.response || {};
      const mime = String(r.mimeType || '');
      if (!mime.startsWith('image/')) return;
      if (images.has(r.url)) return;
      const len = Number((r.headers && (r.headers['content-length'] || r.headers['Content-Length'])) || 0) || 0;
      images.set(r.url, { url: r.url, mime, bytes: len });
    });
    let html = '';
    let nav = null;
    try {
      nav = await b.page.goto(url, { timeout, waitForQuiet: quiet });
      html = await b.page.html();
    } finally { off(); }
    active.lastUsed = Date.now();
    // 每次渲染成功都把 cookie（含 WAF 挑战令牌）回存，下次同一站点的纯 HTTP 请求就能直接过验证。
    try { await syncCookies(b.page, { host: new URL(url).hostname }); } catch { /* 浏览器可能已退出 */ }
    return { html, images: [...images.values()], nav };
  });
}

/** 只取 DOM（给站酷这类页面用）。这个不进 cookie 注入路径，走浏览器。 */
export async function renderHtml(url, { timeout = 25000, quiet = 1200 } = {}) {
  const r = await capturePage(url, { timeout, quiet, maxBytes: 0 });
  return r.html;
}

/** 让出 profile：--dump-dom 渲染通道要独占 user-data-dir，常驻实例必须先退。
 *  （同一个 profile 被两个浏览器进程同时打开会直接启动失败。） */
export function releaseProfile() {
  return serialize(() => release());
}

/**
 * 短暂开一个浏览器连同一 profile，把里面的 cookie 读出来存进 jar。
 *
 * 为什么需要这一步：站酷那类阿里云 WAF 只有 `--dump-dom` + virtual-time 才跑得完挑战
 * （CDP 普通模式会一直卡在 68KB 挑战页，加虚拟时间又会让导航挂死），而 --dump-dom 是
 * 一次性进程、拿不到 cookie。它跑完 cookie 留在 profile 里，这里补一刀读出来。
 * 代价约 1.2 秒，只在「刚跑完挑战」时发生一次。
 */
export function harvestCookies({ timeout = 15000, host = '' } = {}) {
  return serialize(async () => {
    await release();
    const b = await launchBrowser({ mode: 'headless', profileDir: PROFILE_DIR, timeout });
    try {
      let list = await b.page.cookieHeader(null);
      if (host) {
        const key = siteKey(host);
        list = list.filter((c) => siteKey(c.domain) === key);
      }
      return list.length ? mergeCookies(list) : { added: 0, updated: 0, total: 0 };
    } finally {
      b.page.close();
      await killBrowser(b.child, { grace: 2000 });
    }
  });
}

/**
 * 借一张页签把某个页面跑一遍，交给 handler(page, instance) 去观察 ——
 * 「让页面自己发出带签名的请求，我们从网络层捞结果」这条路全走在这里。
 *
 * 实例复用顺序（顺序很重要）：
 *   1. 已经有实例（用户正开着的登录窗口也算）→ **借它一张新页签**，绝不 release 它：
 *      关掉登录窗口等于让用户重登一次，而且它本来就是我们唯一的登录态来源。
 *   2. 没有实例 → 起一个 headless 并留着复用（空闲 90 秒由 sweeper 回收）。
 * 全程走 serialize()：同一个 profile 不能被两个浏览器进程同时打开。
 */
export function watchPage(handler, { timeout = 40000 } = {}) {
  return serialize(async () => {
    let instance = alive() ? active : null;
    if (instance) instance.lastUsed = Date.now();
    if (!instance) {
      const b = await launchBrowser({ mode: 'headless', profileDir: PROFILE_DIR, timeout });
      instance = { ...b, startedAt: Date.now(), lastUsed: Date.now() };
      active = instance;
      const child = instance.child;
      child.once('exit', () => { if (active?.child === child) active = null; });
    }
    const tab = await openPageTarget(instance.port);
    try {
      return await handler(tab.page, instance);
    } finally {
      instance.lastUsed = Date.now();
      await tab.close().catch(() => {});
    }
  });
}

export function sessionStatus() {  return {
    ok: true,
    profileDir: PROFILE_DIR,
    profileExists: fs.existsSync(PROFILE_DIR),
    running: alive(),
    mode: alive() ? active.mode : null,
    exe: alive() ? active.exe?.name || '' : '',
    login: loginStatus(),
    cookies: cookieStats(),
  };
}

/** 关机时别把 chrome 留在后台。 */
export async function shutdownBrowser() {
  clearInterval(sweeper);
  await closeLogin().catch(() => {});
  await release().catch(() => {});
}
