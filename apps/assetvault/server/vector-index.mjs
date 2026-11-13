// 语义索引（ADR-15）：把资产的可读文本向量化，支持「按意思搜」与「找相似」。
//
// 三条设计约束，决定了这里的每一个取舍：
//   1. **不引入本地模型**。向量走用户已经配好的 OpenAI 兼容 /embeddings；
//      没有向量模型时整块功能安静地不出现，而不是起一个几百 MB 的推理进程。
//   2. **向量是可再生派生数据**。它住在独立表 asset_vectors 里，`reindex` 随时能重算；
//      内容没变的资产靠文本 hash 跳过，所以第二次构建通常几秒结束。
//   3. **不做向量数据库**。本机资产量（万级）用一次全表扫描 + 余弦足够快，
//      换成 ANN 索引要先有个索引服务，收益不成比例。50 万级再谈分片（记在 ADR 里）。
//
// 不参与向量化的：logs / verification / 缩略图地址 —— 它们是任务元数据，
// 混进文本只会让「相似」变成「下载过同一个站点的都相似」。
import {createHash} from 'node:crypto';

const MAX_TEXT = 2000;
const DEFAULT_LIMIT = 40;
const SCAN_PAGE = 64;

// 同一口径用于状态与构建：用户列（包括空备注）始终覆盖采集时的 payload。
function textOfRow(row, tags) {
  try {
    const model = JSON.parse(row.payload);
    if (!model || typeof model !== 'object' || Array.isArray(model)) return '';
    return vectorTextOf({...model, note: row.note}, tags);
  } catch { return ''; }
}

function readPage(db, model, after, size) {
  const rows = db.all(`SELECT a.uid, a.payload, a.note, v.hash, v.dim
    FROM assets a LEFT JOIN asset_vectors v ON v.uid = a.uid AND v.model = ?
    WHERE a.state = 'active' AND a.uid > ? ORDER BY a.uid LIMIT ?`, [model, after, size]);
  const tags = new Map();
  if (rows.length) {
    const marks = rows.map(() => '?').join(', ');
    for (const row of db.all(`SELECT uid, tag FROM tags WHERE uid IN (${marks}) ORDER BY uid, tag`, rows.map(row => row.uid))) {
      const list = tags.get(row.uid) || [];
      list.push(row.tag);
      tags.set(row.uid, list);
    }
  }
  return rows.map(row => {
    const text = textOfRow(row, [...new Set(tags.get(row.uid) || [])]);
    return {...row, text, textHash: hashTextOf(text)};
  });
}

const listOf = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : []);

/** 参与 embedding 的文本：人写在卡片上能看到的那些字，不掺任务日志。 */
export function vectorTextOf(model = {}, tags = []) {
  const lines = [];
  const push = (label, value) => {
    const text = String(value ?? '').trim();
    if (text) lines.push(`${label}：${text.slice(0, 300)}`);
  };
  push('名称', model.name);
  push('作者', model.author || model.username);
  push('平台', model.platform);
  push('类型', model.assetType || model.kind || model.formatLabel || model.format);
  push('分类', listOf(model.categories).concat(model.category ? [model.category] : []).join('、'));
  push('标签', tags.join('、'));
  push('备注', model.note);
  push('描述', model.description || model.summary || model.excerpt);
  return lines.join('\n').slice(0, MAX_TEXT);
}

export const hashTextOf = text => createHash('sha1').update(String(text || '')).digest('hex');

