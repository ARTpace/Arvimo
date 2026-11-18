// 整库导出 / 导入（ADR-10）：一份自包含的 JSON 快照，用于换机、合并工作室库、事故后重建。
//
// 为什么不做成「复制 data 目录」：目录里混着数据库、分域状态、临时文件与端口记录，
// 换一台机器就带不走（绝对路径、node ABI、端口号全会打架）。JSON 快照只装**语义**，
// 换机后由服务端按当前库的规则重新派生索引，跨版本也稳。
//
// 分工：
//   - 导出 = DB 权威（assets 表 + 用户域 + 合集）→ 一份自包含 JSON；
//   - 导入 = 走 asset:add / asset:trash / asset:remove 定点 op，
//     派生索引、审计、rev、回收站语义全部沿用 5.1-5.4 的既有路径，绝不直接 INSERT。
//
// 语义边界（故意保守，宁可少迁也不越权改本地标注）：
//   - 合并模式下**已存在的 uid 不覆盖**本地评分 / 备注 / 收藏 / 我的标签 ——
//     DB 里这些字段的权威是本地，导入旧快照不该把它们改回去；
//   - AI 标签不迁移（可由 AI 重新生成）；导出里保留完整 user 域只是让快照完整可读；
//   - replace 模式先清空目录，必须显式 confirm，且调用方负责先做一次备份。
import {listCollections, collectionUids, saveCollection, setCollectionItems} from './library-collections.mjs';
import {MAIN_STATE_KEY, USER_STATE_KEY, PROBE_STATE_KEY, stateStampKey} from './library-schema.mjs';
import {parseMainState} from './library-blob.mjs';
import {MAX_MODEL_BYTES} from './library-asset-ops.mjs';

export const PORTABLE_FORMAT = 'assetvault-library';
export const PORTABLE_VERSION = 1;

/** 单次资产 op 上限（与 asset-ops 契约一致）。 */
const BATCH = 200;
/** 一份快照最多带多少条资产：防止误传一个几十万条的巨型文件把内存打满。 */
const MAX_ITEMS = 200000;
const UID = /^[a-f0-9]{32}$/;

export class PortableRejected extends Error {
  constructor(message, code = 'portable_invalid') {
    super(message);
    this.name = 'PortableRejected';
    this.code = code;
  }
}

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

/** 把用户域作为「种子」合进 model：只有首次入库时才会被 DB 采纳，已存在的行保留本机值。 */
function seedUserDomain(model, user, favorites) {
  const out = {...model};
  const meta = user?.userMeta?.[model.uid];
  if (isObject(meta)) {
    const rating = Number(meta.rating);
    if (rating > 0) out.rating = Math.min(5, Math.round(rating));
    if (typeof meta.note === 'string' && meta.note.trim()) out.note = meta.note.slice(0, 2000);
  }
  if (favorites.has(model.uid)) out.favorite = 1;
  const tags = user?.userTags?.[model.uid];
  if (Array.isArray(tags) && tags.length) out.userTags = tags.filter(tag => typeof tag === 'string' && tag.trim()).slice(0, 24);
  return out;
}

/**
 * 导出整库。
 *
 * 只读一次 DB 连接：readCatalog() 会整表读进内存，导出本来就是全量操作，这里不必按页。
 */
export async function exportLibrary({storage, now = Date.now} = {}) {
  if (!storage) throw new PortableRejected('缺少资产库存储实例');
  const data = await storage.withDb(conn => {
    const catalog = conn.readCatalog();
    const user = conn.readUserDomain();
    const collections = listCollections(conn).map(item => ({...item, uids: [...collectionUids(conn, item.id)]}));
    return {catalog, user, collections};
  });
  if (!data) throw new PortableRejected('数据库不可用，暂时无法导出整库', 'db_unavailable');

  const favorites = new Set(Array.isArray(data.user?.favorites) ? data.user.favorites : []);
  const active = (data.catalog?.models || []).map(model => seedUserDomain(model, data.user, favorites));
  const trashed = (data.catalog?.trashed || []).map(model => seedUserDomain(model, data.user, favorites));

  return {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    exportedAt: typeof now === 'function' ? now() : Number(now),
    counts: {assets: active.length, trashed: trashed.length, collections: data.collections.length},
    assets: active,
    trashed,
    // 合集里去掉运行时算出来的 assetCount，快照只存事实，不存派生结果。
    collections: data.collections.map(({assetCount, ...rest}) => rest),
    // 完整用户域：迁移后可用于人工核对，导入端只取 assets 里的种子字段。
    user: data.user || {},
  };
}

