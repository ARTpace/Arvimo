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

export const SERVER_VERSION = '3.12.0';

/**
 * 服务端当前具备的能力。新增能力位之后，旧进程会在下次启动时被自动换掉。
 * 判定同时看 version 和能力位：只升版本、或只加能力位，两种情况都能触发重启。
 */
export const SERVER_CAPABILITIES = Object.freeze({
  version: SERVER_VERSION,
  platformModules: true,
  aiConnection: true,
  aiSearchTranslation: true,
  pickFolder: true,
  inAppFolderPicker: true,
  lanSharing: true,
  // LAN clients need folder-to-ZIP retrieval and persistent device administration.
  lanFolderDelivery: true,
  lanLargeFolderDelivery: true,
  lanDeviceManagement: true,
  independentLanListener: true,
  lanVisitorSettingsGuard: true,
  clearedDownloadHistory: true,
  fixedExportDefaults: true,
  artstationVerifyWindow: true,
  blenderExistingScene: true,
  dccOneShotImport: true,
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
  ambientcgAssetTypes: true,
  ambientcgTypedSearchCache: true,
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
  // 本地文件夹索引：POST /api/library/scan + GET /api/local/file，资产库「自动认领本地素材」全靠这两条。
  // 老进程没有它们，扫描只会 404——而且因为版本没变永远不会重启，所以必须靠这一位把旧进程换掉。
  localFolderIndex: true,
  // 图站抓取（素材下载器整合）：GET /api/picture-site/resolve 把图站 URL 解析成整站图片清单，
  // 复用 collectImageAssets 下游（下载队列 / 本地图片库）。老进程没有这条路由，前端入队只会 404。
  pictureSiteResolve: true,
  // Pinterest 图站（借力 pin-grabber Python 服务）：GET /api/picture-site/resolve 命中 pinterest 后，
  // 走 pinterest-proxy 把请求转发给 pin-grabber（AV 按需自动拉起）。老进程没有这条链路，图站解析只会撞 404。
  pinterestViaPinGrabber: true,
  pinterestBoardListing: true,
  discoveryIdleRefresh: true,
  artworkPicturePreview: true,
  // 视频转封装：GET /api/local/play，mov/avi/wmv/mkv 这类容器由 ffmpeg 边转边发。
  // 老进程没有这条路由，视频会直接失败在「放不了」上，同样要靠这一位换进程。
  mediaTranscode: true,
  // Polyfork 检索 + 下载。老进程没有 /api/polyfork/* 路由，点搜索只会撞上
  // 「不存在的页面或接口」；缩略图代理白名单也缺 polyfork.dev，封面会一律裂图。
  polyforkSearch: true,
  polyforkDownload: true,
  // 参数化预览：/api/polyfork/params（旋钮清单）与 /api/polyfork/variant（几何重建）。
  // 少了这两条，remixable 资产能看不能调，前端会显示「当前版本不支持参数预览」。
  polyforkParams: true,
  // 生成器源码接口：前端拿回浏览器跑 createAsset()，改参数 5ms 出新几何。
  // 老进程没有这条路由，前端会静默退回服务端烘焙（能用但慢 400 倍），所以这一位只影响速度。
  polyforkRebuild: true,
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
