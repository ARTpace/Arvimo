import {orderedCategories} from './category-order.js';
import {classifyAsset} from './asset-classification.js';
/** Five permanent mother-category entries, shared with the sidebar through MODE_PRESETS.
 * Discovery keeps each entry's platform context; the library filters the union of its child types.
 * Clicking the active mother exits; clicking it from a child restores the whole mother category.
 */
import {icon} from './icon-set.js';
import {activeMode} from './content-modes.js';
import {MODE_PRESETS} from './mode-presets.js';
import {localAssetKind} from './local-filters.js';
import {formatRegistry} from './format-registry.js';
import {inferKindHints} from './asset-kind-heuristics.js';

/** UI 状态单独存一份，不与资产库 blob 混在一起（同 sidebar-collapse.js 的做法）。 */
export const MODE_UI_KEY = 'av:content-mode:v1';
const LEGACY_UI_KEY = 'av:content-kind:v1';

/** 常驻模式清单，顺序即显示顺序。清单来自 mode-presets.js 的契约表，组件不自己再抄一份。 */
export const MODE_TABS = Object.freeze(MODE_PRESETS.map(preset => Object.freeze({
  id: preset.id, label: preset.label, icon: preset.icon,
  mode: preset.legacyMode, preset: preset.id,
})));

export const modeTabById = id => MODE_TABS.find(entry => entry.id === id) || null;
/** 常驻集合是固定的，不认 route / counts —— 这是模式开关，不是分类 facet。 */
export const modeTabs = () => MODE_TABS;

/** 内容类型判定表：只管「一条资产属于哪几类」，与图标是否常驻解耦。 */
export const CONTENT_KINDS = Object.freeze([
  {id: 'unknown', label: '待分类', icon: 'archive'},
  {id: 'models', label: '3D 模型', icon: 'cube'},
  {id: 'images', label: '图片', icon: 'image'},
  {id: 'textures', label: '材质', icon: 'layers'},
  {id: 'hdris', label: 'HDRI', icon: 'globe'},
  {id: 'packs', label: '资源包', icon: 'archive'},
  {id: 'videos', label: '视频', icon: 'play'},
  {id: 'audio', label: '音频', icon: 'music'},
  {id: 'documents', label: '文档', icon: 'type'},
  // UI 元素（Uiverse 落盘的 index.html + style.css）在顶部图标轨上是一个常驻模式，
  // 但一直没进这张判定表 —— 侧栏类型树按 CONTENT_KINDS 铺，缺一行就等于「UI 只有顶上有、侧栏没有」。
  {id: 'uielement', label: 'UI 元素', icon: 'layout'},
].map(Object.freeze));

export const kindById = id => CONTENT_KINDS.find(entry => entry.id === id) || null;

/** format-registry 的 kind → 类型 id。font / other / text 暂不单独成类。 */
export const FORMAT_TO_ID = Object.freeze({
  model: 'models', image: 'images', video: 'videos',
  audio: 'audio', document: 'documents', env: 'hdris',
});

/**
 * 图标模式 → 磁盘条目的类型名。
 *
 * 资产库里除了 state.models，还有两类「额外卡片」：磁盘上没登记成任务的零散文件（`file.kind`）
 * 与资产包（`pkg.category`）。它们各有自己的类型词表，不进 contentKindsOf()。
 * 少了这张对照表，按「文本」筛的时候那些图片包仍会留在网格里 —— 计数说 0 条、卡片却铺满一屏。
 * 只有下拉没有的类型才会用到它（documents / videos / audio）；images / models 等走 #local-kind，已由 localFiles 自己筛。
 */
export const LOCAL_KINDS_OF_MODE = Object.freeze({
  unknown: Object.freeze({files: ['other'], packages: ['unknown']}),
  models: Object.freeze({files: ['model'], packages: ['model']}),
  images: Object.freeze({files: ['image'], packages: ['images']}),
  textures: Object.freeze({files: ['image'], packages: ['material']}),
  hdris: Object.freeze({files: ['env'], packages: ['skybox']}),
  videos: Object.freeze({files: ['video'], packages: []}),
  audio: Object.freeze({files: ['audio'], packages: []}),
  documents: Object.freeze({files: ['document'], packages: []}),
  // UI 元素落盘是 index.html + style.css：零散文件按 document kind 存，
  // 整包扫描认出 html+css 组合后写 category='uielement'（见 server/local-assets.mjs）。
  uielement: Object.freeze({files: ['document'], packages: ['uielement']}),
  // 资源包：零散 .zip（kind='other'）认成包；整包 info.json 的 kind='pack' 也按包归类。
  // 这两行必须写出来：缺一行就等于「没选模式」，modeAllowsLocalKind 会一律放行，
  // 选「资源包」时磁盘卡片全留在网格里。
  packs: Object.freeze({files: [], packages: ['pack']}),
});

