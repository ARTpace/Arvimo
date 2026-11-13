// /api/library/* 细粒度接口（阶段 2 建、阶段 3 扩展按需分页）。
// 只处理 ROUTES 列出的路径，其余（scan / register）交回 library.mjs。
//
// 双引擎：DB 可用时读规范化表；不可用（原生依赖缺失 / ABI 不匹配，桌面版现已随包装配）时
// 直接从 library-state.json 的 blob 派生同样的行，检索功能不打折，engine 字段如实标明。
// 只有「合集」是纯持久化数据、没有 DB 就无处可存 —— 那几条路由明确返回 503，不假装成功。
import {StringDecoder} from 'node:string_decoder';
import {normalizeRows, rowsFromState, queryAssets, DEFAULT_QUERY, SORTS} from './library-query.mjs';
import {queryAssetPage, simpleFtsTerm, FTS_CANDIDATE_LIMIT} from './library-page.mjs';
import {compileQuery} from './query-sql.mjs';
import {runPushdown} from './library-pushdown.mjs';
import {listCollections, saveCollection, deleteCollection, setCollectionItems, collectionUids, collectionPositions, saveSmartRule, assertSmartConditions} from './library-collections.mjs';
import {SEARCH_FIELDS, SEARCH_SYNTAX_HELP} from './search-expression.mjs';
import {mutationTransform, MutationRejectedError, opsAffectDerived} from './library-mutations.mjs';
import {tagFacetView} from './library-tag-facets.mjs';
import {normalizeTagOps} from './library-tags-write.mjs';
import {normalizeAssetOps} from './library-asset-ops.mjs';
import {exportLibrary, importLibrary, normalizeSnapshot, PortableRejected} from './library-portable.mjs';
import {probeThirdPartyLibrary, importEagleLibrary} from './import-eagle.mjs';
import {listStores, createStore, selectStore, renameStore, removeStore, StoreRejected} from './store-registry.mjs';
import {SESSION_STATE_KEY, SESSION_FIELDS} from './library-schema.mjs';
import {createEventBus} from './library-events.mjs';
import {onScanChange} from './scan-cache.mjs';
import {createMemberDirectory, listMembers, saveMember, removeMember, MemberRejected, can, requestPermission} from './library-members.mjs';

const ROUTES = new Set([
  '/api/library/mutations', '/api/library/query', '/api/library/query/status', '/api/library/assets',
  '/api/library/collections', '/api/library/collections/items', '/api/library/collections/previews',
  '/api/library/smart-collections', '/api/library/smart-collections/resolve',
  '/api/library/tags/facets', '/api/library/tags/mutate', '/api/library/events', '/api/library/members',
  '/api/library/backups', '/api/library/backups/restore',
  '/api/library/export', '/api/library/import',
  '/api/library/import/eagle', '/api/library/import/eagle/probe',
  '/api/library/stores',
  '/api/library/semantic/status', '/api/library/semantic/build',
  '/api/library/semantic/search', '/api/library/semantic/similar',
  '/api/library/assets/detail', '/api/library/assets/remove', '/api/library/assets/mutate', '/api/library/session',
]);

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));

/** 回一个 JSON 答复。**必须返回 true** —— 外层靠它判断「本模块已经答复」。 */
function send(res, status, data) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
  return true;
}

async function readBody(req, max = 128 * 1024) {
  let raw = '', overflow = false, bytes = 0;
  const decoder = new StringDecoder('utf8');
  for await (const chunk of req) {
    // 超限后必须把剩下的数据**继续读掉**再抛错：直接 throw 会让客户端还在上传时被晾着，
    // fetch 永远等不到答复（2026-11-11 实测：启动补发 319KB 的 asset:add 卡死在启动画面）。
    if (overflow) continue;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    // 阶段 4 差量请求最长 96KB（op）+ 附带的小 key，其余路由的 body 仍然很小。
    // 例外是整库导入（ADR-10）与定点写入（asset:add 单条 model 上限 512KB）：单独抬上限。
    if (bytes > max) { overflow = true; raw = ''; continue; }
    raw += decoder.write(buffer);
  }
  if (overflow) throw Object.assign(Error(`请求体超过 ${Math.round(max / 1024 / 1024 * 10) / 10}MB 上限`), {status: 413});
  raw += decoder.end();
  try { const data = JSON.parse(raw || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; }
  catch { throw Error('无效的 JSON 请求'); }
}

/** 本地服务 + 同源：LAN 访问者与跨站页面都不能读改资产库。 */
function guard(req) {
  if (req.headers['x-sfx-local'] !== '1') return '缺少本地请求标识';
  const origin = req.headers.origin;
  if (!origin) return null;
  try { return new URL(String(origin)).host === req.headers.host ? null : '跨站请求被拒绝'; }
  catch { return '跨站请求被拒绝'; }
}

/**
 * SSE 的守卫：EventSource 带不了自定义头，所以不能要求 x-sfx-local。
 * 但也不能因此变成「任意网页都能读资产库」——
 * 跨站的 EventSource 一定带 Origin（现代浏览器还会带 Sec-Fetch-Site: cross-site），
 * 两者都能识别出跨站。带 Origin 必须同站，Sec-Fetch-Site 标了跨站就拒绝，
 * 两者都没有的（脚本 / 局域网工具 / 浏览器同源 GET）放行。
 */
function guardStream(req) {
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(String(origin)).host !== req.headers.host) return '跨站请求被拒绝'; }
    catch { return '跨站请求被拒绝'; }
  }
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return '跨站请求被拒绝';
  return null;
}

