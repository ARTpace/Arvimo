import fs from 'node:fs/promises';
import path from 'node:path';
import {openLibraryDb} from './library-db.mjs';
import {mergeDomains, parseMainState} from './library-blob.mjs';
import {MAIN_STATE_KEY, USER_STATE_KEY, PROBE_STATE_KEY, SESSION_STATE_KEY, STATE_KEYS, STATE_STAMP_PREFIX, stateStampKey} from './library-schema.mjs';
import {validateValues, restoreLibraryCovers, mergeCatalog, stateFileFor} from './library-state-files.mjs';

// 纯函数拆到 library-state-files.mjs，这里保持原有导出路径不变
// （server/library.mjs 与所有测试都从本文件 import）。
export {MAX_STATE_BYTES, MAX_CATALOG_BYTES, stateFileFor, restoreLibraryCovers} from './library-state-files.mjs';

/**
 * 前端契约不变：load() → {values, recovered, scanIndex}，save(values) → Promise。
 *
 * ADR-02：状态**按域拆成独立文件**。
 *
 * 原来所有域挤在一个 library-state.json 里，于是「记一次搜索历史」也要重写整份文件 ——
 * 50 万资产的目录域是 209MB，每搜一次就重写 209MB，这是完全不可接受的。
 * 现在每个域一个文件（state/<key>.json），写一个域只重写那一个域的文件，
 * 写入代价与**该域的体积**成正比，与库大小无关。
 *
 * 权威关系：
 *   - 文件 = 各域快照（目录域 / 探测域 / 会话域）；
 *   - SQLite = 派生索引 + **用户域的权威**（评分、备注、收藏、用户与 AI 标签）。
 *   DB 不可用时自动退回纯文件模式；文件比 DB 新时用文件重建索引，任何情况下都不丢数据。
 */
