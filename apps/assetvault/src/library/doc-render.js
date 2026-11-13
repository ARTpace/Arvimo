// 文档渲染器（独立 bundle，由 build-library.mjs 单独打包成 /doc-render.js）。
//
// 为什么不并进 app.js：marked / docx-preview / epubjs 加起来约 1.2 MB，静态打进主包会让
// 每个用户首屏都背这段用不上的字节。这里复用 lazy-preview.js 的范式 —— 主包里只有一句
// import('./doc-render.js')，第一次打开文档才加载，之后浏览器缓存复用。
//
// 职责边界：本模块只把「已经拿到的字节 / 文本」渲染进 host，不发起任何网络请求
// （取字节统一由 local-files.js 的 fetchBytes / fileUrl 负责，鉴权与白名单只有一处）。
// 渲染库通过依赖注入接进纯函数层 doc-render-state.js，方便 Node 侧离线回归。
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import {renderAsync} from 'docx-preview';
import ePub from 'epubjs';
import {
  MARKED_OPTIONS, PURIFY_OPTIONS, DOCX_OPTIONS, EPUB_OPTIONS, DOC_HINTS,
  EPUB_RENDER_TIMEOUT_MS, markdownToHtml, hardenLinks, docFailureHint, docRenderModeOf,
} from './doc-render-state.js';

// esbuild 打 epubjs 的 ESM 入口时，default 实测就是 ePub 工厂函数（见 spike 验证）。
// dompurify 反过来：browser bundle 里 default 是工厂函数，必须传 window 才拿到带 sanitize 的实例
// （实测 typeof DOMPurify.sanitize === 'undefined'）。两种形态都留兼容，升级库不会静默失效。
const purifier = typeof DOMPurify?.sanitize === 'function' ? DOMPurify : DOMPurify?.(window);
// 安全红线：任何情况下都不能把「未净化」的 markdown 产物注入页面。拿不到净化器就显式报错，
// 绝不能悄悄跳过 sanitize（那样等于把本地 .md 里的 <script> 直接执行）。
if (typeof purifier?.sanitize !== 'function') throw Error('DOMPurify 初始化失败，已阻止渲染未净化的文档');

/** 给可能永久 pending 的第三方 Promise 加超时；超时后仍要能让调用方清理现场。 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label}超时（${ms / 1000} 秒）`)), ms); }),
  ]);
}

/** 把清理函数挂到 host 上：clearStage() 只需通用地调 host.__avDispose?.()，不必 import 本模块。 */
function bindDispose(host, dispose) {
  host.__avDispose = () => {
    try { dispose(); } catch {}
    delete host.__avDispose;
  };
  return host.__avDispose;
}

/** markdown：marked 排版 → DOMPurify 净化 → 外链补 noopener → 注入。 */
export function renderMarkdown(host, source) {
  const html = hardenLinks(
    markdownToHtml(source, {marked, purify: purifier,
      markedOptions: MARKED_OPTIONS, purifyOptions: PURIFY_OPTIONS}),
    window.DOMParser,
  );
  host.classList.add('markdown-body');
  host.innerHTML = html;
  // 相对图片 / 站内锚点不允许导航到预览弹窗之外：markdown 是本地文件，不该有隐式跳转。
  for (const anchor of host.querySelectorAll('a[href^="#"]')) {
    anchor.addEventListener('click', event => event.preventDefault());
  }
  return () => { host.classList.remove('markdown-body'); host.replaceChildren(); };
}

/** docx：docx-preview 在 host 内分页渲染，样式也注入 host（不污染主文档 head）。 */
export async function renderDocx(host, bytes) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
  host.classList.add('docx-viewer');
  await renderAsync(blob, host, host, DOCX_OPTIONS);
  return () => { host.classList.remove('docx-viewer'); host.replaceChildren(); };
}

/** epub：用字节构造 book（不走 XHR，避免鉴权/CORS 与 Range 交互），rendition 挂在 host 内。
 *  损坏 / 受 DRM 的 epub 会让 display() 永久 pending（实测），所以整段包超时并在超时后销毁。 */
export async function renderEpub(host, bytes) {
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes?.buffer ?? bytes;
  const book = ePub(buffer);
  const rendition = book.renderTo(host, EPUB_OPTIONS);
  host.classList.add('epub-reader');
  const dispose = () => {
    try { rendition.destroy(); } catch {}
    try { book.destroy(); } catch {}
    host.classList.remove('epub-reader');
    host.replaceChildren();
  };
  try {
    await withTimeout(rendition.display(), EPUB_RENDER_TIMEOUT_MS, 'EPUB 渲染');
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

/**
 * 统一入口：按注册表的 preview 策略分派。
 * @param {{mode:string, host:HTMLElement, bytes?:ArrayBuffer|Uint8Array, text?:string, ext?:string}} input
 * @returns {{hint:string, dispose:Function}}
 */
export async function renderDocument({mode, host, bytes, text, ext}) {
  const renderer = docRenderModeOf(mode);
  if (!renderer || renderer === 'doc-pdf') throw Error(`不是文档渲染器管辖的策略：${mode}`);
  // 用户连点两个文档时，上一个 epub rendition 还活着会继续占 iframe；先清再渲。
  host.__avDispose?.();
  let dispose;
  try {
    if (renderer === 'markdown') dispose = renderMarkdown(host, text ?? '');
    else if (renderer === 'docx') dispose = await renderDocx(host, bytes);
    else dispose = await renderEpub(host, bytes);
  } catch (error) {
    throw Error(`${docFailureHint(mode, ext)}：${error?.message || '未知原因'}`);
  }
  return {hint: DOC_HINTS[renderer], dispose: bindDispose(host, dispose)};
}
