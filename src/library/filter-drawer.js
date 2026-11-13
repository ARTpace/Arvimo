// 分类抽屉：折叠态侧栏只剩 65px 图标条，放不下分类 / 筛选树。
//
// 做法：折叠时把内联的 #side-filters 整体「藏起来」（CSS：仅在它仍嵌在 .sidebar 内才
// display:none），并在侧栏加一枚「分类」图标键；点开左侧抽屉面板时，把同一个 #side-filters
// 节点 portal 进抽屉。这样抽屉里就是完整的筛选 UI，而且所有按 ID 绑定的逻辑
// （#filter-rows / 筛选树事件）都不用改——搬的是同一批节点。关抽屉再移回侧栏。
import {setTreeOpen} from './disclosure-motion.js';
export function setupFilterDrawer() {
  const trigger = document.getElementById('filter-drawer-trigger');
  const drawer = document.getElementById('filter-drawer');
  const body = document.getElementById('filter-drawer-body');
  const sidebar = document.getElementById('sidebar');
  const spacer = document.getElementById('side-spacer');
  if (!trigger || !drawer || !body || !sidebar) return;

  let open = false,restoreTimer=0;
  drawer.inert=true;

  const portalToDrawer = () => {
    const sf = document.getElementById('side-filters');
    if (sf && sf.parentElement !== body) body.appendChild(sf);
  };

  const restoreToSidebar = () => {
    const sf = document.getElementById('side-filters');
    if (!sf) return;
    // 移回原位：插在 #side-spacer 之前（即最初在 <nav> 与 spacer 之间的位置）。
    const host = spacer ? spacer.parentElement : sidebar;
    if (sf.parentElement !== host) host.insertBefore(sf, spacer || null);
  };

  const openDrawer = () => {
    if (open) return;
    clearTimeout(restoreTimer);
    portalToDrawer();
    drawer.inert=false;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    trigger.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('filter-drawer-open');   // 驱动主内容右移让位（CSS）
    expandParents();
    open = true;
  };

  // 抽屉里默认展开**父级分支**（分类/类型/…），子分组仍折叠——列表太长会拉不到底。
  // 展开靠给 section 加 .open：两套筛选树的点击逻辑都以 DOM 上的 .open 为准，
  // 所以用户再点分支标题就能手动折叠回去。
  const expandParents = () => {
    for (const section of body.querySelectorAll('.ftree-sec')) {
      setTreeOpen(section,true);
    }
  };

  const closeDrawer = () => {
    if (!open) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('filter-drawer-open');
    open = false;
    drawer.inert=true;
    if(drawer.contains(document.activeElement))trigger.focus({preventScroll:true});
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)restoreToSidebar();
    else restoreTimer=setTimeout(restoreToSidebar,220);
  };

  trigger.addEventListener('click', () => (open ? closeDrawer() : openDrawer()));
  drawer.querySelectorAll('[data-drawer-close]').forEach((el) =>
    el.addEventListener('click', closeDrawer)
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) closeDrawer();
  });

  // 用户在抽屉开着时把侧栏展开：先把分类移回侧栏并关抽屉，避免分类卡在抽屉里。
  const narrow = window.matchMedia('(max-width:780px)');
  const syncDrawer = () => {
    if (document.body.dataset.route === 'canvas' && open) closeDrawer();
  };
  const mo = new MutationObserver(syncDrawer);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-route'] });
  narrow.addEventListener('change', syncDrawer);
}