/** 校验并规整一份快照。任何形状不对都整份拒绝 —— 半份导入比不导入更危险。 */
export function normalizeSnapshot(payload) {
  if (!isObject(payload)) throw new PortableRejected('快照格式无效：根节点必须是对象');
  if (payload.format !== PORTABLE_FORMAT) {
    throw new PortableRejected(`不是艺团资产库快照（format=${payload.format ?? '缺失'}）`, 'format_mismatch');
  }
  const version = Number(payload.version);
  if (!Number.isFinite(version) || version < 1 || version > PORTABLE_VERSION) {
    throw new PortableRejected(`快照版本不支持（${payload.version}），当前最高支持 v${PORTABLE_VERSION}`, 'version_unsupported');
  }
  if (!Array.isArray(payload.assets)
    || (payload.trashed !== undefined && !Array.isArray(payload.trashed))
    || (payload.collections !== undefined && !Array.isArray(payload.collections))) {
    throw new PortableRejected('快照资产、回收站和合集必须是数组');
  }
  const active = payload.assets;
  const trashed = Array.isArray(payload.trashed) ? payload.trashed : [];
  if (active.length + trashed.length > MAX_ITEMS) {
    throw new PortableRejected(`快照包含 ${active.length + trashed.length} 条资产，超过单次导入上限 ${MAX_ITEMS}`, 'too_many');
  }

  const clean = (model, where) => {
    if (!isObject(model)) throw new PortableRejected(`${where} 不是有效资产对象`);
    const uid = typeof model.uid === 'string' ? model.uid.trim().toLowerCase() : '';
    if (!UID.test(uid)) throw new PortableRejected(`${where} 的 uid 不合法：${String(model.uid).slice(0, 40)}`);
    // 前端分页标记属于运行时状态，绝不能进库。
    const {_remoteOnly, ...rest} = model;
    const out = {...rest, uid};
    if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_MODEL_BYTES) throw new PortableRejected(`${where} 超过 ${MAX_MODEL_BYTES} 字节`);
    return out;
  };

  const assets = active.map((model, index) => clean(model, `assets[${index}]`));
  const trash = trashed.map((model, index) => clean(model, `trashed[${index}]`));
  if (new Set([...assets, ...trash].map(item => item.uid)).size !== assets.length + trash.length) {
    throw new PortableRejected('快照包含重复 uid');
  }
  const rawCollections = payload.collections || [];
  if (rawCollections.length > 5000 || rawCollections.some(item => !isObject(item)
    || typeof item.id !== 'string' || !item.id.trim()
    || typeof item.name !== 'string' || !item.name.trim()
    || (item.uids !== undefined && (!Array.isArray(item.uids) || item.uids.some(uid => typeof uid !== 'string' || !UID.test(uid)))))) {
    throw new PortableRejected('快照合集格式无效');
  }
  if (new Set(rawCollections.map(item => item.id)).size !== rawCollections.length) {
    throw new PortableRejected('快照包含重复合集 id');
  }
  const collections = rawCollections
    .map((item, index) => ({
      id: typeof item.id === 'string' ? item.id : '',
      name: typeof item.name === 'string' ? item.name.slice(0, 200) : `导入合集 ${index + 1}`,
      parentId: typeof item.parentId === 'string' ? item.parentId : null,
      description: typeof item.description === 'string' ? item.description.slice(0, 500) : '',
      icon: typeof item.icon === 'string' ? item.icon : null,
      color: typeof item.color === 'string' ? item.color : null,
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : 0,
      smart: isObject(item.smart) ? item.smart : null,
      uids: (Array.isArray(item.uids) ? item.uids : []).filter(uid => typeof uid === 'string' && UID.test(uid)).slice(0, MAX_ITEMS),
    }));

  return {assets, trash, collections, exportedAt: Number(payload.exportedAt) || null};
}

/**
 * 导入一份快照。
 *
 * 顺序：清空（仅 replace）→ 全部资产 add（回收站里的也先 add）→ 对回收站 uid 发 trash → 合集。
 * 回收站必须走两步：asset:trash 要求资产已存在，直接 add 成 trashed 会绕过 5.4 的状态机。
 */
