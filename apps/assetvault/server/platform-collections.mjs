// 平台收藏夹通用能力契约（跨模块契约，新平台接入 MUST 读 assetvault-platform-collections skill）
//
// 目标：把「小红书收藏夹」这一套特例抽象成与平台无关的契约。
//   · 数据模型统一：boards=[{id,title,url,count,thumb}]，mode:'boards'，collectionOps=[...]
//   · 写操作统一：collectionCommand(platform,{action,...}) → 各平台 adapter 实现
//   · 能力探测统一：ops 由各平台 probeOps() 运行时上报，前端只显示真实支持的操作
//   · 入口 URL 统一：homeUrl/collectUrl 由 adapter 提供，前端「推荐/我的收藏」切换不再写死域名
//
// 新平台接入三步（详见 skill）：
//   1. registerCollectionPlatform({...adapter})
//   2. 在 picture-sites.mjs 的 resolver 里用 withCollectionCaps() 包裹返回结果
//   3. collectionCommand 的 action 在 adapter.mutate 里实现；前端无需再改平台判断
//
// 依赖方向：generic → adapter(平台)。xhs-browser 不反向依赖本文件，无循环。

const adapters = new Map();

/**
 * 注册一个平台的收藏夹能力。
 * adapter 契约：
 *   {
 *     id: 'xiaohongshu',
 *     label: '小红书',
 *     homeUrl: 'https://…/explore',         // 「推荐」入口，可为空
 *     collectUrl: 'https://…/user/collect', // 「我的收藏」入口，可为空
 *     ops: ['create','rename','remove','add','removeItem'], // 声明的能力（静态基线）
 *     probeOps?: async () => string[],       // 运行时探测真实可用的 ops（覆盖静态基线）
 *     mutate?: async ({action, ...args}) => result, // 写操作分发
 *   }
 */
export function registerCollectionPlatform(adapter) {
  if (!adapter || !adapter.id) throw new Error('收藏夹 adapter 缺 id');
  adapters.set(adapter.id, adapter);
}

export function collectionPlatformIds() {
  return [...adapters.keys()];
}

export function isCollectionPlatform(platform) {
  return adapters.has(platform);
}

/** 同步读取能力描述（不探测），用于 resolver 给前端下发入口与基线能力位。 */
export function collectionCaps(platform) {
  const adapter = adapters.get(platform);
  if (!adapter) return null;
  const caps = {
    collectionPlatform: adapter.id,
    collectionLabel: adapter.label || adapter.id,
    collectionOps: [...(adapter.ops || [])],
  };
  if (adapter.homeUrl) caps.collectionHomeUrl = adapter.homeUrl;
  if (adapter.collectUrl) caps.collectionCollectUrl = adapter.collectUrl;
  const detectSource = detectSourceOf(adapter.collectDetect);
  if (detectSource) caps.collectionCollectDetect = detectSource;
  return caps;
}

/** collectDetect 允许写 RegExp 或返回布尔的函数；统一取出可下发/可重建的 source 字符串。 */
function detectSourceOf(detect) {
  if (detect instanceof RegExp) return detect.source;
  if (typeof detect === 'string') return detect;
  if (typeof detect === 'function') {
    // 函数没有 source，前端无法 new RegExp；约定函数型 adapter 额外提供 collectDetectSource。
    return detect.source || null;
  }
  return null;
}

/**
 * 运行时探测真实可用的能力位。探测失败时回落到静态声明（不让能力位因网络抖动消失）。
 * 探测结果带 defaultItemOps：哪些操作作用在单条笔记/图片上（供卡片按钮用）。
 */
export async function probeCollectionOps(platform) {
  const adapter = adapters.get(platform);
  if (!adapter) return null;
  const base = [...(adapter.ops || [])];
  if (typeof adapter.probeOps !== 'function') return { ops: base, defaultItemOps: adapter.defaultItemOps || [] };
  try {
    const live = await adapter.probeOps();
    const ops = Array.isArray(live) ? live : (live?.ops || base);
    const signatures = live?.signatures || {};
    return { ops, signatures, defaultItemOps: adapter.defaultItemOps || [] };
  } catch {
    return { ops: base, signatures: {}, defaultItemOps: adapter.defaultItemOps || [] };
  }
}

/** 把能力位写进 resolver 结果；缺失时原样返回（非收藏平台零影响）。 */
export function withCollectionCaps(result, platform) {
  const caps = collectionCaps(platform);
  return caps ? { ...result, ...caps } : result;
}

/** 判断结果是否处于「我的收藏」视图（前端切换按钮高亮用，不再读 URL 域名）。 */
export function isCollectView(platform, url) {
  const adapter = adapters.get(platform);
  if (!adapter) return false;
  const target = String(url || '');
  if (adapter.collectDetect instanceof RegExp) return adapter.collectDetect.test(target);
  if (typeof adapter.collectDetect === 'function') return !!adapter.collectDetect(target);
  return false;
}

const ACTIONS = new Set(['create', 'rename', 'remove', 'add', 'removeItem']);

/**
 * 统一写操作入口。校验 action 白名单与平台声明的能力，再分发到 adapter.mutate。
 * 前端只调这一个端点，平台差异全部收敛在这里。
 */
export async function collectionCommand(platform, input = {}) {
  const adapter = adapters.get(platform);
  if (!adapter) throw new Error('这个平台不支持收藏夹操作');
  const action = String(input.action || '');
  if (!ACTIONS.has(action)) throw new Error('不支持的收藏夹操作');
  if (!(adapter.ops || []).includes(action)) throw new Error(`这个平台暂不支持「${action}」操作`);
  if (typeof adapter.mutate !== 'function') throw new Error('这个平台的收藏夹尚未开放写操作');
  return adapter.mutate({ ...input, action });
}
