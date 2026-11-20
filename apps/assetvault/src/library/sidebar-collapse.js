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
  let contentAnimation;
  const main = document.querySelector('main');

  const settle = () => {
    root.classList.remove('side-animating');
    // 冻结期间跳过的重排在这里补一次，让瀑布流 / sticky 落在最终宽度上。
    window.dispatchEvent(new Event('resize'));
  };

  const apply = (next, animate=false) => {
    const moving = animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Read the visible position before cancelling: rapid clicks reverse from this frame.
    const previousLeft = moving && main ? main.getBoundingClientRect().left : 0;
    contentAnimation?.cancel();
    collapsed = next;
    clearTimeout(settleTimer);
    root.classList.toggle('side-animating', moving);
    root.classList.toggle('side-collapsed', next);
    if (moving && main?.animate) {
      const offset = previousLeft - main.getBoundingClientRect().left;
      contentAnimation = main.animate([
        {transform:`translateX(${offset}px)`}, {transform:'translateX(0)'}
      ], {duration:ANIM_MS, easing:'cubic-bezier(.22,.61,.36,1)'});
    }
    // 用定时器兜底而不是 transitionend：侧栏和 main 各有一条过渡，且子元素冒泡会误判；
    // 减少动效偏好下 CSS 本来就无过渡，多等这 280ms 也不会有视觉代价。
    if (moving) settleTimer = setTimeout(settle, ANIM_MS + 40);
    else if (animate) settle();
    if (!button) return;
    // 文案跟着状态翻转：折叠时这个按钮是「展开」，别让无障碍标签说反。
    const label = next ? '展开侧边栏' : '收起侧边栏';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(!next));
  };

  apply(collapsed);
  if (!button) return;
  setupCanvasSidebarReveal(root);
  button.addEventListener('click', () => {
    apply(!collapsed, true);
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* 存不了就只在本次生效 */ }
  });
}

// 画布中的导航是临时展开，不改用户保存的宽栏/图标栏偏好。
export function setupCanvasSidebarReveal(root=document.documentElement) {
  const sidebar=document.getElementById('sidebar');
  if(!sidebar)return;
  let openTimer=0,closeTimer=0;
  const move=(x,target,buttons=0)=>{
    if(document.body.dataset.route!=='canvas')return;
    // HUD 位于画布左缘时不能被导航抢走指针；任何拖动期间也不能改变 iframe 的视口位置。
    if(buttons||target?.closest?.('[data-perf-hud]')){
      clearTimeout(openTimer);openTimer=0;
      clearTimeout(closeTimer);closeTimer=0;
      return;
    }
    const open=root.classList.contains('canvas-nav-open');
    const near=x>=0&&(x<=72||(open&&x<=sidebar.getBoundingClientRect().right+32)||sidebar.contains(target));
    if(near){
      clearTimeout(closeTimer);closeTimer=0;
      if(!open&&!openTimer)openTimer=setTimeout(()=>{
        openTimer=0;
        if(document.body.dataset.route==='canvas')root.classList.add('canvas-nav-open');
      },80);
    }else{
      clearTimeout(openTimer);openTimer=0;
      if(open&&!closeTimer)closeTimer=setTimeout(()=>{
        closeTimer=0;root.classList.remove('canvas-nav-open');
      },550);
    }
  };
  const onPointer=event=>move(event.clientX,event.target,event.buttons);
  window.addEventListener('pointermove',onPointer,{passive:true});
  window.addEventListener('pointerdown',onPointer,{passive:true});
  // iframe 内的指针事件不会冒泡到宿主；直接监听同源画布，不铺遮挡点击的透明热区。
  const bindFrame=frame=>{
    try{
      const onFramePointer=event=>move(frame.getBoundingClientRect().left+event.clientX,event.target,event.buttons);
      frame.contentDocument?.addEventListener('pointermove',onFramePointer,{passive:true});
      frame.contentDocument?.addEventListener('pointerdown',onFramePointer,{passive:true});
    }catch{}
  };
  document.querySelectorAll('iframe').forEach(bindFrame);
  document.addEventListener('load',event=>{if(event.target instanceof HTMLIFrameElement)bindFrame(event.target);},true);
}
