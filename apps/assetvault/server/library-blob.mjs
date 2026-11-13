// 前端整块状态 → 数据库派生索引的纯转换层（无 IO、无第三方依赖，可单独单测）。
//
// 阶段 1 的约定：state_meta 里的原始字符串是权威，下面的行全部是「可重建的派生数据」。
// 因此这里不做任何字段裁剪或重新序列化，前端拿到的永远是原本那串 JSON。
// 阶段 3 反转权威关系时，只需替换本文件的实现，不必动 API 契约。
import {MAIN_STATE_KEY, USER_STATE_KEY, PROBE_STATE_KEY, SESSION_STATE_KEY, STATE_KEYS,
  USER_FIELDS, PROBE_FIELDS, SESSION_FIELDS, CATALOG_FIELDS} from './library-schema.mjs';
// 与查询层共用同一套类型判断与探针提取；在派生阶段就把列化字段算好，
// 查询时不必再逐行 JSON.parse 求 kind / 分辨率 / 色相（50 万行时这是最贵的一步）。
import {kindOf} from './asset-kind.mjs';
import {formatsOfModel} from '../src/library/format-registry.js';
import {probeOfModel} from './model-probe.mjs';
import {platformFromUrl} from './collect-meta.mjs';
import {mergeAutoTags} from '../src/library/auto-tags.js';

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const integer = value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
const list = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/**
 * 分类文本（V5 列化）：与 library-query.mjs 的 categoriesOf 保持同一套来源
 * （categories[] ∪ category ∪ assetType ∪ kind），这里只有两点不同：
 *   1. 拼成一个小写串 —— SQL 侧用 instr(lower 列, ?) 做子串匹配，大小写不一致会让
 *      「下推结果」与「内存降级结果」分叉；
 *   2. 用空格做分隔符（与 tags_text 一致），不引入控制字符。
 */
export function categoryTextOf(model) {
  const values = [
    ...(Array.isArray(model.categories) ? model.categories : []),
    model.category, model.assetType, kindOf(model),
  ];
  return [...new Set(values.map(item => typeof item === 'string' ? item.trim()
    : text(item?.name || item?.label)).filter(Boolean))]
    .map(item => item.toLocaleLowerCase()).join(' ');
}

