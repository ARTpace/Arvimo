// 小红书「浏览器通道」：让页面自己去请求，我们从旁边读。
//
// 为什么必须有这一条：
//   2026-11-09 实测 web build 6.61.3 —— 搜索页、推荐流、笔记详情**全部改成客户端渲染**，
//   SSR 里连 `window.__INITIAL_STATE__` 都不给了（笔记详情页实测 hasState:false）；而那批 JSON
//   必须带 `x-s` 签名，纯 HTTP 直接调会被判 `300011 当前账号存在异常`。
//
// 解法不是去逆向签名，而是**借浏览器**：登录窗口和这里共用同一个 profile（同一份登录态），
// 页面在浏览器里会自己算签名、发请求、把结果写回它自己的响应式 store。于是我们有了三档取材，
// 按可靠性排序，前两档拿不到才退下一档：
//   1. **hydration 后的页面状态**（最可靠）：`search.feeds` / `feed.feeds` / `note.noteDetailMap`
//      —— 实测搜索页 44 条、explore 31 条，字段齐全（标题/作者/封面/尺寸）；
//   2. **页面发出的接口响应体**（补充）：能拿到 `xsec_token`（详情页 URL 要用它），但大页面下
//      响应体会被浏览器回收，所以只当增强、不当主力；
//   3. **渲染后的 DOM 卡片**（兜底）：状态形状哪天再变，DOM 上至少有标题和封面。
//
// 页面状态里的对象带 Vue 的响应式包装、还可能有循环引用（直接 JSON.stringify 会整段失败），
// 所以取状态的是**页面内的一段小程序**：自己解包、只挑我们解析器认得的字段、压成扁平 JSON 再吐出来。
// 这样既躲开循环引用，也只传几百字节回来。
import { watchPage } from './browser-session.mjs';
import { parseXhsApiItems, parseXhsDomCards, parseXhsFeed, parseXhsUser, parseXhsNote } from './xhs-state.mjs';

const HIT_CAP = 3;
const CARD_WAIT_MS = 15000;
const POLL_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cachedUserId = '';
let boardCache = { at: 0, userId: '', boards: null };

/** 页面已经在小红书并且脚本就绪时不再整页重载。重载会一直等图片，收藏页会因此卡很久。 */
async function pageReady(page) {
  const ready = async () => {
    const probe = await page.send('Runtime.evaluate', {
      expression: '!!(location.hostname.endsWith("xiaohongshu.com") && window.webpackChunkxhs_pc_web)',
      returnByValue: true,
    }, 4000).catch(() => null);
    return !!probe?.result?.value;
  };
  if (await ready()) return;
  await page.send('Page.navigate', { url: 'https://www.xiaohongshu.com/explore' }, 8000).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (await ready()) return;
    await sleep(200);
  }
  throw new Error('小红书页面没有准备好。点「登录」后再试。');
}

/**
 * 页面内取状态（会被 toString() 后 Runtime.evaluate，所以不能用外部变量）。
 * 三件事：解 Vue 包装、按 kind 挑出要的那份、压成解析器认得的扁平形状。
 * 返回 JSON 字符串；取不到就 `{"ok":false}`。
 */