const toBuffer = vec => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
/** 用 readFloatLE 而不是对齐拷贝：Buffer 来自 SQLite，byteOffset 不保证 4 字节对齐。 */
function toVector(buffer) {
  const out = new Float32Array(buffer.length >> 2);
  for (let i = 0; i < out.length; i += 1) out[i] = buffer.readFloatLE(i * 4);
  return out;
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createVectorIndex({storage, ai, onWarn = () => {}} = {}) {
  /** 当前可用的向量模型：空字符串表示用户还没配，界面据此把入口藏起来。 */
  async function activeModel() {
    try {
      const settings = await ai.settings();
      return settings?.enabled && settings.embedModel ? settings.embedModel : '';
    } catch { return ''; }
  }

  async function status() {
    const model = await activeModel();
    const counts = await storage.withDb(db => {
      const result = {assets: 0, vectors: 0, pending: 0, dim: 0};
      let after = '';
      while (true) {
        const rows = readPage(db, model, after, SCAN_PAGE);
        if (!rows.length) break;
        for (const row of rows) {
          result.assets += 1;
          if (model && row.hash) {
            result.vectors += 1;
            result.dim ||= Number(row.dim) || 0;
          }
          if (row.text.length >= 2 && (!model || row.hash !== row.textHash)) result.pending += 1;
        }
        after = rows.at(-1).uid;
      }
      return result;
    });
    if (!counts) return {ready: false, reason: '资产库内核不可用', model, assets: 0, vectors: 0, pending: 0, dim: 0};
    return {
      ready: !!model,
      reason: model ? '' : '还没有填写向量模型',
      model,
      assets: counts.assets,
      vectors: counts.vectors,
      pending: counts.pending,
      dim: counts.dim,
    };
  }

  /**
   * 增量构建。按批走「读 → 网络 → 写」，不能整库一次读进来：
   * 5 万条 payload 解析就会吃掉几百 MB，而且会让 UI 卡在第一次请求上。
   * maxBatches 让前端可以「点一次跑几批」，避免一个 HTTP 请求挂几分钟。
   */
  async function build({batch = 16, maxBatches = 20} = {}) {
    const model = await activeModel();
    if (!model) throw Error('还没有填写向量模型，请先在 AI 接入里配置');
    const size = Math.floor(Math.min(64, Math.max(1, Number(batch) || 16)));
    const limitBatches = Math.floor(Math.max(1, Math.min(500, Number(maxBatches) || 20)));

    let scanned = 0, skipped = 0, broken = 0, embedded = 0, failed = 0, remaining = 0;
    let after = '', rounds = 0, lastError = '';
    let chunk = [];
    const flush = async () => {
      const pending = chunk;
      chunk = [];
      rounds += 1;
      let vectors;
      try {
        vectors = await ai.embed(pending.map(item => item.text));
        if (!Array.isArray(vectors) || vectors.length !== pending.length ||
            vectors.some(vec => !(vec instanceof Float32Array) || !vec.length || !vec.every(Number.isFinite))) {
          throw Error('向量模型返回了无效向量');
        }
      } catch (error) {
        // 模型错误后不再发送，但继续有界扫描以准确报告剩余工作。
        lastError = error.message;
        failed += pending.length;
        return;
      }
      const written = await storage.withDb(db => {
        let count = 0;
        for (let i = 0; i < pending.length; i += 1) {
          // 网络等待期间可能发生编辑／删除。只提交仍与本次文本一致的结果。
          const item = pending[i];
          const row = db.all("SELECT uid, payload, note FROM assets WHERE uid = ? AND state = 'active'", [item.uid])[0];
          if (!row) continue;
          const tags = db.all('SELECT tag FROM tags WHERE uid = ? ORDER BY tag', [item.uid]).map(tag => tag.tag);
          if (hashTextOf(textOfRow(row, [...new Set(tags)])) !== item.textHash) { remaining += 1; continue; }
          const vec = vectors[i];
          db.run('INSERT OR REPLACE INTO asset_vectors (uid, model, dim, hash, vec, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            [item.uid, model, vec.length, item.textHash, toBuffer(vec), Date.now()]);
          count += 1;
        }
        return count;
      });
      if (written === null) throw Error('资产库内核不可用，语义索引需要 SQLite 引擎');
      embedded += written;
      await new Promise(resolve => setImmediate(resolve));
    };
    while (true) {
      const rows = await storage.withDb(db => readPage(db, model, after, SCAN_PAGE));
      if (!rows) throw Error('资产库内核不可用，语义索引需要 SQLite 引擎');
      if (!rows.length) break;
      for (const row of rows) {
        scanned += 1;
        if (row.text.length < 2) { broken += 1; continue; }
        if (row.hash === row.textHash) { skipped += 1; continue; }
        if (lastError || rounds >= limitBatches) { remaining += 1; continue; }
        chunk.push({uid: row.uid, text: row.text, textHash: row.textHash});
        if (chunk.length === size) await flush();
      }
      after = rows.at(-1).uid;
    }
    if (chunk.length) await flush();
    if (lastError) onWarn(`语义索引构建中断：${lastError}`);
    return {model, scanned, embedded, skipped, failed, broken, remaining, error: lastError};
  }

  /** 旧向量保留供重建覆盖，但仅当前文本 hash 匹配的 active 向量可参与检索。 */
  async function loadVectors(model) {
    const vectors = await storage.withDb(db => {
      const result = [];
      let after = '';
      while (true) {
        const page = readPage(db, model, after, SCAN_PAGE);
        if (!page.length) break;
        const valid = page.filter(row => row.text.length >= 2 && row.hash === row.textHash);
        if (valid.length) {
          const marks = valid.map(() => '?').join(', ');
          for (const row of db.all(`SELECT uid, vec FROM asset_vectors WHERE model = ? AND uid IN (${marks})`, [model, ...valid.map(row => row.uid)])) {
            result.push({uid: row.uid, vec: toVector(row.vec)});
          }
        }
        after = page.at(-1).uid;
      }
      return result;
    });
    return vectors || [];
  }

  function topMatches(vectors, query, limit, exclude = '') {
    const hits = [];
    for (const item of vectors) {
      if (exclude && item.uid === exclude) continue;
      hits.push({uid: item.uid, score: cosine(query, item.vec)});
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /**
   * 命中的完整卡片数据。为什么由服务端回：语义命中可能落在首屏之外 ——
   * 前端 state.models 只有已加载的页，只给 uid 就会「搜到了但画不出卡片」。
   * 剥 logs / verification 与 library-db 的 slimCatalogModel 同义（那边是闭包内的私有函数）。
   */
  async function modelsOf(uids) {
    const list = (uids || []).slice(0, 200);
    if (!list.length) return [];
    const marks = list.map(() => '?').join(', ');
    const rows = await storage.withDb(db => db.all(
      `SELECT uid, payload, note FROM assets WHERE uid IN (${marks}) AND state = 'active'`, list));
    const byUid = new Map();
    for (const row of rows || []) {
      try {
        const model = JSON.parse(row.payload);
        if (!model || typeof model !== 'object') continue;
        model.note = row.note;
        delete model.logs;
        delete model.verification;
        byUid.set(row.uid, model);
      } catch { /* 坏 payload 只影响这一条 */ }
    }
    return list.map(uid => byUid.get(uid)).filter(Boolean);
  }

  async function search(query, {limit = DEFAULT_LIMIT} = {}) {
    const text = String(query || '').trim();
    if (!text) return {uids: [], scores: [], items: [], model: '', total: 0};
    const model = await activeModel();
    if (!model) throw Error('还没有填写向量模型，请先在 AI 接入里配置');
    const [queryVec] = await ai.embed([text]);
    if (!queryVec?.length) throw Error('查询没有生成有效向量');
    const vectors = await loadVectors(model);
    if (!vectors.length) return {uids: [], scores: [], items: [], model, total: 0, reason: '语义索引还是空的'};
    const hits = topMatches(vectors, queryVec, Math.min(200, Math.max(1, Number(limit) || DEFAULT_LIMIT)));
    // 低于 0.15 的基本是「毫不相干」：一并返回会让用户以为整库都像。
    const useful = hits.filter(hit => hit.score >= 0.15);
    const uids = useful.map(hit => hit.uid);
    return {
      uids,
      scores: useful.map(hit => Number(hit.score.toFixed(4))),
      items: await modelsOf(uids),
      model,
      total: vectors.length,
    };
  }

  async function similar(uid, {limit = DEFAULT_LIMIT} = {}) {
    const target = String(uid || '').trim();
    if (!target) throw Error('缺少资产 uid');
    const model = await activeModel();
    if (!model) throw Error('还没有填写向量模型，请先在 AI 接入里配置');
    const vectors = await loadVectors(model);
    const self = vectors.find(item => item.uid === target);
    if (!self) throw Error('这个资产还没有语义向量，请先构建语义索引');
    const hits = topMatches(vectors, self.vec, Math.min(200, Math.max(1, Number(limit) || DEFAULT_LIMIT)), target);
    const uids = hits.map(hit => hit.uid);
    return {
      uids,
      scores: hits.map(hit => Number(hit.score.toFixed(4))),
      items: await modelsOf(uids),
      model,
      total: vectors.length,
    };
  }

  return {status, build, search, similar, activeModel};
}