/** 某个模式下额外卡片该不该出：没有映射（＝没选模式）就一律放行。
 *  kind 可以是字符串（磁盘 kind / 包 category），也可以直接传文件/包对象 ——
 *  传对象时会叠加启发式（如 PBR 图片归材质、html+css 归 UI），与侧栏计数同源。 */
/** Mother categories are unions of their child types, shared by every card surface. */
export const localKindIds = id => MODE_PRESETS.find(preset => preset.groupId === id)?.localKinds || [id];
export const contentMatchesKind = (model, id) => localKindIds(id).some(kind => contentKindsOf(model).includes(kind));

export function modeAllowsLocalKind(modeId, surface, kind, files = null) {
  const children = localKindIds(modeId);
  if (children.length > 1 || children[0] !== modeId) return children.some(id => modeAllowsLocalKind(id, surface, kind, files));
  const map = LOCAL_KINDS_OF_MODE[modeId || ''];
  if (!map) return true;
  const allowed = map[surface] || [];
  if (typeof kind !== 'string') {
    const item = kind || {};
    if(surface==='packages')return classifyAsset({...item,assetType:item.category}).kind===modeId;
    return classifyAsset({...item,assetType:item.kind}).kind===modeId;
  }
  if (allowed.includes(kind)) return true;
  if (files && allowed.length) return inferKindHints(files, '', name => formatRegistry.kindOf(name)).includes(modeId);
  return false;
}

/** Primary asset classification excludes supporting textures, covers and documentation. */
export function contentKindsOf(model = {}) {
  if (!model || typeof model !== 'object') return [];
  return [localAssetKind(model)];
}

/** 当前该点亮哪个模式：显式主状态 > 旧类型字段 > 原内容模式 > 本地类型下拉；都没有就返回空串（＝全部）。
 *  state.mode 是唯一权威：手动在下拉里换平台不会把它冲掉，高亮才不会乱跳。 */
export function activeModeId(state = {}, readKind = () => '') {
  if (Object.hasOwn(state, 'mode')) return modeTabById(state.mode) ? state.mode : '';
  if (modeTabById(state?.mode)) return state.mode;
  if (modeTabById(state?.contentKind)) return state.contentKind;
  const mode = activeMode(state || {});
  if (mode === 'model') return 'models';
  if (mode === 'image') return 'images';
  const value = String(readKind?.() || '');
  return modeTabById(value) ? value : '';
}

/** 刷新后仍停在上次的模式；旧键兼容读取，非法 / 已下线的模式值直接忽略。 */
export function savedMode() {
  try {
    if (typeof localStorage === 'undefined') return '';
    const value = localStorage.getItem(MODE_UI_KEY) || localStorage.getItem(LEGACY_UI_KEY) || '';
    return modeTabById(value) ? value : '';
  } catch { return ''; }
}
export function rememberMode(id) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (id) localStorage.setItem(MODE_UI_KEY, String(id));
    else localStorage.removeItem(MODE_UI_KEY);
    localStorage.removeItem(LEGACY_UI_KEY);
  } catch { /* 隐私模式存不了就只在本次会话生效 */ }
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => (
  {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]
));

/**
 * 渲染一条固定键数的模式轨。DOM 只建一次，之后只更新激活态，hover 动效不会被打断。
 * onPick(entry) = 进入该模式；onExit() = 再点当前模式 / Escape 退出回全部。
 */
