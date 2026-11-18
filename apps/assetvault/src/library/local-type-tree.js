import {classifyAsset} from './asset-classification.js';
/**
 * 侧边栏「类型 → 子分类」层级：与搜索栏上方的模式轨共用同一份 CONTENT_KINDS。
 *
 * 以前侧栏「类型」直接读 index.html 里 #local-kind 的静态 options（只有 models / textures /
 * hdris / images / packs），而顶部图标轨列的是 图片 / 模型 / UI / 文本 / 视频。两张清单各写一份，
 * 于是顶部有的类型侧栏没有（UI、文本、视频、音频），侧栏有的类型顶部没有（材质、HDRI、资源包），
 * 点哪一边都像「没同步」（2026-11-14 用户反馈）。
 *
 * 这张表解决三件事：
 *   1) 类型清单唯一：一级类型 = CONTENT_KINDS，渲染层不再自己抄一份值域；
 *   2) 计数口径统一：登记的资产按 contentKindsOf 算，磁盘卡片按 LOCAL_KINDS_OF_MODE 反查，
 *      与网格真正生效的筛选是同一套判定，不会出现「计数 3 条、点开一屏」；
 *   3) 子分类：一级类型下挂该类型里真实存在的分类 / 标签（带计数），
 *      不凭空造「角色 / 道具」这种库内可能一条都没有的词条。
 */
import {CONTENT_KINDS, contentKindsOf, LOCAL_KINDS_OF_MODE, activeModeId} from './content-kind-tabs.js';
import {MODE_PRESETS, modePresetById} from './mode-presets.js';
import {localAssetCategories} from './local-filters.js';
import {imageSubcategoryOf,isImageKind,categoryIconOf} from './image-subcategories.js';
import {STATIC_SUBCATEGORY_CHILDREN} from './doc-media-subcategories.js';


/** 磁盘条目的类型：基础 kind 反查 + 启发式补类。与 modeAllowsLocalKind 同源，
 *  否则侧栏显示「材质 3」、点进去网格却按 image kind 过滤，数量对不上。 */
function surfaceTypeIds(surface, item) {
  if (!item || typeof item !== 'object') return [];
  return [classifyAsset({...item,assetType:surface==='packages'?item.category:item.kind}).kind];
}

const KIND_IDS = new Set(CONTENT_KINDS.map(kind => kind.id));

/** The same five mother categories drive the top bar and sidebar. */
export const TYPE_GROUPS = Object.freeze(MODE_PRESETS.map(preset => Object.freeze({
  id: preset.groupId, modeId: preset.id, label: preset.label, icon: preset.icon, kinds: preset.localKinds,
})));

/** 一个类型下最多铺几条子分类：Sketchfab 的标签能到几百个，全铺出来只是把侧栏变成词云。 */
const CHILD_LIMIT = 24;

/** 资产自带的 category 字段是内部词表（material / model / skybox / images…），和类型 id 同源。
 *  直接把它铺进子分类，用户看到的就是一排英文枚举，还和上面的一级类型重复；
 *  这里统一挡掉；子分类只读明确分类，平台/AI/用户标签留在标签筛选中。 */
const INTERNAL_WORDS = new Set([
  ...KIND_IDS,
  ...Object.values(LOCAL_KINDS_OF_MODE).flatMap(spec => [...(spec.files || []), ...(spec.packages || [])]),
]);

/** 登记资产按主类型计数，模型附件不重复计类。 */
export function typeIdsOf(model) {
  if (!model || typeof model !== 'object') return [];
  return contentKindsOf(model).filter(id => KIND_IDS.has(id));
}

export const typeIdsOfFile = file => surfaceTypeIds('files', file);
export const typeIdsOfPackage = pkg => surfaceTypeIds('packages', pkg);

/** 当前该点亮哪个类型（供侧栏高亮，与顶部图标轨同源）。
 *  顺序：显式模式 > state.contentKind > 旧下拉值；模式 id 与类型 id 不完全同名（ui → uielement），
 *  所以模式这一层要过一遍 localKind 映射，否则点「UI」侧栏亮不起来。 */
