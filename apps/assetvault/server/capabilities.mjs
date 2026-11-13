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

export const SERVER_VERSION = '3.32.3';

/**
 * 服务端当前具备的能力。新增能力位之后，旧进程会在下次启动时被自动换掉。
 * 判定同时看 version 和能力位：只升版本、或只加能力位，两种情况都能触发重启。
 */
export const SERVER_CAPABILITIES = Object.freeze({
  userDataPaths: true,
  lazyPreview: true,
  incrementalScan: true,
  // 文件夹实时监控：磁盘变化经 SSE 推给前端（kind:'local'）。老进程不认这个 kind，
  // 前端会一直等 15 秒轮询 —— 功能看着「没生效」，所以必须靠能力位换进程。
  folderWatch: true,
  // WebDAV 云同步（/api/library/sync）。老进程没有这三条路由，设置页会一直 404。
  webdavSync: true,
  // 视频源四站（Pexels / Coverr / Civitai / Pixabay）：老进程的 PICTURE_SITES 里没有这四个 id，
  // 视频模式一解析就是「该图站暂不支持抓取」—— 看着像网络问题，其实是进程没换。
  videoSites: true,
  version: SERVER_VERSION,
  platformModules: true,
  simreadyAssets: true,
  simreadyPreview: true,
  aiConnection: true,
  aiSearchTranslation: true,
  pickFolder: true,
  // 外部文件 / 文件夹拖入：/api/library/drop-import（二进制落盘 + 复用 importFile 入库）。
  // 老进程没有这条路由，前端拖进去只会 404，必须靠能力位换进程。
  dropImport: true,
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
  // UI 元素平台（Uiverse）：检索 + 代码取用 + 落盘。
  // 这三样缺一不可，缺哪样都表现为「点了没反应」而不是报错：
  //   检索  POST /api/uiverse/search      —— 平台下拉里选得到它
  //   代码  GET  /api/ui-site/code        —— 卡片上的动效预览靠它懒加载
  //   落盘  kind:'uielement'              —— 下载得到 index.html + style.css
  // 老进程没有这些路由，前端会静默降级成空卡片，所以必须靠能力位换进程。
  uiverseSearch: true,
  uiverseCodePreview: true,
  uiverseElementDownload: true,
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
  // 资产库内核：/api/library-state 背后换成 SQLite（原始快照仍保留、DB 故障自动降级）。
  // 前端契约不变，但老进程没有的能力后续会挂在新路由上，所以必须让启动器换掉旧进程。
  libraryDb: true,
  // 内核附带 FTS5 trigram 索引与合集表，供下一阶段的细粒度查询接口使用。
  libraryDbIndexes: true,
  // 阶段 2：POST /api/library/query 的布尔/字段检索 + 多维过滤 + 11 种排序。
  // 老进程没有这条路由，新面板一提交就是 404，因此必须让启动器换掉旧进程。
  libraryAdvancedQuery: true,
  // 阶段 2：/api/library/collections 与 /api/library/smart-collections（规则自动重算）。
  libraryCollections: true,
  // 阶段 3：GET/POST /api/library/assets 按需分页返回完整资产；FTS5 候选集只对简单词启用，
  // 复杂检索式仍由同一套语义求值。老进程没有这条路由，分页取数会 404。
  libraryPagedAssets: true,
  // 阶段 3：合集手动顺序（collection_assets.position）+ sort:'collection' + reorder 操作。
  libraryCollectionOrder: true,
  // 阶段 4：POST /api/library/mutations 增量写入（前端只发变化的字段/键）。
  // 老进程没有这条路由，前端会自动整块重放，功能不坏但白撞一次 404 —— 靠这一位换掉旧进程。
  libraryIncrementalMutations: true,
  // 阶段 4：/api/library/assets 的 uidScope:'page'，大库按页取数不再一次传全部命中 uid。
  libraryPagedFetch: true,
  // 格式支持：共享注册表 + 分组筛选面板 + ext:/format: 字段检索 + filters.formats。
  // 老进程会静默忽略新 filters 键（不报错但筛选无效），所以必须靠这一位换掉旧进程。
  libraryFormatFilter: true,
  // 颜色 / 数值范围筛选：新 filters 键（colors / ranges / favoriteMode / ratings / excludeTags…）
  // 与 color:/aspect:/width:/duration: 检索字段。老进程会静默忽略这些键，必须换进程。
  libraryColorFilter: true,
  libraryNumericFilter: true,
  // 封面探测缓存 assetProbe 进入主状态差量协议，并由派生索引注入 payload。
  libraryProbeMetadata: true,
  // sortOrder:desc / seed 与新增的 color / resolution / size 排序。
  librarySortDirection: true,
  // 智能收集画板：/api/collect/* 规则 CRUD、立即采集、待合并队列与 60s 调度。
  // 老进程没有这些路由，采集面板一打开就 404，所以必须靠这几位把旧进程换掉。
  collectRules: true,
  collectScheduler: true,
  collectPendingMerge: true,
  collectPlatformSearch: true,
  // 小红书图站接入（笔记 / 短链 / 博主主页 / 关键词搜索）。老进程的 PICTURE_SITES 里没有这个 id，
  // 解析会直接报「这个图站暂时不支持抓取」，所以必须换进程。
  pictureXiaohongshu: true,
  // 小红书「浏览器通道」：当前网页版把搜索/推荐/主页笔记全改成客户端异步拉取（SSR 里没有结果），
  // 而那份 JSON 必须带 x-s 签名 —— 改成借已登录的浏览器让页面自己请求，我们从 CDP 网络层旁观。
  // 老进程没有这条链路，列表页只会报「需要先登录」或者干脆空结果（用户看到的就是「登录了也搜不到」），
  // 所以这一位必须让启动器把旧进程换掉。
  pictureXiaohongshuBrowser: true,
  // 图片包边下边写：reserveFolder 一建好就写「活清单」info.json，第一张图落盘即可出正式卡。
  // 老进程要等全部下完才写清单，前端的 5 秒重扫与状态角标都拿不到 status，必须换进程。
  imageLivePackage: true,
  // 缩略图 / 视频的 ffmpeg、启动器的 PowerShell 等外部命令统一隐藏控制台。
  // 老进程每生成一张 jpg 缩略图就闪一个黑框，打开图集会连闪上百个，必须换进程。
  silentExternalProcesses: true,
  // 光栅缩略图（jpg/webp/avif/gif/bmp/tiff）走 sharp 原生插件，不再 spawn ffmpeg 子进程。
  // 老进程打开图集仍会起上百个 ffmpeg 进程（即使隐藏窗口也只是看不见），必须换进程。
  sharpRasterThumbnails: true,
  // 本地资产库「文档格式支持」：markdown 排版 / docx / epub 走独立 bundle /doc-render.js，
  // pptx/xlsx/rtf 等走 GET /api/doc/pdf（LibreOffice 转 PDF）+ GET /api/doc/status。
  // 与 RSS 无关。老进程既没有这两条路由，也不会放行 /doc-render.js 静态资源 ——
  // 结果就是打开文档直接撞 404 或加载失败，所以必须靠能力位把旧进程换掉。
  docRenderBundle: true,
  docConvertPdf: true,
  // 资产库「导入文件夹」：/api/library/import-roots、pick-folder、browse-folder 三条路由。
  // 老进程没有它们，前端点导入只会撞 404，必须靠能力位把旧进程换掉。
  localImportRoots: true,
  // 阶段 5.1 / ADR-05：asset:* 定点写（POST /api/library/assets/mutate）。
  // libraryDbAuthoritative 要到 5.5 真正拆掉整块通道时才置 true，此处不要提前认领。
  assetOps: true,
  // 阶段 5.2：下载入库改走 asset:add 增量，服务端过渡期同步主 blob。
  // 老进程没有 syncBlob，前端会拿到旧目录，必须靠能力位把旧进程换掉。
  assetIngestIncremental: true,
  // ADR-07：读侧目录域以 assets 表为权威（AV_LEGACY_CATALOG=1 可退回 blob）。
  catalogDbAuthoritative: true,
  // ADR-08：作废 / 恢复走 asset:trash / asset:restore 定点 op。
  assetTrashOps: true,
  // ADR-09 / 阶段 5.5：目录写入以 DB 为唯一权威（整块通道只承载非目录域），
  // 启动改走按页目录读取。老进程没有这两条读路由，必须靠能力位把旧进程换掉。
  libraryDbAuthoritative: true,
  catalogSingleWriter: true,
  catalogPaged: true,
  // ADR-11 / 阶段 5.6：分类与可下载性列化（schema v5）后，筛选条上除颜色外全部可下推；
  // 目录读投影同时去掉下载任务重字段（实测目录体积 -59%）。
  pushdownCategories: true,
  catalogSlim: true,
  // ADR-10：整库导出 / 导入（GET /api/library/export、POST /api/library/import）。
  // 老进程没有这两条路由，前端备份面板会撞 404，必须靠能力位把旧进程换掉。
  libraryPortableExport: true,
  // #7：导入根离线状态与「重新定位」（import-roots 的 entries / relink）。
  importRootRelink: true,
  // ZIP 内嵌浏览：GET /api/local/archive（读中央目录、按条目预览）。
  // 老进程没有这条路由，双击压缩包只会「不支持预览」，必须靠能力位换进程。
  archiveBrowse: true,
  // Eagle / Billfish 迁移：POST /api/library/import/eagle 与 /probe。
  // 老进程没有这两条路由，迁移卡片点了就是 404。
  thirdPartyLibraryImport: true,
  // ADR-12：多资源库注册表（GET/POST /api/library/stores + /stores/restart）。
  // 老进程没有这几条路由，资源库卡片会一直显示「读取失败」。
  multipleLibraries: true,
  // ADR-13：账号与机器令牌住在库外面（accountsDir），所有资源库共用一套账号。
  // 老进程仍把账号绑在 dataDir 上，切库就变成没账号 —— 必须换进程。
  sharedAccounts: true,
  // ADR-15：语义搜索 / 找相似（schema v6 的 asset_vectors + /api/library/semantic/*）。
  // 老进程没有这张表和这几个路由，语义开关点下去只会 404。
  semanticSearch: true,
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
