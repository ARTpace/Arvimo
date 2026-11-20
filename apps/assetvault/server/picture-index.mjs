// 图站清单的「窗口」缓存：一块画板只解析一次，之后每一屏都只是切片。
//
// 为什么需要它：图站解析天生是「一次翻完整个列表」的模式 —— 花瓣一块 1923 张的画板要翻
// 二十页 API。前端滚动加载的语义是「limit 从 60 加到 120 再来一次」，如果服务端每次照做，
// 第二次请求就从第一页重翻，第二屏比第一屏慢、第三屏更慢，用户看到的就是
// 「滑了半天只多出几十张」。
//
// 这里把它改成一份清单 + 多个窗口：
//   · 支持进度的 HTTP 图站只抓一轮，每页并入缓存，首屏够用立即返回；
//   · 其他站保留首屏 + 后台全量两段回退流程；
//   · 这份清单在后台继续翻到底（独立 AbortSignal —— 请求返回后连接就断了，
//     不能拿它当后台任务的生命周期，否则翻到一半被杀，清单永远长不大）；
//   · 之后的每一屏都是对同一个数组切片，毫秒级返回，并且能给出真实总量（「共 1923 张」）。
//
// 清单 30 分钟过期，超过 MAX_ITEMS 张就不再往后记 —— 再大的画板也不至于把进程内存吃光。

const TTL_MS = 30 * 60 * 1000;
const MAX_ITEMS = 6000;
const MAX_ENTRIES = 12;
// 首屏至少解析这么多：比前端一屏（60）多留一点余量，滚动时不必为了下一屏再等一轮。
const FIRST_BATCH = 72;
// 后续窗口等后台翻页的上限。超过就先把已有的给出去，剩下的下次再看 ——
// 让用户干等 30 秒不如先看已经翻到的。
const WAIT_MS = 20000;
// 后台全量解析的时间上限：一页 API 几百毫秒，1923 张约 20 次请求，5 分钟足够；
// 站点抽风时也不能一直挂着占着并发。
const FILL_TIMEOUT_MS = 5 * 60 * 1000;

const entries = new Map();
const personalList=(platform,url)=>platform==='xiaohongshu'&&/\/(?:user\/(?:likes|following)|explore)(?:[/?#]|$)/.test(url)&&! /\/explore\/[a-f0-9]{24}/i.test(url);
const sizeOf=entry=>entry.mode==='boards'?entry.boards.length:entry.items.length;

const keyOf = (platform, url) => `${platform}|${url}`;

// 只搬运「这一批图共有的信息」，不搬 items / boards / truncated ——
// 那三个跟着窗口走，把某一批的截断标记存进清单，翻到底之后还会残留成「还有更多」。
const META_KEYS = ['title', 'author', 'authorUrl', 'cover', 'source', 'platform', 'client', 'label', 'rendition', 'tags', 'user', 'assetType', 'albums', 'boardId', 'collectionPlatform', 'collectionLabel', 'collectionOps', 'collectionHomeUrl', 'collectionCollectUrl', 'collectionCollectDetect','personalPaging','order'];
const metaOf = plan => {
  const meta = {};
  for (const key of META_KEYS) {
    const value = plan?.[key];
    if (value !== undefined && value !== null && value !== '') meta[key] = value;
  }
  return meta;
};

function touch(key, entry) {
  entry.usedAt = Date.now();
  // Map 的迭代顺序就是插入顺序：删了再塞，等于把它挪到「最近使用」那一端。
  entries.delete(key);
  entries.set(key, entry);
}

function evict() {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (now - entry.usedAt > TTL_MS) {
      entry.controller?.abort();
      entries.delete(key);
    }
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.get(oldest)?.controller?.abort();
    entries.delete(oldest);
  }
}

/** 把新解析到的一批并进清单：按图片地址去重，顺序保持「先解析到的在前」。 */
function merge(entry, plan) {
  if (!plan) return;
  if (plan.mode === 'boards') {
    entry.mode = 'boards';
    if (Array.isArray(plan.boards)) entry.boards = plan.boards;
  }
  const items = Array.isArray(plan.items) ? plan.items : [];
  if(plan.order==='liked-desc'){
    const ordered=new Map();
    for(const item of [...items,...entry.items])if(item?.url&&!ordered.has(item.key||item.url))ordered.set(item.key||item.url,item);
    entry.items=[...ordered.values()].slice(0,MAX_ITEMS);entry.seen=new Set(entry.items.map(item=>item.key||item.url));
  }
  if (items.length) {
    for (const item of items) {
      if (entry.items.length >= MAX_ITEMS) break;
      const key=plan.personalPaging?item.key||item.url:item.url;
      if (!item?.url || entry.seen.has(key)) continue;
      entry.seen.add(key);
      entry.items.push(item);
    }
  }
  entry.meta = { ...entry.meta, ...metaOf(plan) };
  const skipped = Array.isArray(plan.skipped) ? plan.skipped.length : 0;
  if (skipped > entry.skipped) entry.skipped = skipped;
}

/** 后台把整块画板翻完。永不 reject：失败只记在 entry.error，调用方按「有没有货」决定报不报错。 */
async function fill(entry, platform, url, limit, { collect, open, progressive }) {
  entry.error = null;
  entry.controller = new AbortController();
  const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(FILL_TIMEOUT_MS)]);
  try {
    if (progressive) {
      const full = await collect(platform, {url}, {open, signal, maxItems: MAX_ITEMS, onProgress: plan => merge(entry, plan)});
      merge(entry, full);
      entry.complete = true;
      return;
    }
    const first = await collect(platform, { url }, { open, signal, maxItems: Math.max(limit, platform === 'xiaohongshu' ? 24 : FIRST_BATCH) });
    merge(entry, first);
    // Personal browser lists continue on demand; don't monopolize the shared login browser
    // crawling thousands of users before the viewer requests the next window.
    if(personalList(platform,url)){
      entry.complete=first?.truncated!==true;entry.error=first?.warning||null;return;
    }
    // 第一批就到底了（单页 HTML 站、小画板、关键词搜索翻不动）：不必再翻一遍。
    if (first?.truncated !== true) {
      entry.complete = true;
      return;
    }
    const full = await collect(platform, { url }, { open, signal, maxItems: MAX_ITEMS });
    merge(entry, full);
    entry.complete = true;
  } catch (error) {
    entry.error = error?.message || String(error);
  } finally {
    entry.promise = null;
  }
}

