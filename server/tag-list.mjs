// 平台标签归一：每个站回来的标签形状都不一样，而下载包清单、任务记录、库索引要的是同一份标签。
//
// 已经遇到的形状：
//   · 字符串数组            Sketchfab / ambientCG / Poly Haven / Pexels / 站酷
//   · `{name}` 对象数组      ArtStation（搜索与作品详情都是）
//   · `{tag, translation}`   Pixiv
//   · 空格分隔的串           Flickr（多词标签用引号包住：`"new york" sunset`）
// 归一化只写在这里，任何平台适配器都不再自己 split / map / slice。

const MAX_TAGS = 24;
const MAX_TAG_LENGTH = 40;
const QUOTED = /"([^"]+)"|(\S+)/g;

/** Flickr 那种「空格分隔 + 引号包短语」的串先拆成数组，其余形状原样返回。 */
function asEntries(value) {
  if (typeof value === 'string') return [...value.matchAll(QUOTED)].map(match => match[1] || match[2]);
  return Array.isArray(value) ? value : [];
}

/** 一条平台标签记录 → 文本。认 `{name}`（ArtStation/Sketchfab）、`{tag}`（Pixiv）、
 *  `{_content}`（Flickr getInfo）三种键。 */
const textOf = entry => {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  return entry.name ?? entry.tag ?? entry._content ?? '';
};

/**
 * 任意形状的平台标签 → 干净的字符串数组。
 * 去空、压掉连续空白、按小写去重（同一个站常同时给 `3D` 和 `3d`），保持原站顺序。
 */
export function tagList(value, {max = MAX_TAGS, maxLength = MAX_TAG_LENGTH} = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of asEntries(value)) {
    const tag = String(textOf(entry)).trim().replace(/\s+/g, ' ').slice(0, maxLength);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 多路标签合并：站点级（整个作品的标签）+ 任务级（资产库里已有的标签）+ 每张图自己的标签。
 * 先到的优先——站点标签代表「这个作品是什么」，比单张图的标签更有信息量。
 */
export function mergeTags(...groups) {
  return tagList(groups.flatMap(asEntries));
}
