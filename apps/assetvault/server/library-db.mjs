// 资产库内核：better-sqlite3 的唯一持有者（业务只依赖本模块导出的接口）。
//
// 原生模块用「动态 import + 惰性打开」加载：ABI 不匹配 / 缺依赖时只是拿不到 DB，
// 上层自动退回原来的 library-state.json，服务照常启动 —— 绝不因为新内核挡住主人用工具。
// 依赖可注入（Database / now / onWarn），测试不必碰真实数据目录。
// 桌面版由 sidecar-server/node_modules 提供原生模块（装配见 desktop scripts/copy-sqlite-native.mjs）；
// 默认裸导入让 Node 自己逐级向上解析，不写死任何绝对路径。
import {createRequire} from 'node:module';
import {V11_ADD_SEED_KEY} from './schema/v11-seed-key-compat.mjs';
import {MIGRATIONS, SUPPORTED_SCHEMA_VERSION, MAIN_STATE_KEY, PROBE_STATE_KEY, STATE_KEYS, STATE_STAMP_PREFIX, stateStampKey, planMigrations} from './library-schema.mjs';
import {assembleState, splitState, categoryTextOf} from './library-blob.mjs';
import {probeOfModel} from './model-probe.mjs';
import {syncVocab} from './vocab-sync.mjs';
import {createTagWriter} from './library-tags-write.mjs';
import {createLocationRegistry} from './file-locations.mjs';
import {anchorPackage} from './asset-claim.mjs';
import {localPlatformCover} from './platform-cover.mjs';
// 归一化键必须与词表种子用同一套规则（NFKC + 压空白 + 小写），
// 否则全角/多空格的标签在库里查不到别名，检索文本也会与内存侧对不上。
import {normOf, compareBinary} from './library-vocab.mjs';

const WARN = () => {};

