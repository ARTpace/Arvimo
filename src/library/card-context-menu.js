// 卡片右键菜单：在资产库网格里右键一张卡，弹出一组针对这张卡的操作。
//
// 两个关键约束（都踩过坑才写成注释）：
//  1. 菜单必须挂在 <body> 上，不能留在卡片里。.model-card 同时有 overflow:hidden（圆角裁切）
//     和 hover 的 transform，而 transform 会让 position:fixed 的子元素改成「相对卡片」定位，
//     菜单会被算进卡片坐标再被裁掉 —— 表现就是「右键了，什么都没出来」。和「发送到」菜单同源。
//  2. 菜单项沿用卡片按钮那套 data-action 约定，靠事件冒泡交给 app.js 已有的点击分发执行，
//     不在这里写第二套执行逻辑（预览/下载/收藏/回收站… 行为必须两处完全一致）。
//     例外是「复制链接」「打开官方页面」这类没有对应 data-action 的动作，用 run 回调。
//
// 条目组装（assetMenuItems / packageMenuItems / fileMenuItems）是纯函数，
// 上下文由 app.js 收集后传进来 —— 这样菜单内容可单测，不必起整个应用。
import {esc} from './html-esc.js';
import {platformLabel} from './platforms.js';
import {openExternal} from './open-url.js';

