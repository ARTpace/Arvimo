// Native shell only: injected after every main-page navigation, including login.
(() => {
  if (window.self !== window.top) return;
  if (document.getElementById('arvimo-window-chrome')) return;
  const host = document.createElement('div');
  host.id = 'arvimo-window-chrome';
  const root = host.attachShadow({mode: 'closed'});
  root.innerHTML = `<style>
    :host{position:fixed;top:0;left:0;right:0;height:7px;z-index:2147483647;color:#e7eaf0;font:13px system-ui;user-select:none}
    :host(:hover),:host(:focus-within){height:36px}
    .drag{position:absolute;top:0;left:0;right:138px;height:28px;background:transparent}
    header{width:138px;height:36px;margin-left:auto;display:flex;align-items:center;background:transparent;transform:translateY(-101%);transition:transform .14s ease;pointer-events:none}
    :host(:hover) header,:host(:focus-within) header{transform:translateY(0);pointer-events:auto}
    button{width:46px;height:36px;border:0;border-radius:0;background:transparent;color:inherit;font:18px system-ui;cursor:pointer}button:hover{background:#ffffff15}button:focus-visible{outline:2px solid #c9f581;outline-offset:-3px}.close:hover{background:#c42b1c}
    @media(prefers-reduced-motion:reduce){header{transition:none}}
  </style><div class="drag" aria-hidden="true"></div><header aria-label="窗口控制"><button data-action="minimize" aria-label="最小化" title="最小化">−</button><button data-action="maximize" aria-label="最大化或还原" title="最大化 / 还原">□</button><button class="close" data-action="close" aria-label="关闭窗口" title="关闭窗口">×</button></header>`;
  const invoke = action => window.__TAURI__.core.invoke('desktop_window_action', {action}).catch(console.error);
  root.querySelector('.drag').addEventListener('mousedown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    invoke(event.detail === 2 ? 'maximize' : 'drag');
  });
  root.querySelectorAll('button').forEach(button => button.addEventListener('click', event => {
    invoke(button.dataset.action);
    if (event.detail) button.blur();
  }));
  document.body.append(host);
})();
