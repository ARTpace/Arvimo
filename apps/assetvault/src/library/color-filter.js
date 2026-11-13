// 颜色筛选协议（前后端共用，纯函数无 DOM）。
//
// 算法与色卡预设移植自 Serpent src/shared/color-filter-presets.ts + color-hsl.ts（MIT），
// 不自己发明距离公式：HSL 盒 + 环形色相距离，才能正确处理红/紫跨 0° 和黑白中性色。
// 这里同时负责偏好持久化（自定义色 + 相似度滑块），查询层只调 matchesColorFilter()。
//
// 数据来源是每个资产封面的单个代表主色（probe: {h,s,l,hex}），不是整张色卡直方图匹配。

export const DEFAULT_COLOR_SIMILARITY = 30;
export const COLOR_PREFS_KEY = 'sfx-color-filter-prefs-v1';
export const MAX_CUSTOM_FILTER_COLORS = 12;

/** 8 个色相 + 2 个中性色；id 是协议值，hex 是标准色卡，可被自定义色覆盖。 */
export const COLOR_PRESETS = Object.freeze([
  {id: 'red', label: '红', hex: '#E11D48', kind: 'hue'},
  {id: 'orange', label: '橙', hex: '#F97316', kind: 'hue'},
  {id: 'yellow', label: '黄', hex: '#EAB308', kind: 'hue'},
  {id: 'green', label: '绿', hex: '#22C55E', kind: 'hue'},
  {id: 'cyan', label: '青', hex: '#06B6D4', kind: 'hue'},
  {id: 'blue', label: '蓝', hex: '#3B82F6', kind: 'hue'},
  {id: 'purple', label: '紫', hex: '#A855F7', kind: 'hue'},
  {id: 'pink', label: '粉', hex: '#EC4899', kind: 'hue'},
  {id: 'black', label: '黑', hex: '#111111', kind: 'neutral'},
  {id: 'white', label: '白', hex: '#F4F4F5', kind: 'neutral'},
].map(Object.freeze));
Object.freeze(COLOR_PRESETS);

const HEX = /^#?([0-9a-f]{6})$/i;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** #RRGGBB → HSL：h 0-360，s/l 0-1。与 Serpent hexToHsl 同值域。 */
export function hexToHsl(input) {
  const match = HEX.exec(String(input || ''));
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  const r = ((int >> 16) & 255) / 255, g = ((int >> 8) & 255) / 255, b = (int & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return {h, s, l};
}

export function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(((h % 360) + 360) % 360 / 60) % 6;
  const table = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][sector];
  return `#${table.map(part => Math.round(clamp(part + m, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** 环形距离：359° 与 1° 只差 2°，不能当 358°。 */
export function hueDelta(a, b) {
  const delta = Math.abs(((a - b) % 360 + 360) % 360);
  return delta > 180 ? 360 - delta : delta;
}

/** 相似度 0-100 → 匹配窗口；数值越高窗口越紧。与 Serpent colorMatchWindows 一致。 */
export function colorMatchWindows(similarity = DEFAULT_COLOR_SIMILARITY) {
  const t = clamp(Number(similarity) || 0, 0, 100) / 100;
  return {
    hueSpan: 55 - 45 * t,
    satDelta: 0.5 - 0.4 * t,
    lightDelta: 0.42 - 0.32 * t,
    chromaticSatFloor: 0.08 + 0.14 * t,
    neutralSatMax: 0.55 - 0.27 * t,
  };
}

const isChromatic = sample => sample.s >= 0.12 && sample.l > 0.08 && sample.l < 0.92;
export const isChromaticHsl = isChromatic;

/** 协议值 → 可比较目标。接受预设 id、#hex、以及 {id,hex} 覆盖对；坏值一律丢掉。 */
export function parseColorFilterValues(values = [], swatches = {}) {
  const list = Array.isArray(values) ? values : String(values || '').split(/[,，\s]+/u);
  const seen = new Set();
  const targets = [];
  for (const raw of list.slice(0, 32)) {
    const token = typeof raw === 'object' && raw ? String(raw.id || raw.hex || '') : String(raw || '');
    const id = token.trim().toLocaleLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const preset = COLOR_PRESETS.find(item => item.id === id);
    const hex = HEX.test(id) ? `#${HEX.exec(id)[1].toUpperCase()}`
      : (swatches?.[id] || preset?.hex || '');
    const hsl = hexToHsl(hex);
    if (!hsl) continue;
    targets.push({id, hex, ...hsl, kind: preset?.kind || (isChromatic(hsl) ? 'hue' : 'neutral')});
  }
  return targets;
}

