// Uiverse 解析层：把站点的 Remix 数据结构翻译成 AssetVault 的资产条目。
//
// 为什么单独一个模块：这个站点有三个数据通道（列表 JSON / 详情 JSON / 代码端点），
// 每种形状都不一样，而且都要有单测覆盖。把「读 JSON」和「读出资产」拆开，
// 解析就能完全离线测 —— 与 xhs-state.mjs 同一套路。
//
// 站点是 Remix 应用，列表与详情都能用 `?_data=routes/xxx` 直接要 JSON，
// 不用抠 HTML 里的 __remixContext，也不用跑浏览器。
//
// 三个通道（全部匿名可读，实测）：
//   列表  GET /elements?_data=routes%2F%24category&search=&theme=&page=
//   详情  GET /{user}/{slug}?_data=routes%2F%24username.%24friendlyId
//   代码  GET /resource/post/code/{id}?v={version}   → {html, css}
//
// 代码端点是关键：Tailwind 元素的 css 里已经带编译好的 utility 类
// （头部注释写着 `tailwindcss v3.4.16`），所以预览不需要现场跑 Tailwind 引擎。
const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));

/** 元素类型 → 中文标签。类型是站点自己的分类语义，标签页与筛选条共用这一份。 */
export const UIVERSE_TYPE_LABELS = Object.freeze({
  button: '按钮',
  checkbox: '复选框',
  switch: '开关',
  radio: '单选框',
  input: '输入框',
  card: '卡片',
  form: '表单',
  notification: '通知',
  loader: '加载动画',
  pattern: '背景图案',
  tooltip: '提示气泡',
});

export const UIVERSE_TYPES = Object.freeze(Object.keys(UIVERSE_TYPE_LABELS));

/** 站点侧的类型路径段（/loaders、/buttons…），用来把分类 URL 还原成 type 参数。 */
const TYPE_PATHS = Object.freeze({
  loaders: 'loader',
  loader: 'loader',
  buttons: 'button',
  button: 'button',
  checkboxes: 'checkbox',
  checkbox: 'checkbox',
  switches: 'switch',
  switch: 'switch',
  'radio-buttons': 'radio',
  radio: 'radio',
  inputs: 'input',
  input: 'input',
  cards: 'card',
  card: 'card',
  forms: 'form',
  form: 'form',
  notifications: 'notification',
  notification: 'notification',
  patterns: 'pattern',
  pattern: 'pattern',
  tooltips: 'tooltip',
  tooltip: 'tooltip',
});

/**
 * 类型 → 路径段的反向表。
 *
 * 关键事实（实测）：站点**只用路径段过滤类型**（/loaders 只出 loader），
 * `/elements?type=loader` 里的 type 参数是死的 —— 照样返回全部 4508 条。
 * 所以要按类型筛，必须换路径，不能加参数。
 *
 * 路径段写复数（站点真实存在的那批：/loaders、/buttons、/checkboxes…）。
 * 上面 TYPE_PATHS 里同时收了单数别名（/loader、/button），那只用于「把粘进来的
 * URL 认出来」；反过来构造路径表时若直接取反，别名会把真路径顶掉
 * （loaders 与 loader 都映射到 loader，后者胜出 → 请求 /loader → 站点不认）。
 * 所以这里显式列出，不用取反。
 */
export const UIVERSE_TYPE_PATHS = Object.freeze({
  loader: 'loaders',
  button: 'buttons',
  checkbox: 'checkboxes',
  switch: 'switches',
  radio: 'radio-buttons',
  input: 'inputs',
  card: 'cards',
  form: 'forms',
  notification: 'notifications',
  pattern: 'patterns',
  tooltip: 'tooltips',
});

/** 详情页 URL 形态：/{username}/{friendlyId}。friendlyId 形如 tame-fly-42。 */
const ELEMENT_PATH = /^\/([A-Za-z0-9_-]+)\/([a-z0-9]+-[a-z0-9]+-\d+)$/i;

