// 侧边栏折叠：宽屏时把导航收成一列纯图标，内容区（main / toast / 多选栏）跟着让位。
//
// 只切 html 上的 class，宽度与隐藏规则全在 app.css 里（`html.side-collapsed …`），
// 这样「折叠态」和「≤780px 窄屏态」是两套独立规则，互不覆盖；窄屏本来就是图标态，按钮直接隐藏。
// class 挂在 <html> 上是为了能在 <head> 的内联脚本里先设一次，避免刷新时「先展开再收起」闪一下。
const KEY = 'av:sidebar:collapsed';
// 与 app.css 的 --side-anim 一致。动画期间挂 side-animating：main 宽度逐帧变化会让
// masonry 对每张卡片 getBoundingClientRect()（强制同步布局）、sticky RO 逐帧读 offsetHeight，
// 这是折叠卡顿的主因。冻结这些重排，动画结束后统一补一次。
const ANIM_MS = 240;

export function setupSidebarCollapse() {
  // Keep labels measurable during collapse, rather than snapping font-size to zero.
  document.querySelectorAll('#sidebar .nav').forEach(nav=>{
    for(const node of [...nav.childNodes]){
      if(node.nodeType!==Node.TEXT_NODE||!node.textContent.trim())continue;
      const label=document.createElement('span');label.className='nav-label';label.textContent=node.textContent.trim();node.replaceWith(label);
    }
  });
  const button = document.getElementById('sidebar-toggle');
  const root = document.documentElement;
  let collapsed = root.classList.contains('side-collapsed');
  try { collapsed = localStorage.getItem(KEY) === '1'; } catch { /* 隐私模式读不到就按展开算 */ }
  let settleTimer = 0;

  const settle = () => {
    root.classList.remove('side-animating');
    // 冻结期间跳过的重排在这里补一次，让瀑布流 / sticky 落在最终宽度上。
    window.dispatchEvent(new Event('resize'));
  };

  const apply = (next, animate=false) => {
    collapsed = next;
    clearTimeout(settleTimer);
    root.classList.toggle('side-animating', animate);
    root.classList.toggle('side-collapsed', next);
    // 用定时器兜底而不是 transitionend：侧栏和 main 各有一条过渡，且子元素冒泡会误判；
    // 减少动效偏好下 CSS 本来就无过渡，多等这 280ms 也不会有视觉代价。
    if (animate) settleTimer = setTimeout(settle, ANIM_MS + 40);
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
    apply(!collapsed, true);
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* 存不了就只在本次生效 */ }
  });
}