export function createContentKindTabs({
  host, state, esc = escapeHtml, readKind = () => '',
  onPick = () => {}, onExit = () => {},
} = {}) {
  if (!host) return {render() {}};
  let built = false, peekTimer = 0;
  /**
   * 把每个键的文字实宽量出来写进 --label-w。
   *
   * 展开是「宽度过渡」而不是「瞬间换一个更宽的盒子」，所以目标值必须是文字真实宽度：
   * 写死一个 140px 之类的上限时，文字只占其中二三十像素，宽度会在动画前 15% 的时间里就冲到顶、
   * 剩下一大段时间画面是静止的 —— 看着就是「啪」地弹开、还把旁边的键顶飞。
   * 量一次的成本只有几个元素，字体换好后再量一次即可跟住不同字体。
   */
  const measureLabelWidths = () => {
    host.querySelectorAll('.ck-tab').forEach(tab => {
      const label = tab.querySelector('.ck-label');
      if (!label) return;
      // 不能在 max-width:0 的收起态直接量 scrollWidth：字体会话早期还没稳定时，
      // 拉丁字母会按更窄的 fallback 字体量出来（「UI」实测 11px，真正渲染是 17px），
      // 展开时 max-width 就卡在 11px，文字被 text-overflow 裁成「U.」。
      // 这里临时解除裁切、量一次真实排版宽度，再还原（收起态的布局不受影响）。
      const previous = label.style.maxWidth;
      label.style.maxWidth = 'none';
      // +1px 吃掉亚像素舍入：差 1px 也会让 text-overflow 画出省略号。
      const width = Math.ceil(label.getBoundingClientRect().width) + 1;
      label.style.maxWidth = previous;
      tab.style.setProperty('--label-w', `${width}px`);
    });
  };
  const build = () => {
    const buttons = MODE_TABS.map(entry =>
      `<button type="button" class="ck-tab" draggable="true" data-category-order="${esc(MODE_PRESETS.find(preset=>preset.id===entry.id).groupId)}" data-mode="${esc(entry.id)}" aria-pressed="false" aria-label="${esc(entry.label)}" title="${esc(entry.label)}">${icon(entry.icon)}<span class="ck-label">${esc(entry.label)}</span></button>`
    ).join('');
    // 不再补 .ck-spacer：轨道改成按内容宽度居中后，右侧留白会把整组图标顶偏，
    // 「居中」就名不副实了。要右对齐的东西另开一个容器，别靠这个假的占位。
    host.innerHTML = buttons;
    built = true;
    // 浏览器里等下一帧再量（此时字体/布局已就绪）。单测环境没有真实 DOM，
    // 直接跳过——否则 setTimeout 会越过测试边界，量到一个假节点上。
    if (globalThis.document) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measureLabelWidths);
      else setTimeout(measureLabelWidths, 0);
      globalThis.document.fonts?.ready?.then(measureLabelWidths).catch(() => {});
      // document.fonts 只跟踪 @font-face；Inter 走系统字体回退时不会触发它。
      // load 之后与首次交互前各补量一次，避免 --label-w 停在 fallback 小字体的宽度上。
      if (globalThis.document.readyState === 'complete') setTimeout(measureLabelWidths, 0);
      else globalThis.addEventListener?.('load', measureLabelWidths, {once: true});
    }
  };
  /** 触屏没有 hover：点完短暂展开，让用户看清刚切到哪个模式。 */
  const peek = button => {
    clearTimeout(peekTimer);
    host.querySelectorAll('.ck-tab.is-peek').forEach(node => node.classList.remove('is-peek'));
    button.classList.add('is-peek');
    peekTimer = setTimeout(() => button.classList.remove('is-peek'), 1200);
  };
  host.addEventListener('click', event => {
    const button = event.target.closest?.('.ck-tab');
    if (!button || !host.contains(button)) return;
    peek(button);
    const entry = modeTabById(button.dataset.mode);
    if (!entry) return;
    if (button.classList.contains('is-active') && (!state.contentKind || state.contentKind === MODE_PRESETS.find(preset => preset.id === entry.id)?.groupId)) onExit();
    else onPick(entry);
  });
  host.addEventListener('keydown', event => {
    if (event.key === 'Escape') { onExit(); return; }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const buttons = [...host.querySelectorAll('.ck-tab')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length].focus();
  });
  return {render() {
    if (!built) build();
    if(host.children)orderedCategories(MODE_PRESETS,state.options,row=>row.groupId).forEach((entry,index)=>{
      const button=host.querySelector(`[data-mode="${entry.id}"]`);
      if(button&&host.children[index]!==button)host.insertBefore(button,host.children[index]||null);
    });
    const active = activeModeId(state, readKind);
    for (const button of host.querySelectorAll('.ck-tab')) {
      const on = !!active && button.dataset.mode === active;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', String(on));
      const label = modeTabById(button.dataset.mode)?.label || button.dataset.mode;
      const whole = !state.contentKind || state.contentKind === MODE_PRESETS.find(preset => preset.id === button.dataset.mode)?.groupId;
      button.setAttribute('aria-label', on ? (whole ? `${label}，再点一次退出模式` : `显示全部${label}`) : label);
    }
  }};
}
