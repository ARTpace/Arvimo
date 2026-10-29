// 图站抓取注册表（Picture Sites）。
//
// 与 image-sources.mjs 平行：image-sources 处理「1 个 3D 资产 → 它的图」，本注册表处理
// 「1 个图站 URL（画师主页 / 画板 / 单作品）→ 整站多作品多图」。两者返回同一形状
// `{items:[{url,title,width,height}], title, author, cover, source, rendition}`，下游的
// runImageJob / 下载队列 / 本地库预览完全复用，互不感知平台差异。
//
// 接入方式：collectImageAssets(platform,...) 已在此 dispatch——图站 platform id 命中本表就走这里，
// 否则回落 image-sources。downloadImage 经 image-store 的 IMAGE_CLIENTS 出域白名单放行图站 CDN。
import {readPublic} from './public-http.mjs';
import {resolvePinterest} from './pinterest-proxy.mjs';
import {renderDom, headlessAvailable} from './headless-dom.mjs';
import {renderHtml, capturePage, syncCookies, releaseProfile, harvestCookies} from './browser-session.mjs';
// 挑战 cookie 保活：站酷这类站的 cookie 一过期，纯 HTTP 就掉回挑战页，只能退回 15~20s 渲染。
// 解析这边只负责「报告用过 / 刚拿到过」，续期由 cookie-warmer 在后台做。
import {noteUse, noteHarvest} from './cookie-warmer.mjs';
import {browserProfileDir, cookieHeaderFor} from './cookie-jar.mjs';

/** Pixiv 游客态 AJAX 需要的伪装头；缺 Referer 会被站点以 403 打回。 */
const PIXIV_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://www.pixiv.net/',
  Accept: 'application/json',
};

async function pixivJson(url, open, signal) {
  const r = await readPublic(url, { headers: PIXIV_HEADERS, signal, maxBytes: 8 * 1024 * 1024 });
  try {
    return JSON.parse(r.body.toString('utf8'));
  } catch {
    throw new Error('Pixiv 返回的不是有效 JSON（可能需登录或站点拒绝访问）');
  }
}

const parsePixivUrl = (url) => {
  const clean = String(url || '').trim();
  const illust = clean.match(/\/artworks\/(\d+)/i);
  if (illust) return { type: 'illust', id: illust[1] };
  const user = clean.match(/\/users\/(\d+)/i);
  if (user) return { type: 'user', id: user[1] };
  return { type: 'unknown', id: '' };
};

async function resolvePixiv({ url }, { open, signal, maxItems = Infinity } = {}) {
  const { type, id } = parsePixivUrl(url);
  if (type === 'unknown' || !id) {
    throw new Error('无法识别的 Pixiv 链接，需包含 /users/用户ID 或 /artworks/作品ID');
  }

  const items = [];
  let title = 'Pixiv';
  let author = 'Pixiv Artist';

  if (type === 'illust') {
    const json = await pixivJson(`https://www.pixiv.net/ajax/illust/${id}`, open, signal);
    if (json.error || !json.body) throw new Error(json.message || '获取 Pixiv 作品详情失败');
    const b = json.body;
    title = b.title || title;
    author = b.userName || author;

    let pages = [];
    try {
      const pj = await pixivJson(`https://www.pixiv.net/ajax/illust/${id}/pages`, open, signal);
      if (!pj.error && Array.isArray(pj.body)) pages = pj.body;
    } catch { /* 单页作品没有 pages 接口，忽略 */ }
    if (!pages.length && b.urls) {
      pages = [{ urls: { original: b.urls.original, regular: b.urls.regular }, width: b.width || 1920, height: b.height || 1080 }];
    }

    pages.forEach((p, i) => {
      const original = p.urls?.original;
      if (!original) return;
      const w = p.width || 1920;
      const h = p.height || 1080;
      // urls.regular 就是 pixiv 的 1200px 变体，正好当缩略图（图片墙只加载它）。
      items.push({
        url: original,
        thumb: p.urls?.regular || '',
        title: pages.length > 1 ? `${title} (p${i + 1})` : title,
        width: w, height: h,
        // pixiv 的作者主页能被本 resolver 直接解析（/users/{id} 会拉全量作品），所以给 authorUrl。
        author,
        authorUrl: b.userId ? `https://www.pixiv.net/users/${b.userId}` : '',
        pageUrl: `https://www.pixiv.net/artworks/${id}`,
      });
    });
    return { items, skipped: [], title, author, cover: items[0]?.url || null, source: String(url), rendition: 'original' };
  }

  // type === 'user'：拉取公开作品库全量，逐张拼原图直链
  const json = await pixivJson(`https://www.pixiv.net/ajax/user/${id}/profile/all`, open, signal);
  if (json.error || !json.body) throw new Error(json.message || '获取 Pixiv 用户作品列表失败');
  const ids = [...Object.keys(json.body.illusts || {}), ...Object.keys(json.body.manga || {})];
  if (!ids.length) throw new Error('该 Pixiv 用户未发布任何公开作品');

  const BATCH = 48;
  for (let i = 0; i < ids.length && items.length < maxItems; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const q = chunk.map((w) => `ids[]=${w}`).join('&');
    const bj = await pixivJson(
      `https://www.pixiv.net/ajax/user/${id}/profile/illusts?${q}&work_category=illustManga&is_first_page=1`,
      open,
      signal
    );
    const works = bj.body?.works || {};
    for (const wid of chunk) {
      const w = works[wid];
      if (!w || !w.url) continue;
      const base = (w.url.match(/img\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d+/) || [])[0];
      if (!base) continue;
      const pc = w.pageCount || 1;
      title = w.title || title;
      author = w.userName || author;
      const w_ = w.width || 1920;
      const h_ = w.height || 1080;
      for (let p = 0; p < pc; p++) {
        const original = `https://i.pximg.net/img-original/${base}_p${p}.png`;
        // 缩略图变体：pixiv 的 master1200（长边 1200，约 200–400KB）；原图常常 2–8MB。
        // 图片墙只加载它，点开大图与下载仍用 original。
        const thumb = `https://i.pximg.net/img-master/${base}_p${p}_master1200.jpg`;
        items.push({
          url: original,
          thumb,
          title: pc > 1 ? `${w.title || title} (P${p + 1})` : (w.title || title),
          width: w_, height: h_,
          // 画师主页逐张给：一个用户的收藏里可能混着很多画师，按作品各自归属才不会张冠李戴。
          author: String(w.userName || '').trim(),
          authorUrl: w.userId ? `https://www.pixiv.net/users/${w.userId}` : '',
          pageUrl: wid ? `https://www.pixiv.net/artworks/${wid}` : '',
        });
      }
    }
  }
  return { items, skipped: [], title, author, cover: items[0]?.url || null, source: String(url), rendition: 'original' };
}

// ---------- 共享 helper ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** 带伪装头的 JSON 读取；artstation:true 让 ArtStation 域名在 403 时降级 curl-impersonate。 */
async function fetchJson(url, { headers = {}, artstation = false, signal, maxBytes = 8 * 1024 * 1024 } = {}) {
  const r = await readPublic(url, { headers, artstation, signal, maxBytes });
  const text = r.body.toString('utf8');
  if (/^\s*</.test(text)) throw new Error('站点返回了网页而非数据，可能被反爬 / WAF 过滤拦截（当前网络无法抓取）');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('站点返回的不是有效 JSON（可能需要登录，或站点拒绝访问）');
  }
}
const MAX_PAGES = 10;

