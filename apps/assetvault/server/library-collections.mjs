// 合集 / 智能合集服务：只依赖注入的 conn.all(sql, params) / conn.run(sql, params)。
//
// 表是阶段 1 预建的（collections / collection_assets / smart_collections），这里不新建 schema。
// 两条纪律：
//   1) collection_assets 存 uid 而不是 assets 表外键 —— assets 是每次 save 都会整批重建的派生表，
//      挂外键会在重建时被清空；用稳定 uid 才能让合集跨重建存活。
//   2) 智能合集不落「结果快照」，只存规则（q + filters + sort），内容每次查询时重算，
//      资产新增/改标签后自动跟着变，没有需要手动刷新的一致性状态。
import {randomUUID} from 'node:crypto';
import {SORTS, normalizeFilters} from './library-query.mjs';
import {parseSearchExpression} from './search-expression.mjs';

// Adapted from Serpent shared/smart-collection-query.ts (MIT): sort is not a condition.
export function assertSmartConditions(rule = {}) {
  const search = parseSearchExpression(text(rule.q).slice(0, 500));
  const f = normalizeFilters(rule.filters);
  const meaningful = search.clauses.length || search.groups?.some(group => group.length)
    || f.state !== 'active' || f.rating[0] > 0 || f.rating[1] < 5 || f.favoriteMode !== 'any'
    || f.downloadable || f.formats.active
    || ['tags', 'excludeTags', 'platforms', 'kinds', 'categories', 'uids', 'colors', 'ratings', 'ranges'].some(key => f[key].length);
  if (!meaningful) throw Object.assign(Error('智能画板至少需要一个有效筛选条件'), {status: 400});
}
const OPTIONS = '__assetvaultSmartOptions';
function readSmart(row) {
  const filters = parseFilters(row.smart_filters);
  const options = filters[OPTIONS];
  delete filters[OPTIONS];
  return {q: row.smart_query || '', filters, sort: row.smart_sort || 'recent',
    sortOrder: options?.sortOrder === 'desc' ? 'desc' : 'asc', seed: text(options?.seed)};
}

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const number = value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
const strings = value => (Array.isArray(value) ? value : []).map(text).map(item => item.trim()).filter(Boolean).slice(0, 5000);
const newId = () => `c-${randomUUID().replace(/-/g, '').slice(0, 16)}`;

function cleanName(value) {
  const name = text(value).trim().slice(0, 80);
  if (!name) throw Error('合集名称不能为空');
  return name;
}

function cleanJson(value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  try { return JSON.stringify(data); } catch { return '{}'; }
}

/** 合集树：每张表都带 assetCount，智能合集额外带规则，前端一次请求就能画完整侧栏。 */
export function listCollections(conn) {
  const rows = conn.all(`SELECT c.*,
      (SELECT count(*) FROM collection_assets ca WHERE ca.collection_id = c.collection_id) AS asset_count,
      s.query AS smart_query, s.filters AS smart_filters, s.sort AS smart_sort
    FROM collections c LEFT JOIN smart_collections s ON s.collection_id = c.collection_id
    ORDER BY c.position, c.created_at`, []);
  return rows.map(row => ({
    id: row.collection_id, parentId: row.parent_id || null, name: row.name,
    description: row.description || '', coverAssetId: row.cover_asset_id || null,
    icon: row.icon || null, color: row.color || null, position: number(row.position),
    createdAt: number(row.created_at), updatedAt: number(row.updated_at),
    assetCount: number(row.asset_count),
    smart: row.smart_query !== undefined && row.smart_query !== null ? {
      ...readSmart(row),
    } : null,
  }));
}

