// Pinterest 图站解析适配器：把 AssetVault 的图站 resolve 请求转发给 pin-grabber。
//
// pin-grabber 是「fire-and-forget + 全局 STATE」模型：/api/collect 触发后台采集，结果留在
// /api/status 的 STATE.images 里。本适配器做三件事：① 触发采集（mode=keyword|link）② 轮询
// /api/status 直到 state 变 preview/ok/err ③ 把 STATE.images 映射成 AV 的 items 形状。
//
// 单飞串行：pin-grabber 全局只有一个 STATE，一次只能跑一个任务。用 chain 把并发 resolve /
// related 排成队列，每个任务在 fn 内读走 images 快照后才放行下一个，避免 STATE 被覆盖。
import { ensurePinGrabber, PIN_GRABBER_URL } from './pinterest-launcher.mjs';
import { tagList } from './tag-list.mjs';

const COLLECT_TIMEOUT = 90_000;
const STATUS_POLL_INTERVAL = 250;
const COLLECT_RPC_TIMEOUT = 12_000;
// pin-grabber 单次上限。关键词一页就能拿满；链接预览按调用方要的张数截断，下载再要全量。
const KEYWORD_CAP = 80;
const LINK_CAP = 250;

let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.catch(() => {}).then(task);
  chain = run.then(() => {}, () => {});
  return run;
}

