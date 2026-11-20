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
const personalPages=new WeakMap();

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

// 账号状态可能晚于webpack就绪；只认登录用户或侧栏「我」，不取正在浏览的作者ID。
const readAccount = function () {
  const unwrap=v=>v&&typeof v==='object'&&('_value' in v||'_rawValue' in v)?unwrap(v._value??v._rawValue):v;
  const user=unwrap(window.__INITIAL_STATE__?.user)||{};
  const info=unwrap(user.userInfo)||{};
  const self=[...document.querySelectorAll('a[href*="/user/profile/"]')].find(a=>a.getClientRects().length&&/^(我|我的|个人主页)$/.test(String(a.textContent||'').trim()));
  const userId=info.userId||info.user_id||(self?.getAttribute('href')?.match(/\/user\/profile\/([a-z0-9]{16,32})/i)||[])[1]||'';
  return JSON.stringify({userId,guest:!self&&(user.loggedIn===false||info.guest===true)});
};
async function currentAccount(page) {
  await pageReady(page);
  const deadline=Date.now()+4000;
  do{
    const me=await evaluate(page,`(${readAccount.toString()})()`,'account');
    if(me?.guest){cachedUserId='';throw Error('小红书登录已失效，请重新扫码登录');}
    if(me?.userId){cachedUserId=me.userId;return me.userId;}
    await sleep(200);
  }while(Date.now()<deadline);
  throw Error('小红书页面已打开，但未读到当前账号标识；请在登录窗口打开「我」后重试');
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
  const streamOut = node => {
    const streams=unwrap(node)||{};
    return Object.fromEntries(['h264','h265'].map(codec=>{
      const entries=unwrap(streams[codec]);
      return [codec,(Array.isArray(entries)?entries:[]).map(item=>{
        const entry=unwrap(item)||{};
        return {masterUrl:entry.masterUrl||entry.master_url||'',backupUrls:entry.backupUrls||entry.backup_urls||[],avgBitrate:entry.avgBitrate||entry.videoBitrate||0};
      })];
    }));
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
      stream:streamOut(value.stream),
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
    // 赞过在主页 state.user.notes 的第 3 栏（笔记 / 收藏 / 赞过）。只取这一栏，不把「笔记」栏当成赞过。
    if (kind === 'likes') {
      const user = unwrap(unwrap(state.user)) || {};
      const notes = unwrap(user.notes) || unwrap(user.likedNotes) || unwrap(user.likeNotes) || [];
      const buckets = Array.isArray(notes) && notes.some(entry => Array.isArray(unwrap(entry)) && typeof unwrap(entry)[0] !== 'string');
      const list = buckets ? (unwrap(notes[2]) || []) : notes;
      const feeds = (Array.isArray(list) ? list : []).map(cardOut).filter(card => card.noteCard.noteId && (card.noteCard.cover.urlDefault || card.noteCard.cover.urlPre || card.noteCard.cover.url));
      if (feeds.length) return JSON.stringify({ ok: true, payload: { user: { notes: feeds } } });
      return JSON.stringify({ ok: false, why: 'personal-dom' });
    }
    if (kind === 'history') return JSON.stringify({ok:false,why:'personal-dom'});
    if (kind === 'note') {
      const map = unwrap(unwrap(state.note)?.noteDetailMap) || {};
      const entry = unwrap(map[id]) || unwrap(map[unwrap(unwrap(state.note)?.currentNoteId)]) || null;
      const note = unwrap(entry?.note) || unwrap(entry?.noteData) || unwrap(entry);
      if (!note || !note.noteId) return JSON.stringify({ ok: false, why: 'no-note' });
      const rawVideo=unwrap(note.video)||{};
      const video={media:{stream:streamOut(unwrap(rawVideo.media)?.stream)},consumer:{originVideoKey:unwrap(rawVideo.consumer)?.originVideoKey||''}};
      const videoReady=note.type!=='video'||!!video.consumer.originVideoKey||Object.values(video.media.stream).some(entries=>entries.some(entry=>entry.masterUrl||entry.backupUrls.length));
      return JSON.stringify({ ok: videoReady, payload: { note: { noteDetailMap: { [note.noteId]: { note: {
        noteId: note.noteId,
        title: note.title || '',
        desc: note.desc || '',
        user: (() => { const u = unwrap(note.user) || {}; return { nickname: u.nickname || u.nickName || '', userId: u.userId || '' }; })(),
        imageList: (unwrap(note.imageList) || []).map(imageOut),
        tagList: (unwrap(note.tagList) || []).map((tag) => ({ name: unwrap(tag)?.name || '' })),
        video,
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
const readCards = function (limit, visibleOnly = false) {
  const out = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"],a[href*="/user/profile/"]')) {
    if (visibleOnly && !anchor.getClientRects().length) continue;
    const href = anchor.getAttribute('href') || '';
    const id = (href.match(/(?:explore|discovery\/item)\/([0-9a-f]{16,32})/i) || href.match(/user\/profile\/[a-z0-9]{8,32}\/([a-z0-9]{16,32})(?:[/?#]|$)/i) || [])[1] || '';
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
      xsecToken: new URL(href,location.origin).searchParams.get('xsec_token')||'',
      type:box.querySelector('video, [class*="video"], use[href*="play"], use[xlink\\:href*="play"]')?'video':'normal',
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

/**
 * 页面内滚动：瀑布流可能挂在 window 或某个 overflow 容器上，逐个滚到底触发懒加载。
 * 用 toString 注入页面执行，不能引用外部变量。返回总位移（0 表示没scrollable容器，仍会滚 window）。
 */
const scrollBottom = function () {
  const nodes = [document.scrollingElement, document.body, document.documentElement,
    ...document.querySelectorAll('main,section,[class*=scroll],[class*=feed],[class*=container],[class*=waterfall],[class*=follow],[class*=list],[role=dialog] *')];
  let moved = 0;
  for (const el of nodes) {
    if (!el) continue;
    const max = (el.scrollHeight || 0) - (el.clientHeight || 0);
    if (max > 40) {
      const before = el.scrollTop || 0;
      try { el.scrollTop = max; } catch (e) { /* 只读容器赋值会抛，忽略 */ }
      moved += Math.abs((el.scrollTop || 0) - before);
    }
  }
  window.scrollTo(0, document.body.scrollHeight);
  return moved;
};

/**
 * 首屏之后模拟滚动，触发瀑布流继续吐卡片，按 noteId 累积去重，直到够 cardLimit 或真到底。
 * 只用于列表类页面（home / list / profile / collect），笔记详情不需要。
 * state 那份带 xsecToken，优先保留；DOM 那份兜底补标题和封面。
 */
async function gatherMore(page, { kind, noteId, cardLimit, initial, readApi, initialApi=[], hasMore=null }) {
  const byId = new Map();
  const apiOrder=new Map((kind==='home'?[...(initial||[]),...initialApi]:initialApi).map(note=>[note.noteId,note]));
  const put = (n) => {
    if (!n?.noteId) return false;
    const ex = byId.get(n.noteId);
    if (!ex) { byId.set(n.noteId, n); return true; }
    if (!ex.xsecToken && n.xsecToken) byId.set(n.noteId, n);
    return false;
  };
  for (const n of initial || []) put(n);
  let stagnant = 0;
  // 每轮滚到底 → 等 700ms 让页面发懒加载请求 → 重读 state + DOM 两套卡片补齐。
  const personal=kind==='likes'||kind==='history';
  const paged=personal||kind==='home';
  for (let round = 0; round < (paged?Math.ceil(cardLimit/10)+5:14) && (paged&&apiOrder.size?apiOrder.size:byId.size) < cardLimit && stagnant < (paged?5:3); round++) {
    if(paged&&hasMore===false)break;
    await evaluate(page, `(${scrollBottom.toString()})()`, 'scroll');
    await sleep(700);
    const state = await evaluate(page, `(${readState.toString()})(${JSON.stringify(kind)},${JSON.stringify(noteId)})`, 'state-scroll');
    let batch = [];
    const api=readApi?await readApi():null;
    if(api){
      for(const note of api.notes)apiOrder.set(note.noteId,note);
      batch.push(...api.notes);
      if(api.hasMore!==null)hasMore=api.hasMore;
    }
    if (state?.ok) {
      batch.push(...(kind === 'profile' ? parseXhsUser(state.payload).notes : parseXhsFeed(state.payload).feeds));
    }
    const raw = await evaluate(page, `(${readCards.toString()})(${cardLimit},${kind==='likes'||kind==='history'})`, 'dom-scroll');
    if (Array.isArray(raw)) batch.push(...parseXhsDomCards(raw));
    let added = 0;
    for (const n of batch) if (put(n)) added++;
    stagnant = added ? 0 : stagnant + 1;
  }
  let notes=paged&&apiOrder.size>byId.size?[...apiOrder.values()]:[...byId.values()];
  // Only explicit like timestamps can override the website's own liked-list order.
  if(personal&&notes.length&&notes.every(note=>note.likedAt>0))notes.sort((a,b)=>b.likedAt-a.likedAt);
  const pending=paged&&(notes.length>=cardLimit||hasMore!==false);
  return {notes:notes.slice(0,cardLimit),allNotes:notes,sourceHasMore:hasMore,hasMore:paged?pending:null,
    warning:paged&&pending&&notes.length<cardLimit?`小红书暂未返回后续${personal?'点赞':'推荐'}内容，可点击重试继续加载。`:''};
}

export function xhsHasMore(payload){
  const data=payload?.data||payload||{};
  const value=data.has_more??data.hasMore;
  return value===true||value===1?true:value===false||value===0?false:null;
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
export async function xhsBrowserCapture({ url, kind = 'list', noteId = '', apiMatch = /\/api\/sns\/web\//, cardLimit = 60, waitMs = CARD_WAIT_MS, refresh=false } = {}) {
  if (!url) throw new Error('缺少要打开的小红书地址');
  return watchPage(async (page) => {
    const hits = [];
    const videoRequests=[];
    let apiHasMore=null;
    let previous=null,personalUserId='';
    const readApi=async()=>{
      const payloads=[];
      for(const hit of hits.splice(0)){
        const data=await readBody(page,hit.requestId);
        if(!data)continue;
        payloads.push(data);
        const more=xhsHasMore(data);if(more!==null)apiHasMore=more;
      }
      return {payloads,notes:payloads.flatMap(parseXhsApiItems),hasMore:apiHasMore};
    };
    const off = page.on('Network.responseReceived', (p) => {
      const target = String(p?.response?.url || '');
      if(kind==='note'&&p?.response?.status>=200&&p.response.status<300&&/^https?:\/\/[^/]*\.xhscdn\.com\//i.test(target)&&(/\.mp4(?:[?#]|$)/i.test(target)||/^video\//i.test(p.response.mimeType||''))&&!videoRequests.includes(target))videoRequests.push(target);
      if (!apiMatch.test(target)) return;
      const clean = target.replace(/\?.*/, '');
      if (hits.some((hit) => hit.requestId === p.requestId)) return;
      hits.push({ requestId: p.requestId, url: clean });
    });
    try {
      // 笔记详情不等 load、也不等「网络安静 3 秒」。小红书会一直拉图，安静条件往往要拖到超时；
      // 状态里的 imageList 一出现就可以收工。列表页仍走原来的安静等待。
      const fast = kind === 'note';
      if (kind === 'collect' || kind === 'likes' || kind === 'history') {
        const userId=await currentAccount(page);
        personalUserId=userId;
        const cached=personalPages.get(page);
        if((kind==='likes'||kind==='history')&&!refresh&&cached?.kind===kind&&cached.userId===userId){previous=cached;apiHasMore=cached.hasMore;}
        if(!previous){
        await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`, { timeout: 15000, loadTimeout: 2000, waitForQuiet: 0 });
        hits.length=0;
        let selected=false;
        const labels=kind==='likes'?['点赞','赞过']:kind==='history'?['浏览记录','浏览历史','最近浏览','足迹']:['收藏'];
        const tabDeadline=Date.now()+8000;
        while(!selected&&Date.now()<tabDeadline){
        selected=await evaluate(page, `(() => {
          const labels=${JSON.stringify(labels)};
          const nodes=[...document.querySelectorAll('div,span,a,button')].filter(node=>node.getClientRects().length);
          const tab=nodes.find(node=>{
            const text=String(node.textContent||'').replace(/\\s+/g,'').trim();
            return labels.some(label=>text===label||text.startsWith(label))&&text.length<=label.length+6;
          });
          const target=tab&&tab.childElementCount?tab.parentElement||tab:tab;
          if(target){target.click();return true;}
          return false;
        })()`, 'fav-tab');
        if(!selected)await sleep(POLL_MS);
        }
        if(!selected)throw Error(kind==='history'?'当前小红书网页版没有可用的浏览记录入口，无法读取手机端浏览历史；不会用推荐或本地预览记录代替。':`没有找到小红书「${labels[0]}」入口，请先登录或稍后重试。`);
        await sleep(500);
        hits.length=0;
        // 已确认进入对应页之后再采集，避免混入主页「笔记」接口。
        }
      } else if(kind==='home'){
        const cached=personalPages.get(page);
        if(!refresh&&cached?.kind===kind){previous=cached;apiHasMore=cached.hasMore;}
        else await page.goto(url,{timeout:15000,loadTimeout:2000,waitForQuiet:0});
      } else if (fast) page.send('Page.navigate', { url }, 15000).catch(() => {});
      // 导航仅短暂等待load；图片没加载完也继续检查卡片，不再等网络安静。
      else await page.goto(url, { timeout: 15000, loadTimeout: 2000, waitForQuiet: 0 });
      const deadline = Date.now() + (fast ? Math.min(waitMs, 12000) : ['collect','likes','history'].includes(kind)?Math.min(waitMs,6000):waitMs);
      let state = null;
      // 状态是客户端渲染后才写进去的：轮询到有数据为止（笔记详情与列表页都在这一档）。
      while (Date.now() < deadline) {
        state = await evaluate(page, `(${readState.toString()})(${JSON.stringify(kind)},${JSON.stringify(noteId)})`, 'state');
        if (state?.ok || (fast&&videoRequests.length)) break;
        if(!fast){
          const cards=await evaluate(page,`(${readCards.toString()})(${cardLimit},true)`,'personal-cards');
          if(Array.isArray(cards)&&cards.length)break;
        }
        await sleep(fast ? 200 : POLL_MS);
      }
      // 接口体当作增强（token 只在它那里），但响应体可能已被回收，取不到就算了。
      // 笔记已经从页面状态拿到图，就不必再把接口体读回来。
      let payloads = [],initialApi={notes:[],hasMore:null};
      if (!(fast && state?.ok)) {
        if(kind==='likes'||kind==='history'||kind==='home'){
          initialApi=await readApi();payloads=initialApi.payloads;
        }else for (const hit of hits.slice(0, HIT_CAP)) {
          const data = await readBody(page, hit.requestId);
          if (data?.data || data?.items) payloads.push(data);
        }
      }

      if (kind === 'note') {
        let note = state?.payload ? parseXhsNote(state.payload, noteId) : null;
        if(videoRequests.length){
          // The current website plays a blob-backed video; the real MP4 request is
          // authoritative even when its reactive store no longer exposes media.stream.
          const current=await evaluate(page,`(() => {
            const id=${JSON.stringify(noteId)},title=document.querySelector('#detail-title');
            const video=[...document.querySelectorAll('video')].find(node=>node.getClientRects().length);
            if(!title||!video||!location.pathname.includes(id))return null;
            return JSON.stringify({noteId:id,title:title.textContent.trim(),desc:document.querySelector('#detail-desc')?.textContent?.trim()||'',author:'',authorId:'',tags:[],images:[]});
          })()`,'playing-note');
          if(current?.noteId===noteId){
            note=note||current;
            const urls=[...new Set([note.videoUrl,...(note.videoAlternates||[]),...videoRequests].filter(Boolean))];
            note={...note,videoUrl:urls[0],videoAlternates:urls.slice(1)};
          }
        }
        if (!note || (!note.images.length && !note.videoUrl)) {
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
      const fromApi = [...(previous?.notes||[]),...payloads.flatMap((payload) => parseXhsApiItems(payload))];
      const fromDom = async () => {
        const raw = await evaluate(page, `(${readCards.toString()})(${cardLimit},${kind==='likes'||kind==='history'})`, 'dom');
        return Array.isArray(raw) ? parseXhsDomCards(raw) : [];
      };
      let notes = kind==='home'&&fromApi.length?fromApi:fromProfile.length ? fromProfile : fromState;
      let source = fromProfile.length ? 'state' : (fromState.length ? 'state' : 'none');
      if (!notes.length && fromApi.length) { notes = fromApi; source = 'api'; }
      if (!notes.length) {
        notes = await fromDom();
        if (notes.length) source = 'dom';
      }
      if(!notes.length&&['collect','likes','history'].includes(kind))throw Error('已打开小红书个人列表，但未读到笔记；请确认网页对应标签有内容，或页面结构是否发生变化');
      // token / 作者 id 富化：状态那份不一定带（token 只在接口那份里），按笔记 id 补上。
      if (notes.length && fromApi.length) {
        const extra = new Map(fromApi.map((item) => [item.noteId, item]));
        notes = notes.map((item) => {
          const hit = extra.get(item.noteId);
          if (!hit) return item;
          return { ...item, xsecToken: item.xsecToken || hit.xsecToken, authorId: item.authorId || hit.authorId };
        });
      }
      // 首屏不够就模拟滚动补：小红书瀑布流首屏只渲染约 31 条，不滚就拿不到「加载更多」。
      // 前端 limit 递增续页时 cardLimit 跟着涨，这里滚到够数或真到底，服务端才能返回足额卡片、
      // truncated 才判得出「还有更多」。collect 的收藏流 / home 推荐 / 搜索都吃这一档。
      let paging={hasMore:kind==='likes'||kind==='home'?notes.length>=cardLimit||initialApi.hasMore!==false:null,warning:''};
      if (kind !== 'note' && notes.length && notes.length < cardLimit) {
        paging = await gatherMore(page, { kind, noteId, cardLimit, initial: notes,
          ...(kind==='likes'||kind==='home'?{readApi,initialApi:fromApi,hasMore:initialApi.hasMore}:{}) });
        notes=paging.notes;
      }
      if(kind==='likes'&&notes.length&&notes.every(note=>note.likedAt>0))notes.sort((a,b)=>b.likedAt-a.likedAt);
      if(kind==='likes'||kind==='home')personalPages.set(page,{kind,userId:personalUserId,notes:paging.allNotes||notes,hasMore:paging.sourceHasMore??initialApi.hasMore});
      return { notes, note: null, source, payload: state?.payload || null, profile,hasMore:paging.hasMore,warning:paging.warning };
    } finally {
      off();
    }
  },{sessionKey:kind==='likes'?'xhs-likes':kind==='home'?'xhs-home':''});
}

export function xhsMe() {
  return watchPage(currentAccount, {timeout:20000});
}

/** Read every page emitted by the real following dialog; no signed endpoint is fabricated. */
export function xhsFollowings({limit=25,refresh=false}={}) {
  return watchPage(async page=>{
    const userId=await currentAccount(page),hits=[];
    const cached=personalPages.get(page);
    const previous=!refresh&&cached?.kind==='following'&&cached.userId===userId?cached:null;
    const users=previous?.users||[],seen=new Set(users.map(user=>user.id));
    const off=page.on('Network.responseReceived',event=>{
      if(/\/api\/sns\/web\/.*(?:follow|relation)/i.test(event?.response?.url||''))hits.push(event.requestId);
    });
    try{
      if(!previous){
      await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`,{timeout:15000,loadTimeout:2000,waitForQuiet:0});
      let opened=false;
      const deadline=Date.now()+6000;
      while(Date.now()<deadline&&!opened){
        opened=await evaluate(page,`(() => {
          const nodes=[...document.querySelectorAll('span,div,a')].filter(n=>n.getClientRects().length&&/^\\d[\\d.万+]*\\s*关注$/.test(n.textContent.trim()));
          const node=nodes.sort((a,b)=>a.textContent.length-b.textContent.length)[0];
          if(!node)return false;node.click();return true;
        })()`,'follow-open');
        if(!opened)await sleep(200);
      }
      if(!opened)throw Error('没有找到当前账号的关注列表入口');
      }
      const target=Math.min(5001,Math.max(1,Number(limit)||25));
      let hasMore=previous?.hasMore??null,stagnant=0,lastCount=-1;
      const until=Date.now()+6000;
      let round=0;
      while(round<Math.ceil(target/10)+5&&users.length<target&&stagnant<5){
        for(const id of hits.splice(0)){
          const data=await readBody(page,id);
          for(const user of followingUsers(data))if(!seen.has(user.id)){seen.add(user.id);users.push(user);}
          const more=xhsHasMore(data);if(more!==null)hasMore=more;
        }
        if(hasMore===false||users.length>=target)break;
        if(!users.length){if(Date.now()>=until)break;await sleep(200);continue;}
        stagnant=users.length===lastCount?stagnant+1:0;lastCount=users.length;
        await evaluate(page,`(${scrollBottom.toString()})()`,'following-scroll');
        await sleep(700);
        round++;
      }
      if(!users.length)throw Error('关注列表已打开，但未读到用户数据；请确认关注列表正常显示');
      const pending=users.length>=target||hasMore!==false;
      personalPages.set(page,{kind:'following',userId,users,hasMore});
      return {users:users.slice(0,target),hasMore:pending,
        warning:pending&&users.length<target?'小红书暂未返回后续关注用户，可点击重试继续加载。':''};
    }finally{off();}
  },{sessionKey:'xhs-following'});
}

export function followingUsers(payload) {
  const data=payload?.data||payload||{};
  const list=data.users||data.user_list||data.followings||data.items||[];
  if(!Array.isArray(list))return [];
  return list.map(raw=>{
    const user=raw.user_info||raw.userInfo||raw.user||raw;
    return {id:String(user.user_id||user.userId||user.id||''),name:String(user.nickname||user.nick_name||user.nickName||''),avatar:String(user.image||user.avatar||user.avatar_url||''),token:String(user.xsec_token||user.xsecToken||raw.xsec_token||'')};
  }).filter(user=>/^[a-f0-9]{16,32}$/i.test(user.id)&&user.name);
}

/** 当前账号的专辑。短时间重复打开收藏页直接用上次结果。 */
export function xhsBoards() {
  if (boardCache.boards && Date.now() - boardCache.at < 45000) return Promise.resolve(boardCache);
  return watchPage(async (page) => {
    const accountId=await currentAccount(page);
    const result = await page.send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const unwrap = (v) => v && typeof v === 'object' && ('_value' in v || '_rawValue' in v) ? unwrap(v._value ?? v._rawValue) : v;
          const info = unwrap(unwrap(window.__INITIAL_STATE__?.user)?.userInfo) || {};
          const userId = ${JSON.stringify(accountId)};
          if (!userId) return JSON.stringify({ error: '没有读到当前登录的小红书账号。先点「登录」。' });
          const chunk = window.webpackChunkxhs_pc_web;
          let req;
          chunk.push([[Date.now()], {}, (r) => { req = r; }]);
          const id = Object.keys(req.m).find((key) => String(req.m[key]).includes('web查询用户的专辑'));
          if(!id)return JSON.stringify({error:'当前小红书网页版专辑接口已变化，暂时无法读取专辑'});
          const exp = req(id);
          const fn = Object.entries(exp).find(([, item]) => typeof item === 'function' && String(item).includes('web查询用户的专辑'));
          if(!fn)return JSON.stringify({error:'当前小红书网页版专辑接口已变化，暂时无法读取专辑'});
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

// ── 收藏夹写操作：接口说明文字候选表 ───────────────────────────────────────────
// 小红书的签名接口按「接口说明文字」在 webpack 里查（见 xhsSigned）。不同 web 版本说明文字
// 会变，所以每种操作列多个候选；探测时找出页面里真实存在的那个，只有探测到的操作才开放按钮，
// 绝不凭空捏造接口。调用时再用探测到的真实文字 + 参数候选逐个尝试。
const WRITE_SIGNATURES = {
  create: ['web创建专辑'],
  add: ['web笔记收藏'],
  rename: ['web编辑专辑', 'web修改专辑', 'web更新专辑', 'web专辑改名', 'web编辑收藏夹'],
  remove: ['web删除专辑', 'web移除专辑', 'web解散专辑', 'web删除收藏夹'],
  removeItem: ['web取消收藏', 'web取消笔记收藏', 'web移除笔记', 'web从专辑移除', 'web取消笔记收藏到专辑'],
};
// 各操作的参数候选（按小红书常见 convention 排序，探测调用时逐个试到不报错为止）。
const WRITE_ARGS = {
  rename: [
    (a) => ({ boardId: a.boardId, name: a.name }),
    (a) => ({ board_id: a.boardId, name: a.name }),
    (a) => ({ id: a.boardId, title: a.name }),
  ],
  remove: [
    (a) => ({ boardId: a.boardId }),
    (a) => ({ board_id: a.boardId }),
    (a) => ({ id: a.boardId }),
  ],
  removeItem: [
    (a) => ({ noteId: a.noteId, boardId: a.boardId }),
    (a) => ({ note_id: a.noteId, board_id: a.boardId }),
    (a) => ({ noteId: a.noteId }),
  ],
};

/**
 * 运行时探测页面里真实存在的收藏夹写接口，返回可用 action 列表。
 * 只在页面内枚举 webpack 模块说明文字，不发写请求、无副作用。
 */
export function xhsProbeWriteOps() {
  return watchPage(async (page) => {
    await pageReady(page);
    const result = await page.send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const chunk = window.webpackChunkxhs_pc_web;
          if (!chunk) return JSON.stringify({ error: '页面还没准备好' });
          let req;
          chunk.push([[Date.now()], {}, (r) => { req = r; }]);
          const signatures = [];
          for (const key of Object.keys(req.m)) {
            const src = String(req.m[key]);
            const hits = src.match(/web[\\u4e00-\\u9fa5A-Za-z]{1,16}/g) || [];
            for (const h of hits) if (!signatures.includes(h)) signatures.push(h);
          }
          return JSON.stringify({ signatures });
        } catch (error) {
          return JSON.stringify({ error: String(error && error.message || error).slice(0, 180) });
        }
      })()`,
      returnByValue: true,
    }, 20000);
    const parsed = JSON.parse(result?.result?.value || '{"error":"小红书没有返回结果"}');
    if (parsed.error) throw new Error(parsed.error);
    const found = new Set(parsed.signatures || []);
    const ops = [];
    for (const [action, candidates] of Object.entries(WRITE_SIGNATURES)) {
      const hit = candidates.find((s) => found.has(s));
      if (hit) ops.push({ action, signature: hit });
    }
    return ops;
  }, { timeout: 30000 });
}

/**
 * 执行一次收藏夹写操作。summary 由探测阶段确定（真实存在的接口说明文字），
 * arg 从候选里逐个尝试直到接口不报错。create/add 用已验证的固定签名。
 */
export async function xhsCollectionWrite({ action, signature, boardId, name, noteId } = {}) {
  const argCandidates = WRITE_ARGS[action]
    ? WRITE_ARGS[action]({ boardId, name, noteId })
    : [{}];
  const summary = signature || WRITE_SIGNATURES[action]?.[0];
  if (!summary) throw new Error('没有找到小红书对应的接口');
  let lastError = '';
  for (const arg of argCandidates) {
    try {
      const data = await xhsSigned(summary, arg);
      const err = data?.error || data?.msg || (typeof data?.success === 'boolean' && !data.success ? '接口返回失败' : '');
      if (err) { lastError = String(err).slice(0, 120); continue; }
      forgetXhsBoards();
      return { ok: true, data };
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 120);
    }
  }
  throw new Error(lastError || '操作失败，小红书接口参数可能已变化');
}
