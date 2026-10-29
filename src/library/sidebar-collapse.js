// 侧边栏折叠：宽屏时把导航收成一列纯图标，内容区（main / toast / 多选栏）跟着让位。
//
// 只切 html 上的 class，宽度与隐藏规则全在 app.css 里（`html.side-collapsed …`），
// 这样「折叠态」和「≤780px 窄屏态」是两套独立规则，互不覆盖；窄屏本来就是图标态，按钮直接隐藏。
// class 挂在 <html> 上是为了能在 <head> 的内联脚本里先设一次，避免刷新时「先展开再收起」闪一下。
const KEY = 'av:sidebar:collapsed';

export function setupSidebarCollapse() {
  const button = document.getElementById('sidebar-toggle');
  const root = document.documentElement;
  let collapsed = root.classList.contains('side-collapsed');
  try { collapsed = localStorage.getItem(KEY) === '1'; } catch { /* 隐私模式读不到就按展开算 */ }

  const apply = (next) => {
    collapsed = next;
    root.classList.toggle('side-collapsed', next);
    if (!button) return;
    // 文案跟着状态翻转：折叠时这个按钮是「展开」，别让无障碍标签说反。
    const label = next ? '展开侧边栏' : '收起侧边栏';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(!next));
  };

  apply(collapsed);
  if (!button) return;
  button.addEventListener('click', () => {
    apply(!collapsed);
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* 存不了就只在本次生效 */ }
  });
}
