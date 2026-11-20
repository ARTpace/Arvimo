// 小红书各条数据通道的解析（纯函数层，不碰网络）。
//
// 三条来源，形状各不相同，全部收在这一层：
//   1. `window.__INITIAL_STATE__`（笔记详情 / 带 xsec_token 的主页 / 短链）—— extractXhsState 那一套；
//   2. 页面自己发的 JSON（搜索、推荐等列表页走客户端渲染后**只剩这一条**）—— parseXhsApiItems；
//   3. 渲染完的 DOM（兜底，任何列表页都能用）—— parseXhsDomCards。
// 三条最终都归一成同一种「笔记卡片」，调用方不需要知道内容是从哪儿来的。
//
// 第 1 条通道有两个坑必须在这一层处理掉：
//
//  1. 状态对象里有**裸 `undefined` 字面量**（实测 27 处），`JSON.parse` 必然抛错。必须先用字符
//     状态机把字符串外的 `undefined` / `NaN` 换成 `null` —— 不能用全局 replace，正文里出现
//     "undefined" 这个词的词条会被一起改坏。
//  2. Vue 的响应式包装（`{_rawValue: [...]}`）会出现在 `user.notes` / `search.feeds` 这类列表上，
//     直接当数组用会静默拿到空结果（「页面有数据但解析出 0 条」的典型原因）。
//
// 图片地址还有第三层：SSR 给的是压缩转码版（`sns-webpic-qc` + `!nd_dft_wlteh_webp_3`），
// 换成 `sns-img-qc` 并去掉转码后缀才是原图。
//
// 所有导出都是纯函数，`test/library-xhs-state.test.js` 用 fixture 覆盖。

/** 标识符字符：用于判断 `undefined` 是独立 token 还是 `myundefinedFlag` 的一部分。 */
const IDENT = /[A-Za-z0-9_$]/;
/** `-Infinity` 必须排在 `Infinity` 前面，否则会留下半截 `-null`。 */
const LOOSE_TOKENS = Object.freeze(['-Infinity', 'undefined', 'Infinity', 'NaN']);

/**
 * 把 JSON 文本里**字符串外**的 `undefined` / `NaN` / `Infinity` 换成 `null`。
 * 逐字符扫描，遇到引号就整体复制到配对引号（处理 `\"` 转义），因此正文里的这些词不会被误改。
 */