/** 同步建核。Database 由调用方注入，避免模块顶层静态加载原生依赖。 */
export function createLibraryDb({Database, file, now = Date.now, onWarn = WARN} = {}) {
  if (typeof Database !== 'function') throw Error('缺少 SQLite 驱动');
  if (!file) throw Error('缺少资产库文件路径');
  const db = new Database(file);
  // 单文件日志模式（不用 WAL）：库数据目录现在住在资产根里，会跟着整库被拷走、
  // 被网盘/微力同步搬运。WAL 的 .db/.db-wal/.db-shm 三个文件必须同进同退，
  // 同步工具只按文件搬运，漏一个或版本错位就是一份撕裂的库。成熟素材库
  // （Billfish 的 .bf/billfish.db）同样用单文件模式。切回单文件时 SQLite 会
  // 自动 checkpoint 并删掉遗留的 -wal/-shm。
  db.pragma('journal_mode = DELETE');
  // 单文件模式下 NORMAL 在断电瞬间仍有极小概率留下坏页；库要能"拔了就走"，
  // 这里用 FULL 换确定性。写入频率是单人操作量级，fsync 开销无感。
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');

  // 迁移失败必须先把连接关掉再抛，否则 Windows 上 .db 文件会被句柄锁住、无法清理或替换。
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('schema_migrations')").all();
    const applied = columns.length ? db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() : [];
    const pending = planMigrations(applied, MIGRATIONS);
    if (pending.length) db.transaction(() => {
      for (const item of pending) {
        // 记录语句必须等建表 SQL 执行完才能 prepare（表本来就不存在）。
        const sql=item.version===11&&db.prepare("SELECT 1 FROM pragma_table_info('tag_terms') WHERE name='seed_key'").get()
          ?item.sql.replace(V11_ADD_SEED_KEY,''):item.sql;
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
          .run(item.version, item.name, item.checksum, new Date(now()).toISOString());
      }
    })();
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }

  // 词表同步是「数据对齐」，不是迁移：rev 没变直接返回。失败只告警不阻断 ——
  // 词表挂掉的时候，标签仍应按原样可用，不能因为分类体系没对齐就让整个库打不开。
  let vocabState = null;
  try { vocabState = syncVocab(db, {now}); }
  catch (error) { onWarn(`词表同步失败，标签按原样使用：${error.message}`); }

  /**
   * 词表版本变了就要重算检索文本：它内含标准名与别名，词表一变内容就跟着变。
   * 一条 UPDATE 覆盖全表（20 万条实测 4.3s），只在词表真的变了时才跑。
   * SQL 侧的集合与排序规则和 rebuildDerived 里的 JS 版完全一致（同样的 token、同样的码点序）。
   */
  function refreshSearchText() {
    const update = db.prepare(`UPDATE assets SET tags_text = (SELECT group_concat(x, ' ') FROM (
      SELECT DISTINCT x FROM (
        SELECT tg.tag AS x FROM tags tg WHERE tg.uid = assets.uid
        UNION ALL
        SELECT t2.value AS x FROM asset_tags at2 JOIN tag_terms t2 ON t2.term_id = at2.term_id WHERE at2.uid = assets.uid
        UNION ALL
        SELECT ta.alias_norm AS x FROM asset_tags at3 JOIN tag_aliases ta ON ta.term_id = at3.term_id WHERE at3.uid = assets.uid
      ) ORDER BY x COLLATE BINARY))`);
    db.transaction(() => update.run())();
  }
  if (vocabState?.applied) {
    try { refreshSearchText(); }
    catch (error) { onWarn(`检索文本重算失败，标签检索可能不完整：${error.message}`); }
  }

  const upsertState = db.prepare('INSERT INTO state_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  /**
   * ADR-02 合并写入：目录域的列随 blob 走，用户域的列（rating / note / favorite）不动。
   * rev 也不动 —— 它是并发版本号，派生层不该替用户改自己的版本。
   */
  const upsertAsset = db.prepare(`INSERT INTO assets
    (uid, position, state, payload, name, author, url, platform, thumbnail, rating, note, favorite, added_at, trashed_at, source,
     kind, width, height, long_edge, bytes, color_h, duration, content_hash, rev, updated_at, tags_text,
     category_text, downloadable)
    VALUES (@uid, @position, @state, @payload, @name, @author, @url, @platform, @thumbnail, @rating, @note, @favorite, @added_at, @trashed_at, @source,
     @kind, @width, @height, @long_edge, @bytes, @color_h, @duration, @content_hash, @rev, @updated_at, @tags_text,
     @category_text, @downloadable)
    ON CONFLICT(uid) DO UPDATE SET
      position = excluded.position, state = excluded.state, payload = excluded.payload,
      name = excluded.name, author = excluded.author, url = excluded.url, platform = excluded.platform,
      thumbnail = excluded.thumbnail, added_at = excluded.added_at, trashed_at = excluded.trashed_at,
      kind = excluded.kind, width = excluded.width, height = excluded.height, long_edge = excluded.long_edge,
      bytes = excluded.bytes, color_h = excluded.color_h, duration = excluded.duration,
      content_hash = excluded.content_hash, updated_at = excluded.updated_at, tags_text = excluded.tags_text,
      category_text = excluded.category_text, downloadable = excluded.downloadable`);
  const selAssetRow = db.prepare('SELECT rowid, uid, rating, note, favorite, name, author, platform FROM assets WHERE uid = ?');
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (uid, kind, tag) VALUES (?, ?, ?)');
  const delPlatformTags = db.prepare("DELETE FROM tags WHERE uid = ? AND kind = 'platform'");
  const delAssetTags = db.prepare('DELETE FROM asset_tags WHERE uid = ?');
  const delPlatformAssetTags = db.prepare("DELETE FROM asset_tags WHERE uid = ? AND source = 'platform'");
  /** 遗留整块通道改用户域时，先清掉旧的用户/AI 数据再按 blob 重建。 */
  const delUserAiTags = db.prepare("DELETE FROM tags WHERE uid = ? AND kind IN ('user','ai')");
  const delUserAiAssetTags = db.prepare("DELETE FROM asset_tags WHERE uid = ? AND source IN ('user','ai')");
  const selAssetTerms = db.prepare('SELECT term_id FROM asset_tags WHERE uid = ?');
  const updateUserColumns = db.prepare('UPDATE assets SET rating = ?, note = ?, favorite = ? WHERE uid = ?');
  const delFormats = db.prepare('DELETE FROM asset_formats WHERE uid = ?');
  const countTerm = db.prepare('SELECT count(DISTINCT uid) AS n FROM asset_tags WHERE term_id = ?');
  const insertFts = db.prepare('INSERT INTO assets_fts (rowid, uid, body) VALUES (?, ?, ?)');
  const delFts = db.prepare('DELETE FROM assets_fts WHERE rowid = ?');
  const insertFormat = db.prepare('INSERT OR IGNORE INTO asset_formats (uid, ext) VALUES (?, ?)');
  const insertAssetTag = db.prepare(`INSERT OR IGNORE INTO asset_tags
    (uid, term_id, source, model_version, created_at, created_by)
    VALUES (@uid, @term_id, @source, @model_version, @created_at, @created_by)`);
  // 词表解析只读这三条：别名优先于 canonical，merged 词条追到 merged_into。
  const findTerm = db.prepare('SELECT term_id, status, merged_into FROM tag_terms WHERE norm = ?');
  const findAlias = db.prepare('SELECT term_id FROM tag_aliases WHERE alias_norm = ?');
  const insertTerm = db.prepare("INSERT INTO tag_terms (value, norm, status, created_at) VALUES (?, ?, 'pending', ?)");
  const getMetaStmt = db.prepare('SELECT value FROM db_meta WHERE key = ?');
  const setMetaStmt = db.prepare('INSERT INTO db_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  /**
   * V5 一次性回填：老库的 category_text / downloadable 都是新列，默认值分别是 NULL / 0。
   * 不回填的后果不是「慢」而是「筛不到」：用户点「分类」会拿到空集，而内存降级路径
   * 又能筛出来 —— 两条路径分叉，比性能问题难查十倍。
   *
   * 逐行 JSON.parse 是有意的：复用 library-blob 的 categoryTextOf，绝不在 SQL 里用
   * json_extract 复刻一套分类规则（那就是第二套语义，迟早漂移）。
   * db_meta 标记保证只跑一次；失败由调用方告警，不阻断打开库。
   */
  function backfillDeriveColumns() {
    if (getMetaStmt.get('derive_v5')?.value) return 0;
    const rows = db.prepare('SELECT uid, payload FROM assets').all();
    const update = db.prepare('UPDATE assets SET category_text = ?, downloadable = ? WHERE uid = ?');
    let changed = 0;
    db.transaction(() => {
      for (const row of rows) {
        let model;
        try { model = JSON.parse(row.payload); } catch { continue; }
        if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
        update.run(categoryTextOf(model), model.downloadable === true ? 1 : 0, row.uid);
        changed++;
      }
      setMetaStmt.run('derive_v5', String(now()));
    })();
    return changed;
  }
  try {
    const filled = backfillDeriveColumns();
    if (filled) onWarn(`已回填 ${filled} 条资产的分类 / 可下载列（V5 一次性迁移）`);
  } catch (error) { onWarn(`分类列回填失败，分类筛选可能为空：${error.message}`); }

  /**
   * 目录读投影的瘦身（阶段 5.6 的内存裁剪）。
   *
   * 实测（本机 54 条真实资产 = 213KB）：下载任务的 `logs` 占 71KB、`verification` 占 56KB
   * —— 合起来 59% 的目录体积，而卡片渲染一个字段都用不到，它们只属于「下载详情」。
   * 5.5 之后目录是唯一的浏览工作集，这部分会随资产线性增长（50 万条 ≈ 700MB 纯日志）。
   *
   * 只删这两个字段：filePath / bytes / attempts / fileExists 仍被卡片与右键菜单读，
   * 详情要日志时走下载任务接口（jobs 域），不从目录里捞。
   * 副作用（已写进 ADR-11）：整库导出的快照也不再带下载日志 —— 本来就该是语义快照。
   */
  function slimCatalogModel(model) {
    if (!model || typeof model !== 'object') return model;
    if (Object.hasOwn(model, 'logs')) delete model.logs;
    if (Object.hasOwn(model, 'verification')) delete model.verification;
    return model;
  }

  /**
   * 查询下推的语句缓存。SQL 由 query-sql.mjs 编译，形态只有几十种（条件组合 × 排序），
   * 每次请求重新 prepare 是白扔编译开销。缓存只按 SQL 文本命中，参数数量随之确定。
   */
  const statements = new Map();
  function prepared(sql) {
    let statement = statements.get(sql);
    if (statement) return statement;
    if (statements.size > 64) statements.clear();
    statement = db.prepare(sql);
    statements.set(sql, statement);
    return statement;
  }

  /**
   * 强制走排序索引的命中量门槛。
   *
   * 低于这个数就不强制：命中稀疏时沿索引顺序扫要扫很久才凑不满一页，
   * 比原来的「物化命中集再排序」更慢。门槛以上强制，门槛以下维持原样 ——
   * 这样即使门槛设得不准，最坏也只是「没拿到加速」，不会比原来更差。
   * 环境变量 AV_INDEX_SCAN_MIN_ROWS 可覆盖（0 = 完全关闭强制索引）。
   */
  function indexScanThreshold() {
    const raw = Number(process.env.AV_INDEX_SCAN_MIN_ROWS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 1000;
  }

  /**
   * 当前页的 uid。命中足够多时强制走排序索引，沿索引顺序扫、凑够一页就停。
   * 失败即退回自然计划：INDEXED BY 满足不了 ORDER BY 时 SQLite 会在 prepare 阶段报错，
   * 那是安全失败路径，绝不产出错序结果。
   */
  function pageUidRows(plan, total) {
    const natural = () => prepared(`SELECT a.uid FROM assets a WHERE ${plan.where} ORDER BY ${plan.orderBy} LIMIT ? OFFSET ?`)
      .all(...plan.params, plan.limit, plan.offset);
    const hint = plan.indexHint;
    const threshold = indexScanThreshold();
    if (!hint || threshold <= 0 || total < threshold) return natural();
    try {
      return prepared(`SELECT a.uid FROM assets a INDEXED BY ${hint} WHERE ${plan.where} ORDER BY ${plan.orderBy} LIMIT ? OFFSET ?`)
        .all(...plan.params, plan.limit, plan.offset);
    } catch (error) {
      onWarn(`排序索引 ${hint} 不适用于当前查询（${error.message}），已退回默认查询计划`);
      return natural();
    }
  }

  /**
   * 命中总数。COUNT 与分页用同一份 WHERE，所以 total 与 items 永远不会对不上。
   *
   * 强制走统一覆盖索引时，COUNT 变成纯索引扫描，不必逐行回表：
   * 50 万条实测，平台+类型+评分 3010ms → 52ms，关键词检索 3868ms → 548ms。
   * 覆盖索引满足不了 WHERE 时 SQLite 会报错，那是安全失败：捕获后退回自然计划。
   */
  function countRows(plan) {
    const natural = () => Number(
      prepared(`SELECT count(*) AS n FROM assets a WHERE ${plan.where}`).get(...plan.params).n) || 0;
    const hint = plan.countIndexHint;
    if (!hint) return natural();
    try {
      return Number(
        prepared(`SELECT count(*) AS n FROM assets a INDEXED BY ${hint} WHERE ${plan.where}`).get(...plan.params).n) || 0;
    } catch (error) {
      onWarn(`覆盖索引 ${hint} 不适用于当前查询（${error.message}），已退回默认查询计划`);
      return natural();
    }
  }

  /**
   * 词表解析：norm 命中走 canonical，别名次之，都没有就建 pending 词条。
   * pending 不阻塞写入 —— 归一化是后台审计的事，不该成为用户打标的前置条件。
   * cache 只在一次重建内有效：词条可能被审计面板合并，跨次缓存会指向已 merged 的 term_id。
   */
  function resolveTerm(value, cache, stamp) {
    const norm = normOf(value);
    if (!norm) return null;
    if (cache.has(norm)) return cache.get(norm);
    let termId = findAlias.get(norm)?.term_id ?? null;
    if (!termId) {
      const hit = findTerm.get(norm);
      if (hit) termId = hit.status === 'merged' && hit.merged_into ? hit.merged_into : hit.term_id;
    }
    if (!termId) termId = Number(insertTerm.run(String(value).trim(), norm, stamp).lastInsertRowid);
    cache.set(norm, termId);
    return termId;
  }

  /** V2 新增列对老派生行必须有默认值，否则绑定命名参数会直接抛错。 */
  const locations = createLocationRegistry(db);
  // 一次性兼容认领旧本地资产。保留 UID / 用户域；异常定位留在原记录中等待诊断。
  if (getMetaStmt.get('file-locations-v1')?.value !== '1') try { db.transaction(() => {
    const update = db.prepare('UPDATE assets SET payload = ? WHERE uid = ?');
    const page = db.prepare('SELECT rowid,uid,payload FROM assets WHERE rowid>? ORDER BY rowid LIMIT 256');
    let cursor = 0;
    for (;;) {
      const rows = page.all(cursor);
      if (!rows.length) break;
      for (const row of rows) {
        let model;
        try { model = JSON.parse(row.payload); } catch { continue; }
        if (!model || typeof model !== 'object' || !model.localRoot) continue;
        update.run(JSON.stringify(locations.apply({...model, uid: row.uid})), row.uid);
      }
      cursor = rows.at(-1).rowid;
    }
    setMetaStmt.run('file-locations-v1', '1');
  })(); } catch(error) { db.close(); throw error; }
  const withAssetDefaults = row => ({
    kind: null, width: null, height: null, long_edge: null, bytes: null,
    color_h: null, duration: null, content_hash: null, rev: 1, updated_at: row.added_at,
    tags_text: null, category_text: null, downloadable: 0,
    ...row,
  });

  /**
   * 检索文本：原始标签 ∪ 词表标准名 ∪ 该词的全部别名，按码点排序。
   * 与内存路径的 vocab.searchValues 是同一套内容（词表是唯一事实源），
   * 排序规则也一样（compareBinary ≡ SQLite 的 BINARY collation），
   * 这样两条路径拼出的字符串逐字节相同，「同一个查询命中结果不一致」不会发生。
   */
  function searchTextOf(rawTags, termIds, valueOf, aliasOf) {
    const tokens = new Set(rawTags);
    for (const termId of termIds) {
      const value = valueOf.get(termId);
      if (value) tokens.add(value);
      for (const alias of aliasOf.get(termId) || []) tokens.add(alias);
    }
    return [...tokens].sort(compareBinary).join(' ');
  }

  /**
   * 派生表可以整批重建：权威字符串不变，重建结果必然一致。合集表不属于派生数据，绝不清空。
   *
   * ADR-02：这里改成 **合并语义**（upsert），不再 DELETE 全表。
   *
   * 为什么要改：主 blob 只装「浏览器手里那部分目录」，服务端的全量目录在 assets 表里。
   * 旧实现每次重建都先 `DELETE FROM assets`，前端保存一次状态就把整库清空 ——
   * 50 万资产的库被一次普通保存打成 2 万条，而且不可逆。
   * 合并语义下：blob 里有的行更新，blob 里没有的行原样留着；
   * 真要删的资产走 asset.remove 通道定点删。
   *
   * 用户域（评分 / 备注 / 收藏 / 用户与 AI 标签）的权威在 DB：
   * 已有行一律保留 DB 里的当前值，blob 的对应字段只在**首次入库**时作为种子。
   * 这样「旧浏览器上传的过期 blob」不会把别人的新评分覆盖回去。
   */
  function mergeDerived(values, stamp, syncUser = false) {
    const {assets, tags, formats} = splitState(values, stamp);
    const cache = new Map();
    const tagsByUid = new Map();
    for (const row of tags) {
      let bucket = tagsByUid.get(row.uid);
      if (!bucket) { bucket = {platform: [], user: [], ai: []}; tagsByUid.set(row.uid, bucket); }
      bucket[row.kind].push(row.tag);
    }
    const formatsByUid = new Map();
    for (const row of formats) {
      const list = formatsByUid.get(row.uid) || [];
      list.push(row.ext);
      formatsByUid.set(row.uid, list);
    }
    const valueOf = new Map(db.prepare('SELECT term_id, value FROM tag_terms').all().map(row => [row.term_id, row.value]));
    const aliasOf = new Map();
    for (const row of db.prepare('SELECT term_id, alias_norm FROM tag_aliases').all()) {
      const bucket = aliasOf.get(row.term_id);
      if (bucket) bucket.push(row.alias_norm);
      else aliasOf.set(row.term_id, [row.alias_norm]);
    }
    // 只重算这次真正碰到的词条计数：全量 GROUP BY 在 50 万行上是几秒钟，不能每次保存都付。
    const touchedTerms = new Set();
    const recount = db.prepare(`INSERT INTO tag_counts (term_id, asset_count, updated_at)
      VALUES (?, (SELECT count(DISTINCT uid) FROM asset_tags WHERE term_id = ?), ?)
      ON CONFLICT(term_id) DO UPDATE SET asset_count = excluded.asset_count, updated_at = excluded.updated_at`);
    const clearCount = db.prepare('DELETE FROM tag_counts WHERE term_id = ?');

    for (const row of assets) {
      const bucket = tagsByUid.get(row.uid) || {platform: [], user: [], ai: []};
      const existing = selAssetRow.get(row.uid);
      const fresh = !existing;
      /**
       * 用户域的权威在 DB，但有一条遗留通道：/api/library/mutations 仍把整块 blob
       * （含 userMeta / userTags / favorites）发回来。它明确表达「本次要改用户数据」，
       * 由 syncUser 标记，此时以 blob 为准重建该资产的用户域；否则一律保留 DB 的当前值，
       * 免得旧浏览器上传的过期 blob 把别人新打的评分覆盖回去。
       */
      const useBlobUser = fresh || syncUser;
      if (syncUser && !fresh) {
        // 旧词条被删掉后计数也要跟着降，先把它们记进本轮重算集合。
        for (const item of selAssetTerms.all(row.uid)) touchedTerms.add(item.term_id);
      }
      const rating = useBlobUser ? row.rating : Number(existing.rating) || 0;
      const note = useBlobUser ? row.note : (existing.note || '');
      const favorite = useBlobUser ? row.favorite : (Number(existing.favorite) ? 1 : 0);
      // 检索文本 = 平台标签（来自 blob）∪ 用户与 AI 标签 → 标准名与别名。
      const userAi = useBlobUser
        ? [...bucket.user, ...bucket.ai]
        : db.prepare("SELECT tag FROM tags WHERE uid = ? AND kind IN ('user','ai')").all(row.uid).map(item => item.tag);
      const rawTags = [...bucket.platform, ...userAi];
      const termIds = [];
      for (const tag of rawTags) {
        const termId = resolveTerm(tag, cache, stamp);
        if (!termId) continue;
        termIds.push(termId);
        touchedTerms.add(termId);
      }
      const text = searchTextOf(rawTags, termIds, valueOf, aliasOf);
      const model = locations.apply(JSON.parse(row.payload));
      /**
       * 归属锚点：把「这个资产占着哪个包目录」写成事实字段。
       *
       * 这里写最省事也最全——所有入库来源（下载器、素材包登记、迁移脚本、前端手工编辑）
       * 最终都要经过这一处同步落库，所以补在这里等于「不管谁写的记录，落库时都有锚点」。
       * 不补的话记录里只有主文件路径，扫描侧只能靠前缀反推包目录，主文件一改名就断，
       * 于是包卡与资产卡并存、同一资产出两张（2026-11-16 的重复卡）。
       */
      anchorPackage(model);
      /**
       * 卡片缩略图优先级：包内 preview.*（平台官方渲染图，离线可看）> 平台外链 > 包内其它图。
       * 入库时如果 payload.thumbnail 被换成包内 Color.jpg（平铺贴图），材质卡就不再是
       * 平台那颗材质球了 —— 这是 2026-11-16 「库里的图和平台搜索不一样」的成因。
       * 平台外链只认 http(s) 且平台不是 local（本地图床/宿主机地址不是平台图）。
       */
      const platformThumb = /^https?:\/\//.test(String(model.platformThumbnail || ''))
        ? String(model.platformThumbnail)
        : (/^https?:\/\//.test(String(model.thumbnail || '')) && model.platform && model.platform !== 'local'
          ? String(model.thumbnail) : '');
      if (platformThumb) model.platformThumbnail = platformThumb;
      // 包内 preview.* 是「下载进包里的平台官方渲染图」，比外链更可靠（离线可看、不会失效），
      // 所以它是第一优先；其次才是平台外链；最后才退回包内任意贴图。
      const localPreview = localPlatformCover(model.thumbnail);
      upsertAsset.run(withAssetDefaults({...row, payload: JSON.stringify(model),
        name: model.name || row.name,
        url: model.url || row.url, thumbnail: localPreview || platformThumb || model.thumbnail || row.thumbnail,
        rating, note, favorite, tags_text: text}));
      // upsert 的 ON CONFLICT 分支刻意不碰用户域三列；遗留通道要显式改它们。
      if (useBlobUser && !fresh) updateUserColumns.run(rating, note, favorite, row.uid);

      // 平台标签按 uid 整体替换（目录的产物）；用户与 AI 标签只在明确授权时从 blob 覆盖。
      delPlatformTags.run(row.uid);
      for (const tag of bucket.platform) insertTag.run(row.uid, 'platform', tag);
      if (fresh) delAssetTags.run(row.uid);
      else if (useBlobUser) {
        delUserAiTags.run(row.uid);
        delUserAiAssetTags.run(row.uid);
      }
      delPlatformAssetTags.run(row.uid);
      for (const tag of bucket.platform) {
        const termId = resolveTerm(tag, cache, stamp);
        if (!termId) continue;
        insertAssetTag.run({
          uid: row.uid, term_id: termId, source: 'platform',
          model_version: null, created_at: stamp, created_by: 'system',
        });
      }
      if (useBlobUser) {
        for (const [kind, list] of [['user', bucket.user], ['ai', bucket.ai]]) {
          for (const tag of list) {
            const termId = resolveTerm(tag, cache, stamp);
            if(kind==='ai'&&db.prepare('SELECT 1 FROM tag_rejections WHERE uid=? AND term_id=? AND source=?').get(row.uid,termId,kind))continue;
            // tags 表是「这份资产有哪些原始标签」的权威，检索文本与协作取数都读它；
            // 只写 asset_tags 会让词表别名从 FTS 里消失，也会让远端同步拿不到标签。
            insertTag.run(row.uid, kind, tag);
            if (!termId) continue;
            insertAssetTag.run({
              uid: row.uid, term_id: termId, source: kind,
              model_version: kind === 'ai' ? 'legacy' : null, created_at: stamp, created_by: 'legacy',
            });
          }
        }
      }

      // 格式是目录的产物：按 uid 整体替换。
      delFormats.run(row.uid);
      for (const ext of formatsByUid.get(row.uid) || []) insertFormat.run(row.uid, ext);

      // FTS 正文跟着更新。rowid 与 assets.rowid 对齐（派生层按同一顺序插入两者）。
      const current = selAssetRow.get(row.uid);
      if (!current) continue;
      delFts.run(current.rowid);
      insertFts.run(current.rowid, row.uid,
        [current.name, current.author, current.platform, current.note, text].filter(Boolean).join(' \u0001 '));
    }
    for (const termId of touchedTerms) {
      const count = countTerm.get(termId).n;
      if (count) recount.run(termId, termId, stamp);
      else { clearCount.run(termId); }
    }
  }

  /**
   * 探测缓存增量回填：前端后台扫描只写「探测域」，不带目录域。
   * 走 mergeDerived 会整库重算（50 万资产要几百秒），所以这里只重写被采到的那几行，
   * 只动 probe 派生的 5 列 + payload.probe —— 用户域（评分 / 备注 / 标签）一律不碰。
   * 少了这一步，颜色 / 尺寸筛选对本地资产完全无效：payload 里没有 probe，匹配直接落空。
   */
  const selProbeRow = db.prepare('SELECT payload FROM assets WHERE uid = ?');
  const patchProbeRow = db.prepare(`UPDATE assets SET payload = ?, width = ?, height = ?, long_edge = ?,
    color_h = ?, duration = ?, updated_at = ? WHERE uid = ?`);
  function patchProbes(json, stamp) {
    let probes;
    try { probes = JSON.parse(json); } catch { return; }
    if (!probes || typeof probes !== 'object' || Array.isArray(probes)) return;
    for (const [uid, probe] of Object.entries(probes)) {
      if (!uid || !probe || typeof probe !== 'object' || Array.isArray(probe)) continue;
      const row = selProbeRow.get(uid);
      if (!row) continue;
      let model;
      try { model = JSON.parse(row.payload); } catch { continue; }
      if (!model || typeof model !== 'object') continue;
      const info = probeOfModel({...model, probe});
      if (!info) continue;
      const width = info.width ?? null, height = info.height ?? null;
      const longEdge = width && height ? Math.max(width, height) : null;
      patchProbeRow.run(JSON.stringify({...model, probe}), width, height, longEdge, info.h ?? null, info.duration ?? null, stamp, uid);
    }
  }

  const write = db.transaction((values, {replace = false, stamp = now(), stamps = null, derived = true, syncUser = false} = {}) => {
    // 逐域精确时间戳：一次提交若同时写了目录域与会话域，用同一个 max stamp 会让
    // 目录域的戳虚高于它自己的文件 mtime，读权威时误判「DB 更新」而白搬 209MB。
    const stampOf = key => Number(stamps?.[key] ?? stamp);
    const writeStamp = key => setMetaStmt.run(stateStampKey(key), String(stampOf(key)));
    // derived=false：只更新权威原串，**不碰派生表**。
    // 50 万资产时整表重建要 242 秒，而搜索历史 / 任务 / 选项与派生表毫无关系 ——
    // 为了记一次搜索历史重建整库是不能接受的。
    if (!derived) {
      for (const [key, value] of Object.entries(values)) {
        if (!STATE_KEYS.includes(key) || typeof value !== 'string') continue;
        upsertState.run(key, value, stampOf(key));
        writeStamp(key);
      }
      return;
    }
    const {state} = splitState(values, stamp);
    if (replace) {
      db.exec('DELETE FROM state_meta;');
      db.prepare(`DELETE FROM db_meta WHERE key LIKE '${STATE_STAMP_PREFIX}%'`).run();
    }
    for (const row of state) {
      upsertState.run(row.key, row.value, stampOf(row.key));
      writeStamp(row.key);
    }
    // 只有目录域变了才更新派生表；否则部分 key（如 UI 偏好）的写入不该动资产表。
    // derived=false 用于「派生表已经定点改过了」的场合：S3 的增量写路径
    // 已经逐条更新了 assets / tags / asset_tags，再合并一次就是纯浪费。
    if (derived && Object.hasOwn(values, MAIN_STATE_KEY)) mergeDerived(values, stamp, syncUser);
    // 只写了探测域时不会进 mergeDerived（它会整库重算），改走按 uid 的定点回填。
    else if (derived && typeof values[PROBE_STATE_KEY] === 'string') patchProbes(values[PROBE_STATE_KEY], stamp);
  });

  // S3：集合语义写入器。定点改派生表，不重建整表。
  const tagWriter = createTagWriter({db, resolveTerm, searchTextOf, now});

  return {
    file,
    version: SUPPORTED_SCHEMA_VERSION,
    /** 前端契约：返回 {key: 原始字符串}，字节级一致。 */
    readValues() { return assembleState(db.prepare('SELECT key, value FROM state_meta').all()); },
    /**
     * ADR-07：读侧目录域以 assets 表为权威。
     *
     * payload 就是完整 model（派生时原样 JSON.stringify），按 state 分开取、各自按
     * position ASC 还原顺序 —— 5.1 起新增资产的 position 由服务端分配，blob 的数组下标
     * 已经不代表真实顺序。坏 payload 只跳过这一行，绝不让一条脏数据拖垮整库启动。
     */
    readCatalog({active = true} = {}) {
      const pick = state => {
        const rows = db.prepare('SELECT payload FROM assets WHERE state = ? ORDER BY position ASC, rowid ASC').all(state);
        const out = [];
        for (const row of rows) {
          let model;
          try { model = JSON.parse(row.payload); } catch { continue; }
          if (model && typeof model === 'object' && !Array.isArray(model) && typeof model.uid === 'string' && model.uid) out.push(slimCatalogModel(model));
        }
        return out;
      };
      return {models: active ? pick('active') : [], trashed: pick('trashed')};
    },
    /**
     * ADR-09：启动按页取目录。readCatalog() 会把整表读进内存，只能用于合成读视图；
     * 首屏分页必须走 SQL LIMIT/OFFSET，否则「按页」只是把全量 JSON 切着传。
     */
    readCatalogPage(offset = 0, limit = 200) {
      const total = Number(db.prepare("SELECT count(*) AS n FROM assets WHERE state = 'active'").get()?.n || 0);
      const start = Math.max(0, Number(offset) || 0);
      const size = Math.min(500, Math.max(1, Number(limit) || 200));
      const rows = db.prepare("SELECT payload FROM assets WHERE state = 'active' ORDER BY position ASC, rowid ASC LIMIT ? OFFSET ?").all(size, start);
      const items = [];
      for (const row of rows) {
        let model;
        try { model = JSON.parse(row.payload); } catch { continue; }
        if (model && typeof model === 'object' && !Array.isArray(model) && typeof model.uid === 'string' && model.uid) items.push(slimCatalogModel(model));
      }
      return {items, total, offset: start, nextOffset: start + rows.length};
    },
    /** 全选用：只回 32 字节 uid，不回 model payload。 */
    readCatalogUids(state = 'active') {
      const rows = db.prepare('SELECT uid FROM assets WHERE state = ? ORDER BY position ASC, rowid ASC').all(state);
      return {uids: rows.map(row => row.uid), total: rows.length};
    },
    writeValues(values, options) { write(values, options); },
    // 仅供已经校验内容的服务端重定位调用，普通 asset:patch 不允许覆盖权威位置。
    rebindFileLocation(model) { return locations.rebind(model); },
    getMeta(key) { return getMetaStmt.get(key)?.value ?? null; },
    setMeta(key, value) { setMetaStmt.run(key, String(value)); },
    /** 阶段 2 的检索入口：trigram MATCH 支持中文子串，短词退回 LIKE 防 FTS 语法报错。 */
    search(term, limit = 50) {
      const needle = String(term || '').trim();
      if (!needle) return [];
      if (needle.length < 3) {
        return db.prepare('SELECT uid, name FROM assets WHERE name LIKE ? OR author LIKE ? OR note LIKE ? LIMIT ?')
          .all(`%${needle}%`, `%${needle}%`, `%${needle}%`, limit);
      }
      return db.prepare(`SELECT a.uid AS uid, a.name AS name FROM assets_fts f
        JOIN assets a ON a.uid = f.uid WHERE assets_fts MATCH ? LIMIT ?`).all(needle, limit);
    },
    /**
     * 阶段 3 的 FTS5 候选集：一条 JOIN 直接取出命中的完整 assets 行，
     * 避免 IN (...) 的参数上限，也让 normalizeRows 只解析候选行而不是全库。
     * 词加双引号当短语查，既避开 FTS 语法字符，也与 trigram 的子串语义一致。
     * 注意：2 字中文词 trigram 不成立，调用方必须先把这类查询挡在全量路径。
     */
    searchAssetRows(term, limit = 20000) {
      const needle = String(term || '').trim().replace(/"/g, '');
      if (needle.length < 3) return [];
      return db.prepare(`SELECT a.* FROM assets_fts f JOIN assets a ON a.uid = f.uid
        WHERE assets_fts MATCH ? LIMIT ?`).all(`"${needle}"`, limit);
    },
    counts() {
      const one = sql => db.prepare(sql).get()?.n ?? 0;
      return {assets: one('SELECT count(*) AS n FROM assets'), tags: one('SELECT count(*) AS n FROM tags'),
        assetTags: one('SELECT count(*) AS n FROM asset_tags'),
        collections: one('SELECT count(*) AS n FROM collections'), migrations: one('SELECT count(*) AS n FROM schema_migrations')};
    },
    /** 阶段 2 查询/合集服务只通过这两个通用方法访问表：SQL 由服务端构造，值一律参数绑定。 */
    all(sql, params = []) { return db.prepare(sql).all(...params); },
    run(sql, params = []) { return db.prepare(sql).run(...params); },
    /**
     * S2 查询下推：只读当前页的行。plan 由 query-sql.mjs 编译，本方法只负责「取哪张表」。
     *
     * 与 dataset() 的全量路径相比，这里少了两件最贵的事：读全表、逐行 JSON.parse。
     * COUNT 与分页用同一份 WHERE，所以 total 与 items 永远不会对不上。
     * 标签只按当前页 uid 取，不再把全库标签聚合成一个 Map。
     *
     * 取页分两段：先只取 uid（排序器不用搬运 payload），再按 uid 取整行。
     * 20 万条实测：单段 SELECT a.* + ORDER BY 要 4146ms，两段只要 1239ms。
     */
    /**
     * 取当前页的 uid。
     *
     * 命中多的时候强制走排序索引：沿索引顺序扫、凑够一页就停，
     * 省掉「物化全部命中 uid → 临时 B 树排序」。50 万条实测 829ms → 204ms，
     * 且返回序列与自然计划逐条一致。
     *
     * 命中少的时候强制反而更慢（要扫完整条索引才凑不满一页），所以设门槛：
     * 门槛以下维持原计划，零回退风险。
     *
     * 索引若满足不了 ORDER BY，SQLite 在 prepare 阶段就报「no query solution」——
     * 那是安全失败：捕获后退回自然计划，绝不给出错序结果。
     */
    queryPage(plan) {
      const total = countRows(plan);
      const uidRows = pageUidRows(plan, total);
      const uids = uidRows.map(row => row.uid);
      const assetRows = uids.length
        ? prepared(`SELECT a.* FROM assets a WHERE a.uid IN (${uids.map(() => '?').join(', ')})`).all(...uids)
        : [];
      // IN 查询不保证顺序，必须按 uid 序列还原成排序后的顺序。
      const byUid = new Map(assetRows.map(row => [row.uid, row]));
      const ordered = uids.map(uid => byUid.get(uid)).filter(Boolean);
      const tagRows = uids.length
        ? prepared(`SELECT uid, kind, tag FROM tags WHERE uid IN (${uids.map(() => '?').join(', ')})`).all(...uids)
        : [];
      return {assetRows: ordered, tagRows, total};
    },
    /** 只取命中总数（分页器算总页数用，不读行）。 */
    countAssets(plan) {
      return countRows(plan);
    },
    /**
     * S3：集合语义写入（打标签 / 改评分备注收藏）。
     * 只动受影响的资产，不重建派生表；每次写都留审计行。
     */
    applyTagOps(ops, options) {
      return tagWriter.apply(ops, options);
    },
    refreshTagSearch(uids) {return tagWriter.refresh(uids);},
    /**
     * 阶段 5.1 / ADR-05：目录域定点写（asset:add / asset:patch / asset:remove）。
     *
     * 不复刻一套派生逻辑：把「只含这一条 model」的 values 交给既有 mergeDerived，
     * 它本来就是 upsert 合并语义（不清表、不碰别人的用户域），于是只重算这一行及其
     * 标签 / 格式 / FTS / 词条计数。整块 blob 一个字节都不写 —— 这是 5.2/5.3 的前提。
     *
     * 单事务：一批 op 要么全成，要么全不成；每条成功写留审计行，失败项逐条回传。
     */
    applyAssetOps(ops, {actor = 'system', syncBlob = false} = {}) {
      const changes = [];
      const conflicts = [];
      // 5.2 过渡期双写：HTTP 路由传 syncBlob=true，让主 blob 与 DB 目录保持一致，
      // 否则「删掉的资产」会在下次合并写入时被旧 blob 复活。5.5 拆整块通道后停掉。
      const touched = [];
      const stamp = now();
      const selFull = db.prepare('SELECT rowid, rev, position, payload, added_at, state, trashed_at FROM assets WHERE uid = ?');
      const selRev = db.prepare('SELECT rev FROM assets WHERE uid = ?');
      // mergeDerived 用数组下标给 position，patch 会把资产顶到最前 —— 这里恢复原值。
      const bumpRev = db.prepare(`UPDATE assets SET rev = rev + 1, updated_at = ?, position = ?,
        added_at = ?, state = ?, trashed_at = ? WHERE uid = ?`);
      const placeNew = db.prepare(`UPDATE assets SET rev = 1, updated_at = ?,
        position = (SELECT COALESCE(MIN(position), 0) - 1 FROM assets) WHERE uid = ?`);
      const audit = db.prepare('INSERT INTO audit_log (at, actor, action, uid, term_id, detail, rev) VALUES (?, ?, ?, ?, NULL, NULL, ?)');
      const delFtsOne = db.prepare('DELETE FROM assets_fts WHERE rowid = ?');
      const delTagsOne = db.prepare('DELETE FROM tags WHERE uid = ?');
      const delAssetTagsOne = db.prepare('DELETE FROM asset_tags WHERE uid = ?');
      const delFormatsOne = db.prepare('DELETE FROM asset_formats WHERE uid = ?');
      const delAssetOne = db.prepare('DELETE FROM assets WHERE uid = ?');
      const selMeta = db.prepare('SELECT key, value FROM state_meta');

      const run = db.transaction(() => {
        for (const op of ops) {
          const existing = selFull.get(op.uid);
          if (op.rev !== undefined && existing && Number(op.rev) !== Number(existing.rev)) {
            conflicts.push({op: op.op, uid: op.uid, code: 'rev_conflict', rev: Number(existing.rev)});
            continue;
          }
          if (op.op === 'asset:remove') {
            if (!existing) { conflicts.push({op: op.op, uid: op.uid, code: 'not_found'}); continue; }
            delFtsOne.run(existing.rowid);
            delAssetTagsOne.run(op.uid);
            delTagsOne.run(op.uid);
            delFormatsOne.run(op.uid);
            db.prepare('DELETE FROM file_locations WHERE asset_uid=?').run(op.uid);
            db.prepare('DELETE FROM tag_rejections WHERE uid=?').run(op.uid);
            db.prepare('DELETE FROM asset_label_progress WHERE uid=?').run(op.uid);
            delAssetOne.run(op.uid);
            audit.run(stamp, actor, 'asset.remove', op.uid, Number(existing.rev) || 1);
            changes.push({kind: 'asset.remove', uid: op.uid, rev: null});
            touched.push({uid: op.uid, model: null, trashed: false});
            continue;
          }
          const move = op.op === 'asset:trash' || op.op === 'asset:restore';
          let model;
          if (op.op === 'asset:patch') {
            if (!existing) { conflicts.push({op: op.op, uid: op.uid, code: 'not_found'}); continue; }
            let base = {};
            try { base = JSON.parse(existing.payload || '{}') || {}; } catch { base = {}; }
            model = {...base, ...op.patch, uid: op.uid};
          } else if (move) {
            // 5.4：状态迁移只认专用 op。model 可选（按页前端可能拿不到完整 model），
            // 不传就从 DB payload 还原；uid 一律以 op 为准。
            if (!existing) { conflicts.push({op: op.op, uid: op.uid, code: 'not_found'}); continue; }
            let base = {};
            try { base = JSON.parse(existing.payload || '{}') || {}; } catch { base = {}; }
            model = {...(op.model ?? base), uid: op.uid};
            if (op.op === 'asset:trash') model.trashedAt = Number(model.trashedAt) || stamp;
            else delete model.trashedAt;
          } else {
            model = op.model;
          }
          // 回收站里的资产仍从 trashed 数组派生，否则 patch 会把已删除的资产悄悄复活。
          // trash/restore 的目标状态由 op 决定，不能看 existing —— 那正是要改的字段。
          const trashed = move ? op.op === 'asset:trash' : existing?.state === 'trashed';
          const values = Object.fromEntries(selMeta.all().map(row => [row.key, row.value]));
          let main = {};
          try { main = JSON.parse(values[MAIN_STATE_KEY] || '{}') || {}; } catch { main = {}; }
          values[MAIN_STATE_KEY] = JSON.stringify({
            ...main,
            models: trashed ? [] : [model],
            trashed: trashed ? [model] : [],
          });
          mergeDerived(values, stamp, false);
          model = JSON.parse(db.prepare('SELECT payload FROM assets WHERE uid=?').get(op.uid).payload);
          if (existing) {
            const targetState = move ? (trashed ? 'trashed' : 'active') : existing.state;
            const targetTrashedAt = trashed ? (Number(model?.trashedAt) || existing.trashed_at || stamp) : null;
            bumpRev.run(stamp, existing.position, existing.added_at, targetState, targetTrashedAt, op.uid);
          } else {
            placeNew.run(stamp, op.uid);
          }
          const rev = Number(selRev.get(op.uid)?.rev) || 1;
          audit.run(stamp, actor, op.op, op.uid, rev);
          db.prepare('DELETE FROM asset_label_progress WHERE uid=?').run(op.uid);
          changes.push({kind: op.op, uid: op.uid, rev});
          touched.push({uid: op.uid, model, trashed});
        }
        if (syncBlob && touched.length) {
          const raw = db.prepare('SELECT value FROM state_meta WHERE key = ?').get(MAIN_STATE_KEY)?.value;
          let main = {};
          try { main = JSON.parse(raw || '{}') || {}; } catch { main = {}; }
          const toMap = arr => new Map((Array.isArray(arr) ? arr : [])
            .filter(item => item && typeof item.uid === 'string').map(item => [item.uid, item]));
          const models = toMap(main.models), trashed = toMap(main.trashed);
          for (const item of touched) {
            // 一个 uid 只能存在一处：先从两边摘掉，再按当前 state 放回对应数组。
            models.delete(item.uid);
            trashed.delete(item.uid);
            if (item.model) (item.trashed ? trashed : models).set(item.uid, item.model);
          }
          const next = JSON.stringify({
            ...main, version: main.version ?? 2,
            models: [...models.values()], trashed: [...trashed.values()],
          });
          upsertState.run(MAIN_STATE_KEY, next, stamp);
          // 域戳必须一起推进，否则 readValues 会误判「文件快照比 DB 新」而把旧目录搬回来。
          setMetaStmt.run(stateStampKey(MAIN_STATE_KEY), String(stamp));
        }
      });
      run();
      return {applied: changes.length, changes, conflicts};
    },
    /**
     * ADR-02：定点删除资产（合并语义下，blob 里少了某个 uid 不等于它该消失）。
     *
     * 合并写入只做 upsert，所以「彻底删除」必须显式走这条路：
     * 资产行、标签、格式、检索词条、词条关联一次清干净，并留审计行。
     * 单事务：中途失败不会留下「资产没了但标签还在」的半截状态。
     */
    removeAssets(uids, {actor = 'system'} = {}) {
      const list = (Array.isArray(uids) ? uids : []).map(item => String(item || '')).filter(Boolean).slice(0, 500);
      if (!list.length) return {removed: 0, uids: []};
      const removed = [];
      const run = db.transaction(() => {
        for (const uid of list) {
          const row = db.prepare('SELECT rowid FROM assets WHERE uid = ?').get(uid);
          if (!row) continue;
          db.prepare('DELETE FROM assets_fts WHERE rowid = ?').run(row.rowid);
          db.prepare('DELETE FROM asset_tags WHERE uid = ?').run(uid);
          db.prepare('DELETE FROM tags WHERE uid = ?').run(uid);
          db.prepare('DELETE FROM asset_formats WHERE uid = ?').run(uid);
          db.prepare('DELETE FROM file_locations WHERE asset_uid = ?').run(uid);
          db.prepare('DELETE FROM tag_rejections WHERE uid=?').run(uid);
          db.prepare('DELETE FROM asset_label_progress WHERE uid=?').run(uid);
          db.prepare('DELETE FROM assets WHERE uid = ?').run(uid);
          db.prepare('INSERT INTO audit_log (at, actor, action, uid, term_id, detail, rev) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(now(), actor, 'asset.remove', uid, null, null, null);
          removed.push(uid);
        }
      });
      run();
      return {removed: removed.length, uids: removed};
    },
    /**
     * ADR-02：用户域的权威在 DB，前端刷新后从这里取回自己的评分 / 备注 / 标签 / 收藏。
     *
     * 只回「有值」的资产：空评分空备注的资产没有回传价值，
     * 50 万库里真正被打过分的是少数，回传量因此与库大小无关。
     */
    readUserDomain() {
      const assets = db.prepare(`SELECT uid, rating, note, favorite FROM assets
        WHERE rating > 0 OR note <> '' OR favorite = 1`).all();
      const tags = db.prepare("SELECT uid, kind, tag FROM tags WHERE kind IN ('user','ai')").all();
      const userMeta = {};
      const userTags = {};
      const aiTags = {};
      const favorites = [];
      for (const row of assets) {
        const meta = {};
        if (Number(row.rating) > 0) meta.rating = Number(row.rating);
        if (row.note) meta.note = String(row.note);
        if (meta.rating !== undefined || meta.note !== undefined) userMeta[row.uid] = meta;
        if (Number(row.favorite) === 1) favorites.push(row.uid);
      }
      for (const row of tags) {
        const bucket = row.kind === 'user' ? userTags : aiTags;
        const list = bucket[row.uid] || [];
        list.push(row.tag);
        bucket[row.uid] = list;
      }
      return {userMeta, userTags, aiTags, favorites};
    },
    /**
     * ADR-10：导入时把快照里的评分 / 备注 / 收藏作为**补空缺**的种子写进已有资产。
     *
     * 为什么不能走 asset:add / asset:patch：mergeDerived 的 useBlobUser 只在
     * 「新行」或「明确授权整块写」时为真，已存在的行一律保留 DB 现值 —— 这是协作场景
     * 刻意的保护，但也意味着导入端改不动老资产的用户域。这里只做一件事：
     * 当前值为空才补，本机已有的标注永远优先。
     *
     * 用户标签不在这一条通道里：它要过词表解析 + FTS 重建，属于另一件事，导入时明确不迁。
     */
    applyUserSeeds(seeds, {now = Date.now} = {}) {
      const list = Array.isArray(seeds) ? seeds : [];
      if (!list.length) return 0;
      const seed = db.prepare(`UPDATE assets SET
        rating = CASE WHEN rating > 0 THEN rating ELSE ? END,
        note = CASE WHEN note <> '' THEN note ELSE ? END,
        favorite = CASE WHEN favorite = 1 THEN 1 ELSE ? END,
        updated_at = ?
        WHERE uid = ?`);
      const run = db.transaction(() => {
        let applied = 0;
        for (const item of list) {
          const rating = Math.min(5, Math.max(0, Math.round(Number(item?.rating) || 0)));
          const note = typeof item?.note === 'string' ? item.note.slice(0, 2000) : '';
          const favorite = item?.favorite ? 1 : 0;
          if (!rating && !note && !favorite) continue;
          if (typeof item?.uid !== 'string' || !item.uid) continue;
          applied += seed.run(rating, note, favorite, now, item.uid).changes;
        }
        return applied;
      });
      return run();
    },
    /**
     * 在线备份：SQLite 的 backup API 在运行中给出一致性快照，不停服也不锁库。
     * 失败必须抛给调用方 —— 备份失败不能被当成成功（那样会留下「以为有备份」的假象）。
     */
    backupTo(file) {
      return db.backup(file);
    },
    /**
     * 命中集合的 uid 列表（不读 payload，只走索引）。
     * cap 是硬上限：上万条 uid 传回浏览器既没有用，也会把响应撑到几 MB。
     */
    queryUids(plan, cap = 5000) {
      return prepared(`SELECT a.uid FROM assets a WHERE ${plan.where} ORDER BY ${plan.orderBy} LIMIT ?`)
        .all(...plan.params, cap).map(row => row.uid);
    },
    raw(sql) { return db.prepare(sql).all(); },
    exec(sql) { return db.exec(sql); },
    /**
     * 内核内部模块的逃逸口：词表同步需要 prepare + transaction 才能保证「合并全成或全不成」。
     * 业务代码禁止使用 —— 一律走上面的 all/run/exec，将来换驱动时只有这里需要改。
     */
    native() { return db; },
    close() { statements.clear(); try { db.close(); } catch (error) { onWarn(`关闭资产库失败：${error.message}`); } },
  };
}

/**
 * 驱动加载缝（优先级：注入 > 环境变量 > 默认裸导入）。
 * 默认路径的关键是不写死：Node 从 server/ 逐级向上找 node_modules，桌面安装包把依赖放在
 * sidecar-server/node_modules 就能命中，源码版用仓库根 node_modules 也能命中。
 * AV_SQLITE_MODULE 是给绿色版 / 自定义 Node 部署留的覆盖口，值可为包名、绝对路径或
 * 相对本文件的 JS 驱动路径（需导出 Database 构造函数）。
 */
async function loadSqliteDriver(importer) {
  if (importer) return importer();
  const override = process.env.AV_SQLITE_MODULE;
  if (override) return createRequire(import.meta.url)(override);
  return import('better-sqlite3');
}

/** 异步惰性入口：加载失败返回 null，由上层决定降级，不抛到服务启动路径。 */
export async function openLibraryDb({file, now = Date.now, onWarn = WARN, importer, throwOnError = false} = {}) {
  try {
    const module = await loadSqliteDriver(importer);
    const Database = module.default || module.Database || module;
    return createLibraryDb({Database, file, now, onWarn});
  } catch (error) {
    if (throwOnError) throw error;
    const hint = /NODE_MODULE_VERSION|compiled against|specified module could not be found|Cannot find module|\.node/i.test(error.message)
      ? '（原生模块缺失或 ABI 不匹配：源码版执行 npm rebuild better-sqlite3；桌面版重新运行 build-installer.cmd 装配随包依赖）'
      : '';
    onWarn(`SQLite 不可用，已退回文件快照：${error.message}${hint}`);
    return null;
  }
}