/**
 * 解析用户粘进来的链接。
 * 支持四种：元素详情页、分类页、创作者主页、elements 列表页。
 * 返回 {type:'element'|'category'|'profile'|'list'|'unknown', ...}
 */
export function parseUiverseUrl(raw) {
  const clean = text(raw).trim();
  if (!clean) return { type: 'unknown' };
  let u;
  try {
    u = new URL(clean);
  } catch {
    return { type: 'unknown' };
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'uiverse.io' && host !== 'www.uiverse.io') return { type: 'unknown' };
  const segments = u.pathname.split('/').filter(Boolean).map(s => s.toLowerCase());
  if (!segments.length) return { type: 'unknown' };

  // /elements（含 ?search= ?theme= ?page=）
  if (segments[0] === 'elements') {
    const params = u.searchParams;
    return {
      type: 'list',
      search: text(params.get('search')).trim(),
      theme: text(params.get('theme')).trim(),
      elementType: text(params.get('type')).trim(),
      page: Math.max(1, Number(params.get('page')) || 1),
      query: u.search,
    };
  }

  // /profile/{username}
  if (segments[0] === 'profile' && segments[1]) {
    return { type: 'profile', username: segments[1] };
  }

  // /{username}/{friendlyId}
  const element = ELEMENT_PATH.exec(u.pathname);
  if (element) {
    return { type: 'element', username: element[1], friendlyId: element[2], query: u.search };
  }

  // /loaders、/buttons… 分类页
  if (segments.length === 1 && TYPE_PATHS[segments[0]]) {
    return { type: 'category', elementType: TYPE_PATHS[segments[0]], page: 1, query: '' };
  }

  return { type: 'unknown' };
}

/**
 * 按类型 / 搜索词 / 主题算出该请求哪个路径。
 *
 * 站点的类型过滤只认路径段（/loaders），不认 ?type= 参数 —— 实测
 * `/elements?type=loader` 返回的仍是全部 4508 条。所以：
 *   指定类型 → 用类型路径段（可再叠加 search / theme，两者在分类页上都生效）
 *   只搜关键词 → 用 /elements
 */
export function uiverseListPath({ search = '', theme = '', elementType = '' } = {}) {
  const typePath = UIVERSE_TYPE_PATHS[text(elementType)];
  return typePath ? `/${typePath}` : '/elements';
}

/**
 * 列表条目 → 资产条目骨架。
 * 列表 JSON 里只有 id / friendlyId / type / theme / user.username，
 * 封面图字段（ogImageId）要详情页才有，所以这里先不给 thumbnail。
 */
export function parseUiverseList(payload) {
  const posts = Array.isArray(payload?.posts) ? payload.posts : [];
  return {
    items: posts.map(post => ({
      id: text(post?.id),
      slug: text(post?.friendlyId),
      username: text(post?.user?.username),
      elementType: text(post?.type),
      theme: text(post?.theme),
      isTailwind: post?.isTailwind === true,
      version: Number(post?.version) || 1,
    })).filter(item => item.id && item.slug),
    currentPage: Number(payload?.currentPage) || 0,
    hasNextPage: payload?.hasNextPage === true,
    total: Number(payload?.postsCount) || 0,
  };
}

/** 详情 JSON → 完整元数据（代码从代码端点另外取，这里不含代码）。 */
export function parseUiversePost(payload) {
  const post = payload?.post;
  if (!post) return null;
  const tags = Array.isArray(post.post_tag)
    ? post.post_tag.map(entry => text(entry?.tag?.value)).filter(Boolean)
    : [];
  return {
    id: text(post.id),
    slug: text(post.friendlyId),
    username: text(post.user?.username),
    authorName: text(post.user?.name),
    elementType: text(post.type),
    theme: text(post.theme),
    isTailwind: post.isTailwind === true,
    version: Number(post.version) || 1,
    tags: [...new Set(tags)],
    viewCount: Number(post.viewCount) || 0,
    createdDate: text(post.createdDate),
    updatedDate: text(post.updatedDate),
    ogImageId: text(post.ogImageId),
    status: text(post.status),
    backgroundColor: text(post.backgroundColor),
    /** 站内详情页地址。 */
    pageUrl: post.friendlyId && post.user?.username
      ? `https://uiverse.io/${post.user.username}/${post.friendlyId}`
      : '',
    /** 创作者主页地址。 */
    authorUrl: post.user?.username ? `https://uiverse.io/profile/${post.user.username}` : '',
  };
}