async function getStatus() {
  try {
    const r = await fetch(`${PIN_GRABBER_URL}/api/status`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function postCollect(body) {
  const r = await fetch(`${PIN_GRABBER_URL}/api/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(COLLECT_RPC_TIMEOUT),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || '启动 Pinterest 采集失败');
}

async function waitForDone(signal, onPartial) {
  const deadline = Date.now() + COLLECT_TIMEOUT;
  let seen = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const st = await getStatus();
    if (!st) throw new Error('无法连接到 Pinterest 抓取服务（pin-grabber 未运行）');
    if (st.state === 'err') throw new Error(st.error || 'Pinterest 采集出错');
    const got = Array.isArray(st.images) ? st.images.length : 0;
    // 采集还在跑时，每多一页就交出去。调用方可以先把首屏返回，不必等后面几页。
    if (onPartial && got > seen) {
      seen = got;
      onPartial(st);
    }
    if (st.state === 'preview' || st.state === 'ok') return st;
    await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL));
  }
  throw new Error('Pinterest 采集超时（可能触发反爬，稍后重试）');
}

/** 把 pin-grabber 的 STATE.images 映射成 AV 图站 items 形状。 */
// 已采集结果缓存：预览触发一次 collect（全量），下载整站（maxItems=Infinity）时直接复用，
// 不再重新排队等 90 秒。key 含 mode+text，期间用户搜别的不会串。
const pinCache = new Map();
const pinCacheKey = (mode, text) => `${mode}:${text}`;

function toItems(images) {
  return (images || [])
    .map((im) => {
      const title = String(im.title || '');
      const desc = String(im.description || '');
      const board = String(im.board || '');
      // Pinterest 没有 tags 接口，但 pin 资源里的「分类 / 关联信息」能当标签：
      //   · board 名      —— 画板分类（Interior Ideas / 食谱 …），最像分类
      //   · 描述里的 #话题 —— 作者显式打的标签
      // 整句标题 / 描述不按词拆开（避免把一句话拆成几十个噪声标签），只取显式 #话题。
      const hashtags = `${title} ${desc}`.match(/(?:^|\s)#([^\s#@]+)/g) || [];
      const tags = tagList([board, ...hashtags.map((t) => t.trim().replace(/^#/, ''))].filter(Boolean));
      const username = String(im.username || '');
      const author = String(im.author || username);
      return {
        url: im.orig || im.preview,
        title: title || board || '',
        width: Number(im.w) || 0,
        height: Number(im.h) || 0,
        pid: im.pid || null,
        tags,
        author,
        // 作者主页走现成的画板列表：点卡片上的名字会打开这个人的公开画板。
        authorUrl: /^[\w.-]+$/.test(username) ? `https://www.pinterest.com/${username}/` : '',
      };
    })
    .filter((i) => i.url);
}

/**
 * 图站入口：text 是关键词或 Pinterest 链接。
 * - 以 http(s):// 开头 → mode=link（pin-grabber 自动识别画板 / 作者 / 搜索页 / 直链）
 * - 否则 → mode=keyword（Pinterest 关键词搜索）
 */
export async function resolvePinterest({ url }, { signal, maxItems = Infinity, onProgress } = {}) {
  const text = String(url || '').trim();
  if (!text) throw new Error('请输入 Pinterest 关键词或粘贴链接');
  const isUrl = /^https?:\/\//i.test(text);
  const mode = isUrl ? 'link' : 'keyword';
  // 主页和已保存页先列画板；单画板、已创建页和搜索仍走图片采集。
  const profile = isUrl ? new URL(text) : null;
  const segments = profile?.pathname.split('/').filter(Boolean) || [];
  const reserved = new Set(['pin', 'search', 'ideas', 'today', 'explore', 'settings', 'business', 'categories']);
  if (profile && /(^|\.)pinterest\.com$/i.test(profile.hostname) && segments.length &&
      !reserved.has(segments[0].toLowerCase()) &&
      (segments.length === 1 || (segments.length === 2 && ['_saved', 'boards'].includes(segments[1])))) {
    await ensurePinGrabber();
    signal?.throwIfAborted();
    const response = await fetch(`${PIN_GRABBER_URL}/api/boards?username=${encodeURIComponent(segments[0])}`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(COLLECT_TIMEOUT)]) : AbortSignal.timeout(COLLECT_TIMEOUT),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !Array.isArray(data.boards)) {
      throw new Error(data.error || 'Pinterest 画板接口不可用，请重启 pin-grabber 服务后重试');
    }
    return { mode: 'boards', boards: data.boards, items: [], skipped: [], title: data.author || segments[0],
      author: data.author || segments[0], source: text, cover: data.boards[0]?.cover || null, rendition: 'original' };
  }
  const key = pinCacheKey(mode, text);
  const cap = mode === 'keyword' ? KEYWORD_CAP : LINK_CAP;
  const preview = Number.isFinite(maxItems) && maxItems > 0;
  // 下载全量（maxItems=Infinity）优先复用已采集结果，避免重复触发 90s 采集。
  // 预览缓存张数不够时不能拿来当全量，否则下载会被截成首屏。
  const cached = pinCache.get(key);
  if (maxItems === Infinity && cached && cached.items.length >= cap) return cached;
  // 首屏窗口要 72 张，和关键词上限 80 差一页。直接要满 80，一次请求就够，索引不会再补抓一轮。
  let count = preview ? Math.max(1, Math.min(cap, maxItems)) : cap;
  if (mode === 'keyword' && preview && cap - count <= 30) count = cap;
  await ensurePinGrabber();
  const state = await enqueue(async () => {
    signal?.throwIfAborted();
    await postCollect({ mode, text, count });
    return waitForDone(signal, onProgress && ((st) => {
      const items = toItems(st.images);
      if (!items.length) return;
      onProgress({
        items,
        title: isUrl ? 'Pinterest 图站' : `Pinterest · ${text}`,
        author: 'Pinterest',
        cover: items[0].url,
      });
    }));
  });
  const items = toItems(state.images);
  if (!items.length) throw new Error('Pinterest 没有返回任何图片（链接无效或触发反爬，见 pin-grabber 日志）');
  const result = {
    items,
    skipped: [],
    title: isUrl ? 'Pinterest 图站' : `Pinterest · ${text}`,
    author: 'Pinterest',
    cover: items[0]?.url || null,
    source: text,
    rendition: 'original',
    platform: 'pinterest',
    client: 'pinterest',
    label: 'Pinterest',
    total: items.length,
    // 只对关键词标记截断。画板采集不看 count，标了截断会把整块画板再爬一遍。
    truncated: mode === 'keyword' && preview && items.length >= count && count < cap,
  };
  if (!preview || items.length >= cap) pinCache.set(key, result);
  return result;
}

/**
 * 相似推荐（pin-grabber 独有 /api/related）：把选中的 pin id 列表丢给 pin-grabber，
 * 它从 STATE.images 里取原图、采「更多类似图案」推荐流并追加进 STATE.images。返回新增的 items。
 * 需要 STATE.images 已有内容（即用户先做过一次搜索），否则 pin-grabber 会拒绝。
 */
export async function relatedPinterest(pinIds, count = 24) {
  const ids = (pinIds || []).filter(Boolean);
  if (!ids.length) throw new Error('没有选中任何图片');
  await ensurePinGrabber();
  return enqueue(async () => {
    const base = (await getStatus())?.images || [];
    const r = await fetch(`${PIN_GRABBER_URL}/api/related`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin_ids: ids, count }),
      signal: AbortSignal.timeout(COLLECT_RPC_TIMEOUT),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.error || '相似推荐失败');
    const final = await waitForDone();
    const seen = new Set(base.map((b) => b.orig || b.preview));
    return toItems(final.images).filter((i) => !seen.has(i.url));
  });
}
