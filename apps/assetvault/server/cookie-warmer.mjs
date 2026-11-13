// 挑战 cookie 保活。
//
// 背景（2026-10-27 实测）：站酷的阿里云 WAF 发两种 cookie —— acw_tc 约 30 分钟、acw_sc__v2 约 60 分钟。
// 只要它们在，纯 HTTP 拉作品页是 508KB / 1.5s；一过期就立刻回 23KB 挑战页，解析只能退回浏览器渲染，
// 一次 15~20s。用户实际感受就是「同一个链接刚才 1 秒、现在 20 秒」。
//
// 这里干的事：只对「最近用过的站」在 cookie 到期前提前续一次（后台无头渲染 + 收割），
// 让 cookie 永远不会真正过期，从而把「渲染」彻底挪到用户看不见的地方。
//
// 三条约束：
//   1. 只续 WARM_TARGETS 里登记过的站 —— 不能因为某次解析就替任意域名开浏览器。
//   2. 只在最近 USE_WINDOW_MS 用过的站才续 —— 用户不开工就不烧 CPU。
//   3. 同一站不并发续（running 锁），渲染走 headless-dom 自己的串行队列。
import fs from 'node:fs';
import path from 'node:path';
import { cookieExpiresFor, browserProfileDir, mergeCookies, siteKey } from './cookie-jar.mjs';
import { renderDom, headlessAvailable } from './headless-dom.mjs';
import { launchBrowser, killBrowser } from './cdp.mjs';

/** 提前多久续（acw_tc 30 分钟寿命，留 6 分钟缓冲够跑一次 15s 渲染 + 收割）。
 *  调试时可改：SFX_WARM_LEAD_MIN=999 会让「刚拿到的 cookie 也立刻到期」，用来验证巡检真的会跑。 */
const LEAD_MS = (Number(process.env.SFX_WARM_LEAD_MIN) || 6) * 60 * 1000;
/** 多久没用过就不再续了。 */
const USE_WINDOW_MS = 45 * 60 * 1000;
/** 巡检间隔。 */
const TICK_MS = 60 * 1000;

/** 可续期的站：host → 用来「跑一次挑战」的地址。
 *  ⚠️ 别用站酷首页：`https://www.zcool.com.cn/` 在 `--dump-dom + virtual-time` 下永远不结束
 *  （实测 32s 超时、0 字节输出，首页有常驻轮询）。`/discover/1` 约 11.5s / 1.7MB，稳。 */
const WARM_TARGETS = Object.freeze({
  'www.zcool.com.cn': 'https://www.zcool.com.cn/discover/1',
  'zcool.com.cn': 'https://www.zcool.com.cn/discover/1',
});

const state = new Map();
const row = (host) => {
  if (!state.has(host)) state.set(host, { usedAt: 0, lastWarmAt: 0, lastWarmMs: 0, fails: 0, running: false, lastError: '' });
  return state.get(host);
};

/** 有解析用到这个站。冷站点不在这里立刻续 —— 当前这次请求自己会渲染并收割，续期留给巡检。 */
export function noteUse(host) {
  if (!WARM_TARGETS[host]) return;
  row(host).usedAt = Date.now();
}

/** 刚成功拿到过该站的页面（HTTP 快路径或渲染后收割）。用于刷新「还活着」的认知。 */
export function noteHarvest(host) {
  if (!WARM_TARGETS[host]) return;
  const s = row(host);
  s.usedAt = Date.now();
  s.fails = 0;
  s.lastError = '';
}

/** 该站下一次该续期的时间点（ms）。0 表示没有可用 cookie，需要马上续。 */
export function warmDueAt(host) {
  const expires = cookieExpiresFor(host);
  if (!expires) return Date.now();
  return expires - LEAD_MS;
}

