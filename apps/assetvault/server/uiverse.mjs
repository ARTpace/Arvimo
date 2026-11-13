// Uiverse 网络层：读站点的三个数据通道，把结果交给 uiverse-state.mjs 解析。
//
// 站点是 Remix 应用，列表与详情都能用 `?_data=routes/xxx` 直接要 JSON：
//   列表  GET /elements?_data=routes%2F%24category&search=&theme=&page=
//   详情  GET /{user}/{slug}?_data=routes%2F%24username.%24friendlyId
//   代码  GET /resource/post/code/{id}?v={version}
//
// 三个通道全部匿名可读，实测无需登录。
//
// 唯一的坑：封面图 CDN（imagedelivery.net）在部分网络下连不上 —— TLS 直接断，
// 不是 403、不是超时。所以 UI 元素的缩略图不能依赖那张静态图：
// 卡片预览改成用代码端点的 html+css 现场渲染（那才是动效该有的样子）。
import {readPublic} from './public-http.mjs';
import {createHash} from 'node:crypto';
import {
  parseUiverseUrl, parseUiverseList, parseUiversePost, parseUiverseCode,
  buildPreviewDocument, uiverseTitle, uiverseListPath,
} from './uiverse-state.mjs';

const ORIGIN = 'https://uiverse.io';
/** 站点对浏览器 UA 一视同仁，但默认的 Sketchfab UA 会被 Cloudflare 挑出来。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = Object.freeze({
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
});

/**
 * Remix 的 data 路由名。
 *
 * 注意：这里存的是**未编码**的路由名，由 URLSearchParams 负责编码。
 * 早先写成 'routes%2F%24category' 会被二次编码成 routes%252F%2524category，
 * Remix 认不出路由名就回 403 —— 表现为「列表和搜索全挂、但详情页正常」，
 * 很像站点在限流，其实是自己拼错了 URL。
 */
const DATA_LIST = 'routes/$category';
const DATA_POST = 'routes/$username.$friendlyId';

/**
 * 读一个 JSON 端点。
 *
 * Cloudflare 对这个站偶发 403（实测：同一组请求头连发 20 次全过，隔一会儿又会被拒，
 * 与 UA、频率都无关，是边缘节点的抖动）。所以 403 要重试 —— 退避后再打，
 * 通常第二三次就过了。连续失败才当成真错误报出去。
 */
async function uiverseJson(url, { signal, retries = 3 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    if (attempt) {
      // 退避 400 / 900 / 1600ms：抖动是短周期的，等一下就好。
      await new Promise(resolve => setTimeout(resolve, 400 * (2 ** (attempt - 1))));
    }
    try {
      const r = await readPublic(url, { headers: HEADERS, signal, maxBytes: 8 * 1024 * 1024, timeout: 9000, browserPrint: true });
      const body = r.body.toString('utf8');
      try {
        return JSON.parse(body);
      } catch {
        // Cloudflare 有时回 200 的 HTML 挑战页（不是 JSON）。
        if (/<title[^>]*>.*?(Attention Required|Just a moment)/is.test(body)) {
          lastError = new Error('Uiverse 触发了 Cloudflare 人机校验，稍等几秒再试');
        } else {
          lastError = new Error('Uiverse 返回的不是有效数据（站点结构可能已调整）');
        }
      }
    } catch (e) {
      lastError = e;
      // 403 是抖动，值得重试；其它状态码（404 / 400）是真错，重试没意义。
      if (e.status !== 403) throw e;
    }
  }
  throw lastError || new Error('Uiverse 请求失败');
}

/**
 * 列表页数据。
 *
 * 路径由 uiverseListPath 决定：指定类型时走类型路径段（/loaders），
 * 因为站点**只认路径过滤类型** —— `/elements?type=loader` 的 type 参数是死的。
 * search / theme 在两种路径上都生效，可以叠加。
 */
export async function fetchUiverseList({ search = '', theme = '', elementType = '', page = 1 } = {}, { signal } = {}) {
  const params = new URLSearchParams();
  params.set('_data', DATA_LIST);
  if (search) params.set('search', search);
  if (theme && theme !== 'all') params.set('theme', theme);
  if (page > 1) params.set('page', String(page));
  const path = uiverseListPath({ search, theme, elementType });
  const payload = await uiverseJson(`${ORIGIN}${path}?${params}`, { signal });
  return parseUiverseList(payload);
}

/** 详情页数据。 */
export async function fetchUiversePost(username, slug, { signal } = {}) {
  const params = new URLSearchParams();
  params.set('_data', DATA_POST);
  const payload = await uiverseJson(`${ORIGIN}/${encodeURIComponent(username)}/${encodeURIComponent(slug)}?${params}`, { signal });
  return parseUiversePost(payload);
}

/** 代码端点：拿到 html + css 原文。Tailwind 元素的 css 已含编译好的 utility 类。 */
export async function fetchUiverseCode(id, version = 1, { signal } = {}) {
  const payload = await uiverseJson(`${ORIGIN}/resource/post/code/${encodeURIComponent(id)}?v=${version}`, { signal });
  return parseUiverseCode(payload);
}