// ---------- booru 三站（Safebooru / Yande.re / Konachan）共用工厂 ----------
// 三者都是 Danbooru 风格：Safebooru 走 dapi（index.php?page=dapi&s=post&q=index&json=1），
// Yande.re / Konachan 走 /post.json。返回结构都是帖子数组，每张带 file_url / 宽高。
function makeBooruSite({ id, label, client, host, referer, dapi }) {
  return {
    id,
    label,
    client,
    search: true,                               // booru 的看家本领就是标签搜索，关键词直接当 tags
    async resolve({ url }, { signal, maxItems = Infinity } = {}) {
      // 纯关键词 → 标签（booru 用空格分隔多个标签，天然支持「city night」这种多词）。
      const raw = String(url || '').trim();
      let tags = '';
      if (raw && !/^https?:\/\//i.test(raw)) tags = raw;
      else {
        try {
          tags = new URL(raw).searchParams.get('tags') || '';
        } catch { /* 非标准链接也能进，默认抓最新 */ }
      }
      const items = [];
      const seen = new Set();
      // booru 的标签库只有英文：中文关键词发过去站点会回 HTML 错误页，不如直接说清楚。
      if (/[\u4e00-\u9fa5]/.test(tags)) {
        throw new Error(`${label} 只认英文标签，试试 landscape / city / sunset 这类词（多个标签用空格分隔）`);
      }
      for (let page = 0; page < MAX_PAGES && items.length < maxItems; page++) {
        const api = dapi
          ? `https://${host}/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent(tags)}&pid=${page * 100}`
          : `https://${host}/post.json?tags=${encodeURIComponent(tags)}&page=${page + 1}&limit=100`;
        let data;
        try {
          data = await fetchJson(api, { headers: { 'User-Agent': UA, Referer: referer }, signal });
        } catch (e) {
          if (page === 0) throw e;
          break;
        }
        const posts = Array.isArray(data) ? data : (data && data.post) || [];
        if (!posts.length) break;
        for (const p of posts) {
          const file = p.file_url || p.jpeg_url || p.sample_url;
          if (!file || seen.has(file)) continue;
          seen.add(file);
          // preview_url 是几十 KB 的小图，图片墙用它；没有就回退原图（前端 `thumb||url`）。
          items.push({
            url: file,
            thumb: p.preview_url || '',
            title: tags || label,
            width: Number(p.width) || 0,
            height: Number(p.height) || 0,
            // 作者只有 yande.re / konachan 的 post.json 里有（safebooru 常为 null）。
            // booru 站没有「作者主页」这种页面，所以只给作品详情页，不给 authorUrl。
            author: String(p.author || '').trim(),
            pageUrl: p.id ? (dapi ? `https://${host}/index.php?page=post&s=view&id=${p.id}` : `https://${host}/post/show/${p.id}`) : '',
            tags: String(p.tags || '').split(/\s+/).filter(Boolean).slice(0, 12),
            sourceUrl: String(p.source || '').trim(),
          });
        }
        if (items.length >= maxItems || posts.length < 100) break;
      }
      if (!items.length) throw new Error(`${label} 没有返回任何图片，可能该标签下无作品或站点拒绝访问`);
      return { items, skipped: [], title: tags || label, author: label, cover: items[0].url, source: raw, rendition: 'original' };
    },
  };
}

// ---------- 通用 HTML 图站工厂（站酷 / Designspiration / 花瓣） ----------
// 这些站没有公开 JSON 接口，但页面是服务端渲染、初始 HTML 里就带图片直链（已实测各站几百张）。
// 直接抓粘贴的页面、正则取图，按站点的图床域名过滤噪声，必要时升级缩略图尺寸。
function makeHtmlSite({ id, label, client, imgTest, dropTest, upgrade, cap = 300, searchUrl }) {
  return {
    id,
    label,
    client,
    // searchUrl 存在 = 这个站能用关键词搜（前端据此把它标成可搜索）。
    ...(searchUrl ? { search: true } : {}),
    async resolve({ url }, { signal, maxItems = Infinity } = {}) {
      const raw = String(url || '').trim();
      // 纯关键词：有站内搜索地址就拼过去，没有就明确拒绝（前端不会派发，这里只是兜底）。
      if (raw && !/^https?:\/\//i.test(raw) && !searchUrl) {
        throw new Error(`${label} 暂不支持关键词搜索，请把页面链接粘到搜索框`);
      }
      const target = raw && !/^https?:\/\//i.test(raw) ? searchUrl(raw) : raw;
      const limit = Math.min(cap, maxItems);
      let html;
      try {
        const r = await readPublic(target, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal, maxBytes: 6 * 1024 * 1024 });
        html = r.body.toString('utf8');
      } catch (e) {
        throw new Error(`抓取 ${label} 页面失败：${e.message}`);
      }
      const seen = new Set();
      const items = [];
      // 先把 Next.js 的 JSON 转义在整段 HTML 上还原：斜杠写成 `\/`、`&` 写成 `\u0026`、`=` 写成 `\u003d`。
      // 必须整段先还原再扫描 —— 否则正则会在 `\u0026` 处截断，站酷那种 `?k=签名&t=时间戳` 的图只剩 k，
      // 少一半签名直接 403（图片墙全裂就是这个原因）。
      const flat = html
        .replace(/\\u0026/gi, '&')
        .replace(/\\u003d/gi, '=')
        .replace(/\\u002f/gi, '/')
        .replace(/\\\//g, '/');
      const re = /https?:\/\/[^"'\s<>()\\]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>\\]*)?/gi;
      let m;
      while ((m = re.exec(flat))) {
        let u = m[0].replace(/&amp;/g, '&');
        if (!imgTest.test(u)) continue;
        if (dropTest && dropTest.test(u)) continue;
        if (upgrade) u = upgrade(u);
        if (seen.has(u)) continue;
        seen.add(u);
        items.push({ url: u, title: label, width: 0, height: 0 });
        if (items.length >= limit) break;
      }
      if (!items.length) throw new Error(`${label} 页面没有可识别的图片（可能需要登录或页面已改版）`);
      return { items, skipped: [], title: label, author: label, cover: items[0].url, source: target, rendition: 'original' };
    },
  };
}

// ---------- Wallhaven ----------
const resolveWallhaven = {
  id: 'wallhaven',
  label: 'Wallhaven 壁纸',
  client: 'wallhaven',
  search: true,
  async resolve({ url }, { signal, maxItems = Infinity } = {}) {
    // 纯关键词 → 搜索词（Wallhaven 的 q 支持 `city night` 这种多词，也支持 @tag / id: 语法）。
    const raw = String(url || '').trim();
    let q = '';
    if (raw && !/^https?:\/\//i.test(raw)) q = raw;
    else {
      try {
        q = new URL(raw).searchParams.get('q') || '';
      } catch { /* 默认抓最新 */ }
    }
    const items = [];
    const seen = new Set();
    for (let page = 1; page <= MAX_PAGES && items.length < maxItems; page++) {
      const api = `https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(q)}&page=${page}`;
      let data;
      try {
        data = await fetchJson(api, { headers: { 'User-Agent': UA, Referer: 'https://wallhaven.cc/' }, signal });
      } catch (e) {
        if (page === 1) throw e;
        break;
      }
      const arr = (data && data.data) || [];
      if (!arr.length) break;
      for (const it of arr) {
        if (!it.path || seen.has(it.path)) continue;
        seen.add(it.path);
        // thumbs.small 约 30KB（原图常常 5MB+）；缩略图域名 th.wallhaven.cc 已在 CDN 白名单里。
        items.push({
          url: it.path,
          thumb: (it.thumbs && (it.thumbs.small || it.thumbs.large)) || '',
          title: q || 'Wallhaven',
          width: Number(it.dimension_x) || 0,
          height: Number(it.dimension_y) || 0,
          // Wallhaven 不公开上传者，没有 author；it.url 是壁纸详情页（可看分辨率/标签/下载原图）。
          pageUrl: it.url || (it.id ? `https://wallhaven.cc/w/${it.id}` : ''),
        });
      }
      if (items.length >= maxItems || !data.meta || !data.meta.next_page) break;
    }
    if (!items.length) throw new Error(`Wallhaven 没有返回任何图片${q ? `（关键词「${q}」无结果，换个词试试）` : ''}`);
    return { items, skipped: [], title: q || 'Wallhaven', author: 'Wallhaven', cover: items[0].url, source: raw, rendition: 'original' };
  },
};

// ---------- Civitai ----------
const resolveCivitai = {
  id: 'civitai',
  label: 'Civitai 图库',
  client: 'civitai',
  async resolve({ url }, { signal, maxItems = Infinity } = {}) {
    let user = '';
    try {
      const u = new URL(String(url));
      const seg = u.pathname.split('/').filter(Boolean);
      // civitai 的作者页是 /user/{username}，第一段是固定前缀 `user`，不能直接当用户名。
      user = (seg[0] === 'user' || seg[0] === 'users') ? (seg[1] || '') : (seg[0] || u.searchParams.get('username') || '');
    } catch { /* 默认可不带用户名，抓公开流 */ }
    const items = [];
    let cursor = null;
    let page = 0;
    do {
      let api = `https://civitai.com/api/v1/images?limit=100${user ? `&username=${encodeURIComponent(user)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      let data;
      try {
        data = await fetchJson(api, { headers: { 'User-Agent': UA, Referer: 'https://civitai.com/' }, signal });
      } catch (e) {
        if (page === 0) throw e;
        break;
      }
      const arr = (data && data.items) || [];
      if (!arr.length) break;
      for (const it of arr) {
        if (!it.url) continue;
        const title = (it.meta && it.meta.prompt) ? String(it.meta.prompt).slice(0, 60) : (user ? `Civitai · ${user}` : 'Civitai');
        const who = String(it.username || user || '').trim();
        // civitai 的图 URL 里 `original=true` 是原图档，换成 `width=450` 就是缩略图档（同一张图的服务端裁剪）。
        const thumb = String(it.url).replace('/original=true/', '/width=450/');
        items.push({
          url: it.url,
          thumb: thumb !== it.url ? thumb : '',
          title, width: Number(it.width) || 0, height: Number(it.height) || 0,
          author: who,
          // civitai 的 resolve 支持 /user/{username} 这种地址，所以作者可点。
          authorUrl: who ? `https://civitai.com/user/${encodeURIComponent(who)}` : '',
          pageUrl: it.id ? `https://civitai.com/images/${it.id}` : '',
        });
      }
      cursor = (data && data.metadata && data.metadata.nextCursor) || null;
      page++;
    } while (cursor && page < MAX_PAGES && items.length < maxItems);
    if (!items.length) throw new Error('Civitai 没有返回任何图片，可能该用户无公开作品');
    return { items, skipped: [], title: user ? `Civitai · ${user}` : 'Civitai', author: user || 'Civitai', cover: items[0].url, source: String(url), rendition: 'original' };
  },
};

// ---------- 站酷 ZCOOL ----------
// 站酷各类页面的可抓性差别极大，这里的分支比代码本身值钱（2026-10 实测）：
//   · /discover/{频道}    服务端渲染，HTML 直接带作品卡（封面 + 标题 + 作者 /u/ 链接）→ 纯 HTTP 就够
//   · /work/Zxxx.html     躲在阿里云 WAF「无感验证」后面（几十 KB 混淆过的浏览器环境校验，
//                         curl、Googlebot UA、curl-impersonate 都过不去）→ 必须真浏览器渲染；
//                         渲染后 JSON-LD 的 VisualArtwork.author 是可靠的作者来源
//   · /u/Zxxx=            外壳是空的，作品列表靠 JS 拉 → 必须真浏览器渲染（JSON-LD ProfilePage/Person 给作者）
//   · /search/...         结果纯客户端异步拉，SSR 里只有 29 张分类封面；用浏览器渲染这个页面又永远结束不了
//                         → 不做关键词搜索（返回分类封面冒充搜索结果比报错更糟）
const ZCOOL_ORIGIN = 'https://www.zcool.com.cn';
// 站酷的缩略图不是独立地址，而是在原图后面挂阿里云 OSS 图片处理参数（实测 4.6MB 原图 → 48KB webp）。
const ZCOOL_RESIZE = 'x-oss-process=image/resize,m_fill,w_520,h_390,limit_1/auto-orient,1/sharpen,100/quality,q_80/format,webp';

/** 阿里云 WAF 挑战页的判据：体积小且没有任何作品图。带 cookie 的真页面是 500KB、几百个 img.zcool.cn。 */
function zcoolBlocked(html) {
  if (!html || html.length < 30000) return true;
  return !/img\.zcool\.cn/i.test(html);
}

/** 还原 Next.js 的 JSON 转义：`&`→\u0026、`=`→\u003d、`/`→\u002f、`\/`，必须整段先还原再扫描，
 *  否则正则会在转义处截断，签名少一半直接 403（站酷图片墙全裂就是这个原因）。 */
function zcoolFlat(html) {
  return String(html)
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}
/** 原图：只去掉 x-oss-process 参数，k / t 签名必须保留。 */
function zcoolOriginal(u) {
  return String(u || '').replace(/[?&]x-oss-process=[^"'\s]*$/i, '').replace(/[?&]$/, '');
}
/** 缩略图：已经带处理参数就直接用，否则挂上 resize 参数。 */
function zcoolThumb(u) {
  const s = String(u || '');
  if (!s || /x-oss-process=/i.test(s)) return s;
  return s + (s.includes('?') ? '&' : '?') + ZCOOL_RESIZE;
}
function zcoolJsonLd(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      if (j) out.push(j);
    } catch { /* 不是合法 JSON 就跳过 */ }
  }
  return out;
}
/** 抽作品卡：站酷的频道页（SSR）和渲染后的个人主页用的是同一套卡片结构。 */
function zcoolCards(text, limit) {
  // 一张卡里有两三个都指向作品的 <a>（封面、标题…），只保留「后面紧跟着封面图」的那个当卡片起点，
  // 否则卡片区间会在标题链接处就被截断，作者名（在标题后面）就落不进这段区间。
  const anchors = [...text.matchAll(/<a\b[^>]*href="((?:https?:\/\/www\.zcool\.com\.cn)?\/work\/Z[\w=]+\.html)"[^>]*>/g)]
    .filter((a) => /<img\b/i.test(text.slice(a.index, a.index + 600)));
  const items = [];
  const seen = new Set();
  for (let i = 0; i < anchors.length && items.length < limit; i++) {
    const a = anchors[i];
    const href = a[1].startsWith('http') ? a[1] : ZCOOL_ORIGIN + a[1];
    if (seen.has(href)) continue;
    const seg = text.slice(a.index, anchors[i + 1] ? anchors[i + 1].index : Math.min(text.length, a.index + 4000));
    const img = seg.slice(a[0].length).match(/<img\b[^>]*>/i);
    const src = img ? (img[0].match(/\bsrc="([^"]+)"/i) || [])[1] || '' : '';
    if (!src || !/img\.zcool\.cn\//i.test(src)) continue;
    seen.add(href);
    const uid = (seg.match(/href="(?:https?:\/\/www\.zcool\.com\.cn)?\/u\/(Z[\w=]+)"/i) || [])[1] || '';
    // 作者名在 cardUserName 那个节点上，站酷把 title 写在 class 前面（`<span title="抓抓太" class="… cardUserName">`），
    // 所以不能按「class 在前 title 在后」去匹配，先把整个开始标签捞出来再各取所需。
    const nameTag = (seg.match(/<[a-z]+[^>]*cardUserName[^>]*>/i) || [''])[0];
    const author = (nameTag.match(/title="([^"]*)"/i) || [])[1]
      || (nameTag.match(/>([^<]+)</) || [])[1] || '';
    items.push({
      url: zcoolOriginal(src),
      thumb: src,
      title: (a[0].match(/title="([^"]*)"/i) || [])[1] || '站酷作品',
      author: author.trim(),
      authorUrl: uid ? `${ZCOOL_ORIGIN}/u/${uid}` : '',
      pageUrl: href,
    });
  }
  return items;
}
const resolveZcool = {
  id: 'zcool',
  label: '站酷 ZCOOL',
  client: 'zcool',
  async resolve({ url }, { signal, maxItems = Infinity } = {}) {
    const raw = String(url || '').trim();
    if (raw && !/^https?:\/\//i.test(raw)) {
      throw new Error('站酷的关键词搜索由浏览器端异步加载，抓不到稳定结果；请在站酷站内搜完后，把作品页 / 创作者主页（/u/…）/ 频道页（/discover/…）链接粘过来');
    }
    const limit = Math.min(300, maxItems);
    const kind = /\/work\//i.test(raw) ? 'work' : (/\/u\//i.test(raw) ? 'user' : 'other');
    const host = (() => { try { return new URL(raw).hostname; } catch { return ''; } })();
    if (host) noteUse(host);

    // 1) 先试纯 HTTP（会自动带上该域名的登录态 cookie）。用户在这个站登录过、或浏览器跑过一次
    //    挑战之后，作品页 / 创作者页都能直取 —— 实测作品页 23KB 挑战页 → 505KB 真页面，比渲染快一个数量级。
    let html = '';
    let via = '';
    try {
      const r = await readPublic(raw, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal, maxBytes: 8 * 1024 * 1024 });
      const body = r.body.toString('utf8');
      if (!zcoolBlocked(body)) { html = body; via = 'http'; if (host) noteHarvest(host); }
    } catch (e) {
      if (signal?.aborted) throw e;      // 用户取消要如实抛出，不能当成「没抓到」继续开浏览器
    }

    // 2) 被 WAF 挡住（没 cookie 时必然如此）：交给本机浏览器跑完 JS。
    //    跑完的挑战 cookie 会自动落进 cookie 仓库，下次同一页面就走上面的快路径。
    if (!html) {
      if (!headlessAvailable()) {
        throw new Error('站酷作品页 / 创作者页有防爬验证（阿里云 WAF），需要本机装有 Chrome 或 Edge 才能渲染；也可以改用 /discover/ 频道页链接');
      }
      // 先走 CDP 常驻实例（快，顺带能抓网络图片）；被挑战卡住再换 --dump-dom + virtual-time。
      // 后者是唯一能跑完阿里云 WAF 的通道（CDP 普通模式会一直卡在 68KB 挑战页，加虚拟时间导航会挂死），
      // 跑完 cookie 留在共享 profile 里，靠 harvestCookies 读出来，下次同站请求就不用再渲染。
      html = await renderHtml(raw, { timeout: 22000, quiet: 1200 }).catch(() => '');
      if (!html || zcoolBlocked(html)) {
        await releaseProfile().catch(() => {});
        html = await renderDom(raw, { timeout: 32000, budget: 9000, profileDir: browserProfileDir() }).catch(() => '');
        await harvestCookies({ host: new URL(raw).hostname }).catch(() => {});
      }
      if (!html) throw new Error('站酷页面渲染超时（可能被 WAF 拦住），稍后重试或换频道页链接');
      via = 'browser';
      // 渲染这条路已经把 cookie 收割进仓库了，告诉续期器「现在这批是新的」，
      // 它就会按 acw_tc 的到期时间（约 30 分钟）提前 6 分钟再续一次。
      if (host) noteHarvest(host);
    }
    const flat = zcoolFlat(html);
    const lds = zcoolJsonLd(html);

    if (kind === 'work') {
      const work = lds.find((j) => String(j['@type']).includes('VisualArtwork')) || {};
      const author = String((work.author && work.author.name) || '').trim();
      const authorUrl = String((work.author && work.author.url) || '').trim();
      const crumb = lds.find((j) => String(j['@type']).includes('BreadcrumbList'));
      const tags = crumb && Array.isArray(crumb.itemListElement)
        ? crumb.itemListElement.map((x) => x && x.name).filter((n) => n && n !== '站酷首页').slice(0, 6)
        : [];
      const cover = String(work.image || '');
      // 同一个作品的多张图共用同一个 t= 签名时间戳；头像 / 导航图是别的签名，靠这个把它们筛掉。
      const stamp = (cover.match(/[?&]t=([^&"'\s]+)/) || [])[1] || '';
      const items = [];
      const seen = new Set();
      const push = (u) => {
        const orig = zcoolOriginal(String(u).replace(/&amp;/g, '&'));
        if (!orig || seen.has(orig)) return;
        if (!/img\.zcool\.cn\//i.test(orig) || /\/tubelocation\//i.test(orig)) return;
        seen.add(orig);
        items.push({
          url: orig,
          thumb: zcoolThumb(orig),
          title: String(work.name || '站酷作品'),
          author,
          authorUrl,
          pageUrl: raw,
          tags,
        });
      };
      push(cover);
      for (const m of flat.matchAll(/https?:\/\/img\.zcool\.cn\/[^"'\s<>]+/g)) {
        const u = m[0];
        if (/x-oss-process=/i.test(u)) continue;          // 带处理参数的是缩略图 / 头像 / 导航图标
        if (stamp && !u.includes(`t=${stamp}`)) continue;  // 别的时间戳 = 推荐位、导航图
        push(u);
      }
      if (items.length > limit) items.length = limit;
      if (!items.length) throw new Error('站酷作品页里没解析到图片，页面可能已改版');
      return {
        items, skipped: [],
        title: String(work.name || '站酷作品'),
        author: author || '站酷',
        cover: items[0].url,
        source: raw,
        rendition: 'original',
      };
    }

    if (kind === 'user') {
      const person = lds.find((j) => String(j['@type']).includes('Person'))
        || (lds.find((j) => j.mainEntity) || {}).mainEntity || {};
      const author = String(person.name || '').trim();
      const authorUrl = String(person.url || raw).trim();
      const items = zcoolCards(flat, limit);
      // 创作者主页上的卡片刻意不重复显示作者名，这里统一回填页主，前端就能「点作者看他的作品」。
      for (const it of items) {
        if (author) it.author = author;
        it.authorUrl = authorUrl;
      }
      if (!items.length) throw new Error('该站酷创作者主页没有公开作品（或页面还没渲染出作品列表）');
      return { items, skipped: [], title: author ? `站酷 · ${author}` : '站酷创作者主页', author: author || '站酷', cover: items[0].url, source: raw, rendition: 'original' };
    }

    const items = zcoolCards(flat, limit);
    if (!items.length) throw new Error('这个站酷页面上没有解析到作品，换作品页 / 创作者主页 / 频道页链接试试');
    return { items, skipped: [], title: '站酷 ZCOOL', author: items[0].author || '站酷', cover: items[0].url, source: raw, rendition: 'original' };
  },
};
const resolveDesignspiration = makeHtmlSite({
  id: 'designspiration',
  label: 'Designspiration',
  client: 'designspiration',
  imgTest: /dspncdn\.com\/a1\/media\//i,
  dropTest: /favicon|apple-touch|logo|icon|\/a1\/webapp\//i,
  upgrade: (u) => u.replace(/\/a1\/media\/(?:236|293|500)x\//, '/a1/media/736x/'),
});
// ---------- 花瓣 Huaban ----------
// 网页本身已挂上 EdgeOne 的 JS 挑战（纯 HTTP 只拿到 ~1KB 的混淆脚本，算不出那个 cookie），
// 但 api.huaban.com/v3 没设防，所以改走接口：
//   · 画板 /v3/boards/{id}/pins：分页用 `max` 游标（上一页最后一张的 pin_id），
//     `page` 参数无效（永远回第一页），limit 上限 100。
//   · 搜索 /v3/search/pins?q=：一页 20 条，同样用 `max` 翻。
//   · 图片直链 https://{bucket}.huaban.com/{key}，不需要 file.url 里那串会过期的 auth_key。
function huabanImageUrl(file) {
  if (!file || !file.key) return '';
  const key = String(file.key);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return '';
  return `https://${file.bucket || 'gd-hbimg'}.huaban.com/${key}`;
}
// 作者主页（huaban.com/用户名）：网页挂了 EdgeOne 的 JS 挑战，普通 UA 只拿到 1KB 混淆脚本，
// 但爬虫 UA 走的是服务端渲染分支，HTML 里带完整的 __NEXT_DATA__（user + 首页画板）。
// 所以只有「urlname → user_id」这一步要读网页，之后全部走 api.huaban.com/v3。
const HUABAN_BOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
/** 这些一级路径不是用户名：画板 / 单图 / 搜索等都是站点自己的功能页。 */
const HUABAN_RESERVED = new Set([
  'boards', 'pins', 'search', 'explore', 'categories', 'topics', 'download', 'app',
  'about', 'login', 'signup', 'help', 'terms', 'privacy', 'u', 'user', 'users',
]);

/** 画板对象 → 前端卡片需要的最小字段（cover 用第一张图拼直链）。
 *  thumb 是 CDN 的 `_fw236` 变体：实测同一张图 3.7MB → 255KB，画板墙几十张卡也不会拖慢首屏。 */
function huabanBoardCard(board) {
  const pins = Array.isArray(board?.pins) ? board.pins : [];
  const coverPin = pins.find((pin) => pin && pin.file && huabanImageUrl(pin.file));
  const id = String(board?.board_id || '');
  const cover = coverPin ? huabanImageUrl(coverPin.file) : null;
  return {
    id,
    title: String(board?.title || '未命名画板'),
    count: Number(board?.pin_count) || 0,
    cover,
    thumb: cover ? `${cover}_fw236` : null,
    url: `https://huaban.com/boards/${id}`,
    description: String(board?.description || ''),
  };
}

/** urlname → 用户对象。只读一次网页，失败时给明确原因，不静默降级。 */
async function huabanProfile(urlname, { signal } = {}) {
  let res;
  try {
    // 裸用户名会先 308 跳到 /user/用户名，openPublic 内部已跟随；直接给 /user/ 形式也能省一次跳转。
    res = await readPublic(`https://huaban.com/user/${encodeURIComponent(urlname)}`, {
      headers: { 'User-Agent': HUABAN_BOT_UA, Accept: 'text/html,application/xhtml+xml' },
      signal,
      maxBytes: 6 * 1024 * 1024,
    });
  } catch (e) {
    if (e.status === 404) throw new Error(`花瓣上没有这个用户「${urlname}」：主页地址 404，请打开作者主页后从浏览器地址栏复制完整链接`);
    throw e;
  }
  const html = res.body.toString('utf8');
  const raw = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!raw) throw new Error(`花瓣没有返回可解析的主页数据（收到 ${html.length} 字节，站点风控或页面结构已变）`);
  let data;
  try { data = JSON.parse(raw[1]); } catch { throw new Error('花瓣主页数据结构已变化，无法解析'); }
  const page = data?.props?.pageProps || {};
  if (!page.serversideUser || !page.serversideUser.user_id) throw new Error(`花瓣上没有这个用户「${urlname}」，请检查主页地址`);
  return { user: page.serversideUser, boards: Array.isArray(page.serversideBoards) ? page.serversideBoards : [] };
}

/** 该用户的全部画板。分页游标是上一页最后一块的 seq（limit 上限 100，page 参数无效）。 */
async function huabanBoards(userId, { headers, signal, pageCap = 20 } = {}) {
  const out = [];
  const seen = new Set();
  let cursor = '';
  for (let page = 0; page < pageCap; page++) {
    const api = `https://api.huaban.com/v3/users/${encodeURIComponent(userId)}/boards?limit=100${cursor ? `&max=${cursor}` : ''}`;
    const data = await fetchJson(api, { headers, signal });
    if (data && data.err) throw new Error(`花瓣接口返回错误：${data.msg || data.err}`);
    const list = Array.isArray(data?.boards) ? data.boards : [];
    if (!list.length) break;
    let added = 0;
    for (const board of list) {
      const card = huabanBoardCard(board);
      if (!card.id || seen.has(card.id)) continue;
      seen.add(card.id);
      out.push(card);
      added++;
    }
    const lastSeq = String(list[list.length - 1]?.seq || '');
    if (!added || !lastSeq || lastSeq === cursor || list.length < 100) break;
    cursor = lastSeq;
  }
  return out;
}

const resolveHuaban = {
  id: 'huaban',
  label: '花瓣 Huaban',
  client: 'huaban',
  search: true,                                 // 支持纯关键词输入（等价于 /search?q=）
  async resolve({ url }, { signal, maxItems = Infinity } = {}) {
    // 纯关键词（不是网址）等价于搜索页：前端把用户打的词直接丢进来，这里统一补成搜索 URL，
    // 免得每个调用点都要知道「这个站的搜索地址长什么样」。
    const input = String(url || '').trim();
    const target = !input || /^https?:\/\//i.test(input)
      ? input
      : `https://huaban.com/search?q=${encodeURIComponent(input)}`;
    const boardId = (target.match(/huaban\.com\/boards\/(\d+)/i) || [])[1];
    let q = '';
    if (!boardId) {
      try { q = new URL(target).searchParams.get('q') || ''; } catch { /* 交给下面的报错 */ }
    }
    // 作者主页：/用户名、/u/数字、/用户名/boards 都归到「画板列表」这一层。
    // 这一层只返回画板卡片（不展开成几百张图），点某块画板再走一次解析取它的图片。
    if (!boardId && !q) {
      // /u/数字、/user/数字、/user/用户名、/用户名 四种写法都归到「画板列表」这一层。
      let userRef = (target.match(/huaban\.com\/(?:u|user|users)\/([\w.-]+)/i) || [])[1] || '';
      if (!userRef) {
        let segs = [];
        try { segs = new URL(target).pathname.split('/').filter(Boolean); } catch { /* 非法 URL 走下面的报错 */ }
        if (segs.length && !HUABAN_RESERVED.has(segs[0].toLowerCase())) userRef = segs[0];
      }
      if (!userRef) {
        throw new Error('花瓣请粘作者主页（huaban.com/user/用户名）、画板（huaban.com/boards/数字）或搜索页（huaban.com/?q=关键词）');
      }
      const headers = { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://huaban.com/' };
      let user = null;
      let userId = userRef;
      if (/^\d+$/.test(userRef)) {
        try { const info = await fetchJson(`https://api.huaban.com/v3/users/${userRef}`, { headers, signal }); if (info && !info.err) user = info; } catch { /* 名字拿不到不影响画板列表 */ }
      } else {
        user = (await huabanProfile(userRef, { signal })).user;
        userId = String(user.user_id);
      }
      const boards = (await huabanBoards(userId, { headers, signal })).filter((board) => board.count > 0 || board.cover);
      if (!boards.length) throw new Error('这个花瓣用户没有公开画板（或画板都是空的）');
      const author = String(user?.username || '').trim();
      return {
        mode: 'boards',
        boards,
        items: [],
        skipped: [],
        title: author || '花瓣作者',
        author: author || '花瓣',
        cover: boards[0]?.cover || null,
        source: target,
        rendition: 'original',
        user: { id: String(userId), name: author, urlname: String(user?.urlname || userRef) },
      };
    }
    const headers = { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://huaban.com/' };
    // 分页两套参数，方向完全相反，别混用（都实测过）：
    //   · 画板 /v3/boards/{id}/pins：`limit=100` + `max=上一页最后一张 pin_id`；`page` 无效。
    //   · 搜索 /v3/search/pins：`per_page=100`（**不是 limit，limit 硬顶 20**）+ `page=页码`；
    //     `max` 在搜索接口上被完全忽略（传了永远回第一页），只有 page 会真的往后走。
    //     page 大约到 3 就翻不动了（再往后花瓣回退到同一批），靠下面的去重把它自然停住。
    const isSearch = !boardId;
    const perPage = 100;
    const pageLimit = Number.isFinite(maxItems)
      ? Math.max(1, Math.ceil(maxItems / perPage))
      : (isSearch ? 3 : 40);                    // 下载走全量：搜索约 300 张上限，画板给 40 页（868 张≈9 页）
    const items = [];
    const seen = new Set();                     // 搜索翻页会有重叠，按图片地址去重
    let cursor = '';
    let boardTitle = boardId ? '' : q;
    let boardAuthor = '';
    let boardAuthorUrl = '';
    for (let page = 0; page < pageLimit; page++) {
      const api = boardId
        ? `https://api.huaban.com/v3/boards/${boardId}/pins?limit=100${cursor ? `&max=${cursor}` : ''}`
        : `https://api.huaban.com/v3/search/pins?q=${encodeURIComponent(q)}&per_page=100&page=${page + 1}`;
      const data = await fetchJson(api, { headers, signal });
      if (data && data.err) throw new Error(`花瓣接口返回错误：${data.msg || data.err}（画板可能需要登录或已删除）`);
      const list = Array.isArray(data?.pins) ? data.pins : [];
      if (!list.length) break;
      if (page === 0 && data.board) {
        if (data.board.title) boardTitle = data.board.title;
        // 画板响应里带 board.user（user_id / username / urlname）—— 画板里的图都是这个作者，
        // 一次就能给全部 items 填上作者名与主页，不用逐张去查。
        const bu = data.board.user;
        if (bu && bu.user_id) {
          boardAuthor = String(bu.username || '').trim();
          boardAuthorUrl = bu.urlname ? `https://huaban.com/user/${bu.urlname}` : `https://huaban.com/user/${bu.user_id}`;
        }
      }
      let added = 0;
      for (const pin of list) {
        const file = pin && pin.file;
        if (!file || (file.type && !/^image\//.test(String(file.type)))) continue;
        const image = huabanImageUrl(file);
        if (!image || seen.has(image)) continue;
        seen.add(image);
        items.push({
          url: image,
          // 缩略图变体：CDN 认 `_fw480`（原图 1.7MB → 173KB），图片墙几十张才不会一次拉几百 MB。
          // 只用于预览，下载与放大仍走上面的原图 url。
          thumb: `${image}_fw480`,
          title: String(pin.raw_text || boardTitle || '花瓣').slice(0, 80),
          width: Number(file.width) || 0,
          height: Number(file.height) || 0,
          // 搜索结果的每张图可能来自不同作者，所以逐张用 pin.user_id 拼主页；
          // 画板层已有作者名，直接复用（名字拿不到就留空，前端回退到整批作者）。
          author: boardAuthor,
          authorUrl: boardAuthorUrl || (pin.user_id ? `https://huaban.com/user/${pin.user_id}` : ''),
          pageUrl: pin.pin_id ? `https://huaban.com/pins/${pin.pin_id}` : '',
          sourceUrl: String(pin.link || '').trim(),
        });
        added++;
        if (items.length >= maxItems) break;
      }
      if (items.length >= maxItems) break;
      if (!added) break;                        // 整页都是非图片 / 整页都是已抓过的，别再往后翻了
      if (isSearch) continue;                   // 搜索靠页码推进，翻不动时上面的 !added 会收手
      const last = list[list.length - 1];
      const next = String(last?.pin_id || '');
      if (!next || next === cursor || list.length < perPage) break;
      cursor = next;
    }
    if (!items.length) {
      throw new Error(isSearch
        ? `花瓣没有搜到「${q}」的图片（换个关键词试试，或直接在花瓣网页确认有结果）`
        : '花瓣这个画板里没有可抓取的图片（可能是空的私有画板）');
    }
    return { items, skipped: [], title: boardTitle || '花瓣', author: boardAuthor || '花瓣', authorUrl: boardAuthorUrl, cover: items[0].url, source: target, rendition: 'original' };
  },
};

// ---------- 摄影三站：Pexels / Flickr / 500px ----------
// 三家网页版对脚本都不友好（Pexels 页面直接 403、500px 页面是客户端渲染、Flickr 列表懒加载），
// 但都有自己的「网页端正在用」的 JSON 通道，且都不需要用户去申请 API key：
//   · Pexels  /en-us/api/v3/...        + 请求头 secret-key（网页端内置的公开 key，不是 api.pexels.com 的用户 key）
//   · Flickr  /services/rest           + api_key 从页面 HTML 现抓（硬编码的 key 会过期，实测已过期）
//   · 500px   api-neo.500px.com/graphql + x-500px-platform / x-500px-device-id 伪装头（缺了就 400/403）
// 图片直链三站都能直接下载（CDN 不校验 Referer）；缩略图各取小档，别把几十 MB 原图塞进图片墙。

const PEXELS_ORIGIN = 'https://www.pexels.com';
const PEXELS_API = `${PEXELS_ORIGIN}/en-us/api/v3`;
/** 网页端内置的公开 secret-key（不是 api.pexels.com 的用户 API key；失效时从页面 HTML 里再抓一个）。 */
const PEXELS_WEB_KEY = 'H2jk9uKnhRmL6WPwh89zBezWvr';
const pexelsJson = (path, signal) => fetchJson(`${PEXELS_API}${path}`, {
  headers: { 'User-Agent': UA, 'secret-key': PEXELS_WEB_KEY, Referer: `${PEXELS_ORIGIN}/`, Accept: 'application/json' },
  signal,
});
/** pexels 的 URL 里，slug 后面那串数字才是 id（@用户名-{id} 同理，末尾数字是用户 id，不是作品 id）。 */
const pexelsTrailingId = (s) => (String(s || '').match(/(\d{4,})\/?$/)?.[1] || '');
function pexelsItem(a) {
  const img = a.image || {};
  const who = a.user || {};
  const id = Number(a.id) || 0;
  // 摄影师主页地址是 /@{slug}/，而 slug 本身通常已经带上了末尾的 -{用户id}，别再拼一次（会变成 -2572136-2572136）。
  const slug = String(who.slug || who.username || '').replace(new RegExp(`-${who.id}$`), '');
  return {
    // download_link 是「原始尺寸 jpg」，large 只有 w=1440，别混用。
    url: img.download_link || `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?cs=srgb&fm=jpg`,
    thumb: img.medium || img.small || '',
    title: a.alt || a.title || `Pexels #${id}`,
    width: Number(a.width) || 0,
    height: Number(a.height) || 0,
    author: [who.first_name, who.last_name].filter(Boolean).join(' ') || who.username || '',
    authorUrl: who.id && slug ? `${PEXELS_ORIGIN}/@${slug}-${who.id}/` : '',
    pageUrl: a.slug ? `${PEXELS_ORIGIN}/photo/${a.slug}-${id}/` : `${PEXELS_ORIGIN}/photo/${id}/`,
    tags: Array.isArray(a.tags) ? a.tags.slice(0, 12) : [],
  };
}
const resolvePexels = {
  id: 'pexels',
  label: 'Pexels 摄影图库',
  client: 'pexels',
  search: true,
  async resolve({ url }, { signal, maxItems = Infinity } = {}) {
    const raw = String(url || '').trim();
    let keyword = raw && !/^https?:\/\//i.test(raw) ? raw : '';
    let userId = '';
    let photoId = '';
    if (!keyword) {
      let u;
      try { u = new URL(raw); } catch { throw new Error('无法识别的 Pexels 链接'); }
      const seg = u.pathname.split('/').filter(Boolean);
      const head = seg[0] || '';
      if (head === 'photo' || head === 'photos') photoId = pexelsTrailingId(seg[1] || '');
      else if (head.startsWith('@')) userId = pexelsTrailingId(head);
      // 搜索页 /search/landscape/ 也当关键词处理，省得让用户再手打一遍。
      else if (head === 'search' && seg[1]) keyword = decodeURIComponent(seg[1]).replace(/-/g, ' ');
      else if (/^\d+$/.test(head)) userId = head;
    }

    // 单张作品
    if (photoId) {
      const j = await pexelsJson(`/photos/${photoId}`, signal);
      const it = j && j.data && j.data.attributes;
      if (!it) throw new Error('Pexels 没有返回这张作品（链接里的作品号可能不对）');
      return { items: [pexelsItem(it)], skipped: [], title: it.alt || `Pexels #${photoId}`, author: pexelsItem(it).author || 'Pexels', cover: pexelsItem(it).url, source: raw, rendition: 'original' };
    }

    // 摄影师主页 / 关键词搜索：都是「同一套列表结构 + 分页」
    if (!keyword && !userId) {
      throw new Error('Pexels 这串链接里找不到摄影师或作品编号；请粘摄影师主页（/@名字-数字/）或作品页（/photo/…-数字/），或直接输入关键词搜索');
    }
    const items = [];
    const seen = new Set();
    let total = Infinity;
    const base = keyword
      ? `/search/photos?query=${encodeURIComponent(keyword)}&per_page=80`
      : `/users/${userId}/photos?per_page=80`;
    for (let page = 1; page <= MAX_PAGES && items.length < maxItems; page++) {
      let j;
      try {
        j = await pexelsJson(`${base}&page=${page}`, signal);
      } catch (e) {
        if (page === 1) throw e;
        break;
      }
      const list = (j && j.data) || [];
      if (!list.length) break;
      total = Number(j.pagination && j.pagination.total_results) || total;
      for (const row of list) {
        const a = row.attributes || {};
        // 摄影师接口会混进 status:'rejected' 的非公开作品，别让它们进图片墙。
        if (a.status && a.status !== 'approved') continue;
        if (!a.id || seen.has(a.id)) continue;
        seen.add(a.id);
        items.push(pexelsItem(a));
        if (items.length >= maxItems) break;
      }
      const pages = Number(j.pagination && j.pagination.total_pages) || 1;
      if (page >= pages || page * 80 >= total) break;
    }
    if (!items.length) throw new Error(keyword ? `Pexels 没有搜到「${keyword}」的图片` : '这个 Pexels 摄影师主页没有公开作品');
    return {
      items, skipped: [],
      title: keyword ? `Pexels · ${keyword}` : `Pexels · ${items[0].author || userId}`,
      author: keyword ? 'Pexels' : (items[0].author || 'Pexels'),
      cover: items[0].url, source: raw, rendition: 'original',
    };
  },
};

// Flickr：官方 REST API 要 api_key，但**网页端自己那个 key 就在页面 HTML 里**（32 位 hex），
// 直接现抓最稳；写死任何一个迟早过期（素材下载器里那个 c0c34b... 现在返回 "Key has expired"）。
// 作品列表、相册、关键词搜索、单图都能走 REST，比抠页面稳。
let flickrKeyCache = { at: 0, key: '' };
async function flickrApiKey(signal) {
  if (flickrKeyCache.key && Date.now() - flickrKeyCache.at < 30 * 60 * 1000) return flickrKeyCache.key;
  // 首页没有这个字段（随便抓一个 32 位 hex 会得到 "Key not found"），搜索页和用户页才有，所以固定拿搜索页。
  const r = await readPublic('https://www.flickr.com/search/?text=landscape', { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal, maxBytes: 6 * 1024 * 1024 });
  const html = r.body.toString('utf8');
  const key = (html.match(/(?:api_key|site_key|apiKey)["']?\s*[:=]\s*["']([a-f0-9]{32})/i) || [])[1] || '';
  if (!key) throw new Error('没能从 Flickr 页面取到可用的 api_key（站点可能改版）');
  flickrKeyCache = { at: Date.now(), key };
  return key;
}
async function flickrCall(method, params, signal) {
  const key = await flickrApiKey(signal);
  const qs = new URLSearchParams({ method, api_key: key, format: 'json', nojsoncallback: '1', ...params });
  const j = await fetchJson(`https://api.flickr.com/services/rest/?${qs}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal });
  if (j && j.stat === 'fail') throw new Error(`Flickr 接口返回错误：${j.message || '未知原因'}`);
  return j;
}
/** url_o 是原图（常 5–10MB），列表页一律用 url_z / url_c 当缩略图。 */
function flickrItem(p, fallbackOwner = '') {
  // 尺寸必须跟「实际选中的那个档位」对齐，原来固定用 width_l 会把 2048 的图报成 1024。
  const tiers = [
    ['url_o', 'width_o', 'height_o'],
    ['url_k', 'width_k', 'height_k'],
    ['url_h', 'width_h', 'height_h'],
    ['url_l', 'width_l', 'height_l'],
    ['url_z', 'width_z', 'height_z'],
    ['url_c', 'width_c', 'height_c'],
    ['url_m', 'width_m', 'height_m'],
  ];
  const hit = tiers.find(([u]) => p[u]);
  const url = hit ? p[hit[0]]
    : (p.server && p.id && p.secret ? `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_b.jpg` : '');
  const owner = p.owner || '';
  // 链接一律用可读的 path_alias（/photos/nicointhebus/），没别名才退回 NSID 的 /people/{nsid}/。
  const slug = p.pathalias || p.path_alias || '';
  const authorUrl = slug ? `https://www.flickr.com/photos/${slug}/` : (owner ? `https://www.flickr.com/people/${owner}/` : '');
  return {
    url,
    thumb: p.url_z || p.url_c || p.url_m || url,
    title: p.title || `Flickr ${p.id}`,
    width: hit ? Number(p[hit[1]]) || 0 : 0,
    height: hit ? Number(p[hit[2]]) || 0 : 0,
    author: p.ownername || fallbackOwner || '',
    authorUrl,
    pageUrl: (slug || owner) ? `https://www.flickr.com/photos/${slug || owner}/${p.id}` : (p.id ? `https://www.flickr.com/photo.gne?id=${p.id}` : ''),
    tags: [],
  };
}
const FLICKR_EXTRAS = 'url_o,url_k,url_h,url_l,url_c,url_z,url_m,original_format,owner_name,path_alias,date_upload,date_taken';
const resolveFlickr = {
  id: 'flickr',
  label: 'Flickr 摄影社区',
  client: 'flickr',
  search: true,
  async resolve({ url }, { signal, maxItems = Infinity } = {}) {
    const raw = String(url || '').trim();
    const keyword = raw && !/^https?:\/\//i.test(raw) ? raw : '';
    let mode = keyword ? 'search' : 'user';
    let user = '';
    let setId = '';
    let photoId = '';
    if (!keyword) {
      let u;
      try { u = new URL(raw); } catch { throw new Error('无法识别的 Flickr 链接'); }
      const seg = u.pathname.split('/').filter(Boolean);
      // 形态：/photos/{作者}/、/people/{nsid}/、/photos/{作者}/albums/{相册id}、/photos/{作者}/{作品id}
      if (seg[0] === 'photos' || seg[0] === 'people') {
        user = seg[1] || '';
        if (seg[2] === 'albums' || seg[2] === 'sets' || seg[2] === 'collections') {
          setId = seg[3] || '';
          // /photos/{作者}/albums/ 后面没有相册 id 时，就是这位摄影师的作品集首页 → 按作者主页处理，别当相册去查。
          mode = setId ? 'set' : 'user';
        }
        else if (/^\d{6,}$/.test(seg[2] || '')) { photoId = seg[2]; mode = 'photo'; }
      } else if (seg[0] === 'photo.gne') {
        photoId = u.searchParams.get('id') || '';
        mode = 'photo';
      } else if (seg[0] === 'p') {
        throw new Error('短链接 flic.kr/p/… 需要先展开；请把 flickr.com 的原始作品链接粘过来');
      } else if (seg[0]) {
        user = seg[0];         // 老式 /用户名/ 形态
      }
    }

    if (mode === 'photo') {
      const sizes = await flickrCall('flickr.photos.getSizes', { photo_id: photoId }, signal);
      const arr = (sizes.sizes && sizes.sizes.size) || [];
      if (!arr.length) throw new Error('Flickr 没有返回这张作品的尺寸信息');
      const pick = (label) => arr.find((s) => s.label === label);
      const best = pick('Original') || pick('Large 2048') || pick('Large 1600') || pick('Large') || arr[arr.length - 1];
      const thumb = pick('Medium 640') || pick('Small 320') || best;
      let info = null;
      try { info = (await flickrCall('flickr.photos.getInfo', { photo_id: photoId }, signal)).photo; } catch { /* 没权限就只要图 */ }
      const it = {
        url: best.source,
        thumb: thumb.source,
        title: (info && info.title && info.title._content) || `Flickr ${photoId}`,
        width: Number(best.width) || 0,
        height: Number(best.height) || 0,
        author: (info && info.owner && (info.owner.realname || info.owner.username)) || '',
        authorUrl: (info && info.owner && (info.owner.path_alias || info.owner.nsid))
          ? (info.owner.path_alias ? `https://www.flickr.com/photos/${info.owner.path_alias}/` : `https://www.flickr.com/people/${info.owner.nsid}/`)
          : '',
        pageUrl: raw,
        tags: info && info.tags ? (info.tags.tag || []).map((t) => t._content).slice(0, 12) : [],
      };
      return { items: [it], skipped: [], title: it.title, author: it.author || 'Flickr', cover: it.url, source: raw, rendition: 'original' };
    }

    // 作者名（path alias）→ NSID。
    // ⚠️ findByUsername 只认「用户名」，/photos/{path_alias}/ 里的别名它一律回 User not found；
    // 必须先走 urls.lookupUser（吃整个主页 URL，别名和 NSID 都认），失败再退回 findByUsername（用户直接输纯用户名时）。
    let nsid = /^\d+@N\d+$/.test(user) ? user : '';
    if (!nsid && mode !== 'search') {
      if (!user) throw new Error('Flickr 链接里找不到作者，请粘摄影师主页或相册页');
      const tries = [];
      for (const slug of [user, decodeURIComponent(user)]) {
        if (!slug || tries.includes(slug)) continue;
        tries.push(slug);
        for (const home of [`https://www.flickr.com/photos/${slug}/`, `https://www.flickr.com/people/${slug}/`]) {
          try {
            const found = await flickrCall('flickr.urls.lookupUser', { url: home }, signal);
            nsid = (found.user && found.user.id) || '';
            if (nsid) break;
          } catch { /* 换下一个形态继续试 */ }
        }
        if (nsid) break;
      }
      if (!nsid) {
        try {
          const found = await flickrCall('flickr.people.findByUsername', { username: user }, signal);
          nsid = (found.user && found.user.nsid) || '';
        } catch (e) {
          if (mode === 'set') nsid = '';      // 相册接口只需要相册 id，作者查不到也能继续
          else throw new Error(`找不到这个 Flickr 用户（${user}）：${e.message}`);
        }
      }
      if (!nsid && mode !== 'set') throw new Error(`找不到这个 Flickr 用户（${user}），请确认主页地址是否正确`);
    }

    const items = [];
    const seen = new Set();
    const perPage = 100;
    for (let page = 1; page <= MAX_PAGES && items.length < maxItems; page++) {
      const params = { per_page: String(perPage), page: String(page), extras: FLICKR_EXTRAS, safe_search: '1' };
      let method;
      if (mode === 'search') { method = 'flickr.photos.search'; params.text = keyword; params.sort = 'relevance'; }
      else if (mode === 'set') { method = 'flickr.photosets.getPhotos'; params.photoset_id = setId; }
      else { method = 'flickr.people.getPhotos'; params.user_id = nsid; }
      let j;
      try {
        j = await flickrCall(method, params, signal);
      } catch (e) {
        if (page === 1) {
          if (mode === 'set') throw new Error(`这个相册取不到图（${setId}）：${e.message}；确认相册 id 正确且是公开相册`);
          throw e;
        }
        break;
      }
      const box = j.photos || j.photoset || {};
      const list = box.photo || [];
      if (!list.length) break;
      for (const p of list) {
        if (!p.id || seen.has(p.id)) continue;
        seen.add(p.id);
        items.push(flickrItem(p, user));
        if (items.length >= maxItems) break;
      }
      const pages = Number(box.pages) || 1;
      if (page >= pages || list.length < perPage) break;
    }
    if (!items.length) throw new Error(mode === 'search' ? `Flickr 没有搜到「${keyword}」的图片` : '这个 Flickr 页面没有公开作品');
    return {
      items, skipped: [],
      title: mode === 'search' ? `Flickr · ${keyword}` : `Flickr · ${user || nsid}`,
      author: mode === 'search' ? 'Flickr' : (items[0].author || user || 'Flickr'),
      cover: items[0].url, source: raw, rendition: 'original',
    };
  },
};

// 500px：GraphQL 是唯一稳定通道（网页 HTML 是客户端渲染，RSS 通道也早失效）。
// 注意两点：① 必须带 x-500px-platform / x-500px-device-id 伪装头，缺了直接 400；
//          ② 返回的图片地址是**限时签名**（expiry 约 2 天），下载要趁热，缓存久了会 403。
const PX_GQL = 'https://api-neo.500px.com/graphql';
const PX_HEADERS = {
  'User-Agent': UA,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Origin: 'https://500px.com',
  Referer: 'https://500px.com/',
  'x-500px-platform': 'web',
  'x-500px-device-id': 'b9f29135-23c8-472e-8c3b-15f18c5e93df',
};
/** 500px 的 /popular /search 这类不是用户名，直接当用户名去查会得到 null，先挡掉。 */
const PX_RESERVED = new Set(['p', 'photo', 'user', 'popular', 'upcoming', 'fresh', 'editors', 'search', 'groups', 'settings', 'stories', 'blog', 'about', 'licensing', 'market', 'challenges', 'join', 'login', 'signup', 'terms', 'privacy']);
export function parse500pxUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('无法识别的 500px 链接'); }
  if (!['http:', 'https:'].includes(u.protocol) || !/^(?:www\.)?500px\.com$/i.test(u.hostname)) throw new Error('无法识别的 500px 链接');
  const seg = u.pathname.split('/').filter(Boolean);
  const head = (seg[0] || '').toLowerCase();
  if (head === 'photo') {
    if (!/^[a-zA-Z0-9_-]+$/.test(seg[1] || '')) throw new Error('500px 作品链接里没有作品编号');
    return { photoId: seg[1] };
  }
  const username = head === 'p' || head === 'user' ? seg[1] : seg[0];
  if (!/^[a-zA-Z0-9_-]+$/.test(username || '') || PX_RESERVED.has(username.toLowerCase())) throw new Error('500px 这个链接不是摄影师主页；请粘 /p/{用户名} 或 /photo/{编号} 这类地址');
  return { username };
}
async function pxGql(body, signal) {
  // useProxy:false —— 本机系统代理连不通 api-neo.500px.com（实测直连 200、走代理 000/403），
  // 而这里是写死的固定端点、不带用户输入，直连没有额外风险。
  const r = await readPublic(PX_GQL, { method: 'POST', body: JSON.stringify(body), headers: PX_HEADERS, signal, maxBytes: 4 * 1024 * 1024, useProxy: false });
  let j;
  try { j = JSON.parse(r.body.toString('utf8')); } catch { throw new Error('500px GraphQL 返回的不是 JSON（接口可能改了）'); }
  const err = j && Array.isArray(j.errors) && j.errors[0];
  if (err) throw new Error(`500px 接口报错：${err.message || '未知原因'}`);
  return j && j.data;
}
const PX_PHOTO_FIELDS = 'id title width height uploadedAt urls { size_600 size_1024 size_2048 size_4k } uploader { id username displayName }';
/** 签名地址里带着 /photo/{legacyId}/，作品页地址可以从中还原（GraphQL 的 Photo 上没有 legacyId 字段）。 */
function pxPhotoUrl(urls) {
  const any = (urls && (urls.size_4k || urls.size_2048 || urls.size_1024 || urls.size_600)) || '';
  const legacy = (any.match(/\/photo\/(\d+)\//) || [])[1] || '';
  return legacy ? `https://500px.com/photo/${legacy}` : '';
}
/**
 * 500px 的图片是**签名地址**（`?s=&w=&expiry=&sig=`），签名覆盖全部参数，改任何一个都 403。
 * 未登录时官方只发两档预览：`s=1`→长边 600、`s=2&w=1`→长边 1024；size_2048 / size_4k 拿到的
 * 还是同一个 1024 地址（实测三档字节数完全一致）。所以宽度必须按长边换算，别把 declared 原始
 * 像素当成下载尺寸报出去 —— 那会让人以为拿的是 1294×1944，实际下来只有 682×1024。
 */
function pxPreviewDims(node, url) {
  const w0 = Number(node.width) || 0;
  const h0 = Number(node.height) || 0;
  if (!w0 || !h0) return [0, 0];
  const s = (/[?&]s=(\d+)/.exec(url || '') || [])[1] || '2';
  const cap = s === '1' ? 600 : 1024;
  const long = Math.max(w0, h0);
  if (long <= cap) return [w0, h0];
  const k = cap / long;
  return [Math.round(w0 * k), Math.round(h0 * k)];
}
function pxItem(node, fallbackAuthor = '') {
  const urls = node.urls || {};
  const up = node.uploader || {};
  const url = urls.size_4k || urls.size_2048 || urls.size_1024 || urls.size_600 || '';
  const [w, h] = pxPreviewDims(node, url);
  return {
    url,
    thumb: urls.size_600 || urls.size_1024 || url,
    title: node.title || `500px ${node.id}`,
    width: w,
    height: h,
    author: up.displayName || up.username || fallbackAuthor || '',
    authorUrl: up.username ? `https://500px.com/${up.username}` : '',
    pageUrl: pxPhotoUrl(urls),
    tags: [],
  };
}
const resolve500px = {
  id: '500px',
  label: '500px 摄影社区',
  client: '500px',
  async resolve({ url }, { signal, maxItems = Infinity } = {}) {
    const raw = String(url || '').trim();
    if (raw && !/^https?:\/\//i.test(raw)) {
      throw new Error('500px 的关键词搜索接口没有公开（GraphQL 只有 getUser / pageResources），请粘摄影师主页或作品页链接');
    }
    const { photoId, username } = parse500pxUrl(raw);
    if (photoId) {
      const numeric = /^\d+$/.test(photoId);
      const operation = numeric ? 'getPhotoByLegacyId' : 'getPhotoById';
      const key = numeric ? 'legacyId' : 'id';
      const data = await pxGql({
        operationName: operation,
        query: `query ${operation}($${key}: ${numeric ? 'String!' : 'ID!'}) { ${operation}(${key}: $${key}) { ${PX_PHOTO_FIELDS} } }`,
        variables: { [key]: photoId },
      }, signal);
      const node = data && data[operation];
      if (!node || !node.id) throw new Error('500px 没有返回这张作品（可能已删除或仅自己可见）');
      const it = pxItem(node);
      return { items: [it], skipped: [], title: it.title, author: it.author || '500px', cover: it.url, source: raw, rendition: 'original' };
    }

    const userData = await pxGql({
      operationName: 'getUserProfile',
      query: 'query getUserProfile($username: String!) { getUser(username: $username) { id username displayName } }',
      variables: { username },
    }, signal);
    const user = userData && userData.getUser;
    if (!user || !user.id) throw new Error(`找不到这个 500px 摄影师（${username}）`);
    const ownerName = user.displayName || user.username || username;

    const items = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 20 && items.length < maxItems; page++) {
      const data = await pxGql({
        operationName: 'pageResources',
        query: `query pageResources($userId: ID!, $first: Int!, $after: String) {
          pageResources(userId: $userId, first: $first, after: $after, resourceTypes: [PHOTO], sort: CREATED_AT_DESC) {
            totalCount
            pageInfo { hasNextPage endCursor }
            edges { node { ... on Photo { ${PX_PHOTO_FIELDS} } } }
          }
        }`,
        variables: { userId: user.id, first: 50, after: cursor },
      }, signal);
      const pr = data && data.pageResources;
      const edges = (pr && pr.edges) || [];
      if (!edges.length) break;
      for (const e of edges) {
        const node = e && e.node;
        if (!node || !node.id || seen.has(node.id)) continue;
        seen.add(node.id);
        items.push(pxItem(node, ownerName));
        if (items.length >= maxItems) break;
      }
      const info = pr.pageInfo || {};
      if (!info.hasNextPage || !info.endCursor || info.endCursor === cursor) break;
      cursor = info.endCursor;
    }
    if (!items.length) throw new Error('这个 500px 摄影师主页没有公开作品');
    return { items, skipped: [], title: `500px · ${ownerName}`, author: ownerName, authorUrl: `https://500px.com/${username}`, cover: items[0].url, source: raw, rendition: 'original' };
  },
};

// 各站的「登录入口」。需要 cookie 才放行的站点（站酷的作品页、500px 的大图、Pinterest 的私有画板…），
// 用户点「登录」就把这个地址开在一个可见窗口里，登录/过验证完 cookie 自动入库。
// 不需要登录的站不列在这里，前端就不显示登录按钮。
export const PICTURE_LOGIN_URLS = Object.freeze({
  zcool: 'https://www.zcool.com.cn/',
  huaban: 'https://huaban.com/',
  pinterest: 'https://www.pinterest.com/',
  pixiv: 'https://www.pixiv.net/',
  civitai: 'https://civitai.com/',
  pexels: 'https://www.pexels.com/',
  flickr: 'https://www.flickr.com/',
  '500px': 'https://500px.com/',
  designspiration: 'https://designspiration.com/',
  artstation: 'https://www.artstation.com/',
});

export const PICTURE_SITES = Object.freeze({
  pixiv: {
    id: 'pixiv',
    label: 'Pixiv 插画',
    client: 'pixiv',
    async resolve(ctx, opts) {
      return resolvePixiv(ctx, opts);
    },
  },
  safebooru: makeBooruSite({ id: 'safebooru', label: 'Safebooru', client: 'safebooru', host: 'safebooru.org', referer: 'https://safebooru.org/', dapi: true }),
  yandere: makeBooruSite({ id: 'yandere', label: 'Yande.re', client: 'yandere', host: 'yande.re', referer: 'https://yande.re/', dapi: false }),
  konachan: makeBooruSite({ id: 'konachan', label: 'Konachan', client: 'konachan', host: 'konachan.net', referer: 'https://konachan.net/', dapi: false }),
  wallhaven: resolveWallhaven,
  civitai: resolveCivitai,
  zcool: resolveZcool,
  designspiration: resolveDesignspiration,
  huaban: resolveHuaban,
  pexels: resolvePexels,
  flickr: resolveFlickr,
  '500px': resolve500px,
  // Pinterest：不自己抓，resolve 转发给 pin-grabber（Pinterest 搜索/解析引擎，独立 Python 服务，由 AV 自动拉起）。
  // 关键词搜索 + 画板/作者/搜索页/直链解析 + 相似推荐全走 pin-grabber，下载复用 AV 管线（client:'pinterest' 走 image-store 白名单）。
  pinterest: {
    id: 'pinterest',
    label: 'Pinterest',
    client: 'pinterest',
    search: true,                               // 纯关键词由 pin-grabber 走它的搜索页
    async resolve(ctx, opts) {
      return resolvePinterest(ctx, opts);
    },
  },
  // 后续图站按同构签名在此追加：每个实现 resolve({url},{open,signal}) -> {items,title,author,cover,source,rendition}
});

/** 图站 CDN 主机 → 预览代理需要的 Referer（防 hotlink 403）。 */
const PICTURE_CDN_HOSTS = [
  { re: /(?:^|\.)i?pximg\.net$/i, referer: 'https://www.pixiv.net/' },
  { re: /(?:^|\.)safebooru\.org$/i, referer: 'https://safebooru.org/' },
  { re: /(?:^|\.)yande\.re$/i, referer: 'https://yande.re/' },
  { re: /(?:^|\.)konachan\.(?:com|net)$/i, referer: 'https://konachan.com/' },
  { re: /(?:^|\.)wallhaven\.cc$/i, referer: 'https://wallhaven.cc/' },
  { re: /(?:^|\.)civitai\.com$/i, referer: 'https://civitai.com/' },
  { re: /(?:^|\.)zcool\.cn$/i, referer: 'https://www.zcool.com.cn/' },
  { re: /(?:^|\.)dspncdn\.com$/i, referer: 'https://www.designspiration.com/' },
  { re: /(?:^|\.)huaban\.com$/i, referer: 'https://huaban.com/' },
  { re: /(?:^|\.)pexels\.com$/i, referer: 'https://www.pexels.com/' },
  { re: /(?:^|\.)staticflickr\.com$/i, referer: 'https://www.flickr.com/' },
  // 500px 的图走阿里云式的对象存储 CDN，域名是 500px.cloud / 500px.org 两种都可能出现。
  { re: /(?:^|\.)500px\.(?:cloud|org)$/i, referer: 'https://500px.com/' },
  { re: /(?:^|\.)pinimg\.com$/i, referer: 'https://www.pinterest.com/' },
  { re: /(?:^|\.)artstation\.com$/i, referer: 'https://www.artstation.com/' },
];
export const isPictureCdnHost = (host) => PICTURE_CDN_HOSTS.some((h) => h.re.test(host));
export const pictureRefererForHost = (host) => {
  const h = PICTURE_CDN_HOSTS.find((x) => x.re.test(host));
  return h ? h.referer : null;
};

/** 统一入口：图站名 -> 抓取结果（与 collectImageAssets 同构）。 */
export async function collectPictureAssets(site, { url } = {}, options = {}) {
  const source = PICTURE_SITES[site];
  if (!source) throw new Error('这个图站暂时不支持抓取');
  // maxItems：预览时只抓前 N 张（各 resolver 会在分页循环里提前收手，省掉大部分网络请求）；
  // 下载走 runImageJob 不传这个值，仍然抓整站全量。
  const raw = Number(options.maxItems);
  const maxItems = Number.isFinite(raw) && raw > 0 ? raw : Infinity;
  const result = await source.resolve({ url }, { ...options, maxItems });
  const all = Array.isArray(result.items) ? result.items : [];
  // 两级解析（mode:'boards'）：这一层给的是「画板卡片」而不是图片，条目数与截断都按画板算。
  // 前端据此渲染画板墙，点某块画板再发一次解析请求取它的图片，下载仍只发生在图片层。
  if (Array.isArray(result.boards)) {
    return { ...result, items: all, boards: result.boards, total: result.boards.length, truncated: false, platform: source.id, client: source.client, label: source.label };
  }
  const items = maxItems === Infinity ? all : all.slice(0, maxItems);
  return {
    ...result,
    items,
    total: all.length,
    truncated: maxItems !== Infinity && all.length >= maxItems,
    platform: source.id,
    client: source.client,
    label: source.label,
  };
}

export const isPictureSite = (platform) => Boolean(PICTURE_SITES[platform]);
