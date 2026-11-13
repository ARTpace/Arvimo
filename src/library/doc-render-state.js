// 文档渲染的纯函数 / 配置层：无 DOM、无 window、不 import 任何渲染库，Node 里可直接单测。
// 与 server/uiverse-state.mjs 同一范式——把「能离线验证的策略」从浏览器渲染器里剥出来。
// 真正的库调用在 doc-render.js（独立 bundle，按需加载），本文件只定策略与做字符串变换。

/** 哪些 preview 策略走文档渲染器（与 format-registry.js 的行一一对应）。 */
export const DOC_RENDER_MODES = Object.freeze({
  markdown: 'markdown',
  docx: 'docx',
  epub: 'epub',
  'doc-pdf': 'doc-pdf',
});

/** 注册表 preview → 渲染器 id；不在表里就说明不是文档渲染管辖的格式。 */
export function docRenderModeOf(preview) {
  return DOC_RENDER_MODES[preview] || null;
}

/** marked 选项：GFM 表格/任务列表 + 换行符转 <br>，不执行原文里的任何 HTML 逻辑。 */
export const MARKED_OPTIONS = Object.freeze({gfm: true, breaks: true});

/**
 * DOMPurify 白名单：markdown 产物只允许排版 / 媒体标签，链接只放 http/https/mailto。
 * 显式 ADD_ATTR target/rel 是为了让外链在新标签打开仍受 noopener 保护。
 * 注意：ALLOWED_URI_REGEXP 必须写全，默认配置会放行 data: 的 SVG（XSS 面）。
 */
export const PURIFY_OPTIONS = Object.freeze({
  USE_PROFILES: {html: true},
  ADD_ATTR: ['target', 'rel'],
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input'],
  FORBID_ATTR: ['style', 'srcset', 'formaction'],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
});

/** docx-preview 选项：不注入实验性字段、把内嵌图片转成 data URL（CSP 已放行 data:）。 */
export const DOCX_OPTIONS = Object.freeze({
  className: 'docx-viewer',
  inWrapper: true,
  ignoreWidth: false,
  ignoreHeight: false,
  ignoreFonts: false,
  breakPages: true,
  debug: false,
  experimental: false,
  trimXmlDeclaration: true,
  useBase64URL: true,
});

/** epub.js rendition 选项：srcdoc iframe 自带 allow-same-origin，不开放脚本。 */
export const EPUB_OPTIONS = Object.freeze({
  width: '100%',
  height: '100%',
  spread: 'none',
  flow: 'paginated',
  allowScriptedContent: false,
  allowPopups: false,
});

/**
 * EPUB 渲染超时（毫秒）。实测损坏 / 受 DRM 的 epub 会让 rendition.display() 永久 pending，
 * 不加超时用户只会看到「正在渲染…」一直转。调这个值只改这里，不必碰渲染器。
 */
export const EPUB_RENDER_TIMEOUT_MS = 15000;
/** 前端对任何文档渲染器的兜底超时，比单渲染器超时宽一档，防第三方库整个卡死。 */
export const DOC_RENDER_TIMEOUT_MS = 30000;

/**
 * markdown → 净化后的 HTML。渲染库通过参数注入（浏览器传 marked/DOMPurify，测试传假实现），
 * 保证本函数是纯的：同样的输入 + 同样的库 = 同样的输出，不碰全局 window。
 */
export function markdownToHtml(source, {marked, purify, markedOptions = MARKED_OPTIONS,
  purifyOptions = PURIFY_OPTIONS} = {}) {
  const raw = marked.parse(String(source ?? ''), markedOptions);
  return purify.sanitize(raw, purifyOptions);
}

/**
 * 给外链补 target/rel。DOMPurify 的 ADD_ATTR 只保留属性，不会替我们填值。
 * 直接注入 DOMParser 构造器（浏览器传 window.DOMParser，测试传假实现）——
 * 注意 DOMParser 挂在 window 上而不是 document 上，曾经传错对象导致浏览器里整条渲染链断掉。
 */
export function hardenLinks(html, DOMParserRef) {
  const doc = new DOMParserRef().parseFromString(html, 'text/html');
  for (const anchor of doc.querySelectorAll('a[href]')) {
    if (!/^https?:/i.test(anchor.getAttribute('href') || '')) continue;
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
  return doc.body.innerHTML;
}

/** 预览弹窗右下角的中文提示，按渲染器分开，别在 UI 里堆 if。 */
export const DOC_HINTS = Object.freeze({
  markdown: 'Markdown 排版预览 · 只读',
  docx: 'Word 文档渲染 · 只读',
  epub: 'EPUB 电子书 · 翻页阅读',
  'doc-pdf': '已由 LibreOffice 转成 PDF 预览 · 只读',
});

/** 没装 LibreOffice 时给一句能动手的提示（不是空白 iframe）。 */
export const DOC_CONVERT_UNAVAILABLE_HINT =
  '预览 .pptx / .xlsx / .rtf 等文档需要本机安装 LibreOffice；装好后重开预览即可，或先用 Office 另存为 PDF。';

/** 各渲染器失败时的兜底文案，带格式名，便于用户判断是文件坏了还是工具没装。 */
export function docFailureHint(mode, ext) {
  const label = String(ext || '').toUpperCase() ? `.${String(ext).toUpperCase()}` : '这个文档';
  const base = {
    markdown: `${label} 渲染失败`,
    docx: `${label} 打不开（文件可能损坏或加密）`,
    epub: `${label} 打不开（EPUB 可能损坏或含 DRM）`,
    'doc-pdf': `${label} 转换失败`,
  }[mode] || `${label} 预览失败`;
  return `${base} · 可先用原软件打开确认文件正常`;
}

/** 从文件名取扩展名（小写无点），渲染器只用它做提示，不做格式判定。 */
export function extLabel(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