/**
 * 只取代码 + 预览文档（不取详情元数据）。
 *
 * 卡片上的动效预览是懒加载的：滚进视口才去取代码。走详情通道会多拉一堆用不上的
 * 元数据（标签、浏览量、作者…），所以这里留一条轻的通道。
 */
export async function fetchUiverseCodeOnly(id, version = 1, { signal } = {}) {
  const code = await fetchUiverseCode(id, version, { signal });
  return { ...code, previewDocument: buildPreviewDocument({ html: code.html, css: code.css }) };
}

/**
 * 取一个元素的完整内容：元数据 + 代码 + 可直接预览的文档。
 * 预览文档放服务端生成，前端只要拿到一串 HTML 就能塞进 iframe。
 */
export async function fetchUiverseElement(username, slug, { signal } = {}) {
  const meta = await fetchUiversePost(username, slug, { signal });
  if (!meta) throw new Error('这个 Uiverse 元素不存在或已下架');
  const code = await fetchUiverseCode(meta.id, meta.version, { signal });
  const preview = buildPreviewDocument({
    html: code.html,
    css: code.css,
    backgroundColor: meta.backgroundColor,
  });
  return { meta, code, preview };
}

/**
 * 列表条目 → 采集条目。
 *
 * 缩略图这里给的是「预览文档」而不是图片地址：Uiverse 的封面图 CDN 在很多网络下
 * 连不上，而 UI 元素的卖点本来就是动效 —— 现场渲染 html+css 才是对的预览。
 * 采集层拿到的 url 指向详情页（下载时要用），preview 单独一路走。
 */
function uiverseItem(item, { preview = '' } = {}) {
  const pageUrl = `${ORIGIN}/${item.username}/${item.slug}`;
  const title = uiverseTitle({ elementType: item.elementType, slug: item.slug });
  return {
    url: pageUrl,
    pageUrl,
    thumb: '',
    title,
    author: item.username,
    authorUrl: `${ORIGIN}/profile/${item.username}`,
    width: 0,
    height: 0,
    tags: [item.elementType, item.theme].filter(Boolean),
    // 采集层透传的额外字段：详情与代码在下载阶段才需要，列表阶段不拉。
    elementId: item.id,
    elementType: item.elementType,
    elementSlug: item.slug,
    elementUsername: item.username,
    elementVersion: item.version,
    isTailwind: item.isTailwind,
    previewDocument: preview,
  };
}

/**
 * 解析一个用户粘进来的链接，返回采集条目。
 * 支持：元素详情页、分类页、创作者主页、elements 列表页（带 search / theme）。
 */
export async function resolveUiverse({ url } = {}, { signal, limit = 40, open } = {}) {
  const info = parseUiverseUrl(url);
  if (info.type === 'unknown') {
    throw new Error('无法识别的 Uiverse 链接。支持的形态：uiverse.io/用户名/元素名、uiverse.io/profile/用户名、uiverse.io/elements、uiverse.io/loaders 这类分类页');
  }

  if (info.type === 'element') {
    const { meta, code, preview } = await fetchUiverseElement(info.username, info.friendlyId, { signal });
    const item = uiverseItem({
      id: meta.id,
      slug: meta.slug,
      username: meta.username,
      elementType: meta.elementType,
      theme: meta.theme,
      isTailwind: meta.isTailwind,
      version: meta.version,
    }, { preview });
    item.tags = meta.tags.length ? meta.tags : item.tags;
    item.author = meta.authorName || meta.username;
    item.authorUrl = meta.authorUrl;
    item.viewCount = meta.viewCount;
    item.createdDate = meta.createdDate;
    item.html = code.html;
    item.css = code.css;
    item.backgroundColor = meta.backgroundColor;
    item.title = uiverseTitle(meta);
    return {
      items: [item],
      skipped: [],
      title: item.title,
      author: item.author,
      authorUrl: item.authorUrl,
      cover: '',
      source: item.pageUrl,
      rendition: 'original',
      previewDocument: preview,
    };
  }

  // 分类页 / 列表页 / 创作者主页 → 一批列表条目。
  let list;
  if (info.type === 'profile') {
    // 创作者主页的 _data 端点会 403（实测），只能读 HTML 里嵌的 loader 数据。
    list = await fetchUiverseProfileList(info.username, { signal });
  } else {
    list = await fetchUiverseList({
      search: info.search || '',
      theme: info.theme || '',
      elementType: info.elementType || '',
      page: info.page || 1,
    }, { signal });
  }

  const items = list.items.slice(0, limit).map(item => uiverseItem(item));
  return {
    items,
    skipped: [],
    title: info.type === 'category' ? `Uiverse ${info.elementType}` : 'Uiverse',
    author: info.type === 'profile' ? info.username : 'Uiverse',
    authorUrl: info.type === 'profile' ? `${ORIGIN}/profile/${info.username}` : ORIGIN,
    cover: '',
    source: String(url),
    rendition: 'original',
    total: list.total,
    hasNextPage: list.hasNextPage,
  };
}