/** 右键菜单：条目 + 定位 + 关闭 + 键盘导航。buildItems 返回 null 表示这里不该出菜单。 */
export function setupCardContextMenu({icon, notify = () => {}, buildItems}) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '资产操作');
  menu.hidden = true;
  document.body.appendChild(menu);

  let current = null; // 当前打开的条目表（点击时按索引取回对应条目）

  const close = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.innerHTML = '';
    current = null;
    document.querySelectorAll('.context-target').forEach(el => el.classList.remove('context-target'));
  };

  const render = (spec) => {
    const head = spec.title
      ? `<div class="ctx-head"><strong>${esc(spec.title)}</strong>${spec.subtitle ? `<small>${esc(spec.subtitle)}</small>` : ''}</div>`
      : '';
    const items = spec.items.map((item, index) => {
      if (item.separator) return '<div class="ctx-sep" role="separator"></div>';
      const attrs = Object.entries(item.attrs || {}).map(([key, value]) => ` data-${key}="${esc(value)}"`).join('');
      const cls = ['ctx-item', item.danger ? 'danger' : '', item.disabled ? 'disabled' : ''].filter(Boolean).join(' ');
      // action 型条目带 data-action，事件继续冒泡给 app.js 的既有分发执行；
      // 关闭动作延后到下一个宏任务，避免先清空 DOM 把 data-action 一起带走。
      const action = item.action ? ` data-action="${esc(item.action)}"` : '';
      return `<button class="${cls}" role="menuitem" type="button" data-ctx-index="${index}"${action}${attrs}${item.disabled ? ' disabled' : ''}>${icon(item.icon || 'cube')}<span>${esc(item.label)}</span></button>`;
    }).join('');
    menu.innerHTML = head + items;
  };

  const open = (card, x, y) => {
    const spec = buildItems(card);
    // 没有可用条目就别弹菜单 —— 这时让浏览器原生右键菜单接手，用户还能复制图片地址。
    if (!spec || !spec.items || !spec.items.length) return false;
    current = spec.items;
    render(spec);
    menu.hidden = false;
    card.classList.add('context-target');
    // 先归零再量尺寸：菜单刚从 hidden 变出来时位置是上次的残留值。
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    let left = x, top = y;
    if (left + rect.width > window.innerWidth - 8) left = Math.max(8, x - rect.width);
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - rect.height - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.querySelector('[role="menuitem"]:not(.disabled)')?.focus({preventScroll: true});
    return true;
  };

  // 输入框、下拉、文本编辑区保留浏览器原生右键菜单（复制粘贴是那里唯一有意义的操作）。
  const editable = target => !!target.closest?.('input,textarea,select,[contenteditable="true"],[contenteditable=""]');
  const cardOf = target => target.closest?.('.model-card,[data-package],[data-file]');

  document.addEventListener('contextmenu', event => {
    if (editable(event.target)) return;
    const card = cardOf(event.target);
    if (!card) { close(); return; }
    // 正在选中文本时右键：让浏览器原生菜单接手（复制选中的文字）。
    if (String(window.getSelection?.() || '').trim()) return;
    // 只有真能弹出菜单时才拦下原生菜单。
    if (!open(card, event.clientX, event.clientY)) { close(); return; }
    event.preventDefault();
  });

  menu.addEventListener('click', event => {
    const button = event.target.closest('[data-ctx-index]');
    if (!button || button.disabled) return;
    const item = current?.[Number(button.dataset.ctxIndex)];
    if (!item) return;
    if (item.run) {
      close();
      try { Promise.resolve(item.run()).catch(error => notify(error?.message || '操作失败')); }
      catch (error) { notify(error?.message || '操作失败'); }
      return;
    }
    // action 型：不拦冒泡，让 document 上 app.js 的既有分发接手执行。
    // 关闭放到宏任务之后 —— 同步清空 innerHTML 会把事件目标从 DOM 上摘掉，
    // 那样 app.js 里 e.target.closest('[data-action]') 就找不到动作了。
    setTimeout(close, 0);
  });

  document.addEventListener('pointerdown', event => {
    if (!menu.hidden && !menu.contains(event.target)) close();
  });
  document.addEventListener('scroll', () => close(), true);
  window.addEventListener('resize', () => close());
  window.addEventListener('blur', () => close());
  document.addEventListener('keydown', event => {
    if (menu.hidden) {
      // 键盘等价操作：Shift+F10 或菜单键，位置落在卡片中心。
      if (!((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu')) return;
      const card = cardOf(event.target);
      if (!card || editable(event.target)) return;
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      open(card, rect.left + 18, rect.top + 18);
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(.disabled)')];
    if (!items.length) return;
    const active = items.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index].focus();
  });

  return {close, open, menu};
}

/* ------------------------------------------------------------------ */
/* 菜单条目组装（纯函数）：上下文由 app.js 收集后传入                     */
/* ------------------------------------------------------------------ */

/**
 * 远端资产卡（.model-card[data-uid]）的菜单条目。
 *
 * 「是否已下载 / 能不能导出 / 能不能打开文件夹」不自己判一套：卡片上已经渲染了对应的节点
 * （下载键、.export-control、.open-folder），直接读这三个节点，菜单与卡片显示的状态天然一致。
 * ctx: {card, model, uid, canDownload, revealId, canExport, favorite, inLibrary, isTrash, isVisitor, notify}
 */
export function assetMenuItems(ctx) {
  const {model, uid, canDownload, revealId, canExport, favorite, inLibrary, isTrash, isVisitor, notify = () => {}} = ctx;
  const items = [];
  items.push({icon: 'eye', label: '打开预览', action: 'preview', attrs: {uid}});
  if (canDownload) items.push({icon: 'download', label: '下载到本地', action: 'download', attrs: {uid}});
  if (revealId) items.push({icon: 'folder', label: '打开下载文件夹', action: 'reveal-download', attrs: {id: revealId}});
  if (canExport) items.push({icon: 'share', label: '发送到其它软件…', run: () => clickInside(ctx.card, '.export-toggle')});
  items.push({separator: true});
  if (!isTrash) {
    items.push({icon: 'heart', label: favorite ? '取消收藏' : '收藏', action: 'favorite', attrs: {uid}});
    // 加入 / 移出模型库是改主机资产库的动作，访客没有这个身份。
    if (!isVisitor) {
      if (inLibrary) items.push({icon: 'trash', label: '从模型库移除', action: 'remove', attrs: {uid}});
      else items.push({icon: 'folder', label: '加入模型库', action: 'collect', attrs: {uid}});
    }
    items.push({icon: 'tag', label: '标签与评分', action: 'asset-tags', attrs: {uid}});
  }
  const url = model?.url || model?.artworkUrl || '';
  if (url) {
    items.push({separator: true});
    items.push({icon: 'link', label: '复制官方链接', run: () => copyText(url).then(ok => notify(ok ? '链接已复制' : '复制失败，请手动复制'))});
    items.push({icon: 'external', label: '在浏览器打开官方页面', run: () => openExternalLink(url)});
  }
  if (isTrash) {
    items.push({separator: true});
    items.push({icon: 'rotate', label: '放回模型库', action: 'restore', attrs: {uid}});
    items.push({icon: 'trash', label: '彻底删除记录', action: 'purge', attrs: {uid}, danger: true});
  }
  return {
    title: model?.name || '资产',
    subtitle: platformLabel(model?.platform),
    items,
  };
}

/** 本地素材包卡（.model-card[data-package]）的菜单条目。ctx: {card, pkg, canRegister, notify} */
export function packageMenuItems(ctx) {
  const {pkg, canRegister, notify = () => {}} = ctx;
  const items = [];
  items.push({icon: 'folder', label: '打开素材包', run: () => clickInside(ctx.card, '.preview-hit')});
  items.push({icon: 'download', label: '下载为 ZIP', run: () => clickInside(ctx.card, '[data-package-download]')});
  if (canRegister) items.push({icon: 'tag', label: '登记 info.json', run: () => clickInside(ctx.card, '[data-package-register]')});
  if (pkg?.rel) items.push({icon: 'link', label: '复制路径', run: () => copyText(pkg.rel).then(ok => notify(ok ? '路径已复制' : '复制失败，请手动复制'))});
  return {title: pkg?.title || pkg?.rel || '素材包', subtitle: pkg?.rel || '', items};
}

/** 零散文件卡（.local-file-card[data-file]）的菜单条目。ctx: {card, file, notify} */
export function fileMenuItems(ctx) {
  const {file, notify = () => {}} = ctx;
  const items = [];
  items.push({icon: 'eye', label: '打开文件', run: () => ctx.card.click()});
  if (file?.rel) items.push({icon: 'link', label: '复制路径', run: () => copyText(file.rel).then(ok => notify(ok ? '路径已复制' : '复制失败，请手动复制'))});
  return {title: file?.name || '文件', subtitle: file?.rel || '', items};
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 点卡片里的某个现成按钮 —— 复用卡片已经写好的行为，不重写一遍。 */
function clickInside(card, selector) {
  const button = card?.querySelector?.(selector);
  if (!button) return false;
  button.click();
  return true;
}

/** 写剪贴板：clipboard API 不可用时（http、权限拒绝）退回 execCommand。 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try { await navigator.clipboard.writeText(value); return true; }
  catch { /* 继续走兜底 */ }
  const area = document.createElement('textarea');
  area.value = value;
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

/** 在系统默认浏览器里打开链接（复用 open-url.js：装成桌面应用后要走系统浏览器）。 */
function openExternalLink(url) {
  if (!url) return false;
  openExternal(url);
  return true;
}
