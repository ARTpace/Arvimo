// 客观标签自动派生：把采集时已经拿到、且确定无疑的信息直接变成可检索的标签。
//
// 与 AI 打标的边界：这里只做「事实搬运」，不猜内容。名字看不出画的是什么，就不会凭空
// 产出「角色设计」这类标签 —— 那是视觉或人工的活。因此结果可以直接落库，不需要人工审核。
//
// 为什么放在前后端共享层：server 既有依赖 src/library 的单向通路（format-registry / platforms），
// 而前端标签面板读的是 state 不是 DB。于是三处共用同一个纯函数：
//   · collect-search 归一化：新收藏零点击带标签；
//   · asset-tags.tagsFor：历史资产界面立即可见，无需回填或重新收藏；
//   · library-blob.deriveTagRows：标签表 / FTS / 筛选同步可用。
// 三处都调是幂等的；客观标签虚拟不写入用户 state，改配置即可全库撤销。
//
// 本模块不写库、不发请求、不读文件；同样输入永远得到同样输出（payload 字节级比较安全）。

/** 配置缝：以后从设置页 / YAML 覆盖即可，不用改逻辑。 */
export const AUTO_TAG_CONFIG = Object.freeze({
  enabled: true,
  max: 6,
  minLength: 2,
  maxLength: 40,
  platformPrefix: '来源:',
  includeBoard: true,
  includeCategory: true,
  includeHashtags: true,
  includePlatform: true,
});

/** 平台 id → 可读名称。表里没有的直接用 id，不猜。 */
export const PLATFORM_LABELS = Object.freeze({
  huaban: '花瓣', xiaohongshu: '小红书', pinterest: 'Pinterest', zcool: '站酷',
  pixiv: 'Pixiv', wallhaven: 'Wallhaven', safebooru: 'Safebooru',
  yandere: 'Yandere', konachan: 'Konachan',
  sketchfab: 'Sketchfab', artstation: 'ArtStation', polyhaven: 'Poly Haven',
  ambientcg: 'ambientCG', kenney: 'Kenney', freestylized: 'FreeStylized',
  polypizza: 'Poly Pizza', polyfork: 'Polyfork', simready: 'SimReady',
  '500px': '500px', civitai: 'Civitai', pexels: 'Pexels', flickr: 'Flickr',
  designspiration: 'Designspiration', uiverse: 'Uiverse',
});

/** 格式 / 分辨率 / 占位词：这些是技术元数据，不是检索词，进了标签只会稀释筛选。 */
const NOISE = new Set([
  'image', 'images', 'img', 'photo', 'photos', 'picture', 'jpg', 'jpeg', 'png', 'webp', 'gif',
  'raw', 'high resolution', 'highres', 'resolution', 'untitled', '未命名', '未命名资产',
  '图片素材', '来自相册', '我的收藏', 'unknown', 'n/a', 'none',
]);
const NOISE_PATTERNS = Object.freeze([
  /^\d+x\d+$/i,          // 762x39
  /^\d{2,6}$/,           // 480
  /^\d+(\.\d+)?\s*(k|p|px|mb|kb)$/i,
  /^https?:\/\//i,
  /^[a-z0-9.-]+\.(com|net|org|cn|io|cc|nl|re)$/i,  // 站点名不是标签
]);

/**
 * 旧采集把画板名拼进了 name（如「收藏到 캐릭터 디자인」），没单独存。
 * 这里按已知格式反解，让历史数据也能吃到主人自己分的类。新增格式往表里补正则即可。
 */
export const BOARD_PATTERNS = Object.freeze([
  /^收藏到\s+(.+)$/,
  /^collect(?:ed)?\s+to\s+(.+)$/i,
]);

const text = value => typeof value === 'string' ? value.trim() : (value == null ? '' : String(value).trim());

/**
 * 老 payload 兼容：采集层是后来才加 meta 的，历史资产只有散在 model 上的原始字段
 * （Sketchfab 的 categories 数组、花瓣的 boardTitle 等）。字段表驱动，新增平台补一行即可。
 * 这里刻意不 import server/collect-meta.mjs —— src 不能反向依赖 server，且 Tauri 的
 * sidecar-server 里有一份 server 代码副本，挪动文件会把它弄坏。
 */
export const LEGACY_META_FIELDS = Object.freeze({
  board: ['board', 'boardTitle', 'boardName', 'album', 'collection', 'collectionTitle', 'series'],
  category: ['category', 'categoryLabel', 'categories', 'cat', 'section', 'group', 'typeLabel'],
  hashtags: ['hashtags', 'topics', 'keywords'],
});