const readState = function (kind, id) {
  const unwrap = (value) => {
    let node = value;
    let guard = 0;
    while (node && !Array.isArray(node) && typeof node === 'object' && ('_rawValue' in node || '_value' in node) && guard++ < 6) {
      node = node._rawValue !== undefined ? node._rawValue : node._value;
    }
    return node;
  };
  const list = (...candidates) => {
    for (const candidate of candidates) {
      const value = unwrap(candidate);
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') {
        for (const key of ['list', 'feeds', 'items', 'data', 'notes']) {
          const inner = unwrap(value[key]);
          if (Array.isArray(inner)) return inner;
        }
      }
    }
    return [];
  };
  const imageOut = (node) => {
    const value = unwrap(node) || {};
    const info = unwrap(value.infoList) || unwrap(value.info_list);
    return {
      width: value.width || 0,
      height: value.height || 0,
      urlDefault: value.urlDefault || value.url_default || '',
      urlPre: value.urlPre || value.url_pre || '',
      url: value.url || '',
      infoList: (Array.isArray(info) ? info : []).map((item) => ({
        imageScene: unwrap(item)?.imageScene || '',
        url: unwrap(item)?.url || '',
      })),
    };
  };
  const cardOut = (item) => {
    const tupleId = Array.isArray(item) && typeof item[0] === 'string' ? item[0] : '';
    const raw = unwrap(Array.isArray(item) ? item[1] : item) || {};
    const card = unwrap(raw.noteCard) || unwrap(raw.note_card) || raw;
    const user = unwrap(card.user) || {};
    return {
      id: tupleId || card.noteId || card.id || raw.id || raw.noteId || '',
      noteCard: {
        noteId: card.noteId || card.id || raw.noteId || raw.id || '',
        displayTitle: card.displayTitle || card.title || '',
        type: card.type || '',
        xsecToken: card.xsecToken || raw.xsecToken || raw.xsec_token || '',
        user: { nickname: user.nickname || user.nickName || '', userId: user.userId || '', xsecToken: user.xsecToken || '' },
        cover: imageOut(card.cover || card.image),
        interactInfo: { likedCount: (unwrap(card.interactInfo) || {}).likedCount || '' },
      },
    };
  };
  try {
    const state = window.__INITIAL_STATE__;
    if (!state) return JSON.stringify({ ok: false, why: 'no-state' });
    if (kind === 'note') {
      const map = unwrap(unwrap(state.note)?.noteDetailMap) || {};
      const entry = unwrap(map[id]) || unwrap(map[unwrap(unwrap(state.note)?.currentNoteId)]) || null;
      const note = unwrap(entry?.note) || unwrap(entry?.noteData) || unwrap(entry);
      if (!note || !note.noteId) return JSON.stringify({ ok: false, why: 'no-note' });
      const video = unwrap(unwrap(unwrap(note.video)?.media)?.stream?.h264);
      return JSON.stringify({ ok: true, payload: { note: { noteDetailMap: { [note.noteId]: { note: {
        noteId: note.noteId,
        title: note.title || '',
        desc: note.desc || '',
        user: (() => { const u = unwrap(note.user) || {}; return { nickname: u.nickname || u.nickName || '', userId: u.userId || '' }; })(),
        imageList: (unwrap(note.imageList) || []).map(imageOut),
        tagList: (unwrap(note.tagList) || []).map((tag) => ({ name: unwrap(tag)?.name || '' })),
        video: video ? { media: { stream: { h264: (Array.isArray(video) ? video : []).map((item) => ({ masterUrl: unwrap(item)?.masterUrl || '' })) } } } : null,
      } } } } } });
    }
    if (kind === 'collect' || kind === 'profile') {
      const user = unwrap(state.user) || {};
      const basic = unwrap(unwrap(user.userPageData)?.basicInfo) || unwrap(user.basicInfo) || {};
      // `user.notes` 是按 tab 分的二维数组（[29,0,0,0,0]）：元素都是数组、且首项不是字符串 id
      // （元组卡片 `[id, card]` 的首项才是字符串）时，拍平一层。
      let notes = list(user.notes, user.noteList, unwrap(user.userPageData)?.notes);
      const tabbed = notes.length && notes.every((entry) => Array.isArray(unwrap(entry)) && typeof unwrap(entry)[0] !== 'string');
      if (kind === 'collect') notes = tabbed ? (unwrap(notes[1]) || []) : [];
      else if (tabbed) notes = notes.flat();
      const cards = notes.map(cardOut).filter((card) => card.noteCard.noteId || card.id);
      return JSON.stringify({ ok: kind === 'collect' ? cards.length > 0 : true, payload: {
        user: { basicInfo: { nickname: basic.nickname || basic.nickName || '', userId: basic.userId || '' }, notes: cards },
      } });
    }
    // 搜索页与 explore：两张卡表先试，谁有数据用谁。
    const search = list(unwrap(state.search)?.feeds, unwrap(state.search)?.searchFeedsWrapper);
    const feed = list(unwrap(state.feed)?.feeds);
    const cards = search.length ? search : feed;
    if (!cards.length) return JSON.stringify({ ok: false, why: 'no-feeds' });
    return JSON.stringify({ ok: true, payload: { feed: { feeds: cards.map(cardOut) } } });
  } catch (error) {
    return JSON.stringify({ ok: false, why: String(error && error.message || error).slice(0, 120) });
  }
};

