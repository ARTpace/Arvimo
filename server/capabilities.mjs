// 「正在跑的那个服务是不是这一版」的唯一判据。
//
// 启动器 scripts/start-library-background.mjs 每次双击都会先问服务端
// /api/downloads/capabilities，凭回答决定复用还是重启。问题在于这个回答和启动器的期望
// 曾经分住两个文件 —— 加功能的人改了服务端、忘了同步启动器，旧进程就被判定成「已是最新」，
// 于是永远不重启、新加的路由永远 404。
//
// Poly Haven 检索就是这么坏的：前端早就是新版（平台列表里有 Poly Haven），服务端进程却还是
// 旧的，搜索框一提交就撞上「不存在的页面或接口」；重启一次就恢复，但没人会想到要重启。
//
// 所以两边都从这里取：服务端原样返回 SERVER_CAPABILITIES，启动器用 serverIsCurrent() 判定。
// 加一个前端要用的新接口 = 在这里加一个能力位，两侧自动同步，没有第二处要记得改的地方。

export const SERVER_VERSION = '3.6.8';

/**
 * 服务端当前具备的能力。新增能力位之后，旧进程会在下次启动时被自动换掉。
 * 判定同时看 version 和能力位：只升版本、或只加能力位，两种情况都能触发重启。
 */
export const SERVER_CAPABILITIES = Object.freeze({
  version: SERVER_VERSION,
  aiConnection: true,
  aiSearchTranslation: true,
  pickFolder: true,
  fixedExportDefaults: true,
  artstationVerifyWindow: true,
  blenderExistingScene: true,
  blenderBridgeProgress: true,
  // Poly Haven 检索。加这一位的起因就是它：老进程没有路由，点搜索只能看到 404。
  polyhavenSearch: true,
  // Poly Haven 关键词本地匹配。上游 /assets 不认任何关键词参数，老进程把关键词拼进上游 URL
  // 等于没过滤 —— 不管搜什么都是同一批热门资产，看起来「搜索栏坏了」。行为变了就要换进程，
  // 否则老进程会一直返回那份未过滤的列表。
  polyhavenKeywordSearch: true,
  // Poly Haven 图片下载（官方渲染图，走自家 renders 接口）。老进程把图片任务当 Sketchfab，404。
  polyhavenImages: true,
  // ambientCG 材质检索 + 材质下载（kind:'ambientcg' 走独立 runner）。老进程没有路由，404。
  ambientcgSearch: true,
  ambientcgMaterials: true,
  // ambientCG 交互式材质预览：CSP frame-src 需要放行 releases.pbr.one（官方 PBR 查看器）。
  // 老进程的 CSP 不含这个域，iframe 会被安全策略拦成白屏，所以必须靠能力位换进程。
  ambientcgPreviews: true,
  // 旧收藏卡片的预览懒加载：GET /api/ambientcg/preview 按 assetId 现取查看器地址。
  ambientcgPreviewResolve: true,
  // 材质分类侧栏：GET /api/ambientcg/categories（官方 facets，材质过滤后返回）。
  ambientcgCategories: true,
  // 后台浏览器运行时：GET /api/browser（状态）+ POST /api/browser/install（按需下载）。
  // 漏了这一位就是踩过的老坑：旧进程没有 /api/browser，却因为版本号没变被判成「已是最新」，
  // 界面点「下载浏览器」只会撞上「不存在的页面或接口」，而且永远不重启、永远恢复不了。
  browserRuntime: true,
  // 首次运行的依赖准备：GET /api/setup（依赖清单）+ POST /api/setup（起安装任务 / 记完成）。
  // 老进程没有这条路由，新前端一进页面就会撞上「不存在的页面或接口」，所以必须换进程。
  setupWizard: true,
  setupWeeklyReminder: true,
  // 分类表缓存健壮性：四个平台的侧边栏分类表都是「抓一次缓存一天」，于是一份不完整的响应会毒住
  // 侧边栏整整一天。2026-10-16 实测 ambientCG 只剩一个分类（缓存里躺着 {"categories":[Tiles]}，
  // 来源是测试夹具写进了真缓存）。现在不足 3 条不落盘、缓存键统一换成 :v2 —— 老进程里那份既有
  // 条目只能靠换进程才会被绕过，所以这一位必须让启动器把旧进程重启掉。
  categoryCacheSelfHeal: true,
  // 浏览态改给「最新精选」：无关键词、无分类、排序还停在默认、未勾任何筛选时，Sketchfab 走
  // staffpicked + -publishedAt、ArtStation 走 editor_pick + 最新发布（2026-10-16 用户要求默认
  // 列表每天有变化）。老进程仍会给出那份固定的历史点赞榜，所以必须换进程。
  browseFeaturedDaily: true,
});

/** 必须为 true 的能力位（version 单独比）。从契约派生，不手抄，免得再漏一个。 */
export const REQUIRED_CAPABILITY_KEYS = Object.freeze(
  Object.keys(SERVER_CAPABILITIES).filter(key => key !== 'version'),
);

/**
 * 一份 /api/downloads/capabilities 的回答是否出自「够新」的服务端。
 * 端口被别的程序占着、服务端是旧版本、回答读不出来 —— 一律算不够新，交给启动器去重启。
 */
export function serverIsCurrent(cap) {
  if (!cap || typeof cap !== 'object') return false;
  if (cap.version !== SERVER_VERSION) return false;
  return REQUIRED_CAPABILITY_KEYS.every(key => cap[key] === true);
}