/** 等清单长到 limit 张（或后台翻完 / 超时）。轮询而不是 await promise：
 *  后台任务是「先给一屏、再慢慢翻到底」两段，await 整轮会连首屏一起等 ——
 *  首屏解析完就该返回，不能陪它把二十页 API 翻完。 */
async function waitEnough(entry, limit, signal) {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  while (!entry.complete && entry.promise && sizeOf(entry) < limit) {
    // 一张都没有时不能按 20 秒交卷：小红书笔记要等浏览器渲染完才一次性给图，
    // 提前返回空列表，前端会当成「这篇没有图片」并且预览打不开。
    const cap = sizeOf(entry) ? WAIT_MS : 90000;
    if (Date.now() - startedAt >= cap) break;
    await new Promise(resolve => setTimeout(resolve, 30));
    signal?.throwIfAborted();
  }
}

function viewOf(entry, limit) {
  const items = entry.items.slice(0, limit);
  const complete = entry.complete;
  return {
    ...entry.meta,
    mode: entry.mode,
    items,
    boards: entry.mode === 'boards' ? entry.meta.personalPaging?entry.boards.slice(0,limit):entry.boards : [],
    skipped: [],
    // total 只在清单翻完之后才给：中途把「已翻到的张数」当总数报出去，
    // 卡片上就会写着「共 96 张」，而实际有 1923 张 —— 宁可不写，也不写错。
    total: complete ? sizeOf(entry) : 0,
    truncated: complete ? sizeOf(entry) > limit : true,
    complete,
    warning: entry.error || '',
  };
}

/**
 * 取第 limit 张之前的那一屏。
 * collect(platform, {url}, {open, signal, maxItems}) 由调用方注入（图站 / ArtStation 各一套）。
 */
export async function pictureWindow(platform, url, limit, { collect, open, progressive = false, signal } = {}) {
  const key = keyOf(platform, url);
  let entry = entries.get(key);
  if (entry && Date.now() - entry.usedAt > TTL_MS) {
    entry.controller?.abort();
    entries.delete(key);
    entry = null;
  }
  if (!entry) {
    entry = { items: [], seen: new Set(), boards: [], mode: 'images', meta: {}, skipped: 0, complete: false, error: null, promise: null, usedAt: Date.now(), waiters: 0, served: false };
    entries.set(key, entry);
    evict();
  }
  signal?.throwIfAborted();
  touch(key, entry);
  if (!entry.promise && !entry.complete && (!personalList(platform,url)||sizeOf(entry)<limit)) {
    entry.promise = fill(entry, platform, url, limit, { collect, open, progressive });
  }
  entry.waiters++;
  try {
    await waitEnough(entry, limit, signal);
    entry.served = true;
  } finally {
    entry.waiters--;
    // A disconnected first viewer must not leave an unobserved full crawl running.
    if (signal?.aborted && !entry.waiters && !entry.served) {
      entry.controller?.abort();
      if (entries.get(key) === entry) entries.delete(key);
    }
  }
  // 一张都没翻到：这才是真失败（站点拦截 / 需要登录 / 链接不对）。已经翻到过内容的，
  // 后续某一轮失败不该把已有画面清空 —— 前端拿到的是完整的旧清单 + 少一屏新图。
  if (!entry.items.length && !entry.boards.length && entry.error) throw new Error(entry.error);
  return viewOf(entry, limit);
}

/** 测试与「刷新」用：丢掉某块画板的清单。 */
export function forgetPictureIndex(platform, url) {
  entries.get(keyOf(platform, url))?.controller?.abort();
  entries.delete(keyOf(platform, url));
}

/** 测试用：当前缓存了几块画板。 */
export function pictureIndexStats() {
  return { entries: entries.size, items: [...entries.values()].map(entry => entry.items.length) };
}
