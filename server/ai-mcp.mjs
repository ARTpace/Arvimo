// AssetVault MCP server（stdio / JSON-RPC 2.0，零第三方依赖）。
//
// 为什么自己实现协议而不是装 SDK：这个仓库运行时依赖为零，MCP server 会被 AI 客户端拉起并
// 常驻，多一个 npm 包就多一处安装失败点。stdio 传输本身就是「一行一个 JSON」，握手、工具
// 列举、工具调用、资源读取加起来不到百行，不值得为此引入依赖树。
//
// 关键设计：
//  - 只暴露 8 个语义化工具，不把 100+ 个 /api 路由 1:1 映射进工具列表（吃上下文、易选错）。
//  - 搜索结果在常驻进程里缓存，返回给模型的是紧凑摘要 + handle；入队时用 handle 换回完整
//    model 对象，避免把大段原始 JSON 塞进对话。这正是「长驻有状态」相对 CLI 的优势。
//  - 下载一律立即返回任务 ID，不阻塞等待（转换可能跑 30 分钟，客户端会超时）。
//  - 所有日志只写 stderr，stdout 是协议通道，绝不污染。
import readline from 'node:readline';
import {createClient, SEARCH_ENDPOINTS, PLATFORM_KINDS} from './ai-client.mjs';

const SERVER_INFO = {name: 'assetvault', version: '1.0.0'};
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS.at(-1);
const client = createClient();

const searchCache = new Map(); // batchId -> {platform, kind, models, q, createdAt}
const jobCache = new Map();    // jobId   -> 原始任务对象
let searchSeq = 0;
const MAX_CACHE = 12;

const say = message => process.stdout.write(JSON.stringify(message) + '\n');
const log = message => process.stderr.write(`[assetvault-mcp] ${message}\n`);
const ok = (id, result) => say({jsonrpc: '2.0', id, result});
const fail = (id, code, message, data) => say({jsonrpc: '2.0', id, error: {code, message, ...(data === undefined ? {} : {data})}});

const readOnly = {readOnlyHint: true, destructiveHint: false, openWorldHint: true};

