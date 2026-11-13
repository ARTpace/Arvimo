// 筛选图标条的「单一事实源」：维度顺序、图标、可用态、chip 清单与激活判定都只在这里定义一次。
//
// 顺序对齐 Serpent 工具栏（调色板 / 标签 / 形状 / 星 / 心 / 文件 / 列表 | 排序）。
// 颜色与形状现在都接上了真实数据：主色/宽高来自封面探测缓存 state.assetProbe，
// 采集入口在 asset-probe.js，协议在 color-filter.js / numeric-filter.js。
// 加一个维度 = 在这里加一行 + 在 filter-panels.js 注册表加一个渲染分支，别在调用点写 if 长龙。
//
// 纯数据 + 纯函数：无 DOM、无 node 依赖，可在 Node 单测里直接跑。

/** 主图标条维度（分隔线之前）。
 *  short 是悬停展开时露出的标签：工具栏一行放不下长名字，面板标题仍用 label 全称。 */
export const FILTER_DIMENSIONS = Object.freeze([
  Object.freeze({id: 'color', label: '颜色', short: '颜色', icon: 'palette', ready: true, hint: '主色色卡 · 相似度 · 自定义色'}),
  Object.freeze({id: 'tags', label: '标签', short: '标签', icon: 'tag', ready: true, hint: '包含 / 排除 · 最近使用 · Shift 多选'}),
  Object.freeze({id: 'kinds', label: '形状与类型', short: '类型', icon: 'shapes', ready: true, hint: '宽高比 / 方向 / 分辨率 / 资产类型'}),
  Object.freeze({id: 'rating', label: '评分', short: '评分', icon: 'star', ready: true, hint: '精确星级 · 未评分 · 排除'}),
  Object.freeze({id: 'favorite', label: '收藏', short: '收藏', icon: 'heart', ready: true, hint: '全部 / 只看收藏 / 只看未收藏'}),
  Object.freeze({id: 'format', label: '格式', short: '格式', icon: 'file', ready: true, hint: '按扩展名筛选 · Shift 多选'}),
  Object.freeze({id: 'folders', label: '目录', short: '目录', icon: 'folder', ready: true, hint: '按资产库文件夹收窄 · Shift 多选'}),
  Object.freeze({id: 'source', label: '来源与分类', short: '来源', icon: 'layers', ready: true, hint: '平台来源 · 分类标签 · Shift 多选'}),
  Object.freeze({id: 'more', label: '检索与合集', short: '更多', icon: 'list', ready: true, hint: '检索式 · 尺寸范围 · 合集与智能合集'}),
]);

/** 「目录」维度的取值：包相对根的路径第一段。扁平铺在根下的包归到一个虚拟目录。 */
export const ROOT_FOLDER_KEY = '(根目录)';
export function folderOf(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const cut = clean.indexOf('/');
  return cut <= 0 ? ROOT_FOLDER_KEY : clean.slice(0, cut);
}

/** 分隔线之后的排序维度：常显当前排序名，点击展开排序面板。 */
export const SORT_DIMENSION = Object.freeze({id: 'sort', label: '排序', icon: 'sort', ready: true, hint: '排序方式 · 升降序 · 随机'});
export const ALL_DIMENSIONS = Object.freeze([...FILTER_DIMENSIONS, SORT_DIMENSION]);
export const FILTER_DOCK_STORAGE_KEY = 'sfx-filter-dock-v1';

/** 后端 filters.kinds 的取值：与 kindOf(model) / 本地类型下拉同义。 */
export const KIND_CHIPS = Object.freeze([
  {value: 'models', label: '3D 模型'},
  {value: 'textures', label: '材质贴图'},
  {value: 'hdris', label: 'HDRI / 天空盒'},
  {value: 'images', label: '图片 / Alpha'},
  {value: 'packs', label: '资源包'},
].map(Object.freeze));

/** 本地库「文件状态」维度：值域与 #local-status 的 option 一一对应。 */
export const LOCAL_STATUS_CHIPS = Object.freeze([
  {value: 'downloaded', icon: 'check', label: '已下载'},
  {value: 'missing', icon: 'ban', label: '文件缺失'},
  {value: 'untracked', icon: 'help', label: '未登记'},
].map(Object.freeze));

/** 本地库「范围」维度：值域与 #local-feature 的 option 一一对应（在线专用的两项不再摆入口）。 */
export const LOCAL_SCOPE_CHIPS = Object.freeze([
  {value: 'all', icon: 'grid', label: '全部'},
  {value: 'favorites', icon: 'heart', label: '收藏'},
  {value: 'trash', icon: 'trash', label: '回收站'},
].map(Object.freeze));

/** 「来源 / 分类」维度：后端 filters 字段名 → model 上的字段名。 */
export const SOURCE_GROUPS = Object.freeze([
  {field: 'platforms', modelField: 'platform', label: '平台来源', icon: 'layers'},
  {field: 'categories', modelField: 'categories', label: '分类', icon: 'tag'},
].map(Object.freeze));

/** 统计某一维候选值（platform 是字符串、categories 是数组），按出现次数倒序取前 24 个。 */
export function sourceRows(models = [], field) {
  const counts = new Map();
  for (const model of models) {
    const raw = model?.[field];
    for (const value of (Array.isArray(raw) ? raw : raw ? [raw] : [])) {
      const token = String(value ?? '').trim();
      if (token) counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({key, count}))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'zh'))
    .slice(0, 24);
}

