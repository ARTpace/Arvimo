// S3：集合语义写入 —— 打一个标签不应该重建整个资产库。
//
// 为什么需要它：此前的写入路径是「整块 blob 写回 + 全量重建派生表」。
// 50 万资产时 `rebuildDerived` 要删表再插 400 万行 —— 一次打标等于几分钟。
// 多人协作场景下这不可接受（两个人同时打标，一个人的写入会把另一个人的结果抹掉）。
//
// 这一层做三件事：
//   1. 校验与规范化（纯函数，可脱离 DB 单测）—— ops 的形状、uid 格式、来源枚举、条数上限。
//   2. 定点写（事务内）—— 只动受影响的资产：asset_tags / tags / assets.tags_text /
//      assets_fts / assets.rev / tag_counts，不重建任何整表。
//   3. 审计 —— 每条 op 追加一行 audit_log（谁、什么时候、对哪个资产做了什么）。
//
// 与 blob 的关系：blob（state_meta 里的原始 JSON 字符串）仍然是前端契约，
// 但**同一套 op 语义**同时作用于 blob 与派生表（applyOpsToState / applyTagOps），
// 所以两边不会漂移。批量操作时 blob 只序列化一次。
import {normOf} from './library-vocab.mjs';

/** 一次请求最多多少条 op：再多就该走批量通道了。 */
export const MAX_TAG_OPS = 800;
/** 单个标签值的长度上限（与前端差量通道一致）。 */
export const MAX_TAG_LENGTH = 200;

/** 标签来源：平台标签只读（由采集器维护），AI 标签与我的标签可写可删。 */
export const WRITABLE_SOURCES = Object.freeze(['ai', 'user']);
export const ALL_SOURCES = Object.freeze(['platform', 'ai', 'user']);

/** 可通过 asset.set 修改的单值字段。 */
export const SETTABLE_FIELDS = Object.freeze(['rating', 'note', 'favorite']);

const UID = /^[a-f0-9]{32}$/i;
const LOCAL_UID = /^local-[a-f0-9]{32}$/i;
/** 请求本身该被拒绝（400），与服务器故障（500）区分开。 */
export class TagWriteRejected extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'TagWriteRejected'; this.detail = detail; }
}

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const object = value => (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
const list = value => (Array.isArray(value) ? value : []);

/** 资产 uid：本地资产包是 local- 前缀，其余是 32 位 hex。 */
function checkUid(uid) {
  const value = text(uid);
  if (!UID.test(value) && !LOCAL_UID.test(value)) throw new TagWriteRejected('资产 uid 无效');
  return value;
}

/**
 * 校验与规范化请求体 → op 列表。抛 TagWriteRejected 即 400。
 * 纯函数：不碰 DB，可直接单测。
 */
export function normalizeTagOps(input = {}) {
  const raw = input?.ops;
  if (!Array.isArray(raw) || !raw.length) throw new TagWriteRejected('缺少变更列表');
  if (raw.length > MAX_TAG_OPS) throw new TagWriteRejected(`变更数量超限（最多 ${MAX_TAG_OPS} 条）`);
  const ops = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TagWriteRejected('变更项格式无效');
    const op = text(item.op);
    if (op === 'tag.add' || op === 'tag.remove') {
      const uid = checkUid(item.uid);
      const source = text(item.source || 'user');
      if (!ALL_SOURCES.includes(source)) throw new TagWriteRejected('标签来源无效');
      const value = text(item.value).trim();
      if (!value || value.length > MAX_TAG_LENGTH) throw new TagWriteRejected('标签值无效');
      if (!normOf(value)) throw new TagWriteRejected('标签值无效');
      // 平台标签由采集器维护，用户不能删 —— 否则下一次采集会把标签加回来，
      // 用户看到的是「删了又冒出来」，比直接拒绝更让人困惑。
      if (op === 'tag.remove' && !WRITABLE_SOURCES.includes(source)) {
        throw new TagWriteRejected('平台标签不可删除');
      }
      ops.push({op, uid, source, value, by: text(item.by) || null});
      continue;
    }
    if (op === 'asset.set') {
      const uid = checkUid(item.uid);
      const field = text(item.field);
      if (!SETTABLE_FIELDS.includes(field)) throw new TagWriteRejected(`不支持修改的字段：${field}`);
      let value = item.value;
      if (field === 'rating') {
        value = Number(value);
        if (!Number.isFinite(value) || value < 0 || value > 5) throw new TagWriteRejected('评分必须是 0~5 的数字');
        value = Math.round(value);
      } else if (field === 'note') {
        value = text(value);
        if (value.length > 2000) throw new TagWriteRejected('备注过长');
      } else {
        value = value === true || value === 1 || value === '1';
      }
      const rev = item.rev === undefined || item.rev === null ? null : Number(item.rev);
      if (rev !== null && !Number.isFinite(rev)) throw new TagWriteRejected('版本号无效');
      ops.push({op, uid, field, value, rev, by: text(item.by) || null});
      continue;
    }
    throw new TagWriteRejected(`不支持的变更类型：${op}`);
  }
  return ops;
}