const TOOLS = [
  {
    name: 'get_capabilities',
    description: '检查 AssetVault 本地服务是否在运行、版本号、能力位、可用导出目标。开始工作前先调用一次；若报服务未启动，请让用户双击 AssetVault.lnk 启动工作台，不要自行启动第二个服务实例。',
    inputSchema: {type: 'object', properties: {}},
    annotations: {...readOnly, openWorldHint: false},
  },
  {
    name: 'search_assets',
    description: '在 3D 资产平台在线搜索。返回紧凑结果列表，每条带 handle；handle 可直接交给 enqueue_download，避免复制完整模型数据。cursor 来自上一次返回的 next，用于翻页。支持平台：sketchfab、artstation、polyhaven、polypizza、kenney、freestylized、polyfork、ambientcg。',
    inputSchema: {
      type: 'object',
      properties: {
        q: {type: 'string', description: '关键词，英文命中率通常更高。中文按原文提交，不自动翻译。'},
        platform: {type: 'string', enum: Object.keys(SEARCH_ENDPOINTS), description: '默认 sketchfab'},
        filters: {type: 'object', description: '平台专属筛选，原样透传。Sketchfab 支持 sort(relevance/popular/newest/views)、category、downloadable、animated、staffpicked；其他平台用各自的参数。'},
        cursor: {type: 'string', description: '翻页游标，取上一次返回的 next'},
        limit: {type: 'integer', minimum: 1, maximum: 24, description: '返回条数，默认 12'},
      },
    },
    annotations: readOnly,
  },
  {
    name: 'get_asset',
    description: '按模型 UID 或页面 URL 读取详情（名称、作者、许可证、是否可下载、标签等）。也可传 ids 批量读取。',
    inputSchema: {
      type: 'object',
      properties: {
        uid: {type: 'string', description: '32 位模型 UID'},
        url: {type: 'string', description: 'Sketchfab 模型页 / 合集 / 作者页，或含模型链接的普通网页'},
        ids: {type: 'array', items: {type: 'string'}, description: '批量 UID，最多 500 个'},
      },
    },
    annotations: readOnly,
  },
  {
    name: 'enqueue_download',
    description: '把资产加入后台下载队列，立即返回任务 ID，不等待下载完成。之后用 get_jobs 查进度。必须显式传入 authorized: true：调用前先向用户确认其拥有该模型的下载与使用授权；「可下载」不等于「可商用」。不同平台的资产要分批调用。',
    inputSchema: {
      type: 'object',
      properties: {
        handles: {type: 'array', items: {type: 'string'}, description: 'search_assets 返回的 handle，如 "s3:0"；同一批必须来自同一平台'},
        models: {type: 'array', items: {type: 'object'}, description: '完整的模型对象数组，用于没有 handle 的场景'},
        authorized: {type: 'boolean', description: '必须由用户明确确认授权后才设为 true'},
        kind: {type: 'string', enum: Object.values(PLATFORM_KINDS), description: '仅当直接传 models 时需要；用 handles 时自动推断'},
        options: {type: 'object', description: '导出参数，如 {output:"zip",format:"glb",maxTextureEdge:2048}'},
        folder: {type: 'string', description: '本批次保存目录，须为本机绝对路径'},
        force: {type: 'boolean', description: '已存在成功文件时是否仍然再下一份'},
        openInBlender: {type: 'boolean', description: '下载完成后自动发送到 Blender'},
      },
      required: ['authorized'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true},
  },
  {
    name: 'get_jobs',
    description: '读取后台下载队列。默认返回紧凑摘要；传 jobId 返回该任务的完整详情（含路径、SHA-256 与最近日志）。任务状态包括 queued/held/running/transferring/validating/saving/saved/failed/cancelled/interrupted。',
    inputSchema: {
      type: 'object',
      properties: {
        state: {type: 'string', description: '按状态过滤'},
        jobId: {type: 'string', description: '只看某一个任务，返回完整字段'},
        limit: {type: 'integer', minimum: 1, maximum: 100, description: '默认 20'},
      },
    },
    annotations: {...readOnly, openWorldHint: false},
  },
  {
    name: 'manage_job',
    description: '对下载任务执行 cancel / retry / hold / resume / remove。remove 只删任务记录，不删磁盘文件。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: ['cancel', 'retry', 'hold', 'resume', 'remove']},
        ids: {type: 'array', items: {type: 'string'}, description: '任务 ID 列表'},
      },
      required: ['action', 'ids'],
    },
    annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false},
  },
  {
    name: 'list_library',
    description: '读取本地模型库（收藏、已加入的模型与导出设置）。传 scan: true 会同时索引磁盘上的素材包，返回未被下载任务登记的本地文件。',
    inputSchema: {
      type: 'object',
      properties: {
        scan: {type: 'boolean', description: '是否同时扫描本地磁盘素材包'},
        force: {type: 'boolean', description: '扫描时忽略缓存强制重建'},
        limit: {type: 'integer', minimum: 1, maximum: 100, description: '模型库与扫描结果各返回多少条，默认 20'},
      },
    },
    annotations: {...readOnly, openWorldHint: false},
  },
  {
    name: 'search_library',
    description: '在 AssetVault 本地资产库里检索（不开联网搜索）。支持与前端相同的高级查询语法 q、filters、sort；返回紧凑结果 + uids，uids 可直接交给 tag_assets / manage_collection。用 offset 翻页。',
    inputSchema: {
      type: 'object',
      properties: {
        q: {type: 'string', description: '查询词，支持 tag: / name: / ext: / -排除词 / | 或 等语法'},
        filters: {type: 'object', description: '结构化过滤对象，原样传给服务端（tags / formats / kinds / categories / platforms / rating / favorite 等）'},
        sort: {type: 'string', description: '排序键，默认 recent'},
        sortOrder: {type: 'string', enum: ['asc', 'desc']},
        limit: {type: 'integer', minimum: 1, maximum: 50, description: '默认 20'},
        offset: {type: 'integer', minimum: 0, description: '翻页偏移'},
      },
    },
    annotations: {...readOnly, openWorldHint: false},
  },
  {
    name: 'list_collections',
    description: '列出本地资产库的合集与智能合集，含 id / parentId / assetCount / 智能规则。用它的 id 调 manage_collection 增删成员。',
    inputSchema: {type: 'object', properties: {}},
    annotations: {...readOnly, openWorldHint: false},
  },
  {
    name: 'manage_collection',
    description: '管理合集：create / update / delete / add_items / remove_items / set_items。可传 parentId 建立嵌套层级；传 q / filters 则创建智能合集。写操作，必须先经用户确认并传 confirm: true。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: ['create', 'update', 'delete', 'add_items', 'remove_items', 'set_items'], description: '默认 create'},
        id: {type: 'string', description: 'update / delete / 成员操作必填'},
        name: {type: 'string'},
        parentId: {type: 'string', description: '上级合集 id，用来建层级'},
        description: {type: 'string'},
        coverAssetId: {type: 'string'},
        icon: {type: 'string'}, color: {type: 'string'}, position: {type: 'number'},
        uids: {type: 'array', items: {type: 'string'}, description: '成员操作时的资产 uid 列表'},
        q: {type: 'string', description: '智能合集规则：查询词'},
        filters: {type: 'object', description: '智能合集规则：过滤条件'},
        sort: {type: 'string', description: '智能合集规则：排序'},
        confirm: {type: 'boolean', description: '写操作必须显式传 true'},
      },
      required: ['confirm'],
    },
    annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false},
  },
  {
    name: 'tag_assets',
    description: '批量整理资产：加/删用户标签、改评分(0-5)、收藏、写备注。一次最多 200 个 uid / 800 条变更。写操作，必须先经用户确认并传 confirm: true。',
    inputSchema: {
      type: 'object',
      properties: {
        uids: {type: 'array', items: {type: 'string'}, description: '资产 uid 列表，来自 search_library 的 uids'},
        addTags: {type: 'array', items: {type: 'string'}},
        removeTags: {type: 'array', items: {type: 'string'}},
        rating: {type: 'number', minimum: 0, maximum: 5},
        favorite: {type: 'boolean'},
        note: {type: 'string'},
        confirm: {type: 'boolean', description: '写操作必须显式传 true'},
      },
      required: ['uids', 'confirm'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
  },
  {
    name: 'send_to_blender',
    description: '把一个已保存到本地的任务发送到当前打开的 Blender 场景。任务未保存完成、Blender 未打开或桥接未安装时会明确报错。',
    inputSchema: {
      type: 'object',
      properties: {jobId: {type: 'string', description: '已保存任务的 ID'}},
      required: ['jobId'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
  },
];

const pick = (obj, keys) => {
  const out = {};
  for (const key of keys) if (obj?.[key] !== undefined && obj[key] !== null) out[key] = obj[key];
  return out;
};

function compactModel(raw, handle) {
  const item = pick(raw, [
    'uid', 'name', 'author', 'license', 'licenseUrl', 'downloadable', 'url', 'thumbnail',
    'assetId', 'assetType', 'platform', 'kind', 'sourceType', 'hasMarmoset',
    'likes', 'views', 'animations', 'vertices', 'faces', 'publishedAt',
  ]);
  if (Array.isArray(raw?.categories)) item.categories = raw.categories.slice(0, 5);
  if (Array.isArray(raw?.tags)) item.tags = raw.tags.slice(0, 8);
  return handle ? {handle, ...item} : item;
}

function compactJob(job) {
  const item = pick(job, [
    'id', 'uid', 'name', 'kind', 'state', 'stage', 'message', 'warning',
    'filePath', 'filename', 'fileExists', 'downloadRoot', 'createdAt', 'finishedAt',
    'bytesWritten', 'totalBytes', 'sha256', 'size', 'retryCount', 'attempts',
  ]);
  if (job?.options) item.options = job.options;
  return item;
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE) map.delete(map.keys().next().value);
}

// ---------------------------------------------------------------- 工具实现

async function toolSearch(args) {
  const platform = args.platform || 'sketchfab';
  if (!SEARCH_ENDPOINTS[platform]) throw new Error(`不支持的平台 ${platform}`);
  const limit = Math.min(24, Math.max(1, Number(args.limit) || 12));
  const data = await client.searchAssets({platform, q: args.q || '', filters: args.filters || {}, cursor: args.cursor});
  const models = Array.isArray(data?.models) ? data.models : [];
  const batchId = `s${++searchSeq}`;
  remember(searchCache, batchId, {
    platform,
    kind: PLATFORM_KINDS[platform],
    models,
    q: args.q || '',
    createdAt: Date.now(),
  });
  return {
    batchId,
    platform,
    query: args.q || '',
    source: data?.source || null,
    total: data?.total ?? null,
    received: models.length,
    next: data?.next || null,
    warnings: data?.warnings || [],
    items: models.slice(0, limit).map((model, index) => compactModel(model, `${batchId}:${index}`)),
    hint: `本批共 ${models.length} 条，可用 handle（如 ${batchId}:0）交给 enqueue_download；完整原始数据见资源 assetvault://search/${batchId}。${data?.next ? '还有下一页，把 next 作为 cursor 传入。' : ''}`,
  };
}

async function toolEnqueue(args) {
  if (args.authorized !== true) {
    throw new Error('下载前必须由用户确认拥有该模型的下载与使用授权，然后把 authorized 设为 true。可下载不等于可商用。');
  }
  const groups = new Map();
  if (Array.isArray(args.handles) && args.handles.length) {
    for (const handle of args.handles) {
      const match = /^s(\d+):(\d+)$/.exec(String(handle));
      if (!match) throw new Error(`handle 格式无效：${handle}`);
      const batchId = `s${match[1]}`;
      const batch = searchCache.get(batchId);
      if (!batch) throw new Error(`搜索批次 ${batchId} 已过期，请重新调用 search_assets`);
      const model = batch.models[Number(match[2])];
      if (!model) throw new Error(`handle ${handle} 不在搜索结果范围内`);
      if (!groups.has(batch.kind)) groups.set(batch.kind, {batchId, models: []});
      groups.get(batch.kind).models.push(model);
    }
  }
  if (Array.isArray(args.models) && args.models.length) {
    const kind = args.kind || 'sketchfab';
    const group = groups.get(kind) || {batchId: null, models: []};
    group.models.push(...args.models);
    groups.set(kind, group);
  }
  if (!groups.size) throw new Error('需要提供 handles 或 models');
  if (groups.size > 1) throw new Error('不同平台的资产请分批下载：本次 handle 混用了多个平台');

  const [kind, group] = [...groups.entries()][0];
  const result = await client.enqueueDownload({
    models: group.models,
    kind,
    authorized: true,
    options: args.options,
    folder: args.folder,
    force: args.force,
    openInBlender: args.openInBlender,
  });
  const added = result?.added || [];
  return {
    ...result,
    kind,
    requested: group.models.length,
    hint: added.length
      ? `已加入 ${added.length} 个后台任务，下载不会阻塞本对话。用 get_jobs 查询进度；完成后可用 send_to_blender 或资源 assetvault://job/<任务ID> 查看详情。`
      : '没有新增任务：可能已在队列中或已有成功保存的文件。查 duplicates 字段，必要时传 force: true。',
  };
}

async function toolGetJobs(args) {
  const snapshot = await client.getJobs();
  const all = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
  for (const job of all) if (job?.id) remember(jobCache, job.id, job);
  if (args.jobId) {
    const job = all.find(item => item.id === args.jobId) || jobCache.get(args.jobId);
    if (!job) throw new Error(`找不到任务 ${args.jobId}`);
    const full = {...job, logs: Array.isArray(job.logs) ? job.logs.slice(-40) : job.logs};
    return {...full, hint: `完整日志见资源 assetvault://job/${args.jobId}`};
  }
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const filtered = args.state ? all.filter(item => item.state === args.state) : all;
  const counts = {};
  for (const job of all) counts[job.state] = (counts[job.state] || 0) + 1;
  return {
    total: all.length,
    returned: Math.min(limit, filtered.length),
    stateCounts: counts,
    queuePaused: snapshot?.settings?.paused ?? null,
    warning: snapshot?.warning ?? null,
    storageError: snapshot?.storageError ?? null,
    jobs: filtered.slice(0, limit).map(compactJob),
  };
}

async function toolListLibrary(args) {
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const state = await client.listLibrary();
  const out = {};
  for (const key of ['models', 'favorites', 'history', 'exportSettings', 'tasks']) {
    if (state?.[key] === undefined) continue;
    if (Array.isArray(state[key])) out[key] = {total: state[key].length, items: state[key].slice(0, limit)};
    else out[key] = state[key];
  }
  if (Object.keys(out).length === 0) out.rawKeys = Object.keys(state || {});
  if (args.scan) {
    const scanned = await client.scanLibrary({force: args.force === true});
    out.scan = {
      roots: scanned?.roots || [],
      packageTotal: Array.isArray(scanned?.packages) ? scanned.packages.length : 0,
      packages: (scanned?.packages || []).slice(0, limit),
      fileTotal: Array.isArray(scanned?.files) ? scanned.files.length : 0,
      files: (scanned?.files || []).slice(0, limit),
      truncated: scanned?.truncated ?? null,
    };
  }
  return out;
}

// ---------------------------------------------------------------- 本地资产库工具
// 阶段 2~4 的库检索 / 合集 / 批量打标以前只有浏览器面板能用，MCP 客户端完全看不到。
// 这里只做「紧凑入参 → 已有 /api/library/* 契约」的转发，绝不复制第二套筛选语义。

/** 写操作闸门：与 enqueue_download 的 authorized 同理，Agent 不能自己悄悄改资产库。 */
function requireConfirm(args) {
  if (args?.confirm !== true) throw new Error('这是写操作：请先向用户确认，再把 confirm 设为 true');
}
function uidList(value) {
  const list = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  if (!list.length) throw new Error('uids 必须是非空数组');
  if (list.length > 200) throw new Error('一次最多处理 200 个资产，请分批');
  return list;
}
function compactLibraryItem(raw) {
  const item = compactModel(raw, null);
  for (const key of ['rating', 'favorite', 'note', 'userTags', 'width', 'height', 'size', 'filePath']) {
    if (raw?.[key] !== undefined && raw[key] !== null) item[key] = raw[key];
  }
  return item;
}

async function toolSearchLibrary(args) {
  const data = await client.queryLibrary({
    q: args.q || '', filters: args.filters || {}, sort: args.sort, sortOrder: args.sortOrder,
    limit: Math.min(50, Math.max(1, Number(args.limit) || 20)),
    offset: Math.max(0, Number(args.offset) || 0),
  });
  const items = Array.isArray(data?.items) ? data.items : [];
  return {
    total: data?.total ?? 0, limit: data?.limit ?? null, offset: data?.offset ?? 0,
    engine: data?.engine || null, pushdown: data?.pushdown === true, count: items.length,
    items: items.slice(0, 50).map(compactLibraryItem),
    uids: (Array.isArray(data?.uids) ? data.uids : items.map(row => row?.uid).filter(Boolean)).slice(0, 50),
    hint: 'uids 可直接交给 tag_assets / manage_collection；翻页用 offset。',
  };
}

async function toolListCollections() {
  const data = await client.listCollections();
  const rows = Array.isArray(data?.collections) ? data.collections : [];
  return {total: rows.length, collections: rows.slice(0, 200)};
}

async function toolManageCollection(args) {
  requireConfirm(args);
  const action = String(args.action || 'create');
  const id = args.id ? String(args.id) : '';
  if (action === 'delete') {
    if (!id) throw new Error('delete 需要 id');
    return client.deleteCollection(id);
  }
  if (['add_items', 'remove_items', 'set_items'].includes(action)) {
    if (!id) throw new Error('成员操作需要 id');
    const act = {add_items: 'add', remove_items: 'remove', set_items: 'set'}[action];
    return client.setCollectionItems({id, uids: uidList(args.uids), action: act});
  }
  if (!['create', 'update'].includes(action)) throw new Error(`不支持的 action ${action}`);
  const board = {
    ...(id ? {id} : {}), name: String(args.name || '').trim(),
    ...(args.parentId ? {parentId: String(args.parentId)} : {}),
    ...(args.description !== undefined ? {description: String(args.description)} : {}),
    ...(args.coverAssetId !== undefined ? {coverAssetId: String(args.coverAssetId)} : {}),
    ...(args.icon !== undefined ? {icon: String(args.icon)} : {}),
    ...(args.color !== undefined ? {color: String(args.color)} : {}),
    ...(args.position !== undefined ? {position: Number(args.position)} : {}),
  };
  if (!board.name) throw new Error('name 不能为空');
  if (args.q !== undefined || args.filters !== undefined || args.sort !== undefined) {
    return client.saveSmartCollection({...board,
      q: String(args.q || ''), filters: args.filters || {}, sort: String(args.sort || 'recent')});
  }
  return client.saveCollection(board);
}

async function toolTagAssets(args) {
  requireConfirm(args);
  const uids = uidList(args.uids);
  const tags = key => (Array.isArray(args[key]) ? args[key] : []).map(String).filter(Boolean);
  const ops = [];
  for (const uid of uids) {
    for (const value of tags('addTags')) ops.push({op: 'tag.add', uid, source: 'user', value, by: 'mcp'});
    for (const value of tags('removeTags')) ops.push({op: 'tag.remove', uid, source: 'user', value, by: 'mcp'});
    for (const field of ['rating', 'favorite', 'note']) {
      if (args[field] !== undefined) ops.push({op: 'asset.set', uid, field, value: args[field], by: 'mcp'});
    }
  }
  if (!ops.length) throw new Error('至少要提供 addTags / removeTags / rating / favorite / note 之一');
  if (ops.length > 800) throw new Error('一次最多 800 条变更（uids × 字段数），请分批');
  const data = await client.mutateTags(ops);
  return {
    applied: data?.applied ?? 0, conflicts: data?.conflicts || [],
    fallback: data?.fallback === true, changes: (data?.changes || []).slice(0, 20),
    hint: 'rev_conflict 表示资产版本已变，重新 search_library 再改一次。',
  };
}

const HANDLERS = {
  // 原始 /api/downloads/capabilities 有 45 个布尔位，/api/exports/targets 还带每个 DCC 的
  // 安装路径与版本列表 —— 全塞进上下文没有意义。这里只留「能不能干活」需要的那几个。
  get_capabilities: async () => {
    const status = await client.getStatus();
    const cap = status.capabilities && typeof status.capabilities === 'object' ? status.capabilities : {};
    const missing = Object.entries(cap)
      .filter(([key, value]) => key !== 'version' && value !== true)
      .map(([key]) => key);
    const targets = Array.isArray(status.exportTargets) ? status.exportTargets : [];
    return {
      running: status.health?.name === 'assetvault-local-library',
      baseUrl: status.baseUrl,
      version: status.health?.version || cap.version || null,
      serverVersion: cap.version || null,
      missingCapabilities: missing.slice(0, 10),
      exportTargets: targets.map(target => ({id: target.id, label: target.label, configured: target.configured === true})),
      storage: status.health?.storage || null,
      hint: missing.length
        ? '服务在跑，但缺少部分能力位：多半是旧进程，重启 AssetVault 后即可恢复。'
        : '服务已就绪。可直接 search_assets 开始；下载前记得让用户确认授权。',
    };
  },
  search_assets: toolSearch,
  get_asset: args => client.getAsset(args).then(data => ({
    source: data?.source || null,
    count: Array.isArray(data?.models) ? data.models.length : 0,
    warnings: data?.warnings || [],
    models: (data?.models || []).slice(0, 24).map(model => compactModel(model)),
  })),
  enqueue_download: toolEnqueue,
  get_jobs: toolGetJobs,
  manage_job: args => client.manageJob(args).then(snapshot => ({
    errors: snapshot?.errors || [],
    jobCount: Array.isArray(snapshot?.jobs) ? snapshot.jobs.length : 0,
    hint: '操作已完成；如需确认最新状态请再调用 get_jobs。',
  })),
  list_library: toolListLibrary,
  search_library: toolSearchLibrary,
  list_collections: toolListCollections,
  manage_collection: toolManageCollection,
  tag_assets: toolTagAssets,
  send_to_blender: args => client.sendToBlender(args).then(result => ({
    ok: result?.ok !== false,
    message: result?.message || null,
    hint: '发送结果以 Blender 场景内实际出现的对象为准；桥接未安装或未打开 Blender 时会返回错误。',
    ...(result?.ok === false ? {error: result?.error || null} : {}),
  })),
};

async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`未知工具 ${name}`);
  const value = await handler(args || {});
  return {content: [{type: 'text', text: JSON.stringify(value, null, 2)}]};
}