export function replaceLooseTokens(raw) {
  const src = String(raw || '');
  let out = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    // 只在「独立 token」的位置替换：前一个字符不是标识符，且 token 后面也不再接标识符。
    let matched = '';
    if (!(i > 0 && IDENT.test(src[i - 1]))) {
      matched = LOOSE_TOKENS.find((token) => src.startsWith(token, i) && !IDENT.test(src[i + token.length] || '')) || '';
    }
    if (matched) {
      out += 'null';
      i += matched.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 从这个位置往后找最后一个 `}`，用于 parse 失败时截掉尾随垃圾。 */
function trimToLastBrace(text) {
  const end = text.lastIndexOf('}');
  return end > 0 ? text.slice(0, end + 1) : text;
}

/** Vue 响应式包装拆一层：`{_rawValue: x}` / `{_value: x}` → `x`。 */
export function unwrap(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  if (node._rawValue !== undefined) return node._rawValue;
  if (node._value !== undefined) return node._value;
  return node;
}

/** 取页面里的 `window.__INITIAL_STATE__`；拿不到或解析不了都返回 null。 */
export function extractXhsState(html) {
  const src = String(html || '');
  if (!src) return null;
  const m = src.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/);
  if (!m) return null;
  const raw = m[1].trim().replace(/;+\s*$/, '');
  for (const candidate of [raw, trimToLastBrace(raw)]) {
    try {
      const parsed = JSON.parse(replaceLooseTokens(candidate));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/**
 * 图片地址归一：转码版 → 原图。
 * `sns-webpic-qc` 是「网页压缩档」，`sns-img-qc` 是「原图档」；`!nd_dft_wlteh_webp_3` 是转码指令。
 */
export function normalizeXhsImage(raw) {
  let s = String(raw || '').trim().replace(/&amp;/g, '&');
  if (!s) return '';
  if (/^\/\//.test(s)) s = `https:${s}`;
  s = s.replace(/^http:\/\//i, 'https://');
  // 只换 xhscdn 上的 webpic 档，别碰其它 CDN（视频封面在 sns-video-* / ci.xiaohongshu.com）。
  s = s.replace(/([a-z0-9-]*)-webpic([a-z0-9-]*)\.xhscdn\.com/i, '$1-img$2.xhscdn.com');
  // 时效签名 `/202611092232/1adc/` 只对原来的 webpic 主机有效。换到 sns-img 后还带着它，CDN 直接 403，封面全黑。
  // 同一段在 maxurl / 素材下载器里也是先剥掉再取原图。
  s = s.replace(/(\.xhscdn\.com)\/\d{10,14}\/[0-9a-f]{2,}\//i, '$1/');
  // 截掉 `!nd_...` 这类转码后缀（在 query 之前才截）。
  s = s.replace(/![^/?#]*(?=$|[?#])/i, '');
  return s;
}

/** Keep video path/query signatures intact; prefer broadly supported H.264. */
export function xhsVideoSources(video){
  const value=unwrap(video)||{},streams=unwrap(unwrap(value.media)?.stream)||{},urls=[];
  for(const codec of ['h264','h265']){
    const entries=unwrap(streams[codec]);
    const sorted=(Array.isArray(entries)?entries:[]).map(unwrap).filter(Boolean)
      .sort((a,b)=>(Number(b.avgBitrate||b.videoBitrate)||0)-(Number(a.avgBitrate||a.videoBitrate)||0));
    for(const entry of sorted)urls.push(entry.masterUrl||entry.master_url,...(entry.backupUrls||entry.backup_urls||[]));
  }
  const origin=unwrap(value.consumer)?.originVideoKey;
  if(origin)urls.push(/^https?:\/\//i.test(origin)?origin:'https://sns-video-bd.xhscdn.com/'+String(origin).replace(/^\//,''));
  return [...new Set(urls.filter(Boolean).map(url=>String(url).trim().replace(/&amp;/g,'&').replace(/^\/\//,'https://').replace(/^http:\/\//i,'https://')).filter(url=>/^https:\/\//i.test(url)))];
}

/**
 * 从一个 image 节点取最佳地址。
 * 优先级：infoList 里带 CRD / WB_DFT 的（更清晰）→ infoList[0] → urlDefault → urlPre → url。
 */
export function pickXhsImage(node) {
  const val = unwrap(node);
  if (!val) return '';
  if (typeof val === 'string') return normalizeXhsImage(val);
  if (typeof val !== 'object') return '';
  const info = unwrap(val.infoList);
  if (Array.isArray(info)) {
    const usable = info.filter((item) => item && typeof (unwrap(item) || {}).url === 'string');
    const preferred = usable.find((item) => /CRD|WB_DFT|WB_PRV/i.test(String((unwrap(item) || {}).imageScene || ''))) || usable[0];
    if (preferred) {
      const url = normalizeXhsImage((unwrap(preferred) || {}).url);
      if (url) return url;
    }
  }
  for (const key of ['urlDefault', 'url', 'urlPre', 'originUrl', 'url_default', 'url_pre', 'origin_url', 'traceId']) {
    const url = normalizeXhsImage(unwrap(val[key]));
    if (url) return url;
  }
  return '';
}

/** 图片节点的尺寸（拿不到就 0，前端会按图片实际比例兜底）。snake_case 是浏览器通道那份接口的形状。 */
function imageSize(node) {
  const val = unwrap(node) || {};
  const w = Number(val.width || unwrap(val.infoList)?.[0]?.width || unwrap(val.info_list)?.[0]?.width) || 0;
  const h = Number(val.height || unwrap(val.infoList)?.[0]?.height || unwrap(val.info_list)?.[0]?.height) || 0;
  return { width: w, height: h };
}

/**
 * 识别小红书链接。类型：`note` / `profile` / `shortlink` / `unknown`。
 * 保留原始 query —— `xsec_token` 是笔记自己的访问凭证，丢了就打不开。
 */
export function parseXhsUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return { type: 'unknown' };
  const qIndex = value.indexOf('?');
  const query = qIndex >= 0 ? value.slice(qIndex) : '';
  const personal = value.match(/xiaohongshu\.com\/user\/(likes|history|following)(?:\/?[?#]|\/?$)/i);
  if (personal) return {type: personal[1].toLowerCase(), query};
  const profileNote=value.match(/xiaohongshu\.com\/user\/profile\/[A-Za-z0-9]{8,32}\/([A-Za-z0-9]{16,32})(?:[/?#]|$)/i);
  if(profileNote)return {type:'note',noteId:profileNote[1],query};
  const profile = value.match(/xiaohongshu\.com\/user\/profile\/([A-Za-z0-9]{8,32})/i)
    || value.match(/xiaohongshu\.com\/user\/(?!profile)([A-Za-z0-9]{8,32})/i);
  if (profile) return { type: 'profile', userId: profile[1], query };
  const note = value.match(/xiaohongshu\.com\/(?:explore|discovery\/item)\/([A-Za-z0-9]{16,32})/i);
  if (note) return { type: 'note', noteId: note[1], query };
  const short = value.match(/xhslink\.com\/(?:[a-z]\/)?([A-Za-z0-9]{4,24})/i)
    || value.match(/xhslink\.cn\/(?:[a-z]\/)?([A-Za-z0-9]{4,24})/i);
  if (short) return { type: 'shortlink', shortCode: short[1] };
  // 首页推荐（/explore、/explore?channel_id=…）。**必须排在笔记之后**：`/explore/<id>` 先被上面
  // 那条吃掉，剩下的才是「没有具体笔记的推荐页」。这条只有 DOM 通道拿得到内容（走 service worker）。
  if (/xiaohongshu\.com\/explore(?:\/)?(?:[?#]|$)/i.test(value)) return { type: 'home', query };
  if (/xiaohongshu\.com\/user\/collect(?:[?#]|$)/i.test(value)) return { type: 'collect', notes: /tab=note/.test(query), query };
  const board = value.match(/xiaohongshu\.com\/board\/([0-9a-f]{16,32})/i);
  if (board) return { type: 'board', boardId: board[1], query };
  // 裸 noteId（App 分享文本里常见）
  if (/^[A-Za-z0-9]{24}$/.test(value)) return { type: 'note', noteId: value, query: '' };
  return { type: 'unknown' };
}

/** 笔记详情 → `{noteId,title,desc,author,authorId,tags,images,videoUrl}`；没有数据返回 null。 */
export function parseXhsNote(state, expectedNoteId = '') {
  const root = unwrap(state);
  const noteNode = unwrap(root?.note);
  const map = unwrap(noteNode?.noteDetailMap);
  if (!map || typeof map !== 'object') return null;
  const keys = Object.keys(map);
  if (!keys.length) return null;
  const key = (expectedNoteId && map[expectedNoteId] ? expectedNoteId : '')
    || unwrap(noteNode?.currentNoteId)
    || unwrap(noteNode?.firstNoteId)
    || keys[0];
  const entry = unwrap(map[key]);
  const note = unwrap(entry?.note) || unwrap(entry?.noteData) || unwrap(entry);
  if (!note || typeof note !== 'object' || !note.noteId) return null;

  const images = [];
  const seen = new Set();
  const list = unwrap(note.imageList);
  for (const image of Array.isArray(list) ? list : []) {
    const url = pickXhsImage(image);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const liveUrls=xhsVideoSources({media:{stream:unwrap(image.stream)}});
    images.push({ url, ...imageSize(image),...(liveUrls.length?{liveVideoUrl:liveUrls[0],liveVideoAlternates:liveUrls.slice(1)}:{}) });
  }
  if (!images.length) {
    const cover = pickXhsImage(note.cover) || pickXhsImage(note.image);
    if (cover) images.push({ url: cover, width: 0, height: 0 });
  }

  const candidates=xhsVideoSources(note.video);
  const videoUrl=candidates[0]||'';

  const tags = (unwrap(note.tagList) || [])
    .map((tag) => String(unwrap(tag)?.name || '').trim())
    .filter(Boolean);

  return {
    noteId: String(note.noteId || key),
    title: String(note.title || '').trim(),
    desc: String(note.desc || '').trim(),
    author: String(unwrap(note.user)?.nickname || unwrap(note.user)?.nickName || '').trim(),
    authorId: String(unwrap(note.user)?.userId || '').trim(),
    tags,
    images,
    videoUrl,
    videoAlternates:candidates.slice(1),
  };
}

/** 笔记卡片（feed / 主页共用）→ 归一化条目；拿不到封面就丢弃。 */
function noteCard(item, fallbackAuthor = '') {
  const tupleId = Array.isArray(item) && typeof item[0] === 'string' ? item[0] : '';
  const raw = unwrap(Array.isArray(item) ? item[1] : item) || {};
  const card = unwrap(raw.noteCard) || unwrap(raw.note_card) || raw;
  const noteId = tupleId || String(card.noteId || card.id || raw.id || raw.noteId || '');
  if (!noteId) return null;
  const cover = pickXhsImage(card.cover) || pickXhsImage(card.image);
  if (!cover) return null;
  const xsecToken = String(card.xsecToken || raw.xsecToken || raw.xsec_token || '');
  return {
    noteId,
    title: String(card.displayTitle || card.title || '').trim(),
    cover,
    author: String(unwrap(card.user)?.nickname || unwrap(card.user)?.nickName || fallbackAuthor).trim(),
    // 作者 id：卡片上点作者名要能进他的主页（列表页过去只给了名字，这一条一直缺）。
    authorId: String(unwrap(card.user)?.userId || unwrap(card.user)?.user_id || '').trim(),
    likedCount: String(unwrap(card.interactInfo)?.likedCount || ''),
    type: String(card.type || ''),
    xsecToken,
  };
}

/** 一组卡片列表 → 去重后的条目（兼容元组与对象两种形态）。 */
function notesFrom(list, fallbackAuthor) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const note = noteCard(item, fallbackAuthor);
    if (!note || seen.has(note.noteId)) continue;
    seen.add(note.noteId);
    out.push(note);
  }
  return out;
}

/**
 * 博主主页首屏 → `{nickname,userId,notes[]}`。
 *
 * 坑：`user.notes` 是**按 tab 分的二维数组**（笔记 / 收藏 / 赞过 …，实测 `[29, 0, 0, 0, 0]`）。
 * 直接当一维卡片用，只会把每个 tab 当成一张卡 —— 于是「29 篇笔记的作者」只解析出 1 条
 * （2026-11-09 就是这么显示成 1 条的）。拍平前要排除「元组形态的卡片」`[id, card]`，
 * 否则把一张卡拆成两半；判据是元组的第一项是字符串 id，而 tab 桶的第一项是数组。
 */
export function parseXhsUser(state) {
  const root = unwrap(state);
  const userNode = unwrap(root?.user) || {};
  const basic = unwrap(unwrap(userNode.userPageData)?.basicInfo) || unwrap(userNode.basicInfo) || {};
  const nickname = String(unwrap(basic.nickname) || unwrap(basic.nickName) || unwrap(userNode.nickname) || '').trim();
  const userId = String(unwrap(basic.userId) || unwrap(basic.redId) || unwrap(userNode.userId) || '').trim();
  let list = unwrap(userNode.notes) || unwrap(userNode.noteList) || unwrap(unwrap(userNode.userPageData)?.notes) || [];
  if (Array.isArray(list) && list.length && list.every((entry) => {
    const one = unwrap(entry);
    return Array.isArray(one) && typeof one[0] !== 'string';
  })) list = list.flat();
  return { nickname, userId, notes: notesFrom(list, nickname) };
}

/** 搜索页 / 推荐流 → `{feeds[]}`。`state.search.feeds` 与 `state.feed.feeds` 都可能是包装过的。 */
export function parseXhsFeed(state) {
  const root = unwrap(state);
  const search = unwrap(root?.search) || {};
  const feed = unwrap(root?.feed) || {};
  const list = unwrap(search.feeds) || unwrap(search.items) || unwrap(feed.feeds) || [];
  return { feeds: notesFrom(list, '') };
}

// ---------- 浏览器通道的两份形状 ----------
//
// 2026-11-09 实测：小红书网页版（web build 6.61.3）把搜索结果、推荐流**全部改成客户端异步拉取**，
// SSR 的 `search.feeds` 永远是空数组（登录态下也是），所以「带 cookie 纯 HTTP 拿列表」这条路已经死了。
// 活着的是两条：
//   1. 页面自己发的 JSON —— 带签名（x-s），我们只在网络层旁观，不自己造签名；
//   2. 渲染完的 DOM —— 兜底，任何列表页都能用。
// 这两份的形状都不是 SSR 状态（不是 camelCase 的 Vue 包装），所以归一化单独写，共用 pickXhsImage。

/**
 * 搜索接口的一条 → 归一化笔记卡片。
 * 形状（实测 `so.xiaohongshu.com/api/sns/web/v2/search/notes`）：
 *   `{ id, note_card: { display_title, cover{width,height,url_default,url_pre}, user{nick_name,user_id,xsec_token} },
 *      xsec_token, interact_info }`
 * 注意 `xsec_token` 在**顶层 item 上**（登录态直接拿详情页时才用得上）。
 */
export function parseXhsApiItems(payload) {
  const root = unwrap(payload);
  const data=unwrap(root?.data);
  const items = data?.items || data?.notes || root?.items || root?.notes || [];
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const card = unwrap(item?.note_card) || unwrap(item?.noteCard) || unwrap(item) || {};
    const noteId = String(unwrap(item?.id) || card.note_id || card.noteId || card.id || '');
    if (!noteId || seen.has(noteId)) continue;
    const cover = pickXhsImage(card.cover) || pickXhsImage(card.image) || pickXhsImage(card.image_list?.[0]);
    if (!cover) continue;
    seen.add(noteId);
    const user = unwrap(card.user) || {};
    const likedAt=Number(item?.liked_at || item?.like_time || item?.liked_time || card.liked_at || card.like_time || 0)||0;
    out.push({
      noteId,
      cover,
      title: String(unwrap(card.display_title) || unwrap(card.displayTitle) || unwrap(card.title) || '').trim(),
      author: String(unwrap(user.nick_name) || unwrap(user.nickname) || '').trim(),
      authorId: String(unwrap(user.user_id) || unwrap(user.userId) || '').trim(),
      // 顶层优先：详情页 URL 认这个 token。
      xsecToken: String(unwrap(item?.xsec_token) || unwrap(card.xsec_token) || '').trim(),
      likedCount: String(unwrap(unwrap(card.interact_info)?.liked_count) || '').trim(),
      type:String(unwrap(card.type)||''),
      ...(likedAt>0?{likedAt:likedAt<1e11?likedAt*1000:likedAt}:{}),
    });
  }
  return out;
}

/** 渲染后 DOM 抽出的卡片（`{id,src,title,author}`）→ 同上形状。没有 token，详情链接只能给裸笔记地址。 */
export function parseXhsDomCards(cards) {
  const out = [];
  const seen = new Set();
  for (const card of Array.isArray(cards) ? cards : []) {
    const noteId = String(unwrap(card?.id) || '').trim();
    const cover = normalizeXhsImage(unwrap(card?.src) || '');
    if (!noteId || !cover || seen.has(noteId)) continue;
    seen.add(noteId);
    out.push({
      noteId,
      cover,
      title: String(unwrap(card?.title) || '').trim(),
      author: String(unwrap(card?.author) || '').trim(),
      authorId: '',
      xsecToken: String(card.xsecToken||''),
      type: String(card.type||''),
      likedCount: '',
    });
  }
  return out;
}

/**
 * 判断「为什么没数据」。返回 `captcha` / `login` / `notfound` / `''`。
 * 判据顺序很重要：验证码页也可能同时出现「登录」字样，先判验证码才不会给出误导提示。
 */
export function detectXhsBlock(html, state) {
  const text = String(html || '');
  const head = text.slice(0, 60000);
  if (/website-login\/captcha|滑动验证|拖动滑块|完成验证/i.test(head)) return 'captcha';
  const login = unwrap(unwrap(state)?.login);
  if (login && login.showLogin === true) return 'login';
  if (/请先登录|扫码登录|登录后查看|登录后可/.test(head)) return 'login';
  if (/你访问的页面不存在|页面不存在|内容不存在|已被删除|笔记已删除/.test(head)) return 'notfound';
  return '';
}

/** 主页 / 搜索这类「列表页」是否被登录墙挡住（这类页面站点不做 SSR，没 cookie 就是空壳）。 */
export function isXhsLoginWall(state) {
  const login = unwrap(unwrap(state)?.login);
  return Boolean(login && login.showLogin === true);
}

/**
 * 游客态。小红书**不会**在匿名页面里把 `login.showLogin` 设成 true（实测一直是 false），
 * 所以判断「没数据是不是因为没登录」只能看 `user.loggedIn === false` / `userInfo.guest === true`。
 * 注意：这只说明「没登录」，不说明「这个页面必须登录」——单篇笔记匿名也能读，
 * 要不要报「请登录」由调用方结合「抓的是主页/搜索还是单篇」来决定。
 */
export function isXhsGuest(state) {
  const user = unwrap(unwrap(state)?.user);
  if (!user) return false;
  if (user.loggedIn === false) return true;
  return unwrap(user.userInfo)?.guest === true;
}