/** GET /api/library/assets 的查询串 → 与 POST 相同的 input 形状。 */
function inputFromSearch(params) {
  const list = key => (params.get(key) || '').split(',').map(item => item.trim()).filter(Boolean);
  const filters = {};
  const collection = text(params.get('collection'));
  if (collection) filters.collection = collection;
  if (params.has('state')) filters.state = text(params.get('state'));
  if (params.has('favorite')) filters.favorite = params.get('favorite') === '1' || params.get('favorite') === 'true';
  const rating = Number(params.get('rating'));
  if (Number.isFinite(rating) && rating > 0) filters.rating = [rating, 5];
  if (list('tags').length) filters.tags = list('tags');
  if (list('excludeTags').length) filters.excludeTags = list('excludeTags');
  if (list('platforms').length) filters.platforms = list('platforms');
  // 新维度同样可用 GET 表达，方便脚本 / MCP / 智能合集：
  // ?colors=blue,red&similarity=40&excludeColors=1&ranges=[{"field":"aspect","min":1.05}]
  if (list('colors').length) filters.colors = list('colors');
  if (params.has('similarity')) filters.colorSimilarity = Number(params.get('similarity'));
  if (params.has('excludeColors')) filters.excludeColors = ['1', 'true', 'yes'].includes(text(params.get('excludeColors')).toLowerCase());
  if (list('ratings').length) filters.ratings = list('ratings').map(Number);
  if (params.has('favoriteMode')) filters.favoriteMode = text(params.get('favoriteMode'));
  if (params.has('ranges')) {
    try { const parsed = JSON.parse(params.get('ranges')); if (Array.isArray(parsed)) filters.ranges = parsed; }
    catch { /* 坏参数直接忽略，不影响其它筛选 */ }
  }
  // 格式筛选也能用 GET 表达，方便脚本 / MCP / 智能合集：?formats=png,jpg,text&exclude=1
  if (list('formats').length) filters.formats = list('formats');
  filters.excludeFormats = ['1', 'true', 'yes'].includes(text(params.get('exclude')).toLowerCase());
  return {
    q: text(params.get('q')), sort: text(params.get('sort')) || undefined,
    sortOrder: ['asc', 'desc'].includes(text(params.get('sortOrder'))) ? text(params.get('sortOrder')) : undefined,
    seed: text(params.get('seed')),
    limit: params.has('limit') ? Number(params.get('limit')) : undefined,
    offset: params.has('offset') ? Number(params.get('offset')) : undefined,
    uidScope: params.get('uids') === 'page' ? 'page' : 'all',
    filters,
  };
}