/** DOM 兜底：只认笔记卡片锚点，够撑住"至少有标题和封面"。 */
const readCards = function (limit) {
  const out = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll('a[href*="/explore/"]')) {
    const href = anchor.getAttribute('href') || '';
    const id = (href.match(/explore\/([0-9a-f]{16,32})/i) || [])[1] || '';
    if (!id || seen.has(id)) continue;
    const box = anchor.closest('section') || anchor.parentElement || anchor;
    const img = box.querySelector('img[src*="xhscdn.com"]') || anchor.querySelector('img');
    const titleNode = box.querySelector('[class*=title], .title');
    const nameNode = box.querySelector('[class*=author] [class*=name], [class*=user] [class*=name]');
    seen.add(id);
    out.push({
      id,
      src: img ? (img.currentSrc || img.getAttribute('src') || '') : '',
      title: titleNode ? String(titleNode.textContent || '').trim() : String(img?.getAttribute('alt') || '').trim(),
      author: nameNode ? String(nameNode.textContent || '').trim() : '',
    });
    if (out.length >= limit) break;
  }
  return JSON.stringify(out);
};

async function evaluate(page, expression, label) {
  try {
    const r = await page.send('Runtime.evaluate', { expression, returnByValue: true }, 25000);
    return JSON.parse(String(r?.result?.value ?? 'null'));
  } catch {
    // 表达式在页面里抛错 / 返回不能序列化的东西：当作"取不到"，交给下一档。
    return null;
  }
}

async function readBody(page, requestId, attempt = 0) {
  try {
    const body = await page.send('Network.getResponseBody', { requestId }, 15000);
    const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
    return JSON.parse(text);
  } catch {
    if (attempt === 0) { await sleep(350); return readBody(page, requestId, 1); }
    return null;
  }
}

/**
 * 打开一个页面，把「状态 / 接口体 / DOM」三档素材一次带回，并按可靠性归一成笔记卡片。
 *
 * @param {{url:string, kind?:'list'|'profile'|'home'|'note', noteId?:string, apiMatch?:RegExp, cardLimit?:number, waitMs?:number}} options
 * @returns {Promise<{notes:object[], note:object|null, source:'state'|'api'|'dom', payload:object|null}>}
 */
