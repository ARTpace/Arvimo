// UI 元素（Uiverse）的动效预览。
//
// 为什么不用图片当封面：
//   Uiverse 的封面图放在 Cloudflare Images（imagedelivery.net），在很多网络下根本连不上；
//   更要紧的是，UI 元素的卖点就是「会动」—— 给一张静态截图，最值钱的部分就没了。
//   所以卡片上放的是现场渲染的真东西。
//
// 两种渲染方式，各有用途：
//   卡片  → Shadow DOM。样式天然隔离，元素自带的 :root 变量换成 :host 后照常生效；
//           几十张卡片同时跑动画也不会互相污染。
//   弹窗  → iframe + srcdoc。独立文档，元素的 CSS 一点都漏不到主界面来；
//           sandbox 关掉脚本，社区代码不该有执行权。
//
// CSS 的预处理（:root → :host、@import 提前）在服务端 uiverse-state.mjs 里做，
// 那里是纯函数、能单测；前端只负责把结果用出去。
const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));

/**
 * 卡片是 Shadow DOM，`:root` 在里头匹配不到任何东西（它指向文档根），
 * 元素依赖的 CSS 变量（`--tw-*`、主题色）会全部失效。
 * 换成 `:host`（指向挂载 Shadow 的那个元素）就恢复了 —— 与 Uiverse 官方前端做法一致。
 * 弹窗是独立 iframe 文档，仍用原始 `:root`，所以这里是卡片专属的转换，不碰服务端文档。
 */
export const toShadowCss = css => text(css).replace(/:root\b/g, ':host');

/** 卡片上放一个占位块，等代码到位再渲染。 */
export function uiElementSlot(model, { esc }) {
  const title = esc(model?.name || 'UI 元素');
  return `<div class="ui-element-preview" data-ui-preview="${esc(model?.uid || '')}" role="img" aria-label="${title} 动效预览"><span class="ui-element-loading">动效加载中…</span></div>`;
}

/**
 * 把一段代码渲染进 Shadow DOM。
 *
 * attachShadow 只创建一次：卡片重绘时宿主节点会换掉，但 Shadow DOM 挂在节点上，
 * 同一个节点重复调用就只换内容，不重建。
 */
const shadowCache = new WeakMap();
const previewSizing = new WeakMap();

export function renderInShadow(host, { html = '', css = '' } = {}) {
  if (!host) return null;
  let root = shadowCache.get(host);
  if (!root) {
    root = host.attachShadow({ mode: 'open' });
    shadowCache.set(host, root);
  }
  previewSizing.get(host)?.disconnect();
  // 使用独立设计画布缩放，不能让社区控件的固定宽高直接被卡片裁掉。
  root.innerHTML = `<style>:host{display:block;width:100%;height:100%;}html,body{margin:0;padding:0;}body{display:flex;align-items:center;justify-content:center;min-height:100%;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}${toShadowCss(css)}</style><av-preview-stage data-preview-stage style="position:absolute!important;left:50%!important;top:50%!important;width:320px!important;height:320px!important;display:flex!important;align-items:center!important;justify-content:center!important;flex-wrap:nowrap!important;transform-origin:center!important;overflow:visible!important;box-sizing:border-box!important;margin:0!important;padding:0!important">${html}</av-preview-stage>`;
  const stage=root.querySelector('[data-preview-stage]');
  const fit=()=>{
    const width=host.clientWidth,height=host.clientHeight;
    if(!stage||!width||!height)return;
    stage.style.transform='translate(-50%,-50%)';
    const bounds=stage.getBoundingClientRect();
    const cx=bounds.left+bounds.width/2,cy=bounds.top+bounds.height/2;
    let extentX=160,extentY=160;
    for(const child of stage.children){
      const rect=child.getBoundingClientRect();
      extentX=Math.max(extentX,Math.abs(rect.left-cx),Math.abs(rect.right-cx));
      extentY=Math.max(extentY,Math.abs(rect.top-cy),Math.abs(rect.bottom-cy));
    }
    const scale=Math.min(1,Math.max(1,width-24)/(extentX*2),Math.max(1,height-24)/(extentY*2));
    stage.style.transform=`translate(-50%,-50%) scale(${scale})`;
  };
  fit();
  if(typeof ResizeObserver==='function'){
    const observer=new ResizeObserver(fit);
    observer.observe(host);
    for(const child of stage.children)observer.observe(child);
    previewSizing.set(host,observer);
  }
  return root;
}

/**
 * 弹窗预览：一份独立文档塞进 iframe。
 *
 * sandbox 不给 allow-scripts —— 社区提交的代码不该在主界面的上下文里执行。
 * 但 CSS 动画不需要脚本，sandbox 拦不掉它，动效照跑。
 */
export function previewDocumentFor(model) {
  const prepared = text(model?.previewDocument);
  if (prepared) return prepared;
  // 没有服务端拼好的文档（比如从旧库里读出来的记录），现场拼一份。
  const html = text(model?.html);
  const css = text(model?.css);
  if (!html && !css) return '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;height:100%;}body{display:flex;align-items:center;justify-content:center;height:100%;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}${css}</style></head><body>${html}</body></html>`;
}

/**
 * 取一个元素的代码（html + css）。
 *
 * 列表结果里没有代码（站点的列表端点只给元数据，4508 条不可能每条都带 CSS），
 * 所以要现取。服务端给了一条轻通道 /api/ui-site/code，只回代码不回头部元数据。
 *
 * 结果按元素 id 缓存在会话里：同一个元素在网格、详情弹窗、复制按钮之间来回用，
 * 不该每次都重新走一次网络。
 */
