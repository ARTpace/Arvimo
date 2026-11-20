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
let lastLoginError = ''; // 窗口关掉后仍要能说明「为什么没登录成功」
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
export async function startLogin({ url, platform = '', capture = null } = {}) {
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

  const job = { page: b.page, child: b.child, url, platform, capture, captured: false, corrective: '', correctiveRetry: 0, needEula: '', startedAt: Date.now(), closed: false, synced: 0, timer: null, error: '' };
  loginJob = job;

  /** 拿到授权码 → 换 token → 关窗口；换失败要留痕（别静默吞掉，用户会以为「明明登录了」）。 */
  const finish = async value => {
    if (!job.capture || job.captured || job.closed) return;
    job.captured = true;
    try {
      await job.capture.onExtract(value);
    } catch (error) {
      job.captured = false;
      job.error = String(error?.message || error || 'Epic 授权码换 token 失败');
      return;                      // 窗口留着，让用户看到出错的那一页
    }
    job.error = '';
    if (loginJob === job) loginJob = null;
    job.closed = true;
    clearInterval(job.timer);
    job.page?.close();
    await killBrowser(job.child, { grace: 1500 });
    if (active?.child === job.child) active = null;
  };

  // 第一手：直接听回调页的网络响应正文。Epic 的授权码只能用一次，DOM 轮询慢半拍时
  // 页面可能已经重新加载过一次，抓到的码就作废了 —— 响应体是最早能拿到的那份。
  if (capture) {
    b.page.on('Network.responseReceived', params => {
      if (job.captured || job.closed) return;
      const response = params?.response || {};
      if (!capture.test(String(response.url || ''))) return;
      b.page.send('Network.getResponseBody', { requestId: params.requestId }, 8000)
        .then(body => {
          const raw = String(body?.body || '');
          const text = body?.base64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
          const value = text ? capture.extract(text) : '';
          if (value) return finish(value).catch(() => {});
          if (/"authorizationCode"\s*:\s*null/.test(text)) {
            job.error = 'Epic 那边还是未登录状态（authorizationCode 为空）：请在窗口里真正登进 Epic 账号，等它自动跳到显示授权码的那一页';
          }
        })
        .catch(() => { /* 正文可能已经释放，交给下面的 DOM 兜底 */ });
    });
  }

  /**
   * Epic 的 corrective action：光登录还不够，得先在网页上「接受 Fab EULA / 补生日 / 确认昵称」。
   * 这时回调页返回的是一段 JSON（errorCode: errors.com.epicgames.oauth.corrective_action_required），
   * 里面没有授权码，只等是等不出来的。带 continuation 跳到官方处理页，用户点完接受后
   * Epic 会自己把 OAuth 流程接回去，授权码照样会出现在回调页 —— 我们这边继续监听即可。
   */
  const handleCorrective = async text => {
    if (job.corrective || job.needEula || !/"correctiveAction"\s*:/.test(text)) return false;
    const action = (text.match(/"correctiveAction"\s*:\s*"([A-Z_]+)"/) || [])[1] || '';
    const continuation = (text.match(/"continuation"\s*:\s*"([^"]+)"/) || [])[1] || '';
    // EULA_ACCEPTANCE 是 Epic Games Launcher 的终端用户许可协议：网页端不接受它
    // （跳过去只会看到那段 JSON），只能由用户在工具里确认后走 corrections 接口提交。
    // 这里只挂起待确认标记，不替用户点同意。
    if (action === 'EULA_ACCEPTANCE' && continuation) {
      job.needEula = continuation;
      job.error = 'Epic 要求先接受一次启动器许可协议（EULA），接受后才能用 Fab 下载';
      return true;
    }
    job.corrective = action || 'UNKNOWN';
    job.error = action === 'EULA_ACCEPTANCE'
      ? 'Epic 要求先接受 Fab 的许可协议（EULA）：登录窗口已跳到协议页，点「接受」后会继续登录'
      : `Epic 要求先在登录窗口里完成一步确认：${action || '未知动作'}`;
    const eula = 'https://www.fab.com/eula';
    try {
      if (continuation) {
        // 官方 continuation 页接受完会自动把 OAuth 流程接回去（回到带授权码的回调页）。
        await job.page.goto(`https://www.epicgames.com/id/continuation/${encodeURIComponent(continuation)}`, { timeout: 25000 });
        const check = await job.page.send('Runtime.evaluate', {
          expression: 'document.body?document.body.innerText:""',
          returnByValue: true,
        });
        const body = String(check?.result?.value || '');
        // 路由不存在会是一张空页 / 404 / 还在 Cloudflare 挑战，那就退回 Fab 自己的协议页
        // （用户接受完由上面的「离开协议页就重放授权」把 OAuth 接回来）。
        if (body.trim().length < 40 || /not found|404|just a moment|challenge/i.test(body.slice(0, 400)) || !/eula|license|agreement|协议|许可|accept|agree/i.test(body)) {
          await job.page.goto(eula, { timeout: 25000 });
        }
      } else {
        await job.page.goto(eula, { timeout: 25000 });
      }
    } catch {
      await job.page.goto(eula, { timeout: 25000 }).catch(() => {});
    }
    return true;
  };

  // 第二手：回调页渲染出来的正文（响应体取不到时兜底），每 2.5 秒看一次。
  const probe = async () => {
    if (!job.capture || job.captured || job.closed) return;
    try {
      const r = await b.page.send('Runtime.evaluate', {
        expression: 'JSON.stringify({url:location.href,text:document.body?document.body.innerText:(document.documentElement?document.documentElement.innerText:"")})',
        returnByValue: true,
      });
      let page = {};
      try { page = JSON.parse(String(r?.result?.value || '{}')); } catch { return; }
      const text = String(page.text || '');
      const value = text ? job.capture.extract(text) : '';
      if (value) return finish(value);
      if (await handleCorrective(text)) return;
      // 用户在协议页点完「接受」后，Epic 的网页流程并不总会把 OAuth 接回来
      // （continuation 路由不可用时就断了）。一旦发现已经离开协议页、或页面上出现
      // 「已接受」的迹象，就把最初的授权地址重放一次 —— 这次 EULA 已接受，直接能拿到码。
      if (job.corrective && job.correctiveRetry < 2) {
        const here = String(page.url || '');
        const leftEula = !/epicgames\.com\/id\/continuation|\/eula/i.test(here);
        const accepted = /already accepted|accepted the|已接受|接受成功|you have accepted|thank you/i.test(text);
        if (leftEula || accepted) {
          job.correctiveRetry += 1;
          job.corrective = '';
          job.error = '';
          await job.page.goto(job.url, { timeout: 25000 }).catch(() => {});
          return;
        }
      }
      if (job.capture.test(String(page.url || '')) && /"authorizationCode"\s*:\s*null/.test(text)) {
        job.error = 'Epic 那边还是未登录状态（authorizationCode 为空）：请在窗口里真正登进 Epic 账号，等它自动跳到显示授权码的那一页';
      }
    } catch { /* 页面切换中，下一拍再试 */ }
  };
  const tick = async () => {
    if (job.closed) return;
    try {
      const key = siteKey(new URL(job.url).hostname);
      // 只收当前站点的 cookie：登录窗口顺手打开的 bing / 微软账号等 cookie 不该进仓库。
      const list = (await b.page.cookieHeader(null)).filter((c) => siteKey(c.domain) === key);
      if (list.length) { mergeCookies(list); job.synced = list.length; }
    } catch { /* 用户可能在切页面 */ }
    probe().catch(() => {});
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
    lastLoginError = job.error || '';       // 窗口关掉后还要能解释「为什么没成功」
  });

  lastLoginError = '';
  await b.page.goto(url, { timeout: 25000 }).catch(() => {});
  return { ok: true, url, profile: PROFILE_DIR };
}

