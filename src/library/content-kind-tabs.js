/**
 * 顶部模式轨：每个内容模式一枚常驻 SVG 图标，hover / focus 才横向展开文字。
 *
 * 这是「模式切换器」，不是分类 / 筛选器：
 *   - 图标固定为 图片 / 模型 / UI / 文本 / 视频，不按资产数量增减、不随页面变化、不显示数量；
 *   - 不摆「全部」按钮：默认（无激活）就是全部，再点一次当前模式即退出；
 *   - 不摆来源平台图标：平台切换归搜索区的平台下拉，是另一个维度。
 *
 * 图片 / 模型两键沿用 app.js 的 applyContentMode() 三态语义（平台 + 瀑布流 + A 站类型），
 * UI 键把下拉换成一站 Uiverse（产出的是界面代码），
 * 文本 / 视频落到 state.contentKind，由 filtered() 按本地文件类型筛（contentKindsOf）。
 *
 * 同一排键在两个页面干两件事（app.js 的 applyModeTab 按 state.route 分叉）：
 *   发现页 —— 换平台池 / 结果流 / 布局，去「发现」这个模式的资源；
 *   资产库 —— 只筛本地资产类型，原地重画网格，绝不换页。
 * 组件本身不认识路由，它只报「点了哪个模式」，落点交给宿主。
 *
 * 扩展缝：常驻哪几个模式只看 MODE_TABS 一张表；类型判定表 CONTENT_KINDS 与格式映射分开，
 * 以后想多摆一个「音频」只是配置动作，渲染器一行都不用改。
 */
import {icon} from './icon-set.js';
import {activeMode} from './content-modes.js';
import {MODE_PRESETS} from './mode-presets.js';
import {localAssetKind} from './local-filters.js';
import {formatRegistry} from './format-registry.js';

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
  {id: 'models', label: '3D 模型', icon: 'cube'},
  {id: 'images', label: '图片', icon: 'image'},
  {id: 'textures', label: '材质', icon: 'layers'},
  {id: 'hdris', label: 'HDRI', icon: 'globe'},
  {id: 'packs', label: '资源包', icon: 'archive'},
  {id: 'videos', label: '视频', icon: 'play'},
  {id: 'audio', label: '音频', icon: 'music'},
  {id: 'documents', label: '文本', icon: 'type'},
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
  models: Object.freeze({files: ['model'], packages: ['model']}),
  images: Object.freeze({files: ['image'], packages: ['images']}),
  textures: Object.freeze({files: ['image'], packages: ['material']}),
  hdris: Object.freeze({files: ['env'], packages: ['skybox']}),
  videos: Object.freeze({files: ['video'], packages: []}),
  audio: Object.freeze({files: ['audio'], packages: []}),
  documents: Object.freeze({files: ['document'], packages: []}),
  // UI 元素落盘是 index.html + style.css，零散文件按 document kind 存；资产包不参与。
  uielement: Object.freeze({files: ['document'], packages: []}),
});

/** 某个模式下额外卡片该不该出：没有映射（＝没选模式）就一律放行。 */
export function modeAllowsLocalKind(modeId, surface, kind) {
  const map = LOCAL_KINDS_OF_MODE[modeId || ''];
  if (!map) return true;
  return (map[surface] || []).includes(kind);
}

const FILE_KEYS = ['filePath', 'root', 'rel', 'folder', 'filename'];
const LIST_KEYS = ['entries', 'files', 'downloads', 'assets'];

/**
 * 只看「本地文件名」字段，不碰 thumbnail / url —— 远程收藏的缩略图也是 .jpg，
 * 若把它算进来，全库每条资产都会同时被判成图片，筛选就废了。
 */
function localFileNames(model) {
  const out = [];
  const add = value => { if (typeof value === 'string' && value) out.push(value); };
  for (const key of FILE_KEYS) add(model[key]);
  for (const key of LIST_KEYS) {
    if (!Array.isArray(model[key])) continue;
    for (const item of model[key].slice(0, 200)) {
      if (typeof item === 'string') add(item);
      else if (item && typeof item === 'object') add(item.rel || item.name || item.path || item.file || item.filePath);
    }
  }
  return out;
}

/** 一条资产可能属于多个类型：一个资源包里同时有 .fbx 和 .png 就同时归两类。
 *
 *  但「主类型已明确」时，辅助文件不该再污染出新的文档 / 视频分类 ——
 *  Sketchfab 模型包里附带 .json（元数据）、.html（预览页）是常态，若把它们也算进来，
 *  每个 3D 模型都会同时被判成 documents，切到「文本」就满屏模型卡（2026-11-12 用户反馈）。
 *  规则：base 是采集 / 下载资产类（models / images / textures / hdris / packs / uielement）时，
 *  文件名扫描只补充与之不同的媒体类型（video / audio），跳过 document —— document 几乎总是
 *  元数据 / 预览页的附带文件，真正「纯文档资产」的 base 是空或 other，仍能正常归位。 */
const PRIMARY_KINDS = new Set(['models', 'images', 'textures', 'hdris', 'packs', 'uielement']);

export function contentKindsOf(model = {}) {
  if (!model || typeof model !== 'object') return [];
  const out = new Set();
  const base = localAssetKind(model);
  if (base) out.add(base);
  const suppressDocument = PRIMARY_KINDS.has(base);
  for (const name of localFileNames(model)) {
    const id = FORMAT_TO_ID[formatRegistry.kindOf(name)];
    if (!id) continue;
    // 已有明确主类型时，不让附带文档（.json/.html/.md 等）把这条资产拖进 documents。
    if (suppressDocument && id === 'documents') continue;
    out.add(id);
  }
  return [...out];
}

/** 当前该点亮哪个模式：显式主状态 > 旧类型字段 > 原内容模式 > 本地类型下拉；都没有就返回空串（＝全部）。
 *  state.mode 是唯一权威：手动在下拉里换平台不会把它冲掉，高亮才不会乱跳。 */
export function activeModeId(state = {}, readKind = () => '') {
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
      `<button type="button" class="ck-tab" data-mode="${esc(entry.id)}" aria-pressed="false" aria-label="${esc(entry.label)}" title="${esc(entry.label)}">${icon(entry.icon)}<span class="ck-label">${esc(entry.label)}</span></button>`
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
    if (button.classList.contains('is-active')) onExit();
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
    const active = activeModeId(state, readKind);
    for (const button of host.querySelectorAll('.ck-tab')) {
      const on = !!active && button.dataset.mode === active;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', String(on));
      const label = modeTabById(button.dataset.mode)?.label || button.dataset.mode;
      button.setAttribute('aria-label', on ? `${label}，再点一次退出模式` : label);
    }
  }};
}
