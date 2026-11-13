// 采集元信息归一化：把各平台异构的「画板 / 类目 / 描述 / 话题 / 出处」收成同一个结构。
//
// 为什么要有这一层：采集时各平台其实抓到了不少可当标签参考的信息（花瓣的画板名与 #话题、
// Kenney 的 categoryLabel、ambientCG 的 category、来源站域名…），但归一化函数只取
// name/author/tags/url，其余全被丢掉；而打标提示词只吃 name/author/kind，于是这些信息
// 抓了等于没抓。这里用一个**字段名表**统一收口：新增平台只需在表里补字段名，不改逻辑。
//
// 边界：本模块只做读取与拼装，不写库、不发请求。颜色与构图取自已有 probe，不重新采样。

/** 每类元信息按顺序取第一个非空字段；不区分平台，命中即用。
 *  注意 `categories`：9 个模型平台（sketchfab / polyhaven / kenney / ambientcg / artstation…）
 *  全都用数组形态给出分类，只认单数 `category` 会把它们的分类整片漏掉。 */
export const META_FIELDS = Object.freeze({
  board: ['board', 'boardTitle', 'boardName', 'album', 'collection', 'collectionTitle', 'collectionName', 'series'],
  category: ['category', 'categoryLabel', 'categories', 'cat', 'section', 'group', 'typeLabel', 'assetGroup'],
  description: ['description', 'desc', 'summary', 'content', 'caption', 'note', 'raw_text'],
  hashtags: ['hashtags', 'topics', 'keywords'],
  sourceHost: ['sourceHost', 'sourceDomain', 'domain'],
});

const LIMITS = Object.freeze({board: 60, category: 40, description: 220, hashtags: 12, hashtagItem: 24, sourceHost: 60});

const text = value => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
};

const squash = value => text(value).replace(/\s+/g, ' ');

/** 数组形态（categories）拼成一段，单值走原样清洗。 */
const flatten = value => Array.isArray(value)
  ? value.map(text).filter(Boolean).join(' / ')
  : squash(value);