export const kindLabel = value => KIND_CHIPS.find(item => item.value === value)?.label || value;
export const localStatusLabel = value => LOCAL_STATUS_CHIPS.find(item => item.value === value)?.label || value;
export const localScopeLabel = value => LOCAL_SCOPE_CHIPS.find(item => item.value === value)?.label || value;

/** 服务端 SORTS 的全集；group 只用于面板分节，协议值仍是 value。 */
export const SORT_CHIPS = Object.freeze([
  {value: 'recent', label: '最近添加', group: 'primary'},
  {value: 'oldest', label: '最早添加', group: 'primary'},
  {value: 'name', label: '名称', group: 'primary'},
  {value: 'rating', label: '我的评分', group: 'primary'},
  {value: 'popular', label: '最多点赞', group: 'primary'},
  {value: 'position', label: '入库顺序', group: 'secondary'},
  {value: 'collection', label: '合集顺序', group: 'secondary'},
  {value: 'random', label: '随机', group: 'secondary'},
  {value: 'color', label: '色相', group: 'secondary'},
  {value: 'resolution', label: '分辨率', group: 'secondary'},
  {value: 'size', label: '文件大小', group: 'secondary'},
].map(Object.freeze));

/** 精确评分多选：0 = 未评分（与 Serpent 的 6 个 chip 一致）。 */
export const RATING_CHIPS = Object.freeze([
  {value: '5', label: '5 星'}, {value: '4', label: '4 星'}, {value: '3', label: '3 星'},
  {value: '2', label: '2 星'}, {value: '1', label: '1 星'}, {value: '0', label: '未评分'},
].map(Object.freeze));

export const FAVORITE_MODES = Object.freeze([
  {value: 'any', label: '全部'}, {value: 'yes', label: '只看收藏'}, {value: 'no', label: '只看未收藏'},
].map(Object.freeze));

export const sortLabel = value => SORT_CHIPS.find(item => item.value === value)?.label || '最近添加';

/** 与格式面板一致：普通点击只选一个 / 再点清空，Shift 点击 OR 累加或移除。 */
export function toggleToken(list, value, shiftKey = false) {
  const token = String(value ?? '').trim();
  if (!token) return Array.isArray(list) ? [...list] : [];
  const current = (Array.isArray(list) ? list : []).filter(item => String(item).trim());
  const exists = current.includes(token);
  if (shiftKey) return exists ? current.filter(item => item !== token) : [...current, token];
  return exists && current.length === 1 ? [] : [token];
}

/** 解析 '石头, 木材' / 数组 → 去空白去重的 token 列表。 */
export function parseTokens(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return [...new Set(raw.split(/[,，;；]+/u).map(item => item.trim()).filter(Boolean))].slice(0, 100);
}

/**
 * 图标激活态（小圆点 + 高亮）只看这一份快照。
 * snapshot: {q, rating, favorite, favoriteMode, tags, excludeTags, kinds, ratings,
 *            formats, colors, ranges, sort, sortOrder, activeCollection,
 *            localKind, localStatus, localScope}
 * 后三个来自旧工具栏那三个下拉：整合后它们是隐藏的状态载体，可见入口已经并进图标面板。
 */
export function dimensionActive(id, snapshot = {}) {
  const list = key => Array.isArray(snapshot[key]) ? snapshot[key] : [];
  switch (id) {
    case 'color': return list('colors').length > 0;
    case 'tags': return list('tags').length > 0 || list('excludeTags').length > 0;
    case 'kinds': return list('kinds').length > 0 || list('ranges').length > 0
      || (!!snapshot.localKind && !list('tags').length && !list('excludeTags').length);
    case 'rating': return !!snapshot.rating || list('ratings').length > 0;
    case 'favorite': return snapshot.favorite === true || (!!snapshot.favoriteMode && snapshot.favoriteMode !== 'any')
      || (!!snapshot.localScope && snapshot.localScope !== 'all');
    case 'format': return list('formats').length > 0 || !!snapshot.localStatus;
    case 'folders': return list('folders').length > 0;
    case 'source': return list('categories').length > 0 || list('platforms').length > 0;
    case 'sort': return !!snapshot.sort && (snapshot.sort !== 'recent' || snapshot.sortOrder === 'desc');
    case 'more': return !!String(snapshot.q || '').trim() || !!snapshot.activeCollection;
    default: return false;
  }
}

/** 只读存储也要能开面板：坏存档一律当空状态，绝不让工具栏初始化失败。 */
export function readDockState(storage, key = FILTER_DOCK_STORAGE_KEY) {
  try {
    const saved = JSON.parse(storage?.getItem(key) || 'null');
    const openId = typeof saved?.openId === 'string' ? saved.openId : '';
    return {openId: ALL_DIMENSIONS.some(item => item.id === openId) ? openId : ''};
  } catch { return {openId: ''}; }
}

export function writeDockState(storage, openId, key = FILTER_DOCK_STORAGE_KEY) {
  try { storage?.setItem(key, JSON.stringify({version: 1, openId})); } catch { /* 隐私模式下内存态照常用 */ }
}