/**
 * 把同一套 op 语义作用到 blob 的解析结果上（纯函数）。
 *
 * 与 applyTagOps 用的是同一批 op，所以 blob 与派生表必然一致 ——
 * 这是「同一个词在两个地方意思不一样」这类漂移的根治办法。
 */
export function applyOpsToState(data, ops) {
  const next = {...object(data)};
  const aiTags = {...object(next.aiTags)};
  const userTags = {...object(next.userTags)};
  const userMeta = {...object(next.userMeta)};
  const favorites = new Set(list(next.favorites).filter(uid => typeof uid === 'string'));
  for (const op of ops) {
    if (op.op === 'tag.add') {
      const bucket = op.source === 'ai' ? aiTags : userTags;
      const current = list(bucket[op.uid]).filter(tag => typeof tag === 'string');
      if (!current.includes(op.value)) current.push(op.value);
      bucket[op.uid] = current;
    } else if (op.op === 'tag.remove') {
      const bucket = op.source === 'ai' ? aiTags : userTags;
      const current = list(bucket[op.uid]).filter(tag => typeof tag === 'string');
      const kept = current.filter(tag => tag !== op.value && normOf(tag) !== normOf(op.value));
      if (kept.length) bucket[op.uid] = kept;
      else delete bucket[op.uid];
    } else if (op.op === 'asset.set') {
      if (op.field === 'favorite') {
        if (op.value) favorites.add(op.uid); else favorites.delete(op.uid);
        continue;
      }
      const meta = {...object(userMeta[op.uid])};
      if (op.field === 'rating') meta.rating = op.value;
      else meta.note = op.value;
      userMeta[op.uid] = meta;
    }
  }
  next.aiTags = aiTags;
  next.userTags = userTags;
  next.userMeta = userMeta;
  next.favorites = [...favorites];
  return next;
}

/**
 * DB 定点写。返回 {applied, changes, conflicts}。
 *
 * 依赖注入：resolveTerm 由 library-db.mjs 提供（它知道别名 / canonical / pending 的解析规则，
 * 不能在这里复制一份）；searchTextOf 同理 —— 检索文本的口径必须与派生层逐字一致。
 */