/** 登录窗口状态（关掉之后仍带着最后一次的失败原因，方便前端提示）。 */
export function loginStatus() {
  if (!loginJob || loginJob.closed) return { open: false, error: lastLoginError || '' };
  return { open: true, url: loginJob.url, platform: loginJob.platform, synced: loginJob.synced, ms: Date.now() - loginJob.startedAt, error: loginJob.error || '', needEula: loginJob.needEula || '' };
}

/** 当前登录窗口里是否有一份等着用户确认的 Epic 协议（EULA）。 */
export function pendingEula() {
  if (!loginJob || loginJob.closed) return '';
  return loginJob.needEula || '';
}

/**
 * 用户确认接受协议之后调用：清掉待确认标记，重放最初的授权地址。
 * 这时 EULA 已被接受，Epic 会直接返回授权码，回调页的响应监听随即把会话写完。
 */
export async function resumeLoginAfterEula() {
  const job = loginJob;
  if (!job || job.closed) return { ok: false, error: '登录窗口已关闭，请重新点一次登录' };
  job.needEula = '';
  job.error = '';
  job.corrective = '';
  job.correctiveRetry += 1;
  await job.page.goto(job.url, { timeout: 25000 }).catch(() => {});
  return { ok: true };
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
  lastLoginError = job.error || '';
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
/**
 * 开一张页签把某个站跑一遍，等它自己种 cookie，再同步进 jar。
 *
 * 用途：Fab 的网页接口（/i/ 系列）只认 fab.com 自己的登录 cookie，而登录窗口跑的是
 * epicgames.com —— 把 fab.com 首页在同 profile 里打开一次，Epic SSO 会自动补上
 * fab_sessionid / fab_csrftoken，后面的入库与网页库下载就都复用它。
 */
export function warmCookies(url, host = '') {
  return watchPage(async page => {
    await page.goto(url, { timeout: 30000 }).catch(() => {});
    let synced = { added: 0, updated: 0, total: 0 };
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 900));
      synced = await syncCookies(page, { host }).catch(() => synced);
      if (synced?.added > 0) break;
    }
    return synced;
  }, { timeout: 45000 });
}

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
export function watchPage(handler, { timeout = 40000, sessionKey = '' } = {}) {
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
    const sessions=instance.personalPages??=new Map();
    let saved=sessionKey?sessions.get(sessionKey):null;
    if(saved){
      clearTimeout(saved.timer);
      try{await saved.tab.page.send('Runtime.evaluate',{expression:'true',returnByValue:true},2000);}
      catch{sessions.delete(sessionKey);await saved.tab.close().catch(()=>{});saved=null;}
    }
    const tab = saved?.tab || await openPageTarget(instance.port);
    let keep=false;
    try {
      const result=await handler(tab.page, instance);keep=!!sessionKey;return result;
    } finally {
      instance.lastUsed = Date.now();
      if(keep){
        const entry={tab,timer:setTimeout(()=>{
          if(sessions.get(sessionKey)!==entry)return;
          sessions.delete(sessionKey);void tab.close().catch(()=>{});
        },120000)};
        entry.timer.unref?.();sessions.set(sessionKey,entry);
      }else{if(sessionKey)sessions.delete(sessionKey);await tab.close().catch(() => {});}
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