/** 代码端点 JSON → {html, css}。两者都可能为空（站上有些元素只有图片）。 */
export function parseUiverseCode(payload) {
  return {
    html: text(payload?.html),
    css: text(payload?.css),
  };
}

/**
 * 把 Shadow DOM 里用不了的选择器换掉。
 *
 * Shadow DOM 有自己的样式根，`:root` 在里面匹配不到任何东西（它指向文档根），
 * 于是「写在 :root 里的 CSS 变量」会全部失效 —— Uiverse 的元素大量依赖
 * `:root { --x: ... }` 定义主题色。
 *
 * 官方前端自己的做法就是把 `:root` 替换成 `:host`（见它的 css-imports 模块），
 * 这里照做：`:host` 匹配的就是挂载 Shadow DOM 的那个元素，变量照常生效。
 */
export function toShadowCss(css) {
  return text(css).replace(/:root\b/g, ':host');
}

/**
 * 把 @import 摘出来单独放前面。
 *
 * Shadow DOM 内部无法用外链样式表（没有 <link> 可挂），@import 是唯一能引外链的办法，
 * 但 @import 必须在样式表最前面才生效，所以要从原 CSS 里搬出来、拼到最前。
 */
export function splitCssImports(css) {
  const source = text(css);
  const imports = [];
  const rest = source.replace(/@import\s+(?:url\(\s*)?(?:(["'])(.*?)\1|([^'"\s)]+))(?:\s*\))?\s*;/gi, match => {
    imports.push(match.trim());
    return '';
  });
  return { imports, css: rest };
}

/**
 * 组装一份可独立运行的预览文档。
 *
 * 单独成文档（而不是塞进宿主页面的 DOM）有三个好处：
 *   1. 元素的 CSS 不会污染宿主页面，也不会被宿主页面污染；
 *   2. 可以整体放进 iframe，用 sandbox 关掉脚本 —— 社区代码不该有执行权；
 *   3. Tailwind 元素自带的 CSS 变量（--tw-*）在独立文档里才完整生效。
 */
export function buildPreviewDocument({ html = '', css = '', backgroundColor = '' } = {}) {
  // 弹窗是独立的 iframe 文档，:root 指向文档根、照常生效，不需要转 :host
  // （:host 在 Shadow DOM 外不匹配任何元素，转了反而让 --tw-* 变量失效）。
  const { imports, css: body } = splitCssImports(text(css));
  const background = text(backgroundColor).trim();
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
${imports.join('\n')}
html,body{margin:0;padding:0;min-height:100%;}
body{
  display:flex;align-items:center;justify-content:center;
  ${background ? `background:${background};` : ''}
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
${body}
</style>
</head>
<body>
${text(html)}
</body>
</html>`;
}

/**
 * 落盘用的独立文件：CSS 与 HTML 分开，方便直接拷进项目。
 * 引用的样式用相对路径 link，与 style.css 同目录即可工作。
 */
export function buildStandaloneFiles({ html = '', css = '', title = '' } = {}) {
  const { imports, css: body } = splitCssImports(text(css));
  const styleSheet = [...imports, body].filter(Boolean).join('\n');
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text(title).replace(/[<>&]/g, '')}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
${text(html)}
</body>
</html>
`;
  return { html: doc, css: styleSheet };
}

/** 元素的中文标题：站点没有标题字段，用类型 + slug 拼一个能认出来的。 */
export function uiverseTitle(meta) {
  const label = UIVERSE_TYPE_LABELS[text(meta?.elementType)] || 'UI 组件';
  const slug = text(meta?.slug);
  return slug ? `${label} · ${slug}` : label;
}