export function activeLocalTypeId(state = {}, readKind = () => '') {
  const explicit = String(state?.contentKind || readKind?.() || '');
  if (KIND_IDS.has(explicit)) return explicit;
  if (TYPE_GROUPS.some(group => group.id === explicit)) return '';
  const modeId = activeModeId(state, readKind);
  const fromMode = modePresetById(modeId)?.localKind || '';
  if (fromMode && KIND_IDS.has(fromMode)) return fromMode;
  const contentKind = String(state?.contentKind || '');
  if (contentKind && KIND_IDS.has(contentKind)) return contentKind;
  const fromSelect = String(readKind?.() || '');
  return KIND_IDS.has(fromSelect) ? fromSelect : '';
}

/** Category hierarchy must not be built from free-form tags or asset identifiers. */
function subcategoriesOf(model) {
  const identifiers=new Set([model.assetId,model.uid].filter(Boolean).map(value=>String(value).trim().toLowerCase()));
  // 分类树依旧只读明确分类（tags 留在标签筛选），但图片额外挂一条规则算出的用途子类，
  // 这样「图片 → 图片」的撞名会被 纹理贴图/参考图/其他图片 等真实用途取代。
  // 整条资产传进去而不是只挑 categories/category 两栏：文档 / 视频 / 音频的子类要读文件名
  // （PDF / MP4 / FLAC…），剥掉 name 就只剩空壳，格式子类永远算不出来。
  const base=localAssetCategories({...model,tags:[],userTags:[]});
  const auto=isImageKind(model)?[imageSubcategoryOf(model)]:[];
  return [...new Set([...base,...auto])]
    .filter(value=>!/^\d+$/.test(value)&&!identifiers.has(value.toLowerCase()));
}

/**
 * 算出侧栏要渲染的整棵树：分组 → 类型（含数量）→ 子分类（含数量）。
 * @param {{models?:Array,packages?:Array,files?:Array}} input
 *   models  登记的资产（state.models 或回收站），packages / files 是磁盘扫描出来的卡片。
 */
export function localTypeFacets({models = [], packages = [], files = []} = {}) {
  const counts = new Map();
  const children = new Map();
  const bump = id => counts.set(id, (counts.get(id) || 0) + 1);
  const note = (id, categories) => {
    const usable = categories.filter(value => !INTERNAL_WORDS.has(value.toLowerCase()));
    if (!usable.length) return;
    let bucket = children.get(id);
    if (!bucket) children.set(id, bucket = new Map());
    for (const value of usable) bucket.set(value, (bucket.get(value) || 0) + 1);
  };
  for (const model of models) {
    const ids = typeIdsOf(model);
    if (!ids.length) continue;
    const categories = subcategoriesOf(model);
    for (const id of ids) { bump(id); note(id, categories); }
  }
  for (const pkg of packages) {
    const categories = subcategoriesOf(pkg);
    for (const id of typeIdsOfPackage(pkg)) { bump(id); note(id, categories); }
  }
  for (const file of files) {
    const categories = subcategoriesOf(file);
    for (const id of typeIdsOfFile(file)) { bump(id); note(id, categories); }
  }
  // 文档 / 视频 / 音频的子类按用途（教程指南、音乐配乐…），每类只有 3~4 条。
  // 库里暂时没有这类文件时也要有入口，否则这几个母类展开就是空的 ——
  // 用 STATIC_SUBCATEGORY_CHILDREN 的固定词表兜住，真实条目进来后计数落在同一行上
  //（localAssetCategories 已经会产出这些用途标签）。
  const rows = CONTENT_KINDS.map(kind => {
    const bucket = new Map(children.get(kind.id) || []);
    for (const label of STATIC_SUBCATEGORY_CHILDREN[kind.id] || []) if (!bucket.has(label)) bucket.set(label, 0);
    return {
      id: kind.id,
      label: kind.label,
      icon: kind.icon,
      count: counts.get(kind.id) || 0,
      children: [...bucket]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
        .slice(0, CHILD_LIMIT)
        .map(([value, count]) => ({value, count, icon: categoryIconOf(value)})),
    };
  });
  const byId = new Map(rows.map(row => [row.id, row]));
  return [...TYPE_GROUPS,{id:'unknown',label:'待分类',modeId:'',icon:'archive',kinds:['unknown']}].map(group => ({
    id: group.id,
    label: group.label,
    modeId: group.modeId,
    icon: group.icon,
    kinds: group.kinds.map(id => byId.get(id)).filter(Boolean),
    count: group.kinds.reduce((sum, id) => sum + (byId.get(id)?.count || 0), 0),
  }));
}