// ---------------------------------------------------------------- 协议处理

function resourcesList() {
  const resources = [];
  for (const [id, batch] of searchCache) {
    resources.push({
      uri: `assetvault://search/${id}`,
      name: `搜索结果 ${id}（${batch.platform} · ${batch.q || '浏览'}）`,
      description: `${batch.models.length} 条完整原始模型数据，可用于检查筛选或构造自定义下载参数`,
      mimeType: 'application/json',
    });
  }
  for (const [id, job] of jobCache) {
    resources.push({
      uri: `assetvault://job/${id}`,
      name: `任务 ${job.name || id}`,
      description: `${job.state || '未知状态'} · 完整字段与日志`,
      mimeType: 'application/json',
    });
  }
  return {resources};
}

function resourcesRead(uri) {
  const text = value => ({contents: [{uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2)}]});
  if (uri.startsWith('assetvault://job/')) {
    const id = decodeURIComponent(uri.slice('assetvault://job/'.length));
    const job = jobCache.get(id);
    if (!job) throw new Error(`任务 ${id} 不在缓存中，请先调用 get_jobs`);
    return text(job);
  }
  if (uri.startsWith('assetvault://search/')) {
    const id = decodeURIComponent(uri.slice('assetvault://search/'.length));
    const batch = searchCache.get(id);
    if (!batch) throw new Error(`搜索批次 ${id} 已过期，请重新调用 search_assets`);
    return text({platform: batch.platform, query: batch.q, models: batch.models});
  }
  throw new Error(`未知资源 ${uri}`);
}