/** 话题可能是数组、空格/逗号串，或描述里的 #xxx；统一成去重数组。 */
function hashtagsOf(item = {}) {
  const out = [];
  const push = raw => {
    for (const part of String(raw || '').split(/[,，;；\s]+/)) {
      const tag = part.trim().replace(/^#+/, '').slice(0, LIMITS.hashtagItem);
      if (tag && !out.includes(tag)) out.push(tag);
    }
  };
  for (const key of META_FIELDS.hashtags) {
    const value = item[key];
    if (Array.isArray(value)) value.forEach(push);
    else if (value) push(value);
  }
  const inText = String(item.raw_text || item.description || item.caption || '').match(/(?:^|\s)#([^\s#@]+)/g);
  if (inText) inText.forEach(raw => push(raw));
  return out.slice(0, LIMITS.hashtags);
}

function hostOf(item = {}) {
  for (const key of META_FIELDS.sourceHost) {
    const value = text(item[key]);
    if (value) return value.replace(/^www\./, '').toLowerCase().slice(0, LIMITS.sourceHost);
  }
  for (const key of ['link', 'sourceUrl', 'pageUrl', 'url']) {
    const value = text(item[key]);
    if (!value) continue;
    try {
      return new URL(value).hostname.replace(/^www\./, '').toLowerCase().slice(0, LIMITS.sourceHost);
    } catch {
      // 不是绝对地址就继续找下一个
    }
  }
  return '';
}

/**
 * 平台域名表：采集条目偶尔缺 platform 字段（历史数据、直链收藏、详情页来源），
 * 但从 url / thumbnail 的域名仍能唯一判出平台。新增平台在此补一行即可。
 */
export const PLATFORM_HOSTS = Object.freeze({
  'sketchfab.com': 'sketchfab',
  'artstation.com': 'artstation',
  'polyhaven.com': 'polyhaven',
  'ambientcg.com': 'ambientcg',
  'polypizza.com': 'polypizza',
  'kenney.nl': 'kenney',
  'freestylized.com': 'freestylized',
  'pixiv.net': 'pixiv',
  'pximg.net': 'pixiv',
  'safebooru.org': 'safebooru',
  'yande.re': 'yandere',
  'konachan.com': 'konachan',
  'konachan.net': 'konachan',
  'wallhaven.cc': 'wallhaven',
  'civitai.com': 'civitai',
  'zcool.cn': 'zcool',
  'designspiration.net': 'designspiration',
  'huaban.com': 'huaban',
  'hbimg.huaban.com': 'huaban',
  'pexels.com': 'pexels',
  'flickr.com': 'flickr',
  '500px.com': '500px',
  'xiaohongshu.com': 'xiaohongshu',
  'xhscdn.com': 'xiaohongshu',
  'pinterest.com': 'pinterest',
  'pinimg.com': 'pinterest',
});

/** 从任意地址判平台；判不出返回空串（调用方回退旧字段，不猜）。 */
export function platformFromUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
  for (const [domain, id] of Object.entries(PLATFORM_HOSTS)) {
    if (host === domain || host.endsWith(`.${domain}`)) return id;
  }
  return '';
}

/**
 * 从一条采集结果里抽出可用元信息。全空时返回 null，避免给每个资产塞一个空对象
 * （payload 是字节级比较的，空对象会让「无变化」被误判成有变化）。
 */
export function pickMeta(item = {}) {
  const meta = {};
  for (const key of ['board', 'category', 'description']) {
    for (const name of META_FIELDS[key]) {
      const value = flatten(item[name]);
      if (value) {
        meta[key] = value.slice(0, LIMITS[key]);
        break;
      }
    }
  }
  const hashtags = hashtagsOf(item);
  if (hashtags.length) meta.hashtags = hashtags;
  const sourceHost = hostOf(item);
  if (sourceHost) meta.sourceHost = sourceHost;
  return Object.keys(meta).length ? meta : null;
}

/** 主色 / 明暗 / 构图：来自已有 probe，不重新采样。只在够明确时给词，避免噪声。 */
export function lookOf(probe) {
  if (!probe || typeof probe !== 'object') return [];
  const out = [];
  const {h, s, l, width, height} = probe;
  if (Number.isFinite(s) && Number.isFinite(l)) {
    if (s < 0.08) out.push(l > 0.9 ? '近白底' : l > 0.65 ? '浅灰' : l > 0.35 ? '中灰' : '深灰');
    else {
      if (l > 0.7) out.push('浅色调');
      else if (l < 0.3) out.push('深色调');
      if (Number.isFinite(h)) {
        const stops = [[15, '红'], [40, '橙'], [65, '黄'], [160, '绿'], [200, '青'], [255, '蓝'], [290, '紫'], [330, '粉'], [361, '红']];
        for (const [max, name] of stops) if (h < max) { out.push(`${name}色`); break; }
      }
    }
  }
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const ratio = height / width;
    out.push(ratio > 3 ? '超长竖图' : ratio > 1.2 ? '竖图' : ratio < 0.83 ? '横图' : '方图');
  }
  return out;
}

/**
 * 拼成打标提示词的附加行。整体限长，避免把上下文挤掉；
 * 全部为空时返回空串，让提示词与旧版逐字一致（缓存键不受影响）。
 *
 * exclude 传已有标签：平台标签本来就会出现在 EXISTING TAGS 里（花瓣的画板名、500px 的
 * 站点分类都被归一进 tags），不去重会让同一个词在提示词里出现两次。
 */
export function metaPromptLines(meta, {probe = null, limit = 360, exclude = []} = {}) {
  const lines = [];
  const seen = new Set(exclude.map(value => text(value).toLowerCase()).filter(Boolean));
  const known = value => seen.has(value.toLowerCase());
  // 空数组必须当成「没有」：`[].join()` 是空串但数组本身真值，否则会拼出一行 `VISUAL: `，
  // 既污染提示词，又让「无元信息时提示词与旧版逐字一致」的缓存约定失效。
  const single = (label, value) => {
    const body = text(Array.isArray(value) ? value.join(' / ') : value);
    if (body && !known(body)) lines.push(`${label}: ${body}`);
  };
  const multi = (label, values, joiner) => {
    const kept = (Array.isArray(values) ? values : [values])
      .map(value => text(value))
      .filter(value => value && !known(value));
    if (kept.length) lines.push(`${label}: ${kept.join(joiner)}`);
  };
  single('BOARD', meta?.board);
  // 分类常被拼成「3D 模型 / Fantasy」，要拆开逐个比对才算得准。
  multi('CATEGORY', text(meta?.category).split(/\s*\/\s*/).filter(Boolean), ' / ');
  single('ORIGIN', meta?.sourceHost);
  multi('HASHTAGS', meta?.hashtags, ', ');
  multi('VISUAL', lookOf(probe), ', ');
  single('SUMMARY', meta?.description);
  let body = lines.join('\n');
  if (body.length > limit) body = `${body.slice(0, limit)}…`;
  return body;
}
