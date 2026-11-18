// Native shell only: injected after every main-page navigation, including login.
(() => {
  if (window.self !== window.top) return;
  if (document.getElementById('arvimo-window-chrome')) return;
  // 控制组宽度：3 个 32px 键 + 2 个 6px 间距 + 10px 右边距（box-sizing:border-box）。
  // .drag 的右边界与下面的兜底命中判定都引用它，改尺寸只改这一处。
  const W = 118;
  const host = document.createElement('div');
  host.id = 'arvimo-window-chrome';
  // 作为 popover 提升进浏览器 top layer：模态 <dialog>.showModal() 也在 top layer,
  // 普通 z-index（哪怕 2147483647）都盖不住它,拖动带会被 dialog 遮罩吞掉。
  if (typeof host.setAttribute === 'function') host.setAttribute('popover', 'manual');
  const root = host.attachShadow({mode: 'closed'});
  // 按钮形态参考 Melo 的标题栏（components/AppTitleBar.tsx）：32px 圆角键 + 12px
  // stroke-3 细线图标；hover 浅底 + 变白，关闭键 hover 红底 —— 比原来 46px 宽、
  // 直接用 − □ × 文字字符精确得多（字符受字体影响，各机器粗细/基线都不一致）。
  root.innerHTML = `<style>
    /* 整条 chrome 只从侧边栏右边缘开始（--arvimo-drag-left 由脚本实时同步）：
       以前它铺满窗口宽度，hover 后 44px 高会把侧边栏顶部的折叠键整块盖住、吃掉点击。 */
    :host{position:fixed;top:0;right:0;left:var(--arvimo-drag-left,0px);margin:0;width:auto;height:7px;z-index:2147483647;color:#8893a3;font:13px system-ui;user-select:none;border:0!important;padding:0!important;background:transparent!important;overflow:visible!important}
    :host(:hover),:host(:focus-within){height:44px}
    .drag{position:absolute;top:0;left:0;right:${W}px;height:44px;background:transparent}
    header{width:${W}px;height:44px;box-sizing:border-box;margin-left:auto;display:flex;align-items:center;justify-content:flex-end;gap:6px;padding-right:10px;background:transparent;opacity:0;transform:scale(.96);transform-origin:100% 50%;transition:opacity .2s ease-out,transform .2s cubic-bezier(.2,.8,.2,1);pointer-events:none}
    :host(:hover) header,:host(:focus-within) header{opacity:1;transform:scale(1);pointer-events:auto}
    button{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent!important;color:#8893a3;cursor:pointer;transition:background .18s ease,color .18s cubic-bezier(.2,.8,.2,1)}
    button:hover{color:#fff;background:rgba(255,255,255,.1)!important}
    button:active{background:rgba(255,255,255,.16)!important}
    button:focus-visible{outline:2px solid #c9f581;outline-offset:-2px}
    .close:hover{color:#fff;background:#ef4444!important}
    .close:active{background:#dc2626!important}
    button svg{width:12px;height:12px;display:block;flex:none}
    @media(prefers-reduced-motion:reduce){header{transition:none}button{transition:none}}
  </style><div class="drag" aria-hidden="true"></div><header aria-label="窗口控制"><button data-action="minimize" aria-label="最小化" title="最小化"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12h14"/></svg></button><button data-action="maximize" aria-label="最大化或还原" title="最大化 / 还原"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg></button><button class="close" data-action="close" aria-label="关闭窗口" title="关闭窗口"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></header>`;
  const invoke = action => window.__TAURI__.core.invoke('desktop_window_action', {action}).catch(console.error);
  // ponytail: 侧栏空白复用原生拖窗，交互控件和可拖分类保留自身行为。
  document.addEventListener('mousedown', event => {
    const target = event.target;
    if (event.button !== 0 || !target?.closest?.('#sidebar') ||
        target.closest('button,a,input,select,textarea,label,[role="button"],[contenteditable],[draggable="true"],#side-filters')) return;
    event.preventDefault();
    invoke('drag');
  });
  root.querySelector('.drag').addEventListener('mousedown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    invoke(event.detail === 2 ? 'maximize' : 'drag');
  });
  root.querySelectorAll('button').forEach(button => button.addEventListener('click', event => {
    invoke(button.dataset.action);
    if (event.detail) button.blur();
  }));
  // popover 的 UA 默认样式（border:solid / padding / background）在部分 WebView2
  // 版本里会盖掉 shadow :host 的规则，导致顶部多出一条 2px 灰色横边。
  // 用内联 !important 彻底清零，保证标题栏与界面背景完全一致、无可见色带。
  for (const prop of ['border', 'outline', 'box-shadow']) host.style.setProperty(prop, 'none', 'important');
  for (const prop of ['padding', 'margin']) host.style.setProperty(prop, '0', 'important');
  host.style.setProperty('background', 'transparent', 'important');
  document.body.append(host);

  // 拖动带左边界跟随侧边栏右边缘：展开 226px / 折叠 65px / 窄屏 196px / 画布路由滑出
  // 都由布局自己算（宽度过渡、transform 位移都算进 rect），这里只回填 CSS 变量，
  // 避免硬编码宽度导致折叠后仍挡住侧边栏顶部。
  const sidebar = document.getElementById('sidebar');
  let dragLeft = 0;
  const syncDragLeft = () => {
    const right = sidebar ? sidebar.getBoundingClientRect().right : 0;
    dragLeft = Math.max(0, Math.round(right));
    host.style.setProperty('--arvimo-drag-left', `${dragLeft}px`);
  };
  syncDragLeft();
  if (sidebar) {
    if (typeof ResizeObserver === 'function') new ResizeObserver(syncDragLeft).observe(sidebar);
    sidebar.addEventListener('transitionend', syncDragLeft);
  }
  // 折叠态切的是 html class、画布路由切的是 body[data-route]，两者都只改样式不改尺寸，
  // ResizeObserver 收不到，这里补一层属性观察。
  new MutationObserver(syncDragLeft).observe(document.documentElement, {attributes: true, attributeFilter: ['class']});
  if (document.body) new MutationObserver(syncDragLeft).observe(document.body, {attributes: true, attributeFilter: ['data-route']});
  window.addEventListener('resize', syncDragLeft);

  // 把 chrome 放进 top layer，并在任意模态 dialog 打开后重新置顶：
  // top layer 里后进入的元素盖在先进入的之上，所以每次 showModal() 之后
  // 重新 showPopover()，就能让标题拖动带始终浮在大图/设置/下载等弹窗之上。
  const canPopover = typeof host.showPopover === 'function' && typeof host.hidePopover === 'function';
  const raise = () => { try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch {} };
  if (canPopover) {
    raise();
    new MutationObserver(mutations => {
      for (const m of mutations) {
        const t = m.target;
        if (m.type === 'attributes' && t instanceof HTMLDialogElement && t.open) { raise(); break; }
      }
    }).observe(document, {attributes: true, attributeFilter: ['open'], subtree: true});
  }

  // 兜底：部分 WebView2 版本里 modal dialog 的 inert 会压掉 top layer 中 popover 的
  // 指针事件。此时若 mousedown 落在顶部拖动带、又处在 dialog 矩形之外（即 backdrop
  // 上），在捕获阶段直接补一次窗口动作。无弹窗时交给 chrome 自己处理，避免重复。
  document.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.clientY >= 44 || event.clientX >= window.innerWidth - W) return;
    // 侧边栏上方那段顶部不属于拖动带（chrome 从侧边栏右边缘才开始），别把侧栏里的点击当成拖窗。
    if (event.clientX < dragLeft) return;
    const dialogs = Array.prototype.filter.call(document.querySelectorAll('dialog[open]'), d => d.open);
    if (!dialogs.length) return;
    const onBackdrop = dialogs.every(d => {
      const r = d.getBoundingClientRect();
      return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
    });
    if (!onBackdrop) return;
    if (event.composedPath && event.composedPath().indexOf(host) !== -1) return;
    event.preventDefault();
    event.stopPropagation();
    invoke(event.detail === 2 ? 'maximize' : 'drag');
  }, true);
})();