async function handle(message) {
  const {id, method, params = {}} = message;
  if (id === undefined) return; // 通知类消息不回复
  try {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
        return ok(id, {
          protocolVersion,
          capabilities: {tools: {listChanged: false}, resources: {listChanged: false}, logging: {}},
          serverInfo: SERVER_INFO,
          instructions: 'AssetVault 本地 3D 资产工作台。先调用 get_capabilities 确认服务已启动（其中 storage.engine 说明资产库内核是否在跑）；search_assets 找在线资产、handle 交给 enqueue_download、get_jobs 查进度；search_library 检索本地资产库，list_collections / manage_collection 管理合集，tag_assets 批量打标评分。下载与所有写操作都必须先让用户确认（authorized / confirm: true）。',
        });
      }
      case 'ping':
      case 'logging/setLevel':
      case 'resources/subscribe':
      case 'resources/unsubscribe':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {tools: TOOLS});
      case 'tools/call': {
        const name = params.name;
        try {
          return ok(id, await callTool(name, params.arguments));
        } catch (error) {
          const hint = error?.code === 'SERVICE_NOT_RUNNING'
            ? ' 请先双击 AssetVault.lnk 启动本地工作台服务（不要另起一个服务实例）。'
            : '';
          return ok(id, {
            content: [{type: 'text', text: `错误：${error?.message || String(error)}${hint}`}],
            isError: true,
          });
        }
      }
      case 'resources/list':
        return ok(id, resourcesList());
      case 'resources/templates/list':
        return ok(id, {
          resourceTemplates: [
            {uriTemplate: 'assetvault://search/{batchId}', name: '搜索结果原始数据', description: '某次 search_assets 的完整模型列表', mimeType: 'application/json'},
            {uriTemplate: 'assetvault://job/{jobId}', name: '下载任务详情', description: '某个任务的完整字段与日志', mimeType: 'application/json'},
          ],
        });
      case 'resources/read':
        try {
          return ok(id, resourcesRead(params.uri));
        } catch (error) {
          return fail(id, -32002, error?.message || String(error));
        }
      case 'completion/complete':
        return ok(id, {completion: {values: [], total: 0, hasMore: false}});
      default:
        return fail(id, -32601, `不支持的方法：${method}`);
    }
  } catch (error) {
    log(`处理 ${method} 失败：${error?.stack || error}`);
    return fail(id, -32603, error?.message || String(error));
  }
}

const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
rl.on('line', line => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, -32700, '无法解析 JSON 消息');
    return;
  }
  Promise.resolve(handle(message)).catch(err => {
    log(`未捕获异常：${err?.stack || err}`);
    if (message?.id !== undefined) fail(message.id, -32603, err?.message || String(err));
  });
});
rl.on('close', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
log(`已启动 · ${SERVER_INFO.name} ${SERVER_INFO.version} · 等待 MCP 客户端连接`);