/** 有新采集的 meta 就用它，否则从原始字段现场拼一个同形结构；全空返回 null。 */
export function metaOf(model = {}) {
  const own = model?.meta;
  if (own && typeof own === 'object' && !Array.isArray(own) && Object.keys(own).length) return own;
  if (!model || typeof model !== 'object') return null;
  const out = {};
  for (const [key, names] of Object.entries(LEGACY_META_FIELDS)) {
    for (const name of names) {
      const raw = model[name];
      if (!raw) continue;
      const value = Array.isArray(raw) ? raw.map(text).filter(Boolean).join(' / ') : text(raw);
      if (value) { out[key] = value.slice(0, 160); break; }
    }
  }
  return Object.keys(out).length ? out : null;
}

/** 单个词能不能当标签：长度、噪声、纯符号都在这里收口。 */
function acceptable(raw, cfg) {
  const value = text(raw).replace(/^#+/, '').replace(/^[\s"'「『]+|[\s"'」』]+$/g, '');
  if (value.length < cfg.minLength || value.length > cfg.maxLength) return '';
  const lower = value.toLowerCase();
  if (NOISE.has(lower) || NOISE_PATTERNS.some(pattern => pattern.test(value))) return '';
  if (!/[\p{L}\p{N}]/u.test(value)) return '';
  return value;
}

/** 按优先级收词，去重后截断；同输入必得同输出。 */
function collect(values, seen, out, cfg) {
  for (const raw of values) {
    if (out.length >= cfg.max) return;
    const value = acceptable(raw, cfg);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
}

/** 从 name 反解旧采集丢失的画板名。 */
export function boardFromName(name = '') {
  const value = text(name);
  for (const pattern of BOARD_PATTERNS) {
    const match = value.match(pattern);
    if (match) {
      const board = text(match[1]);
      if (board && !NOISE.has(board.toLowerCase())) return board;
    }
  }
  return '';
}

/** 分类可能是「animals-pets / nature-plants」，拆开才能各自成为筛选词。 */
const splitCategory = value => text(value).split(/\s*\/\s*|\s*\|\s*/).map(text).filter(Boolean);

/**
 * 从一条 model 派生客观标签。model 只需含 uid 无关的普通字段：
 * meta / platform / tags / name / probe 均可缺省。
 * 返回去重后的字符串数组，不含已有 tags（由 mergeTags 负责合并）。
 */
export function deriveAutoTags(model = {}, overrides = {}) {
  const cfg = {...AUTO_TAG_CONFIG, ...overrides};
  if (!cfg.enabled || !model || typeof model !== 'object') return [];
  const meta = metaOf(model) || {};
  const seen = new Set();
  const out = [];
  if (cfg.includeBoard) {
    const board = text(meta.board) || boardFromName(model.name);
    collect([board], seen, out, cfg);
  }
  if (cfg.includeCategory) {
    collect(splitCategory(meta.category), seen, out, cfg);
  }
  if (cfg.includeHashtags) {
    const hashtags = Array.isArray(meta.hashtags)
      ? meta.hashtags : text(meta.hashtags).split(/[,，;；\s]+/);
    collect(hashtags, seen, out, cfg);
  }
  if (cfg.includePlatform) {
    const id = text(model.platform || meta.sourceHost);
    if (id) collect([`${cfg.platformPrefix}${PLATFORM_LABELS[id] || id}`], seen, out, cfg);
  }
  return out;
}

/**
 * 已有标签与派生标签合并。已有标签优先保留（原顺序不动），派生的只补没出现过的。
 * 上限 cfg.max + 原有数量，避免把采集器给的 20 个平台标签挤掉。
 */
export function mergeAutoTags(existing = [], model = {}, overrides = {}) {
  const cfg = {...AUTO_TAG_CONFIG, ...overrides};
  const original = (Array.isArray(existing) ? existing : []).map(text).filter(Boolean);
  if (!cfg.enabled) return original;
  const seen = new Set(original.map(value => value.toLowerCase()));
  const out = [...original];
  for (const tag of deriveAutoTags(model, cfg)) {
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** 名字是否含可用的文本信号。无信号时调 LLM 只会得到瞎猜的标签，直接跳过更省。 */
export function hasTextSignal(name = '') {
  const value = text(name);
  if (value.length < 3) return false;
  if (NOISE.has(value.toLowerCase()) || NOISE_PATTERNS.some(pattern => pattern.test(value))) return false;
  // 「我的收藏 - 微博」这种只有平台占位词的名字，对 LLM 没有任何内容信号。
  if (/^(我的收藏|来自相册|图片素材|未命名)/u.test(value)) return false;
  // 用 Unicode 字母判断：\W 会把中文当成「非单词字符」，纯中文名字会被误判成无信号。
  if (!/[\p{L}\p{N}]/u.test(value)) return false;
  if (/^IMG[_-]?\d+$/i.test(value) || /^DSC\d+$/i.test(value)) return false;
  return true;
}
