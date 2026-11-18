// 卡片展示区的「回到顶部」。
//
// 发现页 / 资产库 / 画板 / 下载管理 / 画布视图全部滚在同一个 #app-scroll 里（见 app.js 的
// pageScroller），所以一颗浮动按钮就能覆盖所有列表，不用每个视图各挂一份。
// 只在滚过一屏的 1/3 之后才浮现：首屏就杵一颗没用的键，比没有更碍事。
import {icon} from './icon-set.js';

const DEFAULT_THRESHOLD = 320;

export function mountScrollTop({threshold = DEFAULT_THRESHOLD} = {}) {
  if (document.getElementById('scroll-top')) return null;

  const host = () => document.getElementById('app-scroll') || document.scrollingElement || document.documentElement;

  const button = document.createElement('button');
  button.id = 'scroll-top';
  button.type = 'button';
  button.className = 'scroll-top';
  button.setAttribute('aria-label', '回到顶部');
  button.title = '回到顶部';
  button.innerHTML = icon('arrow-up');
  document.body.append(button);

  let frame = 0;
  const sync = () => {
    frame = 0;
    const top = Number(host()?.scrollTop) || 0;
    button.classList.toggle('show', top > threshold);
  };
  // scroll 不冒泡，但捕获阶段能拿到；两个来源都监听，避免哪天外层容器换了名字就失效。
  const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };

  window.addEventListener('scroll', schedule, {passive: true, capture: true});
  host()?.addEventListener('scroll', schedule, {passive: true});

  button.addEventListener('click', () => {
    const el = host();
    const behavior = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (el?.scrollTo) el.scrollTo({top: 0, behavior});
    else globalThis.scrollTo?.({top: 0, behavior});
    // 平滑滚动期间先收回，避免用户连点两次时看着像没反应。
    button.classList.remove('show');
  });

  sync();
  return {button, sync};
}