export async function importLibrary({storage, payload, mode = 'merge', actor = 'import', now = Date.now} = {}) {
  if (!storage) throw new PortableRejected('缺少资产库存储实例');
  if (mode !== 'merge' && mode !== 'replace') throw new PortableRejected(`未知导入模式：${mode}`);

  const snapshot = normalizeSnapshot(payload);
  const report = {
    mode,
    received: {assets: snapshot.assets.length, trashed: snapshot.trash.length, collections: snapshot.collections.length},
    removed: 0, added: 0, trashed: 0, collections: 0, conflicts: 0, seeded: 0,
    // 语义边界说清楚：新资产吃种子，已存在的资产一律保留本机标注，别让用户以为导入会覆盖自己整理过的库。
    notes: ['评分 / 备注 / 收藏 / 我的标签只在新资产首次入库时作为种子，已存在的资产保留本机标注'],
  };

  const stamp = Number(typeof now === 'function' ? now() : now) || Date.now();
  return storage.withDbWrite(conn => {
    const previousStamp = Math.max(0, ...conn.all('SELECT updated_at FROM state_meta').map(row => Number(row.updated_at) || 0));
    // replace 替换资产元数据域，不是磁盘清理。保留主机配置、成员、词表定义、审计和原件。
    if (mode === 'replace') {
      report.removed = Number(conn.all('SELECT count(*) AS n FROM assets')[0].n);
      for (const table of ['collection_assets', 'smart_collections', 'collections',
        'asset_vectors', 'asset_tags', 'tags', 'asset_formats', 'assets_fts', 'tag_counts', 'content_tags', 'file_locations', 'tag_rejections', 'asset_label_progress', 'label_backfill', 'assets']) {
        conn.run(`DELETE FROM ${table}`);
      }
      // 定点 op 会读取 state_meta 的种子：同 UID 的旧标注和探测缓存也必须先清理。
      for (const key of [MAIN_STATE_KEY, USER_STATE_KEY, PROBE_STATE_KEY]) {
        const base = key === MAIN_STATE_KEY
          ? parseMainState(conn.all('SELECT value FROM state_meta WHERE key = ?', [key])[0]?.value) : {};
        const clean = key === MAIN_STATE_KEY
          ? {...base, models: [], trashed: [], userMeta: {}, userTags: {}, aiTags: {}, favorites: [], assetProbe: {}}
          : key === USER_STATE_KEY ? {userMeta: {}, userTags: {}, aiTags: {}, favorites: []} : {assetProbe: {}};
        conn.writeValues({[key]: JSON.stringify(clean)}, {derived: false, stamp});
      }
      report.notes.push('替换 active / trashed、资产标注及派生索引、合集成员与智能规则；保留主机配置、成员、词表定义、审计和磁盘原件');
    }

    const all = [...snapshot.assets, ...snapshot.trash];
    for (let index = 0; index < all.length; index += BATCH) {
      const ops = all.slice(index, index + BATCH).map(model => ({op: 'asset:add', uid: model.uid, model}));
      const result = conn.applyAssetOps(ops, {actor});
      report.added += Number(result?.applied) || 0;
      report.conflicts += Array.isArray(result?.conflicts) ? result.conflicts.length : 0;
    }
    for (let index = 0; index < snapshot.trash.length; index += BATCH) {
      const ops = snapshot.trash.slice(index, index + BATCH).map(model => ({op: 'asset:trash', uid: model.uid}));
      report.trashed += Number(conn.applyAssetOps(ops, {actor})?.applied) || 0;
    }
    const seeds = all
      .map(model => ({uid: model.uid, rating: model.rating, note: model.note, favorite: model.favorite}))
      .filter(item => item.rating || item.note || item.favorite);
    if (seeds.length) report.seeded = Number(conn.applyUserSeeds(seeds, {now: stamp})) || 0;

    // 父子可逆序：先建全部节点，再关联父节点和成员。
    const ids = new Set(snapshot.collections.map(item => item.id).filter(Boolean));
    for (const item of snapshot.collections) saveCollection(conn, {...item, parentId: null}, stamp);
    for (const item of snapshot.collections) {
      if (item.parentId && ids.has(item.parentId)) saveCollection(conn, item, stamp);
      if (!item.id || !item.uids.length) continue;
      setCollectionItems(conn, item.id, item.uids, 'add', stamp);
      report.collections += 1;
    }

    // 同事务更新 DB 权威读视图，空库也不能回退到文件里的旧目录/用户域。
    const catalog = conn.readCatalog();
    const user = conn.readUserDomain();
    const base = parseMainState(conn.all('SELECT value FROM state_meta WHERE key = ?', [MAIN_STATE_KEY])[0]?.value);
    const values = {
      [MAIN_STATE_KEY]: JSON.stringify({...base, ...user, models: catalog.models, trashed: catalog.trashed}),
      [USER_STATE_KEY]: JSON.stringify(user),
    };
    if (mode === 'replace') values[PROBE_STATE_KEY] = JSON.stringify({assetProbe: {}});
    // 版本戳采用墙钟而非快照/注入时钟，压过旧文件；后续 save 以 authoritative 为基底。
    const viewStamp = Math.max(Date.now(), previousStamp, ...Object.keys(values).map(key => Number(conn.getMeta(stateStampKey(key))) || 0)) + 1;
    conn.writeValues(values, {derived: false, stamp: viewStamp});
    report.at = stamp;
    return report;
  });
}
