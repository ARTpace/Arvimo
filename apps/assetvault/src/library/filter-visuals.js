// 筛选面板的「视觉注册表」：图标语义、滑条档位、皮肤都只在这里定义一次。
//
// 换一套观感 = 改这份表 / 换 CSS 的 --fd-* 令牌，不需要动任何面板逻辑。
// 纯数据 + 纯函数，无 DOM 依赖，可在 Node 单测里直接跑。
import {RESOLUTION_PRESETS, rangeFromPreset} from './numeric-filter.js';

/** 每个维度的图标与强调色；颜色只用于图标发光，不覆盖全局主题。 */
export const PANEL_VISUALS = Object.freeze({
  color: {icon: 'palette', tone: '#EC4899'},
  tags: {icon: 'tag', tone: '#38BDF8'},
  kinds: {icon: 'shapes', tone: '#A78BFA'},
  rating: {icon: 'star', tone: '#FBBF24'},
  favorite: {icon: 'heart', tone: '#FB7185'},
  format: {icon: 'file', tone: '#60A5FA'},
  folders: {icon: 'folder', tone: '#34D399'},
  source: {icon: 'layers', tone: '#F59E0B'},
  more: {icon: 'list', tone: '#94A3B8'},
  sort: {icon: 'sort', tone: '#C9F581'},
});

/** 7 个格式分组 → 图标（分组 id 来自 format-registry.js 的 GROUP_META）。 */
export const FORMAT_GROUP_VISUALS = Object.freeze({
  image: {icon: 'image', label: '图像'},
  video: {icon: 'play', label: '视频'},
  audio: {icon: 'music', label: '音频'},
  model: {icon: 'cube', label: '模型'},
  document: {icon: 'file', label: '文档'},
  font: {icon: 'type', label: '字体'},
  misc: {icon: 'archive', label: '杂项'},
});

/** 排序方式 → 图标；值域与服务端 SORTS 一一对应，新增排序只加一行。 */
export const SORT_VISUALS = Object.freeze({
  recent: {icon: 'clock', label: '最近'},
  oldest: {icon: 'history', label: '最早'},
  name: {icon: 'type', label: '名称'},
  rating: {icon: 'star', label: '评分'},
  popular: {icon: 'heart', label: '点赞'},
  position: {icon: 'list', label: '入库'},
  collection: {icon: 'layers', label: '合集'},
  random: {icon: 'shuffle', label: '随机'},
  color: {icon: 'palette', label: '色相'},
  resolution: {icon: 'image', label: '分辨'},
  size: {icon: 'drive', label: '体积'},
});

export const KIND_VISUALS = Object.freeze({
  models: {icon: 'cube', label: '模型'},
  textures: {icon: 'image', label: '贴图'},
  hdris: {icon: 'globe', label: 'HDRI'},
  images: {icon: 'grid', label: '图片'},
  packs: {icon: 'archive', label: '资源包'},
});

export const FAVORITE_VISUALS = Object.freeze({
  any: {icon: 'grid', label: '全部', tone: '#94A3B8'},
  yes: {icon: 'heart', label: '收藏', tone: '#FB7185'},
  no: {icon: 'heart-off', label: '未收藏', tone: '#64748B'},
});

/** 方向按钮用 CSS 矩形比例示意，文字只进 tooltip。 */
export const ORIENTATION_VISUALS = Object.freeze([
  {id: 'orientation:landscape', label: '横图', ratio: 1.6, field: 'aspect', min: 1.05, max: null},
  {id: 'orientation:square', label: '方图', ratio: 1, field: 'aspect', min: 0.95, max: 1.05},
  {id: 'orientation:portrait', label: '竖图', ratio: 0.625, field: 'aspect', min: null, max: 0.95},
].map(Object.freeze));

/** 分辨率滑条档位：0 = 不限，其余对应 1K / 2K / 4K 预设。 */
export const RESOLUTION_STOPS = Object.freeze([
  {value: 0, label: '不限', range: null},
  ...RESOLUTION_PRESETS.map((preset, index) => Object.freeze({
    value: index + 1, label: preset.label.split(' ')[0], ...rangeFromPreset(preset), id: `resolution:${preset.id}`,
  })),
]);

export const FILTER_SKINS = Object.freeze(['lime', 'violet', 'amber']);
export const FILTER_SKIN_KEY = 'sfx-filter-skin-v1';

export function readSkin(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(FILTER_SKIN_KEY) || 'null');
    const value = typeof saved === 'string' ? saved : saved?.skin;
    return FILTER_SKINS.includes(value) ? value : FILTER_SKINS[0];
  } catch { return FILTER_SKINS[0]; }
}

export function writeSkin(storage, skin) {
  try { storage?.setItem(FILTER_SKIN_KEY, JSON.stringify({version: 1, skin})); }
  catch { /* 只读存储不影响功能 */ }
}

/** 星级滑条：0 = 不限，N = 「≥N 星」（展开成精确评分数组，后端协议不变）；6 = 只看未评分。 */
export const RATING_SLIDER_MAX = 6;

export function sliderToRatings(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return [];
  if (n >= 6) return ['0'];
  return Array.from({length: 6 - Math.floor(n)}, (_, i) => String(Math.floor(n) + i));
}

export function ratingsToSlider(ratings = []) {
  const list = (Array.isArray(ratings) ? ratings : []).map(Number).filter(value => value >= 0 && value <= 5);
  if (!list.length) return 0;
  if (list.includes(0)) return 6;
  return Math.min(...list);
}

export function ratingSliderLabel(value) {
  const n = Number(value);
  if (n <= 0) return '不限';
  if (n >= 6) return '未评分';
  return `≥${n}★`;
}

/** 分辨率滑条 ↔ ranges：只识别本注册表的预设，自定义范围原样保留不被覆盖。 */
export function sliderToResolutionRange(value) {
  const stop = RESOLUTION_STOPS.find(item => item.value === Number(value));
  if (!stop?.range && !stop?.id) return null;
  return {id: stop.id, field: 'longEdge', min: stop.min, max: stop.max};
}

export function resolutionToSlider(ranges = []) {
  const list = Array.isArray(ranges) ? ranges : [];
  const hit = list.find(item => RESOLUTION_STOPS.some(stop => stop.id && stop.id === item.id));
  return hit ? RESOLUTION_STOPS.find(stop => stop.id === hit.id).value : 0;
}

/** 面板控件用的短提示：统一走 tooltip，不再在面板里堆说明段落。 */
export const PANEL_TIPS = Object.freeze({
  color: '点色卡累加，再点取消 · 滑条调相似度 · ⊘ 改成排除',
  tags: '点标签加入 · ⊘ 切成排除模式 · 右键总是排除 · 放大镜可搜',
  kinds: '点比例图形选宽高比 · 滑条选分辨率 · 图标选资产类型',
  rating: '拖滑条或点星星设最低星级 · 末端 = 只看未评分 · ⊘ 排除',
  favorite: '三个图标 = 全部 / 只看收藏 / 只看未收藏',
  format: '点顶部图标切分组 · 点后缀累加 · ⊘ 排除 · 键盘图标手动输入',
  folders: '点文件夹只看它里面的资产 · Shift 多选 · 再点一下取消',
  source: '点平台 / 分类即过滤 · 再点一下取消 · Shift 多选 · 冷门值可手动输入',
  more: '检索式语法：空格=同时满足，| =任一，-词=排除，tag: color: 限定字段',
  sort: '点图标选排序 · ↕ 切方向 · 骰子重新洗牌',
});