export function createLibraryStorage(dataDir, downloads, options = {}) {
  /** 旧版单文件路径：只在第一次迁移时读一次，之后每个域各写各的。 */
  const legacyFile = path.join(dataDir, 'library-state.json');
  const stateDir = path.join(dataDir, 'state');
  const fileFor = key => stateFileFor(dataDir, key);
  const dbFile = options.dbFile || path.join(dataDir, 'library.db');
  const backupFile = path.join(dataDir, 'library-state.pre-db.json');
  // 默认落到服务端日志：桌面版 sidecar 若没带原生依赖，降级必须留痕而不是静默失效。
  const onWarn = options.onWarn || (message => console.warn(`[AssetVault] ${message}`));
  let queue = Promise.resolve();
  let dbHealthy = options.disableDb !== true;
  // 降级原因与探测状态：以前失败只打 warn，dbHealthy 一直是 true，于是每次读写都
  // 重新去 require 那个加载不了的 .node，日志刷屏、健康检查也看不出内核到底在不在。
  let dbFailure = null;
  let dbProbed = false;
  /** ADR-07：读侧目录域改由 DB 权威合成；环境变量可一键退回旧的 blob 读视图。 */
  const catalogFromDb = options.catalogDbAuthoritative !== false && process.env.AV_LEGACY_CATALOG !== '1';
  /**
   * ADR-09 / 5.5：目录写入以 DB 为唯一权威，主 blob 落盘时目录字段恒为空。
   * 停双写后若仍把过期目录写进文件，ensureIndex / mergeDerived 会把它回灌，
   * 已作废、已删除的资产就有被复活的风险。AV_LEGACY_BULK / AV_SYNC_BLOB 可整体回滚。
   */
  // 显式开启：真实服务端在 library.mjs 里传 true；纯逻辑测试不传就保持旧的双轨语义，
  // 免得 ADR-02 / ADR-05 的既有断言被「默认新行为」误伤。
  const singleWriter = options.catalogSingleWriter === true && catalogFromDb
    && process.env.AV_LEGACY_BULK !== '1' && process.env.AV_SYNC_BLOB !== '1';

  /**
   * 快照缓存：读一次状态文件并 JSON.parse 是整库最贵的单次操作之一。
   * 按域缓存 + mtime/size 失效判据：自己写盘后 mtime 必变，外部改文件也会变。
   */
  const snapshotCache = new Map();
  const missing = () => ({values: {}, mtimes: {}});

  /** 旧版单文件内容：迁移期读一次，之后每个域落到自己的文件里。 */
  let legacyValues = null;
  let legacyChecked = false;
  let legacyStamp = 0;
  async function readDropped() {
    try {
      const list = JSON.parse(await fs.readFile(path.join(stateDir, 'dropped-uids.json'), 'utf8'));
      return new Set(Array.isArray(list) ? list.filter(item => typeof item === 'string') : []);
    } catch { return new Set(); }
  }
  async function readLegacy() {
    if (legacyChecked) return legacyValues;
    legacyChecked = true;
    try {
      const stat = await fs.stat(legacyFile);
      legacyStamp = stat.mtimeMs;
      const raw = await fs.readFile(legacyFile, 'utf8');
      const data = JSON.parse(raw);
      legacyValues = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch { legacyValues = null; }
    return legacyValues;
  }

  /**
   * 损坏的快照必须照旧报错，不能因为 DB 里有副本就静默吞掉。
   *
   * **缓存判据必须放在 readFile 之前**：50 万库时目录域文件 241MB，每次请求重读一遍
   * 就是 500ms 起步。以前缓存放在 JSON.parse 前，等于只省了解析、文件照样读 —— 形同虚设。
   */
  async function readSnapshot() {
    const values = {};
    const mtimes = {};
    /** 值来自旧版单文件、还没有自己的域文件：这些 key 必须视为「未落盘」。 */
    const legacyOnly = new Set();
    for (const key of STATE_KEYS) {
      let stat = null;
      try { stat = await fs.stat(fileFor(key)); }
      catch (error) { if (error.code !== 'ENOENT') throw Error('资产库状态无法读取，已保留原文件，请检查状态目录'); }
      if (stat) {
        const cached = snapshotCache.get(key);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          values[key] = cached.value;
          mtimes[key] = stat.mtimeMs;
          continue;
        }
        let raw = null;
        try { raw = await fs.readFile(fileFor(key), 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw Error('资产库状态无法读取，已保留原文件，请检查状态目录'); }
        if (raw !== null) {
          try { values[key] = JSON.parse(raw); }
          catch { throw Error('资产库状态无法读取，已保留原文件，请检查状态目录'); }
          mtimes[key] = stat.mtimeMs;
          snapshotCache.set(key, {value: values[key], mtimeMs: stat.mtimeMs, size: stat.size});
          continue;
        }
      }
      // 域文件还没有（或刚被删掉）：迁移期从旧单文件里取。
      const legacy = await readLegacy();
      if (legacy && typeof legacy[key] === 'string') {
        values[key] = legacy[key];
        mtimes[key] = legacyStamp;
        legacyOnly.add(key);
      }
    }
    return {values, mtimes, legacyOnly};
  }
  const read = async () => (await readSnapshot()).values;

  /** 首次迁移前留一份人工可读的原始快照，出问题可以直接拷回去。 */
  async function backupBeforeMigration() {
    try { await fs.access(dbFile); return; } catch {}
    try { await fs.access(backupFile); return; } catch {}
    try { await fs.copyFile(legacyFile, backupFile); } catch {}
  }

  /**
   * 每次操作开一条短连接、用完立即关：Windows 上不会锁住 .db 文件，
   * 进程崩溃也不留 WAL，多实例同时打开同一个库更安全。打开失败只降级一次。
   */
  async function openDb() {
    if (!dbHealthy) return null;
    try {
      await fs.mkdir(path.dirname(dbFile), {recursive: true});
      await backupBeforeMigration();
      const conn = await openLibraryDb({file: dbFile, onWarn, importer: options.dbImporter});
      dbProbed = true;
      if (!conn) { dbHealthy = false; dbFailure = 'SQLite 驱动未加载（详见服务端日志）'; }
      else dbFailure = null;
      return conn;
    } catch (error) {
      // 一次失败就钉死降级：同一个进程里 ABI 不会自己变好，重试只会白烧一次 dlopen。
      dbHealthy = false; dbProbed = true; dbFailure = error.message;
      onWarn(`资产库内核不可用，已退回文件模式：${error.message}`);
      return null;
    }
  }

  /** 供 /api/health 暴露：让「SQLite 其实没在跑」变成一眼可见的事实。 */
  function dbStatus() {
    return {
      engine: options.disableDb === true ? 'file' : (dbFailure ? 'file' : (dbProbed ? 'sqlite' : 'pending')),
      healthy: dbHealthy && dbProbed,
      reason: dbFailure,
      nodeAbi: process.versions.modules,
      catalog: options.disableDb === true || !catalogFromDb ? 'blob' : (dbHealthy && dbProbed ? 'db' : 'pending'),
      // ADR-09 单一写入权威是否真的生效：DB 没探测过 / 挂了时会自动退回旧双轨。
      writer: singleWriter && dbHealthy && dbProbed ? 'db' : 'legacy',
    };
  }

  /**
   * 服务端当前权威 values：**逐域**比较文件与 DB，谁新用谁。
   *
   * 单个 snapshot_at 撑不住多域：会话域刚写完、目录域还是三小时前的，
   * 用一个时间戳判断就会整体回退或整体跳过。现在按域比 state_meta 的 updated_at。
   */
  async function authoritative(snapshot) {
    const values = {...snapshot.values};
    const conn = await openDb();
    if (!conn) return values;
    try {
      // 逐域版本戳走 db_meta（小表）。以前无条件 `SELECT key, value, updated_at FROM state_meta`
      // 会把目录域的 209MB 原串搬进内存 —— 50 万库上光这一句就是 680ms，
      // 记一次搜索历史被拖到 7 秒。现在只有「DB 确实比文件新」才去取那一行的 value。
      const stampRows = conn.all(`SELECT key, value FROM db_meta WHERE key LIKE '${STATE_STAMP_PREFIX}%'`);
      const stamps = new Map(stampRows.map(row => [row.key.slice(STATE_STAMP_PREFIX.length), Number(row.value) || 0]));
      // 老库还没写过轻量戳：读一次 state_meta 的时间戳补齐，之后都走快路径（无需迁移）。
      let legacy = null;
      if (!stamps.size) {
        legacy = new Map(conn.raw('SELECT key, updated_at FROM state_meta')
          .map(row => [row.key, Number(row.updated_at) || 0]));
      }
      for (const key of STATE_KEYS) {
        const dbStamp = stamps.get(key) ?? legacy?.get(key) ?? 0;
        const fileStamp = Number(snapshot.mtimes[key] || 0);
        if (dbStamp <= fileStamp) continue;
        // 文件缺失时 fileStamp=0，这一步同时保住「域快照丢失从 state_meta 恢复」。
        const value = conn.all('SELECT value FROM state_meta WHERE key = ?', [key])[0]?.value;
        if (typeof value === 'string') values[key] = value;
      }
      if (legacy) for (const [key, stamp] of legacy) conn.setMeta(stateStampKey(key), String(stamp));
    } catch (error) {
      onWarn(`资产库索引读取失败，改用文件快照：${error.message}`);
    } finally { conn.close(); }
    return values;
  }

  /**
   * 原子写盘 + 同步 DB 索引：整块写入与增量写入共用，持久化行为不分叉。
   *
   * **只写变化的域**：目录域没动就不碰它，写会话域不会重写 209MB 的目录文件。
   */
  async function commitValues(merged, {derived = true, syncUser = false} = {}) {
    const current = await readSnapshot();
    // ADR-09：先探测 DB 再决定剥离。冷启动第一次整块写入时 dbProbed 尚未置位，
    // 拿「已探测」当条件会漏掉这一次，过期目录又回到文件里，复活风险照样在。
    const conn = await openDb();
    const stripped = singleWriter && !!conn;
    const changed = [];
    // 文件里存剥离版（目录归 assets 表独占），但 DB 索引必须收到本次的真实值：
    // 派生索引正是从目录 blob 建出来的，把 models: [] 喂给 mergeDerived 等于清空整库索引。
    // 5.5 把两件事混成一条 `changed` 后踩过这个坑 —— 老库首次保存，索引直接变 0 条。
    const indexPatch = {};
    for (const [key, value] of Object.entries(merged)) {
      if (!STATE_KEYS.includes(key) || typeof value !== 'string') continue;
      // ADR-09：单一写入权威。目录字段由 assets 表独占，主 blob 只承载用户 / 会话 / 探测域。
      // 这是所有写路径（整块 save / mutate / 降级重放）的统一收口，放在这里才不会漏。
      const persisted = key === MAIN_STATE_KEY && stripped
        // 非目录字段以本次写入为准、缺的从当前快照补齐：前端降级重放发来的
        // 「纯目录 blob」只有 version/models/trashed，直接写盘会把评分 / 标签抹掉。
        ? JSON.stringify({...parseMainState(current.values[MAIN_STATE_KEY]), ...parseMainState(value), models: [], trashed: []})
        : value;
      // legacyOnly 的值虽然内容相同，但它还没有自己的域文件、也没进过 DB：
      // 首次 save 必须真正落盘并建索引，否则读到的「相同」只是旧文件里的回声。
      if (current.values[key] === persisted && !current.legacyOnly.has(key)) continue;
      changed.push([key, persisted]);
      indexPatch[key] = value;
    }
    if (!changed.length) { conn?.close(); return; }
    await fs.mkdir(stateDir, {recursive: true});
    const stamps = {};
    let stamp = 0;
    for (const [key, value] of changed) {
      const target = fileFor(key);
      await fs.writeFile(target + '.tmp', JSON.stringify(value));
      await fs.rename(target + '.tmp', target);
      const stat = await fs.stat(target);
      // 每个域用**自己文件**的 mtime 当版本戳：一批同时写目录域与会话域时，
      // 共用 max stamp 会让目录域的戳虚高，读权威时误判「DB 更新」而白搬 209MB。
      stamps[key] = stat.mtimeMs;
      if (stat.mtimeMs > stamp) stamp = stat.mtimeMs;
    }
    if (!conn) return;
    try {
      // 只把变化的那几个 key 交给 DB；state_meta 是逐 key 的，所以这里天然是增量的。
      await conn.writeValues(indexPatch, {replace: false, stamp, stamps, derived, syncUser});
    } catch (error) { onWarn(`资产库索引写入失败，文件快照仍然有效：${error.message}`); }
    finally { conn.close(); }
  }

  /**
   * 确保派生索引至少和文件快照一样新。
   *
   * 这是**所有读写路径的公共前置**：旧版单文件刚升级、上次写 DB 失败、外部改了状态文件，
   * 都会让 DB 落后于文件。不做这一步，集合语义写入会作用在空表上 —— 打标签「成功」
   * 但资产根本不存在，数据就这么静默丢了。
   *
   * 幂等判据是逐域的 state_meta.updated_at 与文件 mtime：已经追上就只付一条 SELECT 的代价。
   * 注意此函数不能被 queue.then() 内部调用（会自锁），必须在排队之前 await。
   */
  async function ensureIndex() {
    await queue;
    return ensureIndexNow();
  }

  // 已占有写队列时不能再等待 queue，否则会等待自己。
  async function ensureIndexNow() {
    const snapshot = await readSnapshot();
    const conn = await openDb();
    if (!conn) return false;
    try {
      // 合并语义下「自愈」就是把目录域重新合并一遍：
      // 文件里有的资产补进派生表，DB 里多出来的资产原样留着。
        const catalog = snapshot.values[MAIN_STATE_KEY];
        const stamp = Number(snapshot.mtimes[MAIN_STATE_KEY] || 0);
        if (typeof catalog === 'string' && stamp) {
          // 先查轻量戳；老库没有就回退读一次 state_meta 并补齐，避免每次都扫那行 209MB 记录。
          let dbStamp = Number(conn.getMeta(stateStampKey(MAIN_STATE_KEY)) || 0);
          if (!dbStamp) {
            const rows = conn.all('SELECT updated_at FROM state_meta WHERE key = ?', [MAIN_STATE_KEY]);
            dbStamp = Number(rows[0]?.updated_at || 0);
            if (dbStamp) conn.setMeta(stateStampKey(MAIN_STATE_KEY), String(dbStamp));
          }
          if (dbStamp < stamp) {
            await conn.writeValues({[MAIN_STATE_KEY]: catalog},
              {replace: false, stamp, stamps: {[MAIN_STATE_KEY]: stamp}, derived: true});
            await conn.setMeta('snapshot_at', String(stamp));
          }
        }
      return true;
    } catch (error) {
      onWarn(`资产库索引同步失败：${error.message}`);
      return true;
    } finally { conn.close(); }
  }

  return {
    /** 数据目录：备份服务要知道把快照写到哪。 */
    dataDir,
    /** 状态目录：备份要把整个目录一起带走。 */
    stateDir,
    dbStatus,
    /** ADR-09：启动按页目录 / 全选 uid 集合；DB 不可用时返回 null，前端整块重放。 */
    async catalogPage(offset, limit) {
      await ensureIndex();
      const conn = await openDb();
      if (!conn) return null;
      try { return conn.readCatalogPage(Number(offset) || 0, Number(limit) || 200); }
      catch (error) { onWarn(`资产库目录分页读取失败：${error.message}`); return null; }
      finally { conn.close(); }
    },
    async catalogUids() {
      await ensureIndex();
      const conn = await openDb();
      if (!conn) return null;
      try { return conn.readCatalogUids('active'); }
      catch (error) { onWarn(`资产库 uid 集合读取失败：${error.message}`); return null; }
      finally { conn.close(); }
    },
    async load({catalogPaged = false} = {}) {
      await ensureIndex();
      const snapshot = await readSnapshot();
      const values = await authoritative(snapshot);
      // 用户域的权威在 DB：前端刷新后要拿回自己的评分 / 备注 / 标签 / 收藏。
      // 文件里的用户域只是首次入库的种子，读取时一律以 DB 为准。
      let dbCatalog = null;
      const conn = await openDb();
      if (conn) {
        try {
          const domain = conn.readUserDomain();
          // 空域不能覆盖主 blob：老库的用户数据本来就躺在 sfx-library-v2 里，
          // 拿一份全空的 DB 结果去合并会把它们清掉。
          const hasUser = domain && (
            Object.keys(domain.userMeta || {}).length || Object.keys(domain.userTags || {}).length ||
            Object.keys(domain.aiTags || {}).length || (domain.favorites || []).length);
          if (hasUser) values[USER_STATE_KEY] = JSON.stringify(domain);
        } catch (error) { onWarn(`资产库用户域读取失败：${error.message}`); }
        finally { conn.close(); }
      }
      // ADR-07：目录域读视图改由 DB 合成。用户域读取失败不能连累目录，
      // 所以另开一条短连接；读失败只告警，沿用文件快照，绝不阻断启动。
      if (catalogFromDb) {
        const readConn = await openDb();
        if (readConn) {
          try { dbCatalog = readConn.readCatalog(); }
          catch (error) { onWarn(`资产库目录读取失败，已沿用文件快照：${error.message}`); }
          finally { readConn.close(); }
        }
      }
      /**
       * 给旧前端一份「看得全」的视图：把用户 / 探测 / 会话三个域合并回主 blob。
       * 前端的 loadLibrary() 只读 sfx-library-v2，不认新域 key；不做这一步，
       * 刷新后评分与搜索历史就会退回旧值。合并只是**读视图**，权威仍是各自的域。
       */
      const hasDomains = [USER_STATE_KEY, PROBE_STATE_KEY, SESSION_STATE_KEY]
        .some(key => Object.keys(parseMainState(values[key])).length);
      if (hasDomains) {
        const merged = mergeDomains(values);
        const base = parseMainState(values[MAIN_STATE_KEY]);
        // 只有合并真的带来内容变化才替换字符串：键顺序重排也会改字节，
        // 而「save 后 load 逐字节还原」是前端 diff 依赖的硬契约。
        const changed = Object.keys(merged).some(key => JSON.stringify(base[key]) !== JSON.stringify(merged[key]))
          || Object.keys(base).some(key => !Object.hasOwn(merged, key));
        if (changed) values[MAIN_STATE_KEY] = JSON.stringify(merged);
      }
      /**
       * ADR-07：目录域读视图以 DB 为权威。DB 里有、blob 里没有的行是 5.1 合并语义留下的
       * 合法历史资产，必须让前端看见；顺序按服务端分配的 position 而不是 blob 数组下标。
       * 三道闸：DB 目录为空不接管、只有内容真变了才换字符串、读失败 / 回退开关走旧视图。
       */
      if (dbCatalog && (dbCatalog.models.length || dbCatalog.trashed.length)) {
        const base = parseMainState(values[MAIN_STATE_KEY]);
        const same = JSON.stringify(base.models) === JSON.stringify(dbCatalog.models)
          && JSON.stringify(base.trashed) === JSON.stringify(dbCatalog.trashed);
        if (!same) values[MAIN_STATE_KEY] = JSON.stringify({
          ...base, version: base.version ?? 2, models: dbCatalog.models, trashed: dbCatalog.trashed,
        });
      }
      const jobs = (downloads?.snapshot().jobs || []).filter(job => job.state === 'saved' && job.fileExists);
      const result = {...await restoreLibraryCovers(values, jobs.map(job => ({...job, addedAt: job.finishedAt || Date.now(), downloadable: true})), path.join(dataDir, 'http-cache', 'json')), scanIndex: true};
      /**
       * ADR-09：按页启动的读视图不再携带整份目录。回收站（trashed）小而完整，照旧随主状态
       * 一起给；models 交给 GET /api/library/catalog/page 分批取。DB 没起来时不给瘦身视图，
       * 免得前端拿到空目录又拿不到分页接口，直接白屏。
       */
      if (catalogPaged && catalogFromDb) {
        const conn = await openDb();
        if (conn) {
          let total = 0;
          try { total = conn.readCatalogPage(0, 1).total; }
          catch (error) { onWarn(`资产库目录计数失败：${error.message}`); }
          finally { conn.close(); }
          const paged = parseMainState(result.values[MAIN_STATE_KEY]);
          paged.models = [];
          result.values = {...result.values, [MAIN_STATE_KEY]: JSON.stringify(paged)};
          result.catalogPaged = true;
          result.catalogTotal = total;
        }
      }
      return result;
    },
    save(values) {
      validateValues(values);
      const write = queue.then(async () => {
        const current = await authoritative(await readSnapshot());
        const merged = {...current, ...values};
        // 目录域走合并：前端只持有它看到的那部分，直接替换会把服务端的目录缩小。
        // ADR-09 单一写入权威下目录根本不落主 blob（commitValues 统一剥离），
        // 这里再做一次合并只是白读 dropped-uids，且会把过期目录带进写盘前的字符串。
        if (!singleWriter && typeof merged[MAIN_STATE_KEY] === 'string' && typeof current[MAIN_STATE_KEY] === 'string') {
          merged[MAIN_STATE_KEY] = mergeCatalog(current[MAIN_STATE_KEY], merged[MAIN_STATE_KEY], await readDropped());
        }
        // 整块保存的语义就是「以这份 blob 为准」：用户域必须同步进 DB，
        // 否则读视图会被 DB 里的旧值盖回去（整块写入与读视图互相打架）。
        await commitValues(merged, {syncUser: true});
      });
      queue = write.catch(() => {}); return write;
    },
    /**
     * 阶段 4 增量写入：在 save 队列内做 read-modify-write，transform 只拿到当前权威 values，
     * 返回新的完整 values（或 null 表示无变化）。与整块 save 串行，不会互相踩；
     * 写盘与索引同步复用 commitValues，DB 不可用时自动退回纯文件模式。
     *
     * derived=false：只改与派生表无关的字段（搜索历史 / 任务 / 选项）时用 ——
     * 省掉整表重建（50 万资产时重建要 242 秒）。
     */
    async dropCatalog(uids) {
      const list = [...new Set((Array.isArray(uids) ? uids : []).map(item => String(item || '')).filter(Boolean))];
      if (!list.length) return {dropped: 0};
      const dropped = await readDropped();
      for (const uid of list) dropped.add(uid);
      await fs.mkdir(stateDir, {recursive: true});
      await fs.writeFile(path.join(stateDir, 'dropped-uids.json'), JSON.stringify([...dropped]));
      await this.mutate(values => {
        const blob = parseMainState(values[MAIN_STATE_KEY]);
        const keep = item => !dropped.has(item?.uid);
        if (Array.isArray(blob.models)) blob.models = blob.models.filter(keep);
        if (Array.isArray(blob.trashed)) blob.trashed = blob.trashed.filter(keep);
        if (Array.isArray(blob.favorites)) blob.favorites = blob.favorites.filter(uid => !dropped.has(uid));
        for (const key of ['userMeta', 'userTags', 'aiTags']) {
          if (blob[key] && typeof blob[key] === 'object') for (const uid of list) delete blob[key][uid];
        }
        return {...values, [MAIN_STATE_KEY]: JSON.stringify(blob)};
      });
      await this.withDb(conn => conn.removeAssets(list, {actor: 'local'}));
      return {dropped: list.length};
    },
    mutate(transform, options = {}) {
      if (typeof transform !== 'function') throw Error('缺少变更函数');
      const write = queue.then(async () => {
        const current = await authoritative(await readSnapshot());
        const next = await transform(current);
        if (!next || next === current) return null;
        await commitValues(validateValues(next), options);
        return next;
      });
      queue = write.catch(() => {}); return write;
    },
    /**
     * 阶段 5.1 / ADR-05：目录域定点写（asset:add / asset:patch / asset:remove）。
     *
     * 与 mutateTags 一样不碰 blob、不重建整表，代价 = 受影响的资产行数。
     * DB 不可用时返回 fallback:true，调用方改用整块通道（兼容层，5.5 才拆）。
     */
    async mutateAssets(ops, {actor = 'system', syncBlob = false} = {}) {
      if (!Array.isArray(ops) || !ops.length) return {applied: 0, changes: [], conflicts: []};
      await ensureIndex();
      const write = queue.then(async () => {
        const conn = await openDb();
        if (!conn) {
          onWarn('资产库内核不可用，asset:* 增量写入已跳过');
          return {applied: 0, changes: [], conflicts: [], fallback: true};
        }
        try {
          return conn.applyAssetOps(ops, {actor, syncBlob});
        } catch (error) {
          onWarn(`资产库 asset:* 写入失败：${error.message}`);
          throw error;
        } finally { conn.close(); }
      });
      queue = write.catch(() => {});
      return write;
    },
    /**
     * S3：集合语义增量写（打标签 / 改评分备注收藏）。
     *
     * 与 mutate 的区别是**不重建派生表**：派生表的定点更新由内核的 applyTagOps 完成。
     * 用户域的权威在 DB，所以这里**不写任何状态文件** ——
     * 打一个标签的写入代价是「受影响的行数」，与库大小、与目录域体积都无关。
     *
     * 批量导入时逐条写是浪费，所以内部按批事务提交（applyTagOps 一次事务搞定）。
     */
    async mutateTags(ops, {actor = 'system'} = {}) {
      if (!Array.isArray(ops) || !ops.length) return {applied: 0, changes: [], conflicts: []};
      // 定点写的前提是派生表已经追上文件快照；必须在排队前 await，否则自锁。
      await ensureIndex();
      const write = queue.then(async () => {
        const conn = await openDb();
        if (!conn) {
          onWarn('资产库内核不可用，集合语义写入已跳过');
          return {applied: 0, changes: [], conflicts: [], fallback: true};
        }
        try {
          return conn.applyTagOps(ops, {actor});
        } catch (error) {
          onWarn(`资产库增量写入失败：${error.message}`);
          throw error;
        } finally { conn.close(); }
      });
      queue = write.catch(() => {});
      return write;
    },
    /**
     * 整库写入与 save / mutateAssets / mutateTags 共用队列，单连接单事务。
     * handler 只调用 conn，禁止调用 storage 排队 API；内核事务会嵌套为 savepoint。
     * 不写状态文件：读视图变更由 handler 同事务写 state_meta 及版本戳。
     */
    withDbWrite(handler) {
      if (typeof handler !== 'function') throw Error('缺少变更函数');
      const write = queue.then(async () => {
        await ensureIndexNow();
        const conn = await openDb();
        if (!conn) throw Error('数据库不可用，无法执行资产库事务');
        try {
          conn.run('BEGIN IMMEDIATE');
          try {
            const result = await handler(conn);
            conn.run('COMMIT');
            return result;
          } catch (error) {
            try { conn.run('ROLLBACK'); } catch { /* 保留原始错误 */ }
            throw error;
          }
        } finally { conn.close(); }
      });
      queue = write.catch(() => {});
      return write;
    },
    /**
     * 在写队列内执行一个**不打开 DB 连接**的动作。
     * 替换库文件这类操作需要独占文件句柄（Windows 上被占用时 rename 会失败），
     * 放进队列里才能保证此刻没有新的写入排队进来。
     */
    async exclusive(action) {
      if (typeof action !== 'function') throw Error('缺少动作');
      const write = queue.then(async () => action());
      queue = write.catch(() => {});
      return write;
    },
    /**
     * 阶段 2 查询接口共用的短连接缝：一次请求开一条连接、用完即关，写入也会排在本实例的
     * save 队列之后，不会和 /api/library-state 的整块写入互相踩。DB 不可用时返回 null。
     */
    async withDb(handler) {
      await queue;
      await ensureIndex();
      const conn = await openDb();
      if (!conn) return null;
      try { return await handler(conn); } finally { conn.close(); }
    },
    /** 内存降级路径的原始快照：查询层可直接从 blob 派生出与 DB 同形的行。 */
    async readRawState() { return (await readSnapshot()).values; },
    /** 确保派生索引至少和文件快照一样新（上次写 DB 失败后可在下次查询时自愈）。 */
    ensureIndex,
    // 短连接无需外部关闭；保留接口是为了让调用方在阶段 3 换成长连接时不用改。
    async close() {},
  };
}
