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

/** 右键菜单：条目 + 定位 + 关闭 + 键盘导航。buildItems 返回 null 表示这里不该出菜单。
 *  targetOf 决定「右键在谁身上才出菜单」，默认是资产卡；画板卡等其它实体各自传自己的选择器，
 *  复用同一套定位 / 关闭 / 方向键逻辑，不再写第二个菜单。 */
export function createContextMenu({icon, notify = () => {}, buildItems,
  targetOf = target => target.closest?.('.model-card,[data-package],[data-file],[data-sequence]')}) {
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
      if (item.group) return `<div class="ctx-group" role="presentation">${esc(item.group)}</div>`;
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
  const cardOf = targetOf;

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
    if (item.confirm && button.dataset.armed !== '1') {
      event.stopPropagation();
      button.dataset.armed = '1';
      button.classList.add('armed');
      const label = button.querySelector('span');
      if (label) label.textContent = item.confirm;
      return;
    }
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

/** 旧名保留：资产卡那份菜单实例（app.js 的既有调用点不变）。 */
export const setupCardContextMenu = createContextMenu;

/* ------------------------------------------------------------------ */
/* 菜单条目组装（纯函数）：上下文由 app.js 收集后传入                     */
/* ------------------------------------------------------------------ */

/**
 * 分组组装：每组一个小标题，组间自动一条分隔线 —— 不再在条目流里手工乱插 separator。
 * 四类卡片共用「打开与获取 / 整理 / 危险操作」三段语义，风格才统一。
 */
const menuSpec = (title, subtitle, groups) => {
  const items = [];
  for (const group of groups) {
    const rows = (group.items || []).filter(Boolean);
    if (!rows.length) continue;
    if (items.length) items.push({separator: true});
    items.push({group: group.label});
    items.push(...rows);
  }
  return {title, subtitle, items};
};

/**
 * 远端资产卡（.model-card[data-uid]）的菜单条目。
 * 只判「能不能下载 / 打开文件夹 / 导出」这类上下文，动作一律沿用卡片的 data-action；
 * 卡片上收起来的入库、打开文件夹、移除全部在这里，不再在封面四角各摆一颗按钮。
 *
 * realm 区分「发现」与「资产库」两套功能（同一张卡在两种视图下右键菜单不一样）：
 *  - 'discover'（在线浏览 / 图站检索结果）：只看、抓到手、存进库、记元数据、取源链接；
 *    不给任何本地管理动作（打开下载文件夹 / 发送给软件 / 加入画板 / 重新定位 / 移除 / 删除）。
 *  - 'library'（本地资产库）：在 discover 的基础上追加本地管理动作（默认）。
 */
export function assetMenuItems(ctx) {
  const {model, uid, canDownload, revealId, canExport, favorite, inLibrary, isTrash, isVisitor, notify = () => {}, realm = 'library'} = ctx;
  const isDiscover = realm === 'discover';
  const url = model?.url || model?.artworkUrl || '';
  // 打开与获取：发现页是「看 / 抓到手」，资产库是「看 / 取本地 / 发到软件」。
  const sendToCanvas = ctx.onSendToCanvas && {icon: 'grid', label: '发送到画布', run: () => ctx.onSendToCanvas([uid])};
  const open = isDiscover ? [
    {icon: 'eye', label: '打开预览', action: 'preview', attrs: {uid}},
    canDownload && {icon: 'download', label: '下载到本地', action: 'download', attrs: {uid}},
    url && {icon: 'external', label: '在浏览器打开官方页面', run: () => openExternalLink(url)},
    sendToCanvas,
  ] : [
    {icon: 'eye', label: '打开预览', action: 'preview', attrs: {uid}},
    canDownload && {icon: 'download', label: '下载到本地', action: 'download', attrs: {uid}},
    revealId && {icon: 'folder', label: '打开下载文件夹', action: 'reveal-download', attrs: {id: revealId}},
    canExport && {icon: 'share', label: '发送到其它软件…', run: () => clickInside(ctx.card, '.export-toggle')},
    url && {icon: 'external', label: '在浏览器打开官方页面', run: () => openExternalLink(url)},
    sendToCanvas,
  ];
  // 整理：发现页只做「存进库 + 记元数据 + 取源链接」，不给画板 / 重新定位（都依赖本地资产身份）。
  const organize = isTrash ? [] : (isDiscover ? [
    {icon: 'heart', label: favorite ? '取消收藏' : '收藏', action: 'favorite', attrs: {uid}},
    // 发现页只给「加入模型库」（把在线资产收进库）；已在库里就不给「移除」——那是库内管理动作。
    !isVisitor && !inLibrary && {icon: 'save', label: '加入模型库', action: 'collect', attrs: {uid}},
    {icon: 'tag', label: '标签与评分…', action: 'asset-tags', attrs: {uid}},
    url && {icon: 'link', label: '复制官方链接', run: () => copyText(url).then(ok => notify(ok ? '链接已复制' : '复制失败，请手动复制'))},
  ] : [
    {icon: 'heart', label: favorite ? '取消收藏' : '收藏', action: 'favorite', attrs: {uid}},
    !isVisitor && (inLibrary
      ? {icon: 'trash', label: '从模型库移除', action: 'remove', attrs: {uid}}
      : {icon: 'save', label: '加入模型库', action: 'collect', attrs: {uid}}),
    {icon: 'tag', label: '标签与评分…', action: 'asset-tags', attrs: {uid}},
    ctx.onBoardPicker && !isVisitor && {icon: 'layers', label: '加入画板…', run: () => ctx.onBoardPicker([uid], {mode: 'add'})},
    ctx.onBoardPicker && !isVisitor && {icon: 'minus', label: '从画板移出…', run: () => ctx.onBoardPicker([uid], {mode: 'remove'})},
    ctx.onSimilar && {icon: 'search', label: '找相似资产', run: () => ctx.onSimilar(uid)},
    url && {icon: 'link', label: '复制官方链接', run: () => copyText(url).then(ok => notify(ok ? '链接已复制' : '复制失败，请手动复制'))},
    ctx.canRelink && {icon: 'folder', label: '重新定位链接文件…', run: () => ctx.onRelink?.()},
  ]);
  // 危险操作：仅资产库（发现页不提供本地删除 / 回收站操作）。
  const danger = isDiscover ? [] : [
    isTrash && {icon: 'rotate', label: '放回模型库', action: 'restore', attrs: {uid}},
    isTrash && {icon: 'trash', label: '彻底删除记录', action: 'purge', attrs: {uid}, danger: true},
    ctx.onDelete && !isVisitor && {icon: 'trash', label: '删除', confirm: '再点一次，连本地文件一起删除', danger: true, run: () => ctx.onDelete()},
  ];
  return menuSpec(model?.name || '资产', platformLabel(model?.platform), [
    {label: '打开与获取', items: open},
    {label: '整理', items: organize},
    {label: '危险操作', items: danger},
  ]);
}

/** 本地素材包卡（.model-card[data-package]）。
 *  登记 / 补原图由 ctx.onPackageAction 直接执行 —— 卡片上那两颗文字键已收进菜单，
 *  不能再靠模拟点击一个不存在的按钮。 */
export function packageMenuItems(ctx) {
  const {pkg, canRegister, notify = () => {}} = ctx;
  const key = `${pkg?.root}|${pkg?.rel}`;
  const open = [
    {icon: 'eye', label: '打开素材包', run: () => clickInside(ctx.card, '.preview-hit')},
    {icon: 'download', label: '下载为 ZIP', run: () => clickInside(ctx.card, '[data-package-download]')},
    pkg?.remote && {icon: 'download', label: '下载原图', run: () => ctx.onPackageAction?.(key, 'fetch')},
  ];
  const organize = [
    canRegister && {icon: 'tag', label: '登记 info.json', run: () => ctx.onPackageAction?.(key, 'register')},
    pkg?.rel && {icon: 'link', label: '复制路径', run: () => copyText(pkg.rel).then(ok => notify(ok ? '路径已复制' : '复制失败，请手动复制'))},
  ];
  const danger = [
    ctx.onDelete && {icon: 'trash', label: '删除', confirm: '再点一次，删除本地文件', danger: true, run: () => ctx.onDelete()},
  ];
  return menuSpec(pkg?.title || pkg?.rel || '素材包', pkg?.rel || '', [
    {label: '打开与获取', items: open},
    {label: '整理', items: organize},
    {label: '危险操作', items: danger},
  ]);
}

/** 本地图片序列卡（.local-file-card[data-sequence]，uid 形如 seq:root|dir|prefix|ext）的菜单。
 *  ctx: {seq, uid, onOpen, onBoardPicker, onCopyPath, notify}
 *  序列是资产、画板是容器——除了「播放」也给「加入画板」，与模型卡同一套组织逻辑；
 *  不再在卡片上摆多余按钮，低频动作全收进右键。 */
export function sequenceMenuItems(ctx) {
  const {seq, uid, onOpen, onBoardPicker, onCopyPath, onSendToCanvas, notify = () => {}} = ctx;
  const items = [
    {icon: 'eye', label: '播放序列', run: () => onOpen?.(uid)},
  ];
  if (onSendToCanvas) items.push({icon: 'grid', label: '发送到画布', run: () => onSendToCanvas([uid])});
  if (onBoardPicker) items.push({icon: 'layers', label: '加入画板…', run: () => onBoardPicker([uid], {mode: 'add'})});
  if (onCopyPath) items.push({icon: 'link', label: '复制路径', run: () => onCopyPath()});
  // 序列菜单项少、无需分组，直接返回扁平条目（避免 menuSpec 拍平时空分组头）。
  return {title: seq?.label || '图片序列', subtitle: `${seq?.count || ''} 帧`, items};
}

/** 零散文件卡（.local-file-card[data-file]）。 */
export function fileMenuItems(ctx) {
  const {file, notify = () => {}} = ctx;
  const open = [
    {icon: 'eye', label: '打开文件', run: () => ctx.card.click()},
    file?.rel && {icon: 'link', label: '复制路径', run: () => copyText(file.rel).then(ok => notify(ok ? '路径已复制' : '复制失败，请手动复制'))},
  ];
  const danger = [
    ctx.onDelete && {icon: 'trash', label: '删除', confirm: '再点一次，删除本地文件', danger: true, run: () => ctx.onDelete()},
  ];
  return menuSpec(file?.name || '文件', file?.rel || '', [
    {label: '打开与获取', items: open},
    {label: '危险操作', items: danger},
  ]);
}

/** 图站图片卡（.picture-site-results 里的 figure.model-card）。
 *  没有 uid，动作仍从缩略图的 data-* 和卡片里现成的按钮取，菜单只负责分组摆出来。 */
export function pictureMenuItems(ctx) {
  const {card, img, notify = () => {}} = ctx;
  const data = img?.dataset || {};
  const original = data.url || '';
  const isVideo = data.type === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(original);
  const page = absoluteUrl(data.pageUrl || (/^https?:\/\//i.test(data.source || '') ? data.source : ''));
  const author = absoluteUrl(data.authorUrl || '');
  const open = [
    {icon: 'eye', label: isVideo ? '播放视频' : '打开大图预览', run: () => img.click()},
    original && {icon: 'download', label: isVideo ? '视频另存到本机…' : '原图另存到本机…', run: () => saveOriginal(original, data.title || '', isVideo)},
    ctx.onBookmark && {icon: 'save', label: '只入库不下载', run: () => ctx.onBookmark()},
  ];
  const organize = [
    card?.querySelector('.pin-similar') && {icon: 'search', label: '用这张图找相似', run: () => clickInside(card, '.pin-similar')},
    original && {icon: 'link', label: isVideo ? '复制视频地址' : '复制原图地址', run: () => copyText(original).then(ok => notify(ok ? '地址已复制' : '复制失败，请手动复制'))},
    page && {icon: 'external', label: '在浏览器打开作品页', run: () => openExternalLink(page)},
    author && card?.querySelector('.pic-author') && {icon: 'user', label: '查看该作者的作品', run: () => clickInside(card, '.pic-author')},
  ];
  const size = Number(data.w) && Number(data.h) ? `${data.w} × ${data.h}` : '';
  return menuSpec(data.title || (isVideo ? '视频' : '图片'), [data.author, size].filter(Boolean).join(' · ') || (isVideo ? '视频' : '图片'), [
    {label: '打开与获取', items: open},
    {label: '整理', items: organize},
  ]);
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 存原图：走本地代理（图站校验 Referer，直连会 403），full=1 取原始像素。
 *  视频没有 full 概念，走 /api/video 直通原文件。 */
function saveOriginal(url, title, video = false) {
  const href = new URL(video ? `/api/video?url=${encodeURIComponent(url)}` : `/api/image?url=${encodeURIComponent(url)}&full=1`, location.origin).href;
  const link = document.createElement('a');
  link.href = href;
  link.download = originalFileName(url, title);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** 文件名：优先用标题，扩展名从地址里取（拿不到就当 jpg —— 这几家图床基本只有 jpg/png）。 */
function originalFileName(url, title) {
  const base = String(title || '').trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  let ext = '';
  try {
    const found = /\.(jpe?g|png|webp|gif|avif|bmp|tiff|mp4|webm|mov)$/i.exec(new URL(url, location.href).pathname);
    ext = found ? found[0].toLowerCase() : '';
  } catch { /* 地址不合法就按默认后缀 */ }
  return `${base || 'image'}${ext || '.jpg'}`;
}

/** data-* 里可能存的是站内相对地址，交给系统浏览器前必须补成绝对地址。
 *  绝对地址直接放行：node 里跑单测没有 location，也不该因此丢条目。 */
function absoluteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try { return new URL(raw, location.href).href; } catch { return ''; }
}

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