export function createTagWriter({db, resolveTerm, searchTextOf, now = Date.now}) {
  const selAsset = db.prepare('SELECT rowid, name, author, platform, note, rating, favorite, rev FROM assets WHERE uid = ?');
  const bumpAsset = db.prepare('UPDATE assets SET tags_text = ?, rev = rev + 1, updated_at = ? WHERE uid = ?');
  const setRating = db.prepare('UPDATE assets SET rating = ?, rev = rev + 1, updated_at = ? WHERE uid = ?');
  const setNote = db.prepare('UPDATE assets SET note = ?, rev = rev + 1, updated_at = ? WHERE uid = ?');
  const setFav = db.prepare('UPDATE assets SET favorite = ?, rev = rev + 1, updated_at = ? WHERE uid = ?');
  const insAssetTag = db.prepare(`INSERT OR IGNORE INTO asset_tags
    (uid, term_id, source, model_version, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`);
  const delAssetTag = db.prepare('DELETE FROM asset_tags WHERE uid = ? AND term_id = ? AND source = ?');
  const insTag = db.prepare('INSERT OR IGNORE INTO tags (uid, kind, tag) VALUES (?, ?, ?)');
  const delTag = db.prepare('DELETE FROM tags WHERE uid = ? AND kind = ? AND tag = ?');
  const delTagNorm = db.prepare('DELETE FROM tags WHERE uid = ? AND kind = ? AND lower(trim(tag)) = ?');
  const tagsOf = db.prepare('SELECT tag FROM tags WHERE uid = ?');
  const termsOf = db.prepare('SELECT term_id FROM asset_tags WHERE uid = ?');
  const delFts = db.prepare('DELETE FROM assets_fts WHERE rowid = ?');
  const insFts = db.prepare('INSERT INTO assets_fts (rowid, uid, body) VALUES (?, ?, ?)');
  const insAudit = db.prepare('INSERT INTO audit_log (at, actor, action, uid, term_id, detail, rev) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const countTerm = db.prepare('SELECT count(DISTINCT uid) AS n FROM asset_tags WHERE term_id = ?');
  const setCount = db.prepare(`INSERT INTO tag_counts (term_id, asset_count, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(term_id) DO UPDATE SET asset_count = excluded.asset_count, updated_at = excluded.updated_at`);
  const selTerms = db.prepare('SELECT term_id, value FROM tag_terms');
  const selAliases = db.prepare('SELECT term_id, alias_norm FROM tag_aliases');

  /** 词表只有几百条，读进内存即可：逐资产查别名不该变成逐资产查库。 */
  function vocabMaps() {
    const valueOf = new Map(selTerms.all().map(row => [row.term_id, row.value]));
    const aliasOf = new Map();
    for (const row of selAliases.all()) {
      const bucket = aliasOf.get(row.term_id);
      if (bucket) bucket.push(row.alias_norm);
      else aliasOf.set(row.term_id, [row.alias_norm]);
    }
    return {valueOf, aliasOf};
  }

  /** 重算单个资产的检索文本（原始标签 ∪ 标准名 ∪ 别名，按码点序）。 */
  function refreshSearchText(uid, maps) {
    const raw = tagsOf.all(uid).map(row => row.tag);
    const termIds = termsOf.all(uid).map(row => row.term_id);
    return searchTextOf(raw, termIds, maps.valueOf, maps.aliasOf);
  }

  /** FTS 正文与派生层逐字一致（分隔符同样是 ' \u0001 '）。 */
  const ftsBody = (row, text) =>
    [row.name, row.author, row.platform, row.note, text].filter(Boolean).join(' \u0001 ');

  /**
   * 应用一批 op。全程单事务：中途失败不会留下「标签加了但检索文本没更新」的半截状态。
   * 返回的 changes 里的 rev 是写入后的新版本号，客户端据此判断本地是否过期。
   */
  function apply(ops, {actor = 'system'} = {}) {
    if (!Array.isArray(ops) || !ops.length) return {applied: 0, changes: [], conflicts: []};
    const stamp = now();
    const maps = vocabMaps();
    const cache = new Map();
    const touched = new Set();
    const touchedTerms = new Set();
    const conflicts = [];
    /** uid → 该资产这次被改成了什么（tags / asset）。SSE 按它广播。 */
    const kinds = new Map();

    const run = db.transaction(() => {
      for (const op of ops) {
        const row = selAsset.get(op.uid);
        // 资产不存在就整条拒绝：给不存在的 uid 写 asset_tags 会留下孤儿行。
        if (!row) { conflicts.push({uid: op.uid, code: 'asset_not_found'}); continue; }
        if (op.op === 'asset.set') {
          // rev 冲突：客户端读到的版本与服务端不一致 → 拒绝，不覆盖别人的改动。
          // 只有显式带了版本号才做冲突检测。内部调用（备份恢复、批量导入）构造的 op
          // 可能压根没有 rev 字段，undefined !== null 会把它误判成「版本不匹配」。
          if (op.rev !== null && op.rev !== undefined && Number(op.rev) !== Number(row.rev)) {
            conflicts.push({uid: op.uid, code: 'rev_conflict', rev: Number(row.rev), serverValue: row[op.field]});
            continue;
          }
          if (op.field === 'rating') setRating.run(op.value, stamp, op.uid);
          else if (op.field === 'note') setNote.run(op.value, stamp, op.uid);
          else setFav.run(op.value ? 1 : 0, stamp, op.uid);
          touched.add(op.uid);
          kinds.set(op.uid, 'asset');
          insAudit.run(stamp, actor, `asset.set.${op.field}`, op.uid, null,
            JSON.stringify({value: op.value}), Number(row.rev) + 1);
          continue;
        }
        const termId = resolveTerm(op.value, cache, stamp);
        if (!termId) { conflicts.push({uid: op.uid, code: 'term_unresolved'}); continue; }
        if (op.op === 'tag.add') {
          if(actor!=='taxonomy-maintenance'&&db.prepare('SELECT retired FROM tag_terms WHERE term_id=?').get(termId)?.retired){conflicts.push({uid:op.uid,code:'term_retired'});continue;}
          const rejected=db.prepare('SELECT 1 FROM tag_rejections WHERE uid=? AND term_id=? AND source=?').get(op.uid,termId,op.source);
          if(['taxonomy-backfill','taxonomy-maintenance'].includes(actor)&&rejected)continue;
          if(!['taxonomy-backfill','taxonomy-maintenance'].includes(actor))db.prepare('DELETE FROM tag_rejections WHERE uid=? AND term_id=? AND source=?').run(op.uid,termId,op.source);
          insAssetTag.run(op.uid, termId, op.source, null, stamp, op.by || actor);
          insTag.run(op.uid, op.source, op.value);
        } else {
          if(op.source==='ai')db.prepare('INSERT OR REPLACE INTO tag_rejections VALUES (?,?,?,?)').run(op.uid,termId,op.source,stamp);
          delAssetTag.run(op.uid, termId, op.source);
          // 原始标签文本可能与归一化后的词条名不同（用户存的是 "wood"，词表标准名是 "木材"），
          // 两种写法都要删掉，否则界面上标签还在。
          delTag.run(op.uid, op.source, op.value);
          delTagNorm.run(op.uid, op.source, normOf(op.value));
        }
        touchedTerms.add(termId);
        touched.add(op.uid);
        kinds.set(op.uid, 'tags');
        insAudit.run(stamp, actor, op.op, op.uid, termId, JSON.stringify({value: op.value, source: op.source}), null);
      }

      // 派生表同步：只重算受影响的资产。
      for (const uid of touched) {
        if(kinds.get(uid)==='tags'){
          const ownChannel=actor==='taxonomy-backfill'?ops.find(op=>op.uid===uid)?.by:null;
          db.prepare('DELETE FROM asset_label_progress WHERE uid=? AND channel<>?').run(uid,ownChannel||'');
        }
        const row = selAsset.get(uid);
        if (!row) continue;
        const text = refreshSearchText(uid, maps);
        bumpAsset.run(text, stamp, uid);
        // FTS 正文跟着更新。rowid 与 assets.rowid 对齐（派生层按同一顺序插入两者）。
        delFts.run(row.rowid);
        insFts.run(row.rowid, uid, ftsBody(row, text));
      }

      // 计数物化：只重算受影响的词条（覆盖索引 (term_id, uid) 让它只扫该词的命中行）。
      for (const termId of touchedTerms) {
        setCount.run(termId, countTerm.get(termId).n, stamp);
      }
    });
    run();

    const changes = [...touched].map(uid => {
      const row = selAsset.get(uid);
      return {kind: kinds.get(uid) || 'tags', uid, rev: row ? Number(row.rev) : null};
    });
    return {applied: changes.length, changes, conflicts};
  }

  function refresh(uids){
    const maps=vocabMaps(),stamp=now();
    const run=db.transaction(()=>{
      for(const uid of new Set(uids)){
        const row=selAsset.get(uid);if(!row)continue;
        const text=refreshSearchText(uid,maps);bumpAsset.run(text,stamp,uid);
        delFts.run(row.rowid);insFts.run(row.rowid,uid,ftsBody(row,text));
        for(const item of termsOf.all(uid))setCount.run(item.term_id,Number(countTerm.get(item.term_id)?.n)||0,stamp);
      }
    });run();
  }
  return {apply,refresh};
}