const codeCache = new Map();
// 同一元素的并发请求合并：卡片预览和详情弹窗可能同时要同一份代码，
// 各自发一次就是两次 550ms 的网络往返。这里让后到的等前一个的 Promise。
const codePending = new Map();

export async function fetchUiCode(model) {
  const id = text(model?.elementId);
  if (!id) return null;
  if (codeCache.has(id)) return codeCache.get(id);
  if (codePending.has(id)) return codePending.get(id);
  const version = Number(model?.elementVersion) || 1;
  const task = (async () => {
    try {
      const response = await fetch(`/api/ui-site/code?platform=uiverse&id=${encodeURIComponent(id)}&version=${version}`, { headers: { 'X-SFX-Local': '1' } });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      const code = { html: text(data.html), css: text(data.css) };
      // 失败不入缓存：站点抖动是暂时的，缓存住失败会让这一轮再也起不来。
      if (code.html || code.css) codeCache.set(id, code);
      return code;
    } catch {
      return null;
    } finally {
      codePending.delete(id);
    }
  })();
  codePending.set(id, task);
  return task;
}

/**
 * 拼出一段可以直接贴进项目的源码。
 *
 * 形态对齐落盘的 index.html + style.css：HTML 一段、样式一段，
 * 样式内联进 <style>，这样单文件粘走也能跑。
 */
export function uiSourceText(model, code = {}) {
  const html = text(code.html ?? model?.html);
  const css = text(code.css ?? model?.css);
  if (!html && !css) return '';
  // 标题与来源都要洗一遍：注释以 --> 收尾，标题里出现 --> 会提前闭合注释，
  // 往后的内容就跑到注释外面去了（这是从社区站取来的名字，不能当 trusted input）。
  const clean = value => text(value).replace(/[<>]/g, '').replace(/-->/g, '--');
  const title = clean(model?.name);
  const source = clean(model?.url);
  return `<!-- ${title || 'UI 元素'}${source ? ` · ${source}` : ''} -->
${html}

<style>
${css}
</style>
`;
}

/** 占位文字直接写进 Shadow DOM（宿主节点上写 innerHTML 会把 Shadow 一起抹掉）。 */
function showPlaceholder(host, message) {
  let root = shadowCache.get(host);
  if (!root) {
    root = host.attachShadow({ mode: 'open' });
    shadowCache.set(host, root);
  }
  root.innerHTML = `<style>:host{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#8b8b8b;font-size:12px;}</style><span>${message}</span>`;
}

/**
 * 给一张卡片渲染动效。
 *
 * 代码可能不在这张卡上（列表页拿到的条目只有 id 与 slug，代码要现取）。
 * 所以这里接受一个 fetchCode 回调：它按 model 取 {html, css}，取不到就退回静态提示。
 */
export async function mountUiPreview(host, model, { fetchCode } = {}) {
  if (!host) return false;
  const inline = { html: text(model?.html), css: text(model?.css) };
  if (inline.html || inline.css) {
    renderInShadow(host, inline);
    host.classList.add('ready');
    return true;
  }
  // 默认就走服务端那条轻通道：列表结果里没有代码，只有元素 id。
  const load = typeof fetchCode === 'function' ? fetchCode : fetchUiCode;
  try {
    const code = await load(model);
    if (!code || (!text(code.html) && !text(code.css))) {
      host.classList.add('failed');
      showPlaceholder(host, '暂无预览');
      return false;
    }
    renderInShadow(host, { html: text(code.html), css: text(code.css) });
    host.classList.add('ready');
    return true;
  } catch {
    host.classList.add('failed');
    showPlaceholder(host, '预览加载失败');
    return false;
  }
}

/**
 * 给一批卡片挂预览。
 *
 * 性能要点：几十张卡片同时渲染几十套 CSS 动画是很吃 CPU 的，
 * 所以只在卡片**真的滚进视口**时才去取代码 —— 用 IntersectionObserver 守着，
 * 没进视口的先不花钱。这跟「懒加载图片」是同一个道理，只是这里懒的是网络与渲染。
 *
 * models：uid → 资产对象。宿主上只有 uid，代码与元数据从这里查。
 */
export function observeUiPreviews(root, models, { fetchCode } = {}) {
  if (!root) return null;
  const lookup = models instanceof Map ? models : new Map(Object.entries(models || {}));
  // 只管还没挂过的宿主：网格重绘会换掉卡片节点，但已经渲染成功的那张不该重来一遍
  // （重来 = 动画从头播 + 一次多余的代码请求）。
  const hosts = [...root.querySelectorAll('[data-ui-preview]:not([data-ui-mounted])')];
  const mount = host => {
    const model = lookup.get(host.getAttribute('data-ui-preview'));
    if (!model) {
      host.classList.add('failed');
      showPlaceholder(host, '暂无预览');
      return;
    }
    host.setAttribute('data-ui-mounted', '1');
    mountUiPreview(host, model, { fetchCode });
  };
  if (typeof IntersectionObserver !== 'function') {
    // 老浏览器没有观察器：直接全量渲染，功能不缺，只是费点 CPU。
    hosts.forEach(mount);
    return null;
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      mount(entry.target);
    }
  }, { rootMargin: '200px' });
  hosts.forEach(host => observer.observe(host));
  return observer;
}
