/**
 * 图片用途子类：侧栏分类树与磁盘落盘目录共用的一张表。
 *
 * 背景：侧栏「图片 → 图片」母子类撞名，因为分组来自 mode-presets（图片），
 * 唯一挂着的 content kind 也叫图片（content-kind-tabs 的 images）。给图片加一层
 * 真实「用途」子类后，第二级不再是 kind 的复读，而是能真正整理资产的维度。
 *
 * 本模块是唯一真相源：
 *   - 前端 local-type-tree.js / local-filters.js 用它算侧栏子分类与筛选；
 *   - 服务端 asset-folders.mjs 用它算落盘目录（图片/<子类>/）。
 * 纯 ESM、无 DOM 依赖，服务端可直接 import。
 */

export const IMAGE_SUBCATEGORIES = Object.freeze([
  {id: 'reference', label: '参考图', hint: '灵感、临摹素材', icon: 'eye'},
  {id: 'concept', label: '概念设计', hint: '角色/场景概念稿', icon: 'edit'},
  {id: 'illustration', label: '插画', hint: '成品插画', icon: 'palette'},
  {id: 'photo', label: '照片', hint: '实拍素材', icon: 'image'},
  {id: 'screenshot', label: '截图', hint: '软件/游戏截图', icon: 'scan'},
  {id: 'ai', label: 'AI生成', hint: 'Civitai/SD/MJ 产出', icon: 'sparkle'},
  {id: 'ui', label: 'UI素材', hint: '按钮/图标切图', icon: 'grid'},
  {id: 'texture', label: '纹理贴图', hint: 'PBR / alpha / 遮罩贴图', icon: 'layers'},
  {id: 'other', label: '其他图片', hint: '无法判定的兜底', icon: 'image'},
].map(Object.freeze));

export const IMAGE_SUBCATEGORY_LABELS = Object.freeze(IMAGE_SUBCATEGORIES.map(item => item.label));
const ICON_BY_LABEL = new Map(IMAGE_SUBCATEGORIES.map(item => [item.label, item.icon]));
/** 侧栏叶子图标：图片用途子类用专属图标，手动分类/标签统一用 tag。 */
export const categoryIconOf = label => ICON_BY_LABEL.get(label) || 'tag';
export const OTHER_IMAGE_LABEL = '其他图片';