export async function xhsBrowserCapture({ url, kind = 'list', noteId = '', apiMatch = /\/api\/sns\/web\//, cardLimit = 60, waitMs = CARD_WAIT_MS } = {}) {
  if (!url) throw new Error('缺少要打开的小红书地址');
  return watchPage(async (page) => {
    const hits = [];
    const off = page.on('Network.responseReceived', (p) => {
      const target = String(p?.response?.url || '');
      if (!apiMatch.test(target)) return;
      const clean = target.replace(/\?.*/, '');
      if (hits.some((hit) => hit.url === clean)) return;
      hits.push({ requestId: p.requestId, url: clean });
    });
    try {
      // 笔记详情不等 load、也不等「网络安静 3 秒」。小红书会一直拉图，安静条件往往要拖到超时；
      // 状态里的 imageList 一出现就可以收工。列表页仍走原来的安静等待。
      const fast = kind === 'note';
      if (kind === 'collect') {
        let userId = cachedUserId;
        if (!userId) {
          await pageReady(page);
          const me = await evaluate(page, `(() => {
            const unwrap = (v) => v && typeof v === 'object' && ('_value' in v || '_rawValue' in v) ? unwrap(v._value ?? v._rawValue) : v;
            const user = unwrap(window.__INITIAL_STATE__?.user) || {};
            const info = unwrap(user.userInfo) || unwrap(unwrap(user.userPageData)?.basicInfo) || {};
            return JSON.stringify({ userId: info.userId || info.user_id || '' });
          })()`, 'me');
          userId = me?.userId || '';
          if (userId) cachedUserId = userId;
        }
        if (!userId) return { notes: [], note: null, source: 'none', payload: { login: true } };
        await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`, { timeout: 20000, waitForQuiet: 0 });
        await evaluate(page, `(() => {
          const tab = [...document.querySelectorAll('div,span,a,button')].find((node) => node.childElementCount === 0 && String(node.textContent || '').trim() === '收藏');
          if (tab) tab.click();
          return '1';
        })()`, 'fav-tab');
      } else if (fast) page.send('Page.navigate', { url }, 15000).catch(() => {});
      else await page.goto(url, { timeout: 35000, waitForQuiet: 3000 });
      const deadline = Date.now() + (fast ? Math.min(waitMs, 12000) : waitMs);
      let state = null;
      // 状态是客户端渲染后才写进去的：轮询到有数据为止（笔记详情与列表页都在这一档）。
      while (Date.now() < deadline) {
        state = await evaluate(page, `(${readState.toString()})(${JSON.stringify(kind)},${JSON.stringify(noteId)})`, 'state');
        if (state?.ok) break;
        await sleep(fast ? 200 : POLL_MS);
      }
      // 接口体当作增强（token 只在它那里），但响应体可能已被回收，取不到就算了。
      // 笔记已经从页面状态拿到图，就不必再把接口体读回来。
      const payloads = [];
      if (!(fast && state?.ok)) {
        for (const hit of hits.slice(0, HIT_CAP)) {
          const data = await readBody(page, hit.requestId);
          if (data?.data || data?.items) payloads.push(data);
        }
      }

      if (kind === 'note') {
        const note = state?.ok ? parseXhsNote(state.payload, noteId) : null;
        if (!note || !note.images.length) {
          const raw = await evaluate(page, `(${readCards.toString()})(1)`, 'dom');
          const fallback = Array.isArray(raw) ? parseXhsDomCards(raw) : [];
          if (fallback.length) {
            return { notes: fallback, note: null, source: 'dom', payload: null };
          }
        }
        return { notes: [], note, source: note ? 'state' : 'none', payload: state?.payload || null };
      }

      const fromState = Array.isArray(state?.payload?.feed?.feeds) && state.payload.feed.feeds.length
        ? parseXhsFeed(state.payload).feeds
        : [];
      const fromProfile = Array.isArray(state?.payload?.user?.notes) && state.payload.user.notes.length
        ? parseXhsUser(state.payload).notes
        : [];
      const profile = state?.payload?.user ? parseXhsUser(state.payload) : null;
      const fromApi = payloads.flatMap((payload) => parseXhsApiItems(payload));
      const fromDom = async () => {
        const raw = await evaluate(page, `(${readCards.toString()})(${cardLimit})`, 'dom');
        return Array.isArray(raw) ? parseXhsDomCards(raw) : [];
      };
      let notes = fromProfile.length ? fromProfile : fromState;
      let source = fromProfile.length ? 'state' : (fromState.length ? 'state' : 'none');
      if (!notes.length && fromApi.length) { notes = fromApi; source = 'api'; }
      if (!notes.length) {
        notes = await fromDom();
        if (notes.length) source = 'dom';
      }
      // token / 作者 id 富化：状态那份不一定带（token 只在接口那份里），按笔记 id 补上。
      if (notes.length && fromApi.length) {
        const extra = new Map(fromApi.map((item) => [item.noteId, item]));
        notes = notes.map((item) => {
          const hit = extra.get(item.noteId);
          if (!hit) return item;
          return { ...item, xsecToken: item.xsecToken || hit.xsecToken, authorId: item.authorId || hit.authorId };
        });
      }
      return { notes, note: null, source, payload: state?.payload || null, profile };
    } finally {
      off();
    }
  });
}

export function xhsMe() {
  if (cachedUserId) return Promise.resolve(cachedUserId);
  return watchPage(async (page) => {
    await pageReady(page);
    const result = await page.send('Runtime.evaluate', {
      expression: `(() => {
        const unwrap = (v) => v && typeof v === 'object' && ('_value' in v || '_rawValue' in v) ? unwrap(v._value ?? v._rawValue) : v;
        const info = unwrap(unwrap(window.__INITIAL_STATE__?.user)?.userInfo) || {};
        return JSON.stringify({ userId: info.userId || info.user_id || '' });
      })()`,
      returnByValue: true,
    }, 15000);
    const parsed = JSON.parse(result?.result?.value || '{}');
    if (!parsed.userId) throw new Error('没有读到当前登录的小红书账号。先点「登录」。');
    cachedUserId = parsed.userId;
    return parsed.userId;
  }, { timeout: 20000 });
}

/** 当前账号的专辑。短时间重复打开收藏页直接用上次结果。 */
export function xhsBoards() {
  if (boardCache.boards && Date.now() - boardCache.at < 45000) return Promise.resolve(boardCache);
  return watchPage(async (page) => {
    await pageReady(page);
    const result = await page.send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const unwrap = (v) => v && typeof v === 'object' && ('_value' in v || '_rawValue' in v) ? unwrap(v._value ?? v._rawValue) : v;
          const info = unwrap(unwrap(window.__INITIAL_STATE__?.user)?.userInfo) || {};
          const userId = ${JSON.stringify(cachedUserId)} || info.userId || info.user_id || '';
          if (!userId) return JSON.stringify({ error: '没有读到当前登录的小红书账号。先点「登录」。' });
          const chunk = window.webpackChunkxhs_pc_web;
          let req;
          chunk.push([[Date.now()], {}, (r) => { req = r; }]);
          const id = Object.keys(req.m).find((key) => String(req.m[key]).includes('web查询用户的专辑'));
          const exp = req(id);
          const fn = Object.entries(exp).find(([, item]) => typeof item === 'function' && String(item).includes('web查询用户的专辑'));
          const data = await fn[1]({ params: { user_id: userId, page: 1, num: 30 } });
          return JSON.stringify({ userId, data });
        } catch (error) {
          return JSON.stringify({ error: String(error && (error.msg || error.message) || error).slice(0, 180) });
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }, 15000);
    const parsed = JSON.parse(result?.result?.value || '{"error":"小红书没有返回结果"}');
    if (parsed.error) throw new Error(parsed.error);
    cachedUserId = parsed.userId;
    const boards = (parsed.data?.boards || []).map((board) => ({
      id: board.id,
      name: board.name || '',
      total: board.total || 0,
      images: board.images || [],
    }));
    boardCache = { at: Date.now(), userId: parsed.userId, boards };
    return boardCache;
  }, { timeout: 25000 });
}

export function forgetXhsBoards() {
  boardCache = { at: 0, userId: '', boards: null };
}

/** 一次打开页面，把多篇笔记放进同一个专辑。 */
export function xhsAddNotes(boardId, noteIds) {
  const ids = [...new Set((noteIds || []).map(id => String(id || '')).filter(Boolean))].slice(0, 50);
  if (!boardId || !ids.length) throw new Error('缺少笔记或专辑');
  return watchPage(async (page) => {
    await pageReady(page);
    const result = await page.send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const chunk = window.webpackChunkxhs_pc_web;
          let req;
          chunk.push([[Date.now()], {}, (r) => { req = r; }]);
          const id = Object.keys(req.m).find((key) => String(req.m[key]).includes('web笔记收藏'));
          const exp = req(id);
          const fn = Object.entries(exp).find(([, item]) => typeof item === 'function' && String(item).includes('web笔记收藏'));
          const failed = [];
          for (const noteId of ${JSON.stringify(ids)}) {
            try { await fn[1]({ note_id: noteId, board_id: ${JSON.stringify(String(boardId))} }); }
            catch (error) { failed.push(String(error && (error.msg || error.message) || error).slice(0, 80)); }
          }
          return JSON.stringify({ ok: ${ids.length} - failed.length, failed });
        } catch (error) {
          return JSON.stringify({ error: String(error && error.message || error).slice(0, 180) });
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }, 60000);
    const parsed = JSON.parse(result?.result?.value || '{"error":"小红书没有返回结果"}');
    if (parsed.error) throw new Error(parsed.error);
    return parsed;
  }, { timeout: 70000 });
}

/** 用页面自己的签名客户端做收藏专辑操作。导出名字每次构建都会变，所以按接口说明文字查找。 */
export function xhsSigned(summary, arg) {
  return watchPage(async (page) => {
    await pageReady(page);
    const result = await page.send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const chunk = window.webpackChunkxhs_pc_web;
          if (!chunk) return JSON.stringify({ error: '小红书页面还没准备好' });
          let req;
          chunk.push([[Date.now()], {}, (r) => { req = r; }]);
          const id = Object.keys(req.m).find((key) => String(req.m[key]).includes(${JSON.stringify(summary)}));
          if (!id) return JSON.stringify({ error: '没有找到小红书专辑接口' });
          const exp = req(id);
          const fn = Object.entries(exp).find(([, item]) => typeof item === 'function' && String(item).includes(${JSON.stringify(summary)}));
          if (!fn) return JSON.stringify({ error: '没有找到小红书专辑接口' });
          const data = await fn[1](${JSON.stringify(arg)});
          return JSON.stringify({ data });
        } catch (error) {
          return JSON.stringify({ error: String(error && (error.msg || error.message) || error).slice(0, 180) });
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }, 25000);
    const parsed = JSON.parse(result?.result?.value || '{"error":"小红书没有返回结果"}');
    if (parsed.error) throw new Error(parsed.error);
    return parsed.data;
  }, { timeout: 40000 });
}