export function warmStatus() {
  const now = Date.now();
  return {
    targets: Object.keys(WARM_TARGETS),
    leadMinutes: Math.round(LEAD_MS / 60000),
    state: [...state.entries()].map(([host, s]) => ({
      host,
      hasCookie: Boolean(cookieExpiresFor(host)),
      expiresAt: cookieExpiresFor(host) || 0,
      dueAt: warmDueAt(host),
      due: now >= warmDueAt(host),
      active: Boolean(s.usedAt) && now - s.usedAt < USE_WINDOW_MS,
      running: s.running,
      fails: s.fails,
      lastWarmAt: s.lastWarmAt,
      lastWarmMs: s.lastWarmMs,
      lastError: s.lastError,
    })),
  };
}

/** 真的续一次：用一个**全新的临时 profile** 去跑挑战，再把拿到的 cookie 并进仓库。
 *  为什么必须用干净 profile：cookie 还有效时，WAF 不会重新下发 acw_*，到期时间一点都不会变
 *  （实测续期后 expiresAt 一毫秒都没动）。只有「没带 cookie」的那次访问才会拿一套新的 30 分钟有效期。
 *  顺带的好处：不碰主 profile，不和正在跑的解析/登录抢 user-data-dir。 */
export async function warmHost(host) {
  const target = WARM_TARGETS[host];
  if (!target) return { ok: false, error: '这个站没有登记续期地址' };
  const s = row(host);
  if (s.running) return { ok: false, skipped: 'running' };
  if (!headlessAvailable()) {
    s.lastError = '本机没有可用的 Chrome / Edge';
    return { ok: false, error: s.lastError };
  }
  s.running = true;
  const t0 = Date.now();
  const before = cookieExpiresFor(host);
  const dir = path.join(path.dirname(browserProfileDir()), 'warm-profile');
  try {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 上次没清掉的残留 */ }
    const bust = `${target}${target.includes('?') ? '&' : '?'}_w=${Date.now()}`;
    const html = await renderDom(bust, { timeout: 34000, budget: 9000, profileDir: dir }).catch(() => '');
    if (!html) {
      s.fails += 1;
      s.lastError = '渲染没拿到页面';
      return { ok: false, error: s.lastError };
    }
    // dump-dom 是一次性进程，cookie 留在那个临时 profile 里，这里补一刀读出来。
    const b = await launchBrowser({ mode: 'headless', profileDir: dir, timeout: 20000 });
    let merged;
    try {
      const key = siteKey(host);
      const list = (await b.page.cookieHeader(null)).filter((c) => siteKey(c.domain) === key);
      merged = mergeCookies(list);
    } finally {
      await killBrowser(b.child, { grace: 1500 });
    }
    const expires = cookieExpiresFor(host);
    if (!expires) {
      s.fails += 1;
      s.lastError = '渲染完成但没收到 cookie';
      return { ok: false, error: s.lastError };
    }
    // 临时 profile 要是没清干净，浏览器会带着旧 cookie 访问、WAF 就不发新的 —— 到期时间一动不动。
    // 这种情况必须当失败报出来，否则「看起来续上了」但其实没续。
    if (before && expires <= before + 60000) {
      s.fails += 1;
      s.lastError = '这次没拿到新 cookie（临时 profile 可能没清干净）';
      return { ok: false, error: s.lastError, expiresAt: expires };
    }
    s.lastWarmAt = Date.now();
    s.lastWarmMs = s.lastWarmAt - t0;
    s.fails = 0;
    s.lastError = '';
    s.usedAt = s.usedAt || Date.now();
    return { ok: true, ms: s.lastWarmMs, expiresAt: expires, cookies: merged?.total || 0 };
  } finally {
    s.running = false;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 占着就留给下次 */ }
  }
}

/** 巡检：只处理「最近用过 + 已到期」的站，串行执行，一次最多一个渲染。 */
async function tick() {
  const now = Date.now();
  for (const [host, s] of state.entries()) {
    if (!s.usedAt || now - s.usedAt > USE_WINDOW_MS) continue;
    if (s.running) continue;
    if (now < warmDueAt(host)) continue;
    await warmHost(host);
  }
}

const timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
timer.unref?.();