function parseFilters(value) {
  try { const data = JSON.parse(value || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; }
  catch { return {}; }
}

export function collectionUids(conn, id) {
  if (!text(id)) return new Set();
  return new Set(conn.all('SELECT asset_id FROM collection_assets WHERE collection_id = ?', [id]).map(row => row.asset_id));
}

/** 阶段 3：合集手动顺序 uid → position，供 sort:'collection' 使用。 */
export function collectionPositions(conn, id) {
  if (!text(id)) return new Map();
  return new Map(conn.all('SELECT asset_id, position FROM collection_assets WHERE collection_id = ? ORDER BY position', [id])
    .map(row => [row.asset_id, number(row.position)]));
}

function exists(conn, id) {
  return conn.all('SELECT 1 AS ok FROM collections WHERE collection_id = ?', [id]).length > 0;
}

/** 新建或更新：传 id 且存在即更新，否则创建。父子关系只做最必要的校验，不引入递归查询。 */
export function saveCollection(conn, input = {}, now = Date.now()) {
  const id = text(input.id) || newId();
  const name = cleanName(input.name);
  const parent = text(input.parentId) || null;
  if (parent === id) throw Error('合集不能把自己设为上级');
  if (parent && !exists(conn, parent)) throw Error('上级合集不存在');
  const ts = number(now) || Date.now();
  const fields = [id, parent, name, text(input.description).slice(0, 500),
    text(input.coverAssetId) || null, text(input.icon) || null, text(input.color) || null,
    number(input.position), ts];
  if (exists(conn, id)) {
    conn.run(`UPDATE collections SET parent_id = ?, name = ?, description = ?, cover_asset_id = ?, icon = ?, color = ?, position = ?, updated_at = ?
      WHERE collection_id = ?`, [...fields.slice(1), id]);
  } else {
    conn.run(`INSERT INTO collections
      (collection_id, parent_id, name, description, cover_asset_id, icon, color, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...fields.slice(0, 8), ts, ts]);
  }
  if (input.smart) saveSmartRule(conn, id, input.smart, ts);
  return id;
}

/** 保存规则时同时保证 collections 里有一行（名称可在同一请求里给）。 */
export function saveSmartRule(conn, id, rule = {}, now = Date.now()) {
  const ts = number(now) || Date.now();
  const q = text(rule.q).slice(0, 500);
  const sortOrder = rule.sortOrder === 'desc' ? 'desc' : 'asc';
  const seed = text(rule.seed).slice(0, 500);
  const filters = cleanJson({...parseFilters(cleanJson(rule.filters)), [OPTIONS]: {sortOrder, seed}});
  const sort = SORTS.includes(rule.sort) ? rule.sort : 'recent';
  conn.run(`INSERT INTO smart_collections (collection_id, query, filters, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(collection_id) DO UPDATE SET
    query = excluded.query, filters = excluded.filters, sort = excluded.sort, updated_at = excluded.updated_at`,
  [id, q, filters, sort, ts, ts]);
  return readSmart({smart_query: q, smart_filters: filters, smart_sort: sort});
}

/** 删除合集：子合集提升为顶层而不是跟着消失，避免一次误删带走整棵树的数据。 */
export function deleteCollection(conn, id) {
  const key = text(id);
  if (!key) throw Error('缺少合集 id');
  if (!exists(conn, key)) return false;
  conn.run('UPDATE collections SET parent_id = NULL WHERE parent_id = ?', [key]);
  conn.run('DELETE FROM collection_assets WHERE collection_id = ?', [key]);
  conn.run('DELETE FROM smart_collections WHERE collection_id = ?', [key]);
  conn.run('DELETE FROM collections WHERE collection_id = ?', [key]);
  return true;
}

/** action: add / remove / set / reorder。uids 不校验是否存在于 assets —— 允许先把还没入库的 uid 记进合集。 */
export function setCollectionItems(conn, id, uids = [], action = 'add', now = Date.now()) {
  if (!exists(conn, id)) throw Error('合集不存在');
  const items = strings(uids);
  const insert = (uid, position) => conn.run(`INSERT INTO collection_assets (collection_id, asset_id, position)
    VALUES (?, ?, ?) ON CONFLICT(collection_id, asset_id) DO UPDATE SET position = excluded.position`, [id, uid, position]);
  if (action === 'set') {
    conn.run('DELETE FROM collection_assets WHERE collection_id = ?', [id]);
    items.forEach((uid, index) => insert(uid, index));
  } else if (action === 'reorder') {
    // 手动排序：传入的顺序优先，没列出的成员按**原有 position** 跟在后面。
    // 不能用 collectionUids（无 ORDER BY 的集合顺序不稳定），否则重排结果会随机抖动。
    const rest = [...collectionPositions(conn, id).keys()].filter(uid => !items.includes(uid));
    [...items, ...rest].forEach((uid, index) => insert(uid, index));
  } else if (action === 'remove') {
    for (const uid of items) conn.run('DELETE FROM collection_assets WHERE collection_id = ? AND asset_id = ?', [id, uid]);
  } else if (action === 'add') {
    const existing = collectionUids(conn, id);
    let position = number(conn.all('SELECT count(*) AS n FROM collection_assets WHERE collection_id = ?', [id])[0]?.n);
    for (const uid of items) if (!existing.has(uid)) insert(uid, position++);
  } else {
    throw Error('不支持的合集操作');
  }
  conn.run('UPDATE collections SET updated_at = ? WHERE collection_id = ?', [number(now) || Date.now(), id]);
  return {count: collectionUids(conn, id).size};
}