/** 损坏的 blob 不能拖垮启动：解析失败就当空库，权威字符串仍原样留在 state_meta。 */
export function parseMainState(value) {
  try {
    const data = JSON.parse(typeof value === 'string' ? value : '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

/** 用户域字段：标签 / 评分备注 / 收藏。权威在服务端 DB，前端只发集合语义 op。 */
// 域字段清单集中在 library-schema.mjs（契约层），这里只做一次转出，
// 免得同一个清单在两个文件里各写一份、日后改漏一处。
export {USER_FIELDS, PROBE_FIELDS, SESSION_FIELDS, CATALOG_FIELDS};

/**
 * 四域合并成一份完整 state（ADR-02）。
 *
 * 派生层只需要「一份看得全的 state」：目录 + 用户数据 + 探测缓存 + 会话现场。
 * 合并规则：**域 key 存在时它就是该域的权威**，不存在才回落到主 blob 里的旧字段
 * （老库里这些字段本来就躺在 sfx-library-v2 里，属于迁移期的正常形态）。
 *
 * 注意「存在」的判定用的是 key 自身有没有内容，而不是字段是否齐全：
 * 用户域一旦被写过就是完整的（前端总是整体写这一域），
 * 此时主 blob 里的旧 aiTags 必须让位 —— 否则删掉的标签会被旧字段复活。
 */
export function mergeDomains(values = {}) {
  const main = parseMainState(values[MAIN_STATE_KEY]);
  const user = parseMainState(values[USER_STATE_KEY]);
  const probe = parseMainState(values[PROBE_STATE_KEY]);
  const session = parseMainState(values[SESSION_STATE_KEY]);
  const merged = {...main};
  /**
   * 字段级覆盖而不是整域替换：域里显式给出的字段才算权威，没给出的字段沿用主 blob。
   * 整域替换曾经把「只写了 userMeta 的域」当成「用户域全空」，
   * 于是主 blob 里的 userTags / favorites 被无声清空 —— 这类漂移比报错更难查。
   */
  const apply = (domain, fields) => {
    for (const field of fields) {
      if (Object.hasOwn(domain, field)) merged[field] = domain[field];
    }
  };
  apply(user, USER_FIELDS);
  apply(probe, PROBE_FIELDS);
  apply(session, SESSION_FIELDS);
  return merged;
}

function ratingOf(meta) {
  const n = Number(object(meta).rating);
  return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.round(n))) : 0;
}

/** models 与 trashed 都进同一张表，用 state 区分；position 保留前端的数组顺序。 */
export function deriveAssetRows(data, now = Date.now()) {
  const userMeta = object(data.userMeta);
  // 封面探测缓存（颜色 / 宽高比）是可重建的派生数据：写进 payload 让 SQLite 索引与内存降级
  // 两条路径拿到同形的 model.probe。没有探测数据时 payload 保持字节级不变，老库零迁移。
  const probes = object(data.assetProbe);
  const favorites = new Set(list(data.favorites).filter(uid => typeof uid === 'string'));
  const rows = [];
  const push = (model, state, position) => {
    if (!model || typeof model !== 'object' || typeof model.uid !== 'string' || !model.uid) return;
    const meta = state === 'trashed' ? object(model.userMeta) : object(userMeta[model.uid]);
    const rawProbe = state === 'trashed' ? null : probes[model.uid];
    const payload = rawProbe && typeof rawProbe === 'object' && !Array.isArray(rawProbe) ? {...model, probe: rawProbe} : model;
    // 列化字段与 payload 必须来自同一个 model：否则「索引里 1920 宽、卡片上 1024 宽」会对不上。
    const info = probeOfModel(payload);
    const addedAt = integer(model.addedAt) ?? integer(now);
    const size = Number(payload.bytes ?? payload.fileSize ?? payload.size);
    rows.push({
      uid: model.uid,
      position,
      state,
      payload: JSON.stringify(payload),
      name: text(model.name),
      author: text(model.author),
      url: text(model.url || model.artworkUrl),
      // platform 兜底：历史数据与直链收藏常常只存了 URL，platform 列空着会让「按平台筛选」
      // 和打标提示词里的来源信息一起失效。域名能判出来就用它，判不出仍回退旧字段。
      platform: text(model.platform) || platformFromUrl(model.url || model.pageUrl || model.thumbnail) || text(model.source),
      thumbnail: text(model.thumbnail),
      rating: ratingOf(meta),
      note: text(meta.note).slice(0, 2000),
      favorite: favorites.has(model.uid) ? 1 : 0,
      added_at: addedAt,
      trashed_at: state === 'trashed' ? (integer(model.trashedAt) ?? integer(now)) : null,
      source: 'blob',
      // V2 列化：派生阶段算一次，查询阶段不再解析 payload。
      kind: kindOf(payload),
      // V5：分类与可下载性是最后两个「只能靠 payload 判、于是整条查询退回全表 JS」的维度。
      // 落成列后，筛选条上除颜色（HSL 距离计算）外全部可下推。
      category_text: categoryTextOf(payload),
      downloadable: payload.downloadable === true ? 1 : 0,
      width: info?.width ?? null,
      height: info?.height ?? null,
      // 长边必须宽高齐全才算：numericValue(probe,'longEdge') 要求 hasPixels，
      // 单边尺寸（例如只知道宽 3000）在那边算「无分辨率」，这里若回退成 3000，
      // 排序与筛选就会在两条路径上错位。
      long_edge: info?.width && info?.height ? Math.max(info.width, info.height) : null,
      bytes: Number.isFinite(size) && size > 0 ? Math.round(size) : null,
      color_h: info?.h ?? null,
      duration: info?.duration ?? null,
      content_hash: text(payload.sha256 || payload.contentHash) || null,
      rev: 1,
      updated_at: integer(model.updatedAt) ?? addedAt,
    });
  };
  list(data.models).forEach((model, index) => push(model, 'active', index));
  list(data.trashed).forEach((model, index) => push(model, 'trashed', index));
  return rows;
}

/** 三层标签：平台只读标签、AI 标签、我的标签；回收站自带的 userTags 不能漏。 */
export function deriveTagRows(data) {
  const rows = new Map();
  const add = (uid, kind, tags, max = 24) => {
    if (typeof uid !== 'string' || !uid) return;
    for (const raw of list(tags, max)) {
      const tag = text(raw).trim().slice(0, 200);
      if (tag) rows.set(`${uid}\u0000${kind}\u0000${tag}`, {uid, kind, tag});
    }
  };
  for (const model of [...list(data.models), ...list(data.trashed)]) {
    if (!model || typeof model.uid !== 'string') continue;
    // 客观标签同样在派生层补一次：历史库没有 meta、也没重新收藏过，仍能在下次写库时
    // 自动获得画板 / 来源等标签，无需回填脚本。与前端 tagsFor 用同一个纯函数，结果一致。
    add(model.uid, 'platform', mergeAutoTags(model.tags, model), 32);
    if (model.state === 'trashed' || Object.hasOwn(object(model), 'userTags')) add(model.uid, 'user', model.userTags);
  }
  for (const [uid, tags] of Object.entries(object(data.aiTags))) add(uid, 'ai', tags);
  for (const [uid, tags] of Object.entries(object(data.userTags))) add(uid, 'user', tags);
  return [...rows.values()];
}

/** 一资产多格式：单独一张表，避免在 assets 上存逗号串（那样既不能索引也不能精确匹配）。 */
export function deriveFormatRows(data = {}) {
  const rows = new Map();
  for (const model of [...list(data.models), ...list(data.trashed)]) {
    if (!model || typeof model.uid !== 'string') continue;
    for (const ext of formatsOfModel(model)) rows.set(`${model.uid}\u0000${ext}`, {uid: model.uid, ext});
  }
  return [...rows.values()];
}

/** trigram tokenizer 对中文子串友好；body 只是检索文本，不参与还原。 */
export function deriveFtsRows(assetRows, tagRows) {
  const tagsByUid = new Map();
  for (const row of tagRows) tagsByUid.set(row.uid, [...(tagsByUid.get(row.uid) || []), row.tag]);
  return assetRows.map(row => ({
    uid: row.uid,
    body: [row.name, row.author, row.platform, row.note, ...(tagsByUid.get(row.uid) || [])]
      .filter(Boolean).join(' \u0001 '),
  }));
}

/** 一次写入所需的全部派生数据。state 行只收白名单 key，避免脏键进库。 */
export function splitState(values = {}, now = Date.now()) {
  const state = Object.entries(values)
    .filter(([key, value]) => STATE_KEYS.includes(key) && typeof value === 'string')
    .map(([key, value]) => ({key, value, updated_at: now}));
  // 派生数据来自三域合并后的完整 state（目录 + 用户 + 会话）。
  const data = mergeDomains(values);
  const assets = deriveAssetRows(data, now);
  const tags = deriveTagRows(data);
  const formats = deriveFormatRows(data);
  return {state, assets, tags, formats, fts: deriveFtsRows(assets, tags)};
}

/** 从 state_meta 行还原前端契约：原字符串不动，因此与旧实现字节级一致。 */
export function assembleState(rows = []) {
  const values = {};
  for (const row of rows) if (STATE_KEYS.includes(row.key)) values[row.key] = row.value;
  return values;
}