/** 路径字段只取文件名：目录名里的短词会误命中（H:\AI-Tools\... 的 "AI" 曾把 552 张图错分成 AI生成）。 */
const baseNameOf = value => String(value || '').split(/[?#]/)[0].split(/[\\/]/).pop() || '';

/** 收集判定用的文本：文件名 + 路径末段 + 标签。平台字段单独判定，避免平台名误伤文件名关键词。 */
function evidenceOf(model = {}) {
  const parts = [];
  for (const key of ['filename', 'name', 'filePath', 'localRel', 'rel', 'url', 'title']) {
    if (typeof model[key] === 'string') parts.push(baseNameOf(model[key]));
  }
  for (const key of ['tags', 'categories', 'userTags']) {
    for (const value of (Array.isArray(model[key]) ? model[key] : [])) {
      parts.push(typeof value === 'string' ? value : value?.name || value?.label || '');
    }
  }
  return parts.join(' ').toLowerCase();
}

// 文件名里 `_` 是事实上的词边界（mat0_c / icon_home），JS 的 \b 不认下划线，
// 所以自己定义边界（含 `.` `/` `\` 空格）；中文没有词边界，单独走 includes。
const BOUND = String.raw`(?:^|[_ ./\\-])`;
const END = String.raw`(?=$|[_ ./\\-])`;
const rx = words => new RegExp(BOUND + '(?:' + words.join('|') + ')' + END, 'i');
const has = (text, words) => words.some(word => text.includes(word));

// PBR 通道名 / matN_ 前缀 / 常见遮罩后缀。图片格式才走这条（由调用方保证 kind=images）。
const TEXTURE_EN = rx(['mat\\d+', 'albedo', 'basecolor', 'base_color', 'ambientocclusion', 'color', 'diffuse', 'diff', 'normal', 'normaldx', 'normalgl', 'normalmap', 'norm', 'nrm', 'rough', 'roughness', 'gloss', 'metal', 'metallic', 'metalness', 'spec', 'sss', 'bump', 'ao', 'height', 'displacement', 'orm', 'arm', 'emissive', 'specular', 'opacity', 'alpha', 'mask', 'out', 'r_metalrough', 'pbr', 'texture', 'cubemap']);
// 游戏资产的通道后缀：T_Baguette_C / 930_plate_nrm / px, nx, py, ny, pz, nz。
const TEXTURE_SUFFIX_RE = /_[cmnr](?=[._]|$)/i;
const CUBEMAP_FACE_RE = /^[pn][xyz](?=\.|$)/i;
const UI_EN = rx(['icon', 'icons', 'button', 'buttons', 'btn', 'ui', 'uielement', 'panel', 'hud', 'widget', 'sprite', 'logo', 'banner', 'frame', 'avatar', 'uiverse']);
const AI_EN = rx(['ai', 'midjourney', 'stable.?diffusion', 'sd', 'mj', 'dalle', 'flux', 'comfy']);
// 生成器导出的确定性命名（不是关键词猜测）：
//   SD WebUI / SD.Next → <时间戳>-<种子>-<提示词截断>.png
//   各类 bot/脚本     → 纯 13 位毫秒时间戳.png
//   放大流程          → upscaled_<uuid>.jpeg
const AI_EXPORT_RE = /\b\d{4,13}-\d{6,10}-|^upscaled?_[0-9a-f]{8}-[0-9a-f]{4}-|\b\d{13}\.(?:png|jpe?g|webp)\b/;
const SHOT_EN = rx(['screenshot', 'screen.?shot', 'capture', 'snipaste', 'shot']);
const CONCEPT_EN = rx(['concept', 'sketch']);
const ILLUST_EN = rx(['illustration', 'artwork', 'anime']);
const REF_EN = rx(['reference', 'ref', 'inspo']);
const PHOTO_EN = rx(['photo', 'dsc_\\d+', 'img_\\d+']);

const TEXTURE_ZH = ['材质', '贴图', '纹理', '法线', '粗糙度', '金属度', '遮罩', '透明通道'];
const UI_ZH = ['图标', '按钮', '面板', '界面'];
const AI_ZH = ['ai生成', 'ai绘制'];
const SHOT_ZH = ['截图', '截屏', '屏幕截图'];
const CONCEPT_ZH = ['概念', '草稿', '设定', '线稿'];
const ILLUST_ZH = ['插画', '绘画', '二次元'];
const REF_ZH = ['参考', '灵感'];
const PHOTO_ZH = ['照片', '实拍'];

const AI_PLATFORMS = new Set(['civitai', 'ai', 'dalle', 'midjourney', 'stable-diffusion', 'flux']);
const UI_PLATFORMS = new Set(['uiverse']);
const PHOTO_PLATFORMS = new Set(['pexels', 'unsplash', 'pixabay']);

/**
 * 规则按「特异性」排序：先认有硬特征的（PBR/UI/AI），再认泛用途，最后兜底。
 * 与 IMAGE_SUBCATEGORIES 的展示顺序无关。
 */
const RULES = [
  {label: '纹理贴图', test: (text) => TEXTURE_EN.test(text) || TEXTURE_SUFFIX_RE.test(text) || CUBEMAP_FACE_RE.test(text) || has(text, TEXTURE_ZH)},
  {label: 'UI素材', test: (text, platform) => UI_PLATFORMS.has(platform) || UI_EN.test(text) || has(text, UI_ZH)},
  {label: 'AI生成', test: (text, platform) => AI_PLATFORMS.has(platform) || AI_EN.test(text) || AI_EXPORT_RE.test(text) || has(text, AI_ZH)},
  {label: '截图', test: (text) => SHOT_EN.test(text) || has(text, SHOT_ZH)},
  {label: '概念设计', test: (text) => CONCEPT_EN.test(text) || has(text, CONCEPT_ZH)},
  {label: '插画', test: (text) => ILLUST_EN.test(text) || has(text, ILLUST_ZH)},
  {label: '参考图', test: (text) => REF_EN.test(text) || has(text, REF_ZH)},
  {label: '照片', test: (text, platform) => PHOTO_PLATFORMS.has(platform) || PHOTO_EN.test(text) || has(text, PHOTO_ZH)},
];

/** 给一个资产／文件算图片用途子类（返回中文 label，与侧栏文案、磁盘目录名一致）。 */
export function imageSubcategoryOf(model = {}) {
  // 只认资产库明确的「图片/已知子类」结构，不把任意祖先目录当关键词。
  for (const key of ['rel','localRel']) {
    const parts=String(model[key]||'').replace(/\\/g,'/').split('/');
    if(parts[0]==='图片'&&IMAGE_SUBCATEGORIES.some(item=>item.label===parts[1]))return parts[1];
  }
  // AI 元数据（服务端扫描 PNG 文本块得到）是确定性指纹，优先于文件名/标签关键词。
  // 有 prompt 或 tool 即判定为 AI 生成 —— 即使文件名是一串 hash 也不会漏。
  const ai = model?.aiMeta;
  if (ai && (ai.prompt || ai.tool)) return 'AI生成';
  const text = evidenceOf(model);
  const platform = String(model?.platform || '').toLowerCase();
  for (const rule of RULES) if (rule.test(text, platform)) return rule.label;
  return OTHER_IMAGE_LABEL;
}

/** 只有文件名时（拖入文件流、磁盘扫描条目）也能判定。 */
export const imageSubcategoryFromName = name => imageSubcategoryOf({filename: String(name || '')});

/** 这个 model 是不是「图片类」——只有图片类才该挂用途子类，别污染模型/材质/Skin 的 children。 */
export function isImageKind(model = {}) {
  const value = String(model?.kind || model?.assetType || model?.contentKind || model?.category || '').toLowerCase();
  return value === 'images' || value === 'image' || value === 'alpha' || value === 'alphas';
}