export function createLibraryApi({storage, backups = null, importRoots = null, dataDir = '', downloadDir = '', storeBase = '', semantic = null, allowLocalRoot = () => {}, onWarn = () => {}} = {}) {
  if (!storage) throw Error('缺少资产库存储实例');
  // 变更广播总线：写路径 emit、SSE 路由 subscribe，两边共用一个实例。
  const events = createEventBus({onWarn});
  // 磁盘实时变化 → SSE 广播。递归监听本来就由缓存层持有（增量索引靠它拿 changedPaths），
  // 这里只把「哪个根变了」翻译成前端能懂的通知；不发绝对路径，局域网访客也看不到盘符结构。
  const stopScanWatch = onScanChange(({roots}) => {
    events.emit({kind: 'local', roots: roots.map(root => String(root).split(/[\\/]/).pop())});
  });
  // 成员目录：身份解析与角色门控都走它（带 2 秒缓存，写操作主动失效）。
  const members = createMemberDirectory({storage, onWarn});

  /**
   * 写操作的身份与权限门控。
   * 返回 identity；权限不足时直接把 403 写出去并返回 null（调用方直接 return true 收工）。
   */
  async function authorize(req, res, action) {
    const identity = await members.resolve(req);
    if (!can(identity.role, action)) {
      send(res, 403, {
        error: action === 'manage' ? '只有主管可以管理成员' : '当前身份没有写入权限',
        role: identity.role,
        member: identity.name || identity.member_id,
      });
      return null;
    }
    return identity;
  }

  // 在总分发器以及独立 API 使用同一授权策略，并在读请求体/产生副作用前拒绝。
  async function authorizeRequest(req, res, u) {
    const action = requestPermission(req.method, u.pathname);
    if (action === 'read') return true;
    if (action === 'host') {
      if (req.lanVisitor) { send(res, 403, {error: '仅主机本地可以执行此操作'}); return false; }
      return !!await authorize(req, res, 'manage');
    }
    return !!await authorize(req, res, action);
  }

  /**
   * 查询数据：优先 SQLite 索引，失败自动退回 blob 派生，两条路径产出的行格式相同。
   * ftsTerm 非空时只从 FTS5 命中里取 assets 行 —— 这是「预筛」，最终仍由 queryAssets 完整求值。
   */
  async function dataset({ftsTerm = null} = {}) {
    let indexed = false;
    try { indexed = await storage.ensureIndex() === true; }
    catch (error) { onWarn(`资产库索引同步失败，改用内存查询：${error.message}`); }
    if (indexed) {
      try {
        const result = await storage.withDb(conn => ({
          rows: normalizeRows(
            ftsTerm ? conn.searchAssetRows(ftsTerm, FTS_CANDIDATE_LIMIT) : conn.all('SELECT * FROM assets', []),
            conn.all('SELECT uid, kind, tag FROM tags', []),
          ),
          engine: 'sqlite', schemaVersion: conn.version,
        }));
        if (result) return result;
      } catch (error) { onWarn(`资产库索引读取失败，改用内存查询：${error.message}`); }
    }
    return {rows: rowsFromState(await storage.readRawState()), engine: 'memory', schemaVersion: 0};
  }

  async function resolveCollection(id) {
    if (!text(id)) return null;
    const result = await storage.withDb(conn => collectionUids(conn, id));
    return result instanceof Set ? result : new Set();
  }

  async function resolvePositions(id) {
    if (!text(id)) return null;
    const result = await storage.withDb(conn => collectionPositions(conn, id));
    return result instanceof Map ? result : null;
  }

  /** 一次查询的公共入口：page=true 时 items 是完整 model（阶段 3 按需取数）。 */
  function runQuery(rows, input = {}, {page = false, positions = null} = {}) {
    const filters = {...(input.filters && typeof input.filters === 'object' ? input.filters : {})};
    const params = {
      rows,
      q: text(input.q).slice(0, 500),
      filters,
      sort: SORTS.includes(input.sort) ? input.sort : DEFAULT_QUERY.sort,
      sortOrder: input.sortOrder === 'desc' ? 'desc' : 'asc',
      limit: input.limit === undefined ? DEFAULT_QUERY.limit : input.limit,
      offset: input.offset === undefined ? DEFAULT_QUERY.offset : input.offset,
      seed: text(input.seed),
      collectionPositions: positions,
      uidScope: input.uidScope === 'page' ? 'page' : 'all',
    };
    return page ? queryAssetPage(params) : queryAssets(params);
  }

  /** 合集写操作必须具备持久化内核；返回 null 表示调用方应给 503。 */
  async function withCollectionDb(handler) {
    const ready = await storage.ensureIndex();
    if (!ready) return null;
    return storage.withDb(handler);
  }

  return {
    /** 变更总线：写路径广播、SSE 路由订阅。外部模块也能用它发通知。 */
    events,
    /** 成员目录：身份解析与角色判定。 */
    members,
    authorizeRequest,
    /** 摘掉磁盘监听订阅（测试与热重载用；正常进程退出不必调）。 */
    dispose() { stopScanWatch(); },
    /** 返回 true 表示本模块已经答复，外层不要再走通用静态/404 分支。 */
    async handle(req, res, u) {
      if (!ROUTES.has(u.pathname)) return false;
      const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      const local = !req.lanVisitor && ['127.0.0.1', '::1'].includes(ip)
        && [`127.0.0.1:${req.socket?.localPort}`, `localhost:${req.socket?.localPort}`].includes(req.headers.host);
      const denied = u.pathname === '/api/library/events' ? guardStream(req) : guard(req);
      if (denied) { send(res, 403, {error: denied}); return true; }
      if (!await authorizeRequest(req, res, u)) return true;
      const method = req.method;
      let input = {};
      if (method === 'POST') {
        // 各路由的体量上限差别很大：整库导入几十 MB、定点写入单条 model 512KB × 200 条、
        // 其余写操作本来只有几十 KB。上限给足的同时，超限要回 413 而不是把连接吊死。
        const limit = u.pathname === '/api/library/import' ? 64 * 1024 * 1024
          : u.pathname === '/api/library/assets/mutate' ? 16 * 1024 * 1024
          : 2 * 1024 * 1024;
        try { input = await readBody(req, limit); }
        catch (error) { send(res, error.status || 400, {error: error.message}); return true; }
      } else if (method === 'GET' && u.pathname === '/api/library/assets') input = inputFromSearch(u.searchParams);

      const identity = await members.resolve(req);

      // ADR-12：多资源库注册表。GET 列清单，POST 建库 / 改选 / 改名 / 移除。
      // 改选只写注册表 —— 进程仍连着旧库，生效必须重启（前端据此显示「重启后生效」）。
      if (u.pathname === '/api/library/stores') {
        if (!storeBase) { send(res, 503, {error: '当前服务未启用资源库注册表'}); return true; }
        if (method === 'GET') {
          try { return send(res, 200, listStores(storeBase, {dataDir, downloadDir})); }
          catch (error) { return send(res, 500, {error: `读取资源库清单失败：${error.message}`}); }
        }
        if (method !== 'POST') { send(res, 405, {error: '只支持 GET / POST'}); return true; }
        const action = text(input.action) || 'create';
        try {
          if (action === 'create') {
            const store = createStore(storeBase, {name: input.name, dir: input.dir});
            return send(res, 200, {ok: true, store, ...listStores(storeBase, {dataDir, downloadDir})});
          }
          if (action === 'select') {
            const {store, restartRequired} = selectStore(storeBase, text(input.id), {dataDir});
            if (restartRequired) events.emit({kind: 'stores', actor: identity?.member_id});
            return send(res, 200, {ok: true, store, restartRequired, ...listStores(storeBase, {dataDir, downloadDir})});
          }
          if (action === 'rename') {
            const store = renameStore(storeBase, text(input.id), input.name);
            return send(res, 200, {ok: true, store, ...listStores(storeBase, {dataDir, downloadDir})});
          }
          if (action === 'remove') {
            const removed = removeStore(storeBase, text(input.id), {dataDir});
            return send(res, 200, {ok: true, ...removed, ...listStores(storeBase, {dataDir, downloadDir})});
          }
          return send(res, 400, {error: `不认识的资源库操作：${action}`});
        } catch (error) {
          const rejected = error instanceof StoreRejected;
          return send(res, rejected ? 400 : 500, {error: error.message});
        }
      }

      // ADR-15：语义搜索 / 找相似。向量是可再生派生数据，接口只做三件事：
      // 查状态、按批构建、按余弦取前 N。没有任何一条会改动权威资产数据。
      if (u.pathname.startsWith('/api/library/semantic')) {
        if (!semantic) { send(res, 503, {error: '当前服务未启用语义搜索'}); return true; }
        const route = u.pathname.slice('/api/library/semantic'.length) || '/';
        try {
          if (route === '/status' && method === 'GET') {
            return send(res, 200, {ok: true, ...(await semantic.status())});
          }
          if (route === '/build') {
            if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
            const result = await semantic.build({batch: input.batch, maxBatches: input.maxBatches});
            return send(res, 200, {ok: true, ...result, status: await semantic.status()});
          }
          if (route === '/search' && method === 'GET') {
            const query = text(u.searchParams.get('q')).slice(0, 200);
            const limit = Number(u.searchParams.get('limit')) || 40;
            return send(res, 200, {ok: true, q: query, ...(await semantic.search(query, {limit}))});
          }
          if (route === '/similar' && method === 'GET') {
            const uid = text(u.searchParams.get('uid'));
            const limit = Number(u.searchParams.get('limit')) || 40;
            return send(res, 200, {ok: true, uid, ...(await semantic.similar(uid, {limit}))});
          }
          return send(res, 404, {error: `未知的语义接口：${route}`});
        } catch (error) {
          // 400 而不是 500：这里的失败几乎都是「没配向量模型 / 索引还没建」，属于用户可修的状态。
          return send(res, 400, {error: error.message});
        }
      }

      // 阶段 4：差量写入。前端只发变化的字段/键，服务端在权威状态上重放并整块落盘。
      if (u.pathname === '/api/library/mutations') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        let transform;
        try { transform = mutationTransform(input); }
        catch (error) { send(res, 400, {error: error.message}); return true; }
        try {
          // 只改搜索历史 / 任务 / 选项时，派生表与派生数据毫无关系 —— 不重建整表。
          // 50 万资产时整表重建要 242 秒，而搜索历史是每搜一次就变一次的高频字段。
          const derived = opsAffectDerived(input.ops);
          // 遗留整块通道改用户域时，明确授权派生层以 blob 为准同步评分/标签；
          // 目录域变更不带这个标记，DB 里的用户数据就不会被旧 blob 覆盖。
          const applied = await storage.mutate(transform, {derived, syncUser: derived});
          if (!applied) { send(res, 409, {error: '资产库状态不可写，请重试'}); return true; }
          const version = await storage.withDb(conn => conn.version) || 0;
          // 整块写入说不清「改了哪些资产」，广播一个粗粒度事件让客户端整体失效。
          events.emit({kind: 'assets', actor: identity.member_id});
          return send(res, 200, {
            saved: true, applied: input.ops.length, incremental: true,
            engine: version ? 'sqlite' : 'memory', schemaVersion: version,
            seq: events.seq,
          });
        } catch (error) {
          const rejected = error instanceof MutationRejectedError;
          return send(res, rejected ? 400 : 500, {error: rejected ? error.message : `增量写入失败：${error.message}`});
        }
      }

      // S3-a：集合语义写入（打标签 / 改评分备注收藏）。
      // 与 /mutations 的区别：这里只动受影响的资产，派生表定点改，不做全量重建。
      if (u.pathname === '/api/library/tags/mutate') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        let ops;
        try { ops = normalizeTagOps(input); }
        catch (error) { send(res, 400, {error: error.message}); return true; }
        let result;
        try { result = await storage.mutateTags(ops, {actor: identity.member_id}); }
        catch (error) { return send(res, 500, {error: `增量写入失败：${error.message}`}); }
        const conflicts = result.conflicts || [];
        if (result.fallback) {
          // 退回了整块路径：说不清改了哪些资产，只能广播粗粒度事件。
          events.emit({kind: 'assets', actor: identity.member_id});
        } else {
          for (const change of result.changes || []) {
            events.emit({kind: change.kind, uid: change.uid, rev: change.rev, actor: identity.member_id});
          }
        }
        // rev 冲突：客户端读到的版本已经不是最新 → 409，让它重读后再改。
        // 其余冲突（资产不存在等）随 200 返回，调用方能逐条看到发生了什么。
        const stale = conflicts.some(item => item.code === 'rev_conflict');
        return send(res, stale ? 409 : 200, {
          applied: result.applied || 0,
          changes: result.changes || [],
          conflicts,
          fallback: result.fallback === true,
          // ADR-02 之后用户域权威在 DB，定点写根本不碰 blob，所以恒为 false；
          // 字段保留只为兼容旧客户端（旧版在 blob 超 16MB 时才回 true）。
          blobSkipped: result.blobSkipped === true,
          seq: events.seq,
        });
      }

      // ADR-02：会话域轻量写。搜索历史 / 任务 / 选项单独成域，
      // 写入代价 = 会话域体积（几 KB），与库大小无关 ——
      // 旧路径每记一次搜索就要重写整个 blob，50 万资产时那是 209MB。
      if (u.pathname === '/api/library/session') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        const session = {};
        for (const field of SESSION_FIELDS) {
          if (!Object.hasOwn(input, field)) continue;
          const value = input[field];
          if (field === 'options') {
            if (!value || typeof value !== 'object' || Array.isArray(value)) { send(res, 400, {error: '会话选项格式无效'}); return true; }
          } else if (!Array.isArray(value) || value.length > 200) {
            send(res, 400, {error: '会话数据格式无效'}); return true;
          }
          session[field] = value;
        }
        if (!Object.keys(session).length) { send(res, 400, {error: '没有会话数据'}); return true; }
        try {
          await storage.mutate(values => ({...values, [SESSION_STATE_KEY]: JSON.stringify(session)}), {derived: false});
        } catch (error) {
          return send(res, 500, {error: `会话保存失败：${error.message}`});
        }
        return send(res, 200, {saved: true, fields: Object.keys(session)});
      }

      // ADR-02：定点删除资产。合并语义下「blob 里少了某个 uid」不等于它该消失，
      // 真正要删的走这里：一次事务清干净资产行、标签、格式与检索词条，并留审计行。
      // 阶段 5.1 / ADR-05：目录域定点写。整块 GET / POST 通道保持可用（5.5 才拆）。
      if (u.pathname === '/api/library/assets/mutate') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        if (process.env.AV_LEGACY_BULK === '1') {
          return send(res, 409, {error: '服务端已退回整块写入模式，请改用 /api/library-state', legacyBulk: true});
        }
        let ops;
        try { ops = normalizeAssetOps(input); }
        catch (error) { return send(res, 400, {error: error.message}); }
        let result;
        // ADR-09：停双写。DB 是目录的唯一写入权威，主 blob 不再被 asset:* 同步。
        // AV_SYNC_BLOB=1 可临时恢复过渡期双写，用于排障 / 回滚，不作为默认路径。
        try { result = await storage.mutateAssets(ops, {actor: identity.member_id, syncBlob: process.env.AV_SYNC_BLOB === '1'}); }
        catch (error) { return send(res, 500, {error: `增量写入失败：${error.message}`}); }
        if (result.fallback) {
          return send(res, 503, {error: '资产库内核不可用，请改用整块写入', legacyBulk: true});
        }
        // 定点写能说清改了哪些资产 → 按 uid 细粒度广播，客户端不必整库失效。
        for (const change of result.changes || []) {
          events.emit({kind: 'asset', uid: change.uid, rev: change.rev, actor: identity.member_id});
        }
        const stale = (result.conflicts || []).some(item => item.code === 'rev_conflict');
        return send(res, stale ? 409 : 200, {
          applied: result.applied || 0,
          changes: result.changes || [],
          conflicts: result.conflicts || [],
          fallback: false,
          seq: events.seq,
        });
      }

      if (u.pathname === '/api/library/assets/remove') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        const uids = (Array.isArray(input.uids) ? input.uids : []).map(text)
          .filter(item => item && item.length <= 40).slice(0, 500);
        if (!uids.length) { send(res, 400, {error: '没有要删除的资产'}); return true; }
        const result = await storage.withDb(conn => conn.removeAssets(uids, {actor: identity.member_id}));
        if (!result) { send(res, 503, {error: '资产库内核不可用'}); return true; }
        for (const uid of result.uids || []) events.emit({kind: 'asset', uid, actor: identity.member_id});
        return send(res, 200, {removed: result.removed, uids: result.uids || []});
      }

      // S3-c：变更广播（单向下行通知）。EventSource 带不了自定义头，
      // 所以守卫比普通路由宽松，但跨站仍然拒绝（见 guardStream）。
      if (u.pathname === '/api/library/events') {
        if (method !== 'GET') { send(res, 405, {error: '只支持 GET'}); return true; }
        const lastEventId = req.headers['last-event-id'] ?? u.searchParams.get('lastEventId');
        events.subscribe(req, res, {uid: text(u.searchParams.get('uid')), lastEventId});
        return true;
      }

      // S3-b：成员与角色。读所有人可读，写只有主管。
      if (u.pathname === '/api/library/members') {
        if (method === 'GET') {
          const me = await members.resolve(req);
          const rows = await storage.withDb(conn => listMembers(conn));
          return send(res, 200, {
            members: rows || [],
            me: {member_id: me.member_id, name: me.name, role: me.role, local},
            // 两个门控分开给：成员管理要 manage，立即备份只要 write。
            // 前端不该自己从角色字符串推导权限，否则以后加角色就要改两处。
            canManage: can(me.role, 'manage'),
            canWrite: can(me.role, 'write'),
          });
        }
        const manager = await authorize(req, res, 'manage');
        if (!manager) return true;
        if (method === 'POST') {
          let saved = null;
          try { saved = await storage.withDb(conn => saveMember(conn, input)); }
          catch (error) {
            const rejected = error instanceof MemberRejected;
            return send(res, rejected ? 400 : 500, {error: rejected ? error.message : `成员保存失败：${error.message}`});
          }
          if (!saved) { send(res, 503, {error: '成员管理需要资产库内核'}); return true; }
          members.invalidate();
          const me = await members.resolve(req);
          const rows = await storage.withDb(conn => listMembers(conn));
          return send(res, 200, {
            member: saved,
            members: rows || [],
            // S3：与 GET 同款门控字段一起回（之前 POST 只回 member/members，前端只能再发一次
            // GET 才能拿回 me / canManage / canWrite 刷新权限）。现在直接回，省掉这次往返。
            me: {member_id: me.member_id, name: me.name, role: me.role, local},
            canManage: can(me.role, 'manage'),
            canWrite: can(me.role, 'write'),
          });
        }
        if (method === 'DELETE') {
          let removed = null;
          try { removed = await storage.withDb(conn => removeMember(conn, u.searchParams.get('id'))); }
          catch (error) {
            const rejected = error instanceof MemberRejected;
            return send(res, rejected ? 400 : 500, {error: rejected ? error.message : `成员删除失败：${error.message}`});
          }
          if (removed === null) { send(res, 503, {error: '成员管理需要资产库内核'}); return true; }
          members.invalidate();
          return send(res, 200, {removed});
        }
        send(res, 405, {error: '不支持的请求方式'}); return true;
      }

      // S3-d：备份与恢复。恢复会覆盖当前库，所以只给主管。
      if (u.pathname === '/api/library/backups' || u.pathname === '/api/library/backups/restore') {
        if (!backups) { send(res, 503, {error: '备份服务未启用'}); return true; }
        if (u.pathname === '/api/library/backups/restore') {
          if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
          const manager = await authorize(req, res, 'manage');
          if (!manager) return true;
          try {
            const result = await backups.restore(input.name ?? u.searchParams.get('name'));
            // 恢复后所有人的本地状态都过期了：广播一个粗粒度事件。
            events.emit({kind: 'assets', actor: manager.member_id});
            return send(res, 200, {restored: result.restored, safety: result.safety});
          } catch (error) {
            return send(res, 400, {error: `恢复失败：${error.message}`});
          }
        }
        if (method === 'GET') return send(res, 200, {backups: await backups.list(), config: backups.config});
        if (method === 'POST') {
          try {
            const result = await backups.runNow();
            return send(res, 200, {backup: result, backups: await backups.list()});
          } catch (error) {
            return send(res, 500, {error: `备份失败：${error.message}`});
          }
        }
        send(res, 405, {error: '不支持的请求方式'}); return true;
      }

      // ADR-10：整库导出 / 导入。导出是只读（GET）；导入走定点 op，替换模式要显式确认并先备份。
      if (u.pathname === '/api/library/export') {
        if (method !== 'GET') { send(res, 405, {error: '只支持 GET'}); return true; }
        try {
          return send(res, 200, await exportLibrary({storage}));
        } catch (error) {
          const rejected = error instanceof PortableRejected;
          return send(res, rejected ? 400 : 500, {error: rejected ? error.message : `导出失败：${error.message}`});
        }
      }
      if (u.pathname === '/api/library/import') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        const mode = input.mode === 'replace' ? 'replace' : 'merge';
        if (mode === 'replace' && input.confirm !== true) {
          return send(res, 400, {error: '整库替换会清空当前目录，需要显式确认', needsConfirm: true});
        }
        // 无效快照不能触发备份（包括保留策略清理），更不能开始替换。
        try { normalizeSnapshot(input.snapshot); }
        catch (error) {
          return send(res, 400, {error: error.message, code: error.code});
        }
        // 没有可靠回退副本时失败关闭，绝不能仅告警后继续覆盖。
        let safety = null;
        if (mode === 'replace') {
          if (typeof backups?.runNow !== 'function') {
            return send(res, 503, {error: '整库替换已取消：安全备份服务不可用', code: 'safety_backup_unavailable'});
          }
          try { safety = await backups.runNow(); }
          catch (error) {
            onWarn(`导入前的现状备份失败：${error.message}`);
            return send(res, 503, {error: '整库替换已取消：安全备份失败，请检查备份服务后重试', code: 'safety_backup_failed'});
          }
        }
        try {
          const report = await importLibrary({
            storage, payload: input.snapshot, mode, actor: identity.member_id,
          });
          events.emit({kind: 'assets', actor: identity.member_id});
          return send(res, 200, {...report, safety});
        } catch (error) {
          const rejected = error instanceof PortableRejected;
          return send(res, rejected ? 400 : 500, {
            error: rejected ? error.message : `导入失败：${error.message}`, code: error.code,
          });
        }
      }

      // Eagle / Billfish：先探测（只数条目），再整库导入。导入 = 复制原图 + 走快照写入。
      if (u.pathname === '/api/library/import/eagle/probe') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        try {
          return send(res, 200, await probeThirdPartyLibrary(input.folder));
        } catch (error) {
          return send(res, 400, {error: error.message});
        }
      }
      if (u.pathname === '/api/library/import/eagle') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        try {
          const report = await importEagleLibrary({folder: input.folder, dataDir, importRoots, storage});
          // 新导入根不进白名单的话，缩略图与预览会被 403 挡住。
          if (report?.libraryRoot) allowLocalRoot(report.libraryRoot);
          events.emit({kind: 'assets', actor: identity.member_id});
          return send(res, 200, report);
        } catch (error) {
          return send(res, 400, {error: `导入失败：${error.message}`});
        }
      }

      // 协作：按 uid 取这几个资产的「用户可变部分」——别人改了评分 / 备注 / 标签 / 收藏后，
      // 客户端据此把本地那几张卡片更新过来。只取这几项，不搬整行模型（50 万资产下搬不起）。
      if (u.pathname === '/api/library/assets/detail') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        const uids = (Array.isArray(input.uids) ? input.uids : []).map(text)
          .filter(item => item && item.length <= 40).slice(0, 200);
        if (!uids.length) return send(res, 200, {details: []});
        const marks = uids.map(() => '?').join(', ');
        const rows = await storage.withDb(conn => ({
          assets: conn.all(`SELECT uid, rating, note, favorite FROM assets WHERE uid IN (${marks})`, uids),
          tags: conn.all(`SELECT uid, kind, tag FROM tags WHERE uid IN (${marks}) AND kind IN ('user','ai')`, uids),
        }));
        if (!rows) { send(res, 503, {error: '资产库内核不可用'}); return true; }
        const byUid = new Map(rows.assets.map(row => [row.uid, {
          uid: row.uid, rating: Number(row.rating) || 0, note: text(row.note),
          favorite: Number(row.favorite) === 1, userTags: [], aiTags: [],
        }]));
        for (const row of rows.tags) {
          const item = byUid.get(row.uid);
          if (!item) continue;
          if (row.kind === 'user') item.userTags.push(row.tag);
          else if (row.kind === 'ai') item.aiTags.push(row.tag);
        }
        return send(res, 200, {details: [...byUid.values()]});
      }

      if (u.pathname === '/api/library/query/status') {        if (method !== 'GET') { send(res, 405, {error: '只支持 GET'}); return true; }
        const info = await storage.withDb(conn => ({counts: conn.counts(), version: conn.version})) || null;
        return send(res, 200, {
          available: true, engine: info ? 'sqlite' : 'memory',
          counts: info?.counts || null, schemaVersion: info?.version ?? 0,
          sorts: SORTS, fields: SEARCH_FIELDS, syntax: SEARCH_SYNTAX_HELP,
        });
      }

      // 分面标签：词表面 + 受控值 + 物化计数。没有 DB 就没有词表，明确 503 而不是返回空面板。
      if (u.pathname === '/api/library/tags/facets') {
        if (method !== 'GET') { send(res, 405, {error: '只支持 GET'}); return true; }
        const limit = Number(u.searchParams.get('limit'));
        const view = await storage.withDb(conn => tagFacetView(conn, {limit: Number.isFinite(limit) && limit >= 0 ? limit : 120}));
        return send(res, view ? 200 : 503, view || {error: '分面标签需要资产库内核'});
      }

      if (u.pathname === '/api/library/query' || u.pathname === '/api/library/assets') {
        const isPage = u.pathname === '/api/library/assets';
        if (method !== 'POST' && !(isPage && method === 'GET')) { send(res, 405, {error: '只支持 POST'}); return true; }
        const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
        const collectionId = text(filters.collection);
        const collectionUids = collectionId ? await resolveCollection(collectionId) : null;

        // —— 优先走 S2 下推：一条 SQL 只取当前页，不再把整库搬进内存 ——
        // 编译失败（颜色 HSL 距离 / 特殊排序 / 不可下推的检索字段）就如实退回全量路径，
        // 语义由同一套 queryAssets 保证，只是慢。绝不为了快而返回不同的结果集。
        // 回退原因要随响应回传：静默变慢是老版本最难查的一类问题。
        const ready = await storage.ensureIndex();
        let fallbackReason = ready ? '' : '资产库内核不可用（纯文件模式）';
        if (ready) {
          const plan = compileQuery({
            q: text(input.q).slice(0, 500),
            filters,
            sort: SORTS.includes(input.sort) ? input.sort : DEFAULT_QUERY.sort,
            sortOrder: input.sortOrder === 'desc' ? 'desc' : 'asc',
            limit: input.limit === undefined ? DEFAULT_QUERY.limit : input.limit,
            offset: input.offset === undefined ? DEFAULT_QUERY.offset : input.offset,
            collectionUids, collectionId,
          });
          if (!plan.ok) fallbackReason = plan.reason || '条件不可下推';
          if (plan.ok) {
            const uidScope = input.uidScope === 'page' ? 'page' : 'all';
            const pushed = await storage.withDb(conn => ({
              ...runPushdown(conn, plan, {page: isPage, uidScope}), version: conn.version,
            }));
            if (pushed) return send(res, 200, {
              total: pushed.total, limit: pushed.limit, offset: pushed.offset,
              items: pushed.items, uids: pushed.uids, uidsComplete: pushed.uidsComplete,
              engine: 'sqlite', schemaVersion: pushed.version,
              collection: collectionId || undefined,
              accelerated: false, pushdown: true,
              mode: isPage ? 'page' : 'uids',
            });
          }
        }

        // —— 降级：全量读 + JS 求值（无 DB、或条件不可下推时）——
        // 只有「单个正向纯文本词」才缩候选集；复杂语法一律走全量，保证语义不变。
        const ftsTerm = simpleFtsTerm(input.q);
        const data = await dataset({ftsTerm});
        // 合集先缩候选集，再走同一套查询语义：一次求值，不产生「两套过滤规则」。
        let rows = data.rows;
        if (collectionId) {
          const members = collectionUids || new Set();
          rows = rows.filter(row => members.has(row.uid));
        }
        const positions = collectionId && input.sort === 'collection' ? await resolvePositions(collectionId) : null;
        const result = runQuery(rows, input, {page: isPage, positions});
        return send(res, 200, {
          ...result, engine: data.engine, schemaVersion: data.schemaVersion,
          collection: collectionId || undefined,
          accelerated: !!ftsTerm && data.engine === 'sqlite',
          pushdown: false,
          reason: fallbackReason,
          mode: isPage ? 'page' : 'uids',
        });
      }

      if (u.pathname === '/api/library/collections') {
        if (method === 'GET') {
          const rows = await withCollectionDb(conn => listCollections(conn));
          return send(res, rows ? 200 : 503, rows ? {collections: rows} : {error: '合集需要资产库内核，当前为纯文件模式'});
        }
        if (method === 'POST') {
          if (input.smart) assertSmartConditions(input.smart);
          const id = await withCollectionDb(conn => saveCollection(conn, input));
          return send(res, id ? 200 : 503, id ? {id, collections: await storage.withDb(conn => listCollections(conn))} : {error: '合集需要资产库内核，当前为纯文件模式'});
        }
        if (method === 'DELETE') {
          const removed = await withCollectionDb(conn => deleteCollection(conn, u.searchParams.get('id')));
          return send(res, removed === null ? 503 : 200, removed === null ? {error: '合集需要资产库内核'} : {removed});
        }
        send(res, 405, {error: '不支持的请求方式'}); return true;
      }

      if (u.pathname === '/api/library/collections/items') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        const result = await withCollectionDb(conn => setCollectionItems(conn, input.id, input.uids, input.action));
        return send(res, result ? 200 : 503, result || {error: '合集需要资产库内核，当前为纯文件模式'});
      }

      // 画板卡片预览：主网格里的画板卡要「大封面 + 一排小图」，所以一次批量取多块画板的头几张。
      // 智能画板的成员是算出来的，这里与 /smart-collections/resolve 共用同一套 runQuery 求值，
      // 不另写一份「规则怎么算」—— 两套实现必然走样。
      if (u.pathname === '/api/library/collections/previews') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        const ids = (Array.isArray(input.ids) ? input.ids : []).map(text).filter(Boolean).slice(0, 80);
        const limit = Math.max(3, Math.min(12, Math.round(Number(input.limit)) || 6));
        const loaded = await withCollectionDb(conn => {
          const list = listCollections(conn);
          const positions = {};
          for (const item of list) positions[item.id] = collectionPositions(conn, item.id);
          return {list, positions};
        });
        if (!loaded) { send(res, 503, {error: '画板预览需要资产库内核，当前为纯文件模式'}); return true; }
        const data = await dataset();
        const byUid = new Map(data.rows.map(row => [row.uid, row]));
        const pick = row => row ? {
          uid: row.uid, name: row.name, thumbnail: text(row.thumbnail),
          platform: text(row.platform), assetType: text(row.model?.assetType) || text(row.kind) || '',
        } : null;
        const previews = {};
        for (const id of ids) {
          const board = loaded.list.find(item => item.id === id);
          if (!board) continue;
          const manual = loaded.positions[id] || new Map();
          let uids = [];
          let total = 0;
          if (board.smart) {
            // 只取头几页 uid：预览不需要全量命中，uidScope:'page' 不把上万 uid 传回进程内。
            const result = runQuery(data.rows, {
              q: board.smart.q, filters: board.smart.filters, sort: board.smart.sort,
              limit: limit + 1, uidScope: 'page',
            });
            uids = [...result.uids];
            total = result.total;
            // 采集 / 手动加进智能画板的成员不在规则命中里，不并进来会「明明收进来了却没封面」。
            const extra = [...manual.keys()].filter(uid => !uids.includes(uid));
            uids = [...uids, ...extra];
            total += extra.length;
          } else {
            uids = [...manual.keys()];
            total = uids.length;
          }
          // 指定了封面的画板优先用它：用户手选的封面比「第一条」更符合预期。
          if (board.coverAssetId && byUid.has(board.coverAssetId)) {
            uids = [board.coverAssetId, ...uids.filter(uid => uid !== board.coverAssetId)];
          }
          const items = uids.slice(0, limit + 1).map(uid => pick(byUid.get(uid))).filter(Boolean);
          previews[id] = {items, total, cover: items[0] || null};
        }
        return send(res, 200, {previews});
      }

      if (u.pathname === '/api/library/smart-collections') {
        if (method === 'GET') {
          const rows = await withCollectionDb(conn => listCollections(conn).filter(item => item.smart));
          return send(res, rows ? 200 : 503, rows ? {collections: rows} : {error: '智能合集需要资产库内核'});
        }
        if (method === 'POST') {
          // 智能合集也是一张 collections 行：没名字时按当前查询词命名，规则单独存表。
          const payload = {name: input.name || `智能合集 ${text(input.q).slice(0, 20) || '未命名'}`, ...input};
          const definition = payload.smart || {q: input.q, filters: input.filters, sort: input.sort,
            sortOrder: input.sortOrder, seed: input.seed};
          assertSmartConditions(definition);
          const result = await withCollectionDb(conn => {
            const id = saveCollection(conn, payload);
            const rule = saveSmartRule(conn, id, definition);
            return {id, rule};
          });
          return send(res, result ? 200 : 503, result || {error: '智能合集需要资产库内核'});
        }
        if (method === 'DELETE') {
          const removed = await withCollectionDb(conn => deleteCollection(conn, u.searchParams.get('id')));
          return send(res, removed === null ? 503 : 200, removed === null ? {error: '智能合集需要资产库内核'} : {removed});
        }
        send(res, 405, {error: '不支持的请求方式'}); return true;
      }

      if (u.pathname === '/api/library/smart-collections/resolve') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        const rules = await withCollectionDb(conn => listCollections(conn));
        if (!rules) { send(res, 503, {error: '智能合集需要资产库内核'}); return true; }
        const rule = rules.find(item => item.id === text(input.id) && item.smart);
        if (!rule) { send(res, 404, {error: '智能合集不存在'}); return true; }
        const query = {q: text(input.q).slice(0, 500), filters: input.filters || {},
          sort: input.sort === undefined ? rule.smart.sort : input.sort,
          sortOrder: input.sortOrder === undefined ? rule.smart.sortOrder : input.sortOrder,
          seed: input.seed === undefined ? rule.smart.seed : text(input.seed),
          limit: input.limit, offset: input.offset};
        // 走下推：智能合集只回「规则命中的一页」，不需要把整库搬进内存。
        // 50 万条实测：全量路径会直接 OOM（Node 堆 4GB 爆掉），下推路径峰值堆 9MB。
        const ready = await storage.ensureIndex();
        const extraCollection = text(query.filters.collection);
        const extraUids = extraCollection ? await resolveCollection(extraCollection) : null;
        const ruleCollection = text(rule.smart.filters.collection);
        const ruleUids = ruleCollection ? await resolveCollection(ruleCollection) : null;
        const basePlan = ready ? compileQuery({...rule.smart, collectionUids: ruleUids, collectionId: ruleCollection}) : {ok: false};
        let plan = ready ? compileQuery({...query, collectionUids: extraUids, collectionId: extraCollection})
          : {ok: false, reason: '没有可用内核'};
        if (basePlan.ok && plan.ok) {
          plan = {...plan, where: `((${basePlan.where}) OR EXISTS (SELECT 1 FROM collection_assets ca WHERE ca.asset_id = a.uid AND ca.collection_id = ?)) AND (${plan.where})`,
            params: [...basePlan.params, rule.id, ...plan.params], indexHint: '', countIndexHint: ''};
        } else plan = {ok: false, reason: basePlan.reason || plan.reason || '画板条件不可下推'};
        let result;
        let engine = 'sqlite';
        let uidsComplete = true;
        if (plan.ok) {
          // uidScope:'all'：命中不超过上限时仍返回完整成员列表（与旧行为一致），
          // 超过上限时只回当前页并标记 uidsComplete:false —— 由前端如实提示。
          const pushed = await storage.withDb(conn => runPushdown(conn, plan,
            {page: input.uidScope === 'page', uidScope: input.uidScope === 'page' ? 'page' : 'all'}));
          result = {total: pushed.total, limit: pushed.limit, offset: pushed.offset, items: pushed.items, uids: pushed.uids};
          uidsComplete = pushed.uidsComplete !== false;
        } else {
          // 下推不了（颜色 / categories / 特殊排序）：如实退回全量路径，语义不变，只是慢。
          const data = await dataset();
          engine = data.engine;
          const manual = await withCollectionDb(conn => collectionUids(conn, rule.id)) || new Set();
          const scope = new Set(queryAssets({rows: data.rows, ...rule.smart, collectionUids: ruleUids}).uids);
          for (const uid of manual) scope.add(uid);
          result = (input.uidScope === 'page' ? queryAssetPage : queryAssets)({
            rows: data.rows.filter(row => scope.has(row.uid)), ...query,
            collectionUids: extraUids, uidScope: input.uidScope === 'page' ? 'page' : 'all'});
        }
        return send(res, 200, {...result, uidsComplete, hasMore: result.offset + result.items.length < result.total,
          engine, pushdown: plan.ok, reason: plan.ok ? '' : plan.reason,
          collection: rule.id, rule: rule.smart});
      }

      return false;
    },
  };
}