/** 单个样本与单个目标的盒判定。sample 为 {h,s,l}（h 度、s/l 0-1）。 */
export function sampleMatchesTarget(sample, target, windows = colorMatchWindows()) {
  if (!sample || !target) return false;
  if (Math.abs(sample.l - target.l) > windows.lightDelta) return false;
  if (target.kind === 'neutral') return sample.s <= windows.neutralSatMax;
  if (sample.s < windows.chromaticSatFloor) return false;
  if (Math.abs(sample.s - target.s) > windows.satDelta) return false;
  return hueDelta(sample.h, target.h) <= windows.hueSpan;
}

/**
 * 查询入口。sample=null 表示这个资产还没采到主色：
 *  包含模式 → 不命中；排除模式 → 保留（与 Serpent 的 NULL 规则一致，别把没数据的资产误删）。
 */
export function matchesColorFilter(sample, {values = [], similarity = DEFAULT_COLOR_SIMILARITY,
  swatches = {}, exclude = false} = {}) {
  const targets = parseColorFilterValues(values, swatches);
  if (!targets.length) return true;
  const windows = colorMatchWindows(similarity);
  const hit = !!sample && targets.some(target => sampleMatchesTarget(sample, target, windows));
  return exclude ? !hit : hit;
}

export function colorFilterSummary(values = [], similarity = DEFAULT_COLOR_SIMILARITY) {
  const targets = parseColorFilterValues(values);
  if (!targets.length) return '';
  const names = targets.map(target => COLOR_PRESETS.find(item => item.id === target.id)?.label || target.hex);
  return `${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''} · 相似度 ${Math.round(similarity)}%`;
}

/** 坏存档不抛错：偏好读失败就退回默认，隐私模式写失败也不影响本次会话。 */
export function loadColorPreferences(storage, key = COLOR_PREFS_KEY) {
  const fallback = {version: 1, customColors: [], similarity: DEFAULT_COLOR_SIMILARITY};
  try {
    const saved = JSON.parse(storage?.getItem(key) || 'null');
    if (!saved || typeof saved !== 'object') return fallback;
    return {
      version: 1,
      customColors: sanitizeCustomColors(saved.customColors),
      similarity: Number.isFinite(Number(saved.similarity))
        ? clamp(Math.round(Number(saved.similarity)), 0, 100) : DEFAULT_COLOR_SIMILARITY,
    };
  } catch { return fallback; }
}

export function saveColorPreferences(storage, prefs, key = COLOR_PREFS_KEY) {
  try { storage?.setItem(key, JSON.stringify({version: 1, ...prefs})); } catch { /* 只读存储照常用内存态 */ }
  return prefs;
}

export function sanitizeCustomColors(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => {
    const match = HEX.exec(String(value || ''));
    return match ? `#${match[1].toUpperCase()}` : '';
  }).filter(Boolean))].slice(0, MAX_CUSTOM_FILTER_COLORS);
}

export function withCustomColorAdded(prefs, hex) {
  const colors = sanitizeCustomColors([...(prefs?.customColors || []), hex]);
  return {...prefs, version: 1, customColors: colors};
}

export function withCustomColorRemoved(prefs, hex) {
  const key = String(hex || '').toLocaleLowerCase();
  return {...prefs, version: 1,
    customColors: sanitizeCustomColors((prefs?.customColors || []).filter(item => item.toLocaleLowerCase() !== key))};
}