/** 读一段文本页面（创作者主页用）。403 同样重试。 */
async function uiverseText(url, { signal, retries = 3 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    if (attempt) await new Promise(resolve => setTimeout(resolve, 400 * (2 ** (attempt - 1))));
    try {
      const r = await readPublic(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal, maxBytes: 8 * 1024 * 1024, browserPrint: true });
      return r.body.toString('utf8');
    } catch (e) {
      lastError = e;
      if (e.status !== 403) throw e;
    }
  }
  throw lastError || new Error('Uiverse 请求失败');
}

/**
 * 创作者主页的元素列表。
 *
 * 主页的 `?_data=` 端点会 403（实测），所以退回解析页面里嵌的
 * window.__remixContext —— 里面同样有 posts 数组，形状与列表端点一致。
 */
async function fetchUiverseProfileList(username, { signal } = {}) {
  const html = await uiverseText(`${ORIGIN}/profile/${encodeURIComponent(username)}`, { signal });
  const match = html.match(/window\.__remixContext\s*=\s*(\{[\s\S]*?\});?<\/script>/);
  if (!match) throw new Error('Uiverse 创作者主页没解析到元素列表（站点结构可能已调整）');
  let ctx;
  try {
    ctx = JSON.parse(match[1]);
  } catch {
    throw new Error('Uiverse 创作者主页数据不是有效 JSON');
  }
  const loader = ctx?.state?.loaderData || {};
  const route = loader['routes/$username'] || loader['routes/profile.$username'] || {};
  const posts = route.posts || route.postsByUser || [];
  return parseUiverseList({ posts, currentPage: 0, hasNextPage: false, postsCount: posts.length });
}

/** 关键词搜索：给采集层的搜索入口用。 */
export async function searchUiverse({ query = '', theme = '', elementType = '', page = 1 } = {}, { signal, limit = 40 } = {}) {
  const list = await fetchUiverseList({ search: query, theme, elementType, page }, { signal });
  return {
    items: list.items.slice(0, limit).map(item => uiverseItem(item)),
    total: list.total,
    hasNextPage: list.hasNextPage,
    nextPage: list.hasNextPage ? page + 1 : null,
  };
}

/**
 * 发现页的检索流：形状与其它平台一致（models / next / pending / warnings / source）。
 *
 * 与采集层那条通道的区别：
 *   采集层（searchUiverse）给的是「条目」，带 previewDocument 等下载要用的字段；
 *   这里给的是「卡片」，字段跟其它平台的 model 一样，网格直接吃。
 *
 * 代码不在这里取：站点的列表端点只给元数据，而一份 CSS 动辄几 KB，
 * 24 张卡片一起拉会拖慢首屏 —— 卡片进视口时再按元素 id 现取（/api/ui-site/code）。
 */
export async function uiverseSearch(input = {}, { signal } = {}) {
  const cursor = input.cursor ? (typeof input.cursor === 'string' ? JSON.parse(input.cursor) : input.cursor) : {};
  const q = String(cursor.q ?? input.q ?? '').trim().slice(0, 200);
  const theme = String(cursor.theme ?? input.theme ?? '').trim().slice(0, 40);
  const elementType = String(cursor.type ?? input.type ?? '').trim().slice(0, 40);
  const page = Math.max(1, Number(cursor.page ?? input.page) || 1);
  const list = await fetchUiverseList({ search: q, theme, elementType, page }, { signal });
  const models = list.items.slice(0, 24).map(item => uiverseCard(item));
  return {
    models,
    received: models.length,
    total: list.total,
    page,
    // 分页游标带上全部筛选条件：翻页时不能把类型或主题丢掉。
    next: list.hasNextPage ? JSON.stringify({ q, theme, type: elementType, page: page + 1 }) : null,
    pending: [],
    source: 'Uiverse · 社区 UI 动效组件',
    warnings: models.length ? [] : ['Uiverse 上没有匹配当前筛选的元素'],
    query: q,
  };
}

/**
 * 列表条目 → 网格卡片。
 *
 * 字段与其它平台的 model 对齐（uid / platform / name / thumbnail / url / license…），
 * 网格的合并逻辑（mergeModels）只认 32 位 hex 的 uid，所以这里必须自己算。
 * 元素代码相关的字段也带上：下载落盘时要用（见 uiverse-job.mjs）。
 */
function uiverseCard(item) {
  const key = item.id || `${item.username}/${item.slug}`;
  return {
    uid: createHash('md5').update(`uiverse:${key}`).digest('hex'),
    platform: 'uiverse',
    assetType: 'uielement',
    name: uiverseTitle({ elementType: item.elementType, slug: item.slug }),
    author: item.username,
    // 官方封面图在 imagedelivery.net，很多网络下连不上；卡片改为现场渲染动效。
    thumbnail: '',
    url: `${ORIGIN}/${item.username}/${item.slug}`,
    license: 'Uiverse 社区作品 · 可自由复制使用',
    downloadable: true,
    tags: [item.elementType, item.theme].filter(Boolean),
    elementId: item.id,
    elementType: item.elementType,
    elementTheme: item.theme,
    elementUsername: item.username,
    elementSlug: item.slug,
    elementVersion: item.version,
    isTailwind: item.isTailwind === true,
  };
}
