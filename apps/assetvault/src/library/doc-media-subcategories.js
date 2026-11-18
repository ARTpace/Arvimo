/**
 * 文档 / 视频 / 音频的「用途子类」。
 *
 * 图片有 image-subcategories 按用途分类，这三类以前什么都没有：展开「文档」「影音」就是死胡同。
 * 这里补上一层按名称 / 标签推断的用途子类（不是按扩展名分格式 —— 用户明确不要格式维度），
 * 和图片用途子类同一套用法：写进 localAssetCategories 之后，
 *   · 侧栏类型树的子分类计数自动就有（localTypeFacets 读的正是这个函数）；
 *   · 点一下子类就能筛（筛选链同样按 localAssetCategories 匹配）。
 *
 * 每类只留 3~4 条：再多侧栏就变成词云，而这类推断本来就粗，细分只会更不准。
 * 推断不出来的一律落到「其他 X」兜底，绝不给资产挂错标签。
 */

/** 先用扩展名认出这是哪一类文件（只用来分流，不作为子类名）。 */
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'dot', 'dotx', 'rtf', 'odt', 'wps', 'md', 'markdown', 'mdx', 'txt', 'log', 'text', 'tex', 'epub', 'pages']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'mpg', 'mpeg']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'mid', 'midi']);

/** 名称 / 标签里的关键词 → 子类。命中第一个就用它。 */
const RULES = Object.freeze({
  documents: Object.freeze([
    { label: '教程指南', words: ['教程', '指南', '手册', '说明', 'tutorial', 'guide', 'manual', 'howto', 'how-to', 'readme'] },
    { label: '设计文档', words: ['设计', '方案', '需求', '规范', '文档', 'design', 'spec', 'brief', 'plan', 'doc'] },
    { label: '参考资料', words: ['参考', '资料', '摘录', '笔记', 'research', 'reference', 'ref', 'note', 'collect'] },
  ]),
  videos: Object.freeze([
    { label: '预览视频', words: ['预览', '演示', '转盘', 'preview', 'turntable', 'spin', 'demo', 'orbit'] },
    { label: '教程视频', words: ['教程', '教学', '过程', 'tutorial', 'guide', 'howto', 'process', 'breakdown'] },
    { label: '素材片段', words: ['素材', '片段', '空镜', 'clip', 'footage', 'plate', 'stock'] },
  ]),
  audio: Object.freeze([
    { label: '音乐配乐', words: ['音乐', '配乐', '主题', 'music', 'bgm', 'song', 'theme', 'soundtrack'] },
    { label: '音效', words: ['音效', '声音', '环境', 'sfx', 'sound', 'effect', 'fx', 'ambience', 'ambient'] },
    { label: '配音人声', words: ['配音', '人声', '旁白', '对白', 'voice', 'vo', 'vocal', 'narrat', 'dialog'] },
  ]),
});

/** 树里始终要露出来的子类：库内还没有这类文件时也得有个入口，否则展开是空的。 */
export const STATIC_SUBCATEGORY_CHILDREN = Object.freeze({
  documents: Object.freeze(['教程指南', '设计文档', '参考资料', '其他文档']),
  videos: Object.freeze(['预览视频', '教程视频', '素材片段', '其他视频']),
  audio: Object.freeze(['音乐配乐', '音效', '配音人声', '其他音频']),
});

const FALLBACK = Object.freeze({ documents: '其他文档', videos: '其他视频', audio: '其他音频' });

/** 资产 / 磁盘条目上可能承载文件名与标签的字段。 */
const NAME_FIELDS = ['fileName', 'filename', 'file', 'rel', 'relPath', 'name', 'path', 'target', 'url', 'key'];
const TEXT_FIELDS = ['name', 'fileName', 'filename', 'rel', 'relPath', 'title', 'caption', 'description'];

function extensionOf(value) {
  const path = String(value).split(/[?#]/)[0];
  const base = path.slice(path.lastIndexOf('/') + 1).slice(path.lastIndexOf('\\') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function fileExtensionOf(item) {
  if (!item) return '';
  if (typeof item === 'string') return extensionOf(item);
  for (const field of NAME_FIELDS) {
    const value = item[field];
    if (typeof value !== 'string' || !value) continue;
    const ext = extensionOf(value);
    if (ext) return ext;
  }
  return '';
}

const groupOfExtension = ext =>
  DOC_EXT.has(ext) ? 'documents' : VIDEO_EXT.has(ext) ? 'videos' : AUDIO_EXT.has(ext) ? 'audio' : '';

/** 名称 + 分类/标签拼成一条待匹配的小写串；只读明确字段，不翻整个对象。 */
function searchText(item) {
  if (typeof item === 'string') return item.toLowerCase();
  const parts = [];
  for (const field of TEXT_FIELDS) if (typeof item[field] === 'string') parts.push(item[field]);
  if (Array.isArray(item.tags)) parts.push(...item.tags.filter(value => typeof value === 'string'));
  if (Array.isArray(item.categories)) parts.push(...item.categories.filter(value => typeof value === 'string'));
  if (typeof item.category === 'string') parts.push(item.category);
  return parts.join(' ').toLowerCase();
}

/** 文档 / 视频 / 音频的用途子类；其它类型一律返回 ''（不掺进图片和 3D 的标签里）。
 *  kind 为空时按扩展名分流，调用方不必先跑一遍 classifyAsset。 */
export function mediaSubcategoryOf(item, kind = '') {
  const ext = fileExtensionOf(item);
  if (!ext) return '';
  const group = kind && FALLBACK[kind] ? kind : groupOfExtension(ext);
  if (!group) return '';
  const rules = RULES[group];
  if (!rules) return '';
  const text = searchText(item);
  for (const rule of rules) if (rule.words.some(word => text.includes(word))) return rule.label;
  return FALLBACK[group];
}
