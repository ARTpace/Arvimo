# CODEMAP — src/library（AssetVault 本地库前端）

> 功能 → 文件 索引，AI 首读。新增 / 移动文件必须同步本表。
> 本文位于 `docs/CODEMAP.md`；下文路径均相对于项目根目录，前端模块省略 `src/library/` 前缀。整体目录约定见 [目录规范](project-structure.md)。
> **设计决策、冻结契约、已完成阶段与后续路线见 [资产库开发文档](asset-library-development.md)**：改 schema / API / 差量协议 / 能力位之前先读那份，本表只负责「功能 → 文件」定位。
> 依赖单向向下：`app.js` 装配一切；子模块经 `createX(ctx)` 工厂拿依赖，互不 `import` 对方、也不 `import app.js`。

## 入口与装配
- `multi-search.js` — 逗号/分号分隔的多词并行检索，保留短语空格、逐词中文翻译、合并结果并保留各词分页；每次最多 8 个词。
- `persistent-storage.js` / `server/library-storage.mjs` — 将资产列表、收藏、搜索快照和界面偏好持久化至应用数据目录，首次迁移恢复实际存在的已下载资产，跨启动端口保持一致。
- `app-updates.js` — 桌面版签名更新：自动检查提示、下载进度、任务保护、重启安装；浏览器模式只显示说明。
- `app.js` — 主入口。持有 `state`、路由、事件绑定，把各工厂拼起来。重构后只保留装配 + 顶层交互，渲染/检索已下移到子模块。检索词组相关：`termSources()` 整理今日主题 / 相近词给浮层，`refreshTopicStrip()` 退化为「通知浮层重画」的薄封装，`pickTerm()` 是推荐词的统一检索入口。
  - **本地库活动图片轮询（`liveImageKey` 那一段）已改自适应**：图片下载活跃时新任务露头先 5s 快速出卡（强制重扫绕过缓存），`key` 稳定后自动降到 15s 低频（`pollSteady`），并加 `pollRunning` 防 `setTimeout` 重入、隐藏页不扫只排期。目的——后台每轮 `rootsSignature` 要对全部下载根做 stat+readdir，长时间批量下载时稳态降频能省下大半扫描开销，单张图晚一二十秒被画廊捕获对用户无感。
  - **启动扫描不阻塞首屏（#5 已达成，无需再改）**：`scanLibraryFiles()` 在启动时 `const initialScan=scanLibraryFiles()` 未 await（fire-and-forget），且 `state.route` 初始为 `discover`、`scanLibraryFiles` 内 `if(state.route!=='discover')renderGrid()`——discover 首屏直接靠 `loadLibrary(storage)` 从 localStorage 渲染，扫描在后台跑；`createLocalFiles` 初始化时也已从 `sfx-local-index-v1` 恢复本地索引（`local-files.js` 顶部），切到资产库瞬间有内容、后台扫描只做刷新。服务端 `/api/library/scan` 还走 `cachedScan` 缓存命中即返回。§255 那条「`/api/library-state` 整块 GET」是另一回事（牵动 `models` 写入从 blob 迁 DB 权威），与本地库扫描路径无关。

## 本次重构从 app.js 切块拆出的模块
- `card-view.js` — `createCardView`：单张模型卡片的 HTML（封面 / 统计 / 操作按钮 / Blender 标记 📦）。卡片上的**来源标签**一律经 `platformLabel`（从 `platforms.js` 注入）取，绝不写死 `Sketchfab`——Poly Haven 资产（无面数无点赞）此前因此误标。统计末格（浏览/点赞）仅在 `m.views||m.likes` 有时才渲染，避免空统计。单测见 `test/library-card-view.test.js`。
- `icon-set.js` — `icon(name)`：SVG 图标集（lucide 风格），唯一导出，全局复用。
- `library-view.js` — `createLibraryView`：网格 / 状态条 / 计数 / 分页 / 布局 / 预览 渲染层；`placeFilters()` 负责宽屏→左栏、窄屏→搜索卡片的 DOM 搬运。
- `discovery-feed.js` — `createDiscoveryFeed`：检索发起三件套 `requestFeed` / `startSearch` / `submitLink`；endpoint 走 `platforms.js` 注册表，不再三元链。
- `discovery-view.js` — 检索文案 / 视图辅助：`statusText` / `subtitleText` / `describeRequest` / `feedLabel`。
- `platforms.js` — 平台注册表：`PLATFORMS` / `FEEDS` / `feedEndpoint` / `routeLink`。**加平台只改这里**（声明 feeds、filters、placeholder、suggestions 即可），契约测试白名单也从 `PLATFORMS` 派生。
- `card-context-menu.js` — 卡片右键菜单（菜单挂 body、条目沿用 `data-action`、`buildItems` 是纯函数可单测）。四类本地卡（远端资产 / 素材包 / 图片序列 / 零散文件）在「打开与获取」组里都有**「打开所在文件夹」**（run 型，`ctx.onReveal` 由 `app.js` 注入本地 root+rel）；没有本地路径的资产卡不塞这颗键，避免死按钮。回归见 `test/library-card-context-menu.test.js`。

## 平台 / 源
- `server/civitai.mjs` — Civitai 模型适配器：模型页 / 版本链接解析、官方 API 搜索、按版本选文件（优先 safetensors）、Range 续传下载、`info.json` 元数据。API key 由调用方注入，不进任务与日志；出域只走 `public-http.mjs`。测试：`test/library-civitai-download.test.js`。
- `polyfork-ui.js` — Polyfork 筛选 UI：类别下拉（固定 9 个官方 class，不编计数）+ 排序；`read()` 输出 `{q,assetClass,sort}`。
- `polyfork-params.js` — Polyfork 参数面板（预览弹窗右侧）：渲染 `-params.json` 的旋钮、持有当前值、分派给 `gltfPreview`。
  **颜色走 `setPolyforkColors()`（本地改顶点色），几何走 `bakePolyfork()`（本地生成器优先，见下）**；
  range 拖动期间按 rAF 合并调 `bakePolyfork(...,{live:true})`，只有 `polyforkLive()` 为假（没有生成器）时才不发请求；
  `range` 只在 `change`（松手）时请求，`input` 期间只更新数字。副标题用 `.pf-meta`，不能用 `.author-name`（会被作者按钮覆盖）。
- `polyfork-zh.js` — 参数中文化的**规则层**：`KEYS`（整 key）→ `PHRASES`（整串短语）→ `WORDS`（逐词拼，全词命中才拼，否则留英文）。
  `labelOf`／`valueOf` 的语义是「规则层翻出来了就信规则层，模型字典只补空缺」——**别改成字典优先**，
  模型会把 windmill 的 `cap pitch` 译成「机头坡度」。`-params.json` 的 `describe` 是整段英文，规则层不碰。
- `artstation-ui.js` — ArtStation 预览 / 作品页 UI（3D Viewer 与图片两种形态）。
- `term-groups.js` — **检索词组分类契约**：`TERM_GROUPS`（最近检索 / 链接解析 / 今日主题 / 相近词四组的顺序、图标、配色、是否参与输入过滤、空组策略）+ 纯函数 `buildTermSections()`。加一类词组 = 表里加一行 + `app.js` 的 provider 给数据。
- `search-history.js` — 检索词组浮层（原「最近检索下拉」）：按 `term-groups.js` 分区渲染，数据由 `app.js` 的 `sources()` 注入；**两列排版**（`data-cols` 随组数退回单列，窄屏媒体查询再退），键盘导航跨分组连续，`onPick` 回放历史、`onTerm` 发起新检索。入场动效只在 `render(true)`（刚打开）时挂 `.term-anim`，打字过滤重绘不重播。
- `search-options.js` — 搜索选项（排序 / 范围记忆等）+ `dailyTopics()` 每日主题词池。

## UI 元素平台（Uiverse，3.16.2）
产出的是**界面动效代码**，不是 3D 模型 —— 独立管线，与模型管线不混。

- `server/uiverse-state.mjs` — 解析层（纯函数、零网络、可单测）：链接四种形态（元素页 / 创作者主页 / 分类页 / 列表页）、类型路径映射、`:root`→`:host`、`@import` 提前、预览文档与落盘文件组装。
  **类型路径表 `UIVERSE_TYPE_PATHS` 必须显式列复数路径，不能由单数别名取反** —— `loaders` 与 `loader` 都映射到 `loader`，取反会让单数别名胜出 → 请求 `/loader`（站点不认）。**站点只认路径段过滤类型**（`/elements?type=loader` 的参数是死的），类型过滤要换路径。
- `server/uiverse.mjs` — 网络层：三个 Remix 通道（列表 / 详情 / 代码）+ 403 退避重试 + 发现页检索流 `uiverseSearch()`。
  **数据路由名存未编码形式**（`routes/$category`）交给 `URLSearchParams` 编码一次 —— 预编码会被二次编码成 `routes%252F%2524category`，Remix 认不出就回 403（表现为「列表和搜索全挂、详情正常」，很像限流）。
  `uiverseSearch()` 给发现页（models / next / pending / warnings），`searchUiverse()` 给采集层（items），`resolveUiverse()` 给粘链接。
- `server/uiverse-job.mjs` — 落盘执行器 `runUiverseJob()`：写 `index.html`（相对路径 `<link>` 引 style.css）+ `style.css` + `README.md`（出处 / 作者 / 许可 / 标签 / 浏览量 + 代码全文）+ `info.json`。
- `src/library/ui-element-preview.js` — 前端预览：**卡片走 Shadow DOM**（`:root` 在 Shadow 里匹配不到，元素的 CSS 变量会全失效，所以换成 `:host`）、**弹窗走 iframe + srcdoc + sandbox**（不给 `allow-scripts`，CSS 动画不需要脚本）。
  `observeUiPreviews()` 用 `IntersectionObserver` 懒加载（滚进视口才取代码）；`fetchUiCode()` 走 `/api/ui-site/code` 并按元素 id 缓存。
  **不用静态封面图**：官方图床在 imagedelivery.net，很多网络下连不上；更关键的是 UI 元素的卖点就是「会动」。
- `src/library/platforms.js` — `UI_SITES` 注册表（粘链接命中谁）、`UI_LINK_ROUTES`、`uiverse` 平台条目（`feeds:['uiverse']`）、`ORIGIN_COPY.uiverse`、`PLATFORM_KINDS.uiverse`（两种模式都列它）。
- `src/library/library-view.js` — `FILTER_ROWS` 的**单一来源**（搬进侧栏 + app.js 的显隐共用一份）；`previewUiElement()` 弹窗；`mountUiPreviews()` 网格懒挂载。**注意 `FILTER_ROWS` 存的是裸 id**：`app.js` 里 `renderFilters()` 必须用 `$('#'+row)` 查询（`$` 是 `querySelector`），漏写 `#` 会返回 null 并在「全部平台」分支抛 `Cannot set properties of null (setting 'hidden')`，导致整个界面初始化失败；回归断言在 `test/library-filter-rows.test.js`。
- 测试：`test/library-uiverse-state.test.js`（16 例）+ `test/library-ui-element-preview.test.js`（4 例）。

## 筛选
- `disclosure-motion.js` — 筛选树共享展开状态与可中断高度过渡；仅用户点击播放，初始化直接到位，折叠内容禁用键盘焦点，遵循减少动态效果设置。
- `filter-tree.js` — 侧栏筛选树（各平台的分类 → 分组 / 折叠 → 可点项）。字段带 `groups`（手工分组表）就按组画、带 `fold`（长列表）就按热度折成长短两截、两者都没有才平铺。
- `filter-groups.js` — 分类清单的分组 / 折叠表：ArtStation 的 6 个用途组（按官方英文分类名声明，中文经 `filter-labels.js` 派生）+ 长列表折叠阈值 / 纯函数 `foldLongList`。**加平台只改这里，渲染器不再认识任何平台名。**
- `filter-labels.js` — 分类标签中文文案。
- `merged-filters.js` — 模型模式统一筛选树（两平台共用一套分类 / 排序 / 范围）。

## 模式（一个图标 = 一整套上下文）
- `mode-presets.js` — **模式契约层 / 单一事实源**：`MODE_PRESETS` 四个模式（图片 / 模型 / 文本 / 视频）各声明 `platformKind`（平台下拉池）、`defaultPlatform`、`gallery` / `modelOnly`（布局与 A 站请求形状）、`localKind` / `localOnly`（资产库页类型）。`platformPoolFor()` / `fullPlatformPool()` 从 `platformsForMode()` 派生清单并剔除 Uiverse（产出的是界面代码，不是这四类内容）；`pickModePlatform()` + `av:mode-platform:v1` 让每个模式各自记住上次选的站，站点关掉后退回默认。以后接新在线源只改这张表，UI 一行不动。测试 `test/mode-presets.test.js`。
- `content-kind-tabs.js` / `content-kind-tabs.css` — 顶部**模式切换轨**（`index.html` 的 `#content-kind-tabs`，挂在 `.search-sticky` 内、`#search-panel` **之前**，即贴卡片上沿之外）：固定 4 个 SVG 图标常驻，hover / focus 才展开文字；**没有「全部」键、不显示数量、不显示来源平台**，也不按资产计数或 route 增减图标。默认无激活＝全部，再点当前键或 `Esc` 退出。`MODE_TABS` 由 `MODE_PRESETS` 派生；`CONTENT_KINDS` + `FORMAT_TO_ID` 只管本地类型判定（`contentKindsOf()`）。UI 状态存 `av:content-mode:v1`（兼容旧键 `av:content-kind:v1`）。轨道用 `width:max-content` + `margin:auto` 居中，**自身不画外框、不铺底色**（只留图标）；`margin-bottom` 取 `calc(8px - var(--ck-panel-gap))` 与 `#search-panel` 的上外边距折叠，把轨压到卡片上沿外 8px，改卡片留白只改 `--ck-panel-gap` 一处。展开宽度不写死：挂载后 `measureLabelWidths()` 量出文字实宽写进每键的 `--label-w`，`max-width:0 → var(--label-w)` 匀速长开（写死大上限会让宽度在前 15% 冲到顶、邻居像被瞬间顶飞）。不要加 `.ck-spacer` 之类的弹性占位，会把居中图标组顶偏。窄屏（≤780）猫头收一档避让图标轨。**同一排键在两个页面干两件事**：发现页换平台池 / 结果流 / 布局（`applyModeTab` 的原逻辑）；资产库页只把本地类型拨到 `#local-kind`（文本 / 视频走 `state.contentKind`）并原地 `renderGrid()`，**绝不换路由**——库里没有在线结果流可换，跳走等于把用户从他正在整理的这一库文件里踢出去。测试 `test/library-content-kind-tabs.test.js`。
- `app.js` — **`state.mode` 是显式主状态**，不再从 `platform/modelOnly/gallery` 反推：`applyModeTab()` 一次性切「下拉池 + 默认站 + 结果流 + 布局 + 本地类型」；`loadModeResults()` 图站走 `openPictureHome()` 拉首页推荐图、3D 平台走 `startSearch()` 重搜（`resetDiscoveryFeeds` 清掉上一模式的流，结果区不残留别类卡片）；`exitContentMode()` 回全量池。手动在 `#search-platform` 换站只算模式内子选择，模式保持点亮；改 `#local-kind` 或清除筛选则退出模式。**落点按路由分叉**：发现页走上面那套完整切换；资产库页只 `applyLocalKind()` + `renderGrid()`，**不换路由**（`exitContentMode()` 同理）。本地磁盘上的额外卡片（`extraCards()` 的零散文件与资产包）不属于 `state.models`、不走 `contentKindsOf()`，靠 `content-kind-tabs.js` 的 `LOCAL_KINDS_OF_MODE` + `modeAllowsLocalKind()` 按 `file.kind` / `pkg.category` 再筛一次，否则会出现「计数 0 条、卡片铺满一屏」。展示区标题由 `library-view.js` 的 `modeTitlePrefix()` 加模式名；类型筛空时用专用空状态（`narrowed` 必须含 `state.contentKind`）。
- `content-modes.js` — 旧三态纯逻辑，仅保留给历史测试与兼容读取；前端不再用它推高亮或决定平台。

## 下载
- `server/civitai.mjs` — `kind:'civitai'` 的 runner 实现；`downloads.mjs` 只负责队列分派 / 进度 / 校验 / 提交，不在这里重复造任务系统。
- `download-ui.js` / `download-card.js` / `download-progress.js` — 下载列表与单条卡片 / 进度。
- `image-download.js` — 图片下载器（作品图 / 封面，带校验）。

## 导出引擎
- `engine.js` — 导出管线代理（拦截外部域名走 `/api/proxy`）+ GLB 校验，调 vendor `pipeline.js`。
- `blender-bridge.js` / `blender-send.js` — 与本地 Blender 的桥接与发送（仅已下载资产显示按钮）。

## 拖出到外部软件（桌面版）
- `src/library/drag-payload.js` — **卡片 → 拖放描述**的注册表（预览大图 / 资产库资产卡 `data-uid` / 本地素材包 `data-package` / 图站卡 `img[data-url]`）。描述只有三种：`asset{uid}`、`local{root,rel}`、`remote{url,name}`；鼠标**悬停资产卡**与 `pointerdown` 都会预热（图站卡按下才预热，避免悬停就抓 4K 原图），`resolve()` 对同一批描述复用同一个 Promise，结果缓存 30 秒（重新导出会换路径，别一直用旧的）。**资产卡只说 uid**（路径由服务端取）：以前 items 留空，前端只能把「一个文件夹」交出去，PS / PureRef 拿着目录没法用。`MAX_DRAG_FILES=64` 与图片包单包上限（IMAGE_MAX 60）对齐 —— 24 会在 60 张画板里被截断。新增可拖卡片 = 加一条 `CARD_SOURCES`，别在协调器里堆 if。
- `src/library/drag-out.js` — 桌面版协调器：**指针驱动，不用 HTML5 dragstart**。`pointerdown` 记录起点并预热（悬停资产卡时也会预取），`pointermove` 位移超过 5px 才 `invoke('start_file_drag')`，`pointerup` 清状态。
  - **为什么不能挂在 dragstart 上**：`dragstart` → 取消网页拖拽 → 再等服务端把卡片描述换成绝对路径，这一圈走完鼠标常已松开；Rust 的 `QueryContinueDrag` 一发现左键不在就立刻 `DRAGDROP_S_DROP`，拖拽当场消失，表现就是「拖了完全没反应」。指针路径在按下期间起拖放，手还按着，OLE 才能接住。
  - 封面上的 `.preview-hit` 是 `button` 且铺满整张图：`NO_DRAG` 必须把 `button:not(.preview-hit)` 排除在外，否则资产卡按不到图上、也就永远拖不出去（这是「完全不行」的直接原因之一）。
  - `EXE_TARGETS` 只用来决定要不要额外跑「导入到当前场景」；**认不出的软件（PS / PureRef / Krita / 资源管理器）静默收场，文件本身已被系统交出**，不用逐个适配。`internalDropActive()` 是给未来页面内 DnD（画板 / 以图搜图）留的让位缝，按住 Alt 强制拖出。
  - 装配时给 `<html>` 加 `native-drag`：CSS 据此关掉图片的网页拖拽（`-webkit-user-drag:none`），网页版的 `DownloadURL` 兜底不受影响。
  - 资产卡解析失败（还没落盘）时：拖到受支持的 3D 软件仍走「先下载、下完自动导入」；拖到 PS / PureRef 这类不认识的软件会先提示原因，**并顺手入队下载**（「已开始下载，完成后把这张卡再拖一次」），别让用户看到一句「先点下载」就卡住。
- `src/library/picture-drag.js` — **仅网页版兜底**（`DownloadURL` + 预取 Blob 挂原图）；检测到 Tauri 直接跳过，避免两边抢 `dataTransfer`。
- `server/drag-stage.mjs` — 把描述换成 CF_HDROP 要的磁盘绝对路径：`local` 走注入的 `resolveLocal`（复用 `resolveLocalFile` 白名单）、`asset` 走注入的 `resolveAsset`、`remote` 用 `/api/image?full=1` 同一套回源策略落盘到 `drag-cache`（原子 `.part`→rename、URL 哈希复用、7 天 / 512MB 清理）。导出 `expandDragFiles()`：**目录摊成里面的图片**（图集落盘是 `images/01-*.png` + `info.json`，跳清单与 `.tmp`，单文件原样返回）。回源函数、域名白名单、MIME 清单全部注入/共用，拖拽层不认识具体站点。
- `server/drag-asset.mjs` — **资产卡 uid → 文件清单**（`createAssetResolver`）：先按 uid 找「已保存且文件还在」的最新任务，`kind:'images'` 展开成整组图片、3D 导出包原样给；没有任务（用户自己拷进来只靠 info.json 登记的资产）就回到磁盘扫描结果里按 uid 找目录。查不到抛可读原因，**不静默返回空清单**。路径只由服务端产生，前端给不出也不该给绝对路径。
- `server/library.mjs` — `POST /api/drag/files`（要求 `x-sfx-local:1`）与 `imageRequest()`：图片代理和拖出共用一份 CDN 阶梯 / Referer / cookie 策略；`resolveAsset` 由 `createAssetResolver` 注入（jobs + 扫描根 + `cachedScan`）。
- `sketchfab-exporter-tauri/src-tauri/src/dragout.rs` — Windows OLE `DoDragDrop` + `CF_HDROP`（本来就是 `Vec<String>` 多文件）+ 落点进程反查。**零改动**，多图集合直接受益。
- 预览大图来源写在 `local-files.js` 的 `showGalleryImage()`：`data-drag-root/rel`（本地包原文件）或 `data-drag-url`（图站原图）。
- **拖回自己窗口 ≠ 导入**（`drop-import.js` 的 `isSelfDrag()`）：站内拖出去再落回窗口时，`drop` 里的 `dataTransfer` 同样是 `Files`（桌面版是 OLE 交回的那批真文件，网页版是 Chromium 从 `<img>` / 卡片合成的），只看 `types` 分不出来。所以由发起方在 `<html>` 上挂标记，`drop-import` 见到就只拦默认行为（不拦 WebView 会把文件当页面打开）、不入库：桌面版 `drag-out-active`（`drag-out.js` 起拖挂、`endDrag` 摘），网页版 `self-drag`（`library-drag-web.js` / `picture-drag.js` / `local-files.js` 的 `markSelfDrag()` 在 `dragstart` 挂、`dragend` 摘）。回归见 `test/library-drop-import.test.js`。
- **预览大图的窗口内手势是平移，不是拖出**：`app.js` 的 `deferNativeDrag()` 让发现页的 `.local-gallery-main` 让位给 `local-files.js` 的 `bindZoom`（要拖出原图按住 Alt）；资产库的大图是本地文件，维持「直接拖到 PS / PureRef」。没有这条，按住拖动会起 OLE 拖放 —— 画面不动，松手还可能落回自己窗口。

## 选择器
- `picker.js` / `picker-model.js` — 自绘下拉：原生 `<select>` 作唯一数据源，旁边画统一风格按钮 + listbox；业务代码零改动。

## 状态 / 存储
- `server/data-dir.mjs` — 后端、cookie 与启停脚本共用用户目录解析；默认 `%APPDATA%/AssetVault/{data,downloads}`，绝对路径环境变量优先。`scripts/migrate-project-data.mjs` 负责显式迁移旧工程数据，先校验并备份，再补充历史库记录。
- `settings-panel.js` — 统一偏好设置：左侧分类、右侧可折叠分组；复用原导出与 AI 控件，分类切换保留未保存值，AI 配置按窗口会话懒加载。S3 新增「协作与备份」分类（`team` 参数），切到该页时调 `team.load()`；LAN 访客的设置面板整体隐藏，所以这个分类只挂主机。
- `help-panel.js` / `feedback.js` — 使用说明与帮助反馈**合并成一个弹窗**（`#help-dialog`，两个页签）：`help-panel.js` 只管切页签与打开，`feedback.js` 只管表单与提交；反馈面板是 `index.html` 的静态标记（`#help-panel-feedback`），不再自己 `createElement` 造 dialog。
- `search-translation.js` / `server/ai-search.mjs` — 中文关键词 AI 翻译、并发合并与缓存；发现页使用英文检索，本地库同时匹配原词与译词；失败保留原词。`tagAssets()` 除 name / author / kind / 已有标签外，还读 `meta`（采集时的画板 / 类目 / 出处 / 话题）与 `probe`（封面主色 / 构图）拼成附加行并去重；两者都为空时提示词与旧版逐字一致，缓存键不变。前端入参统一由 `app.js` 的 `tagInputOf()` 拼装，`meta` 走 `metaOf()`（新数据用采集 meta，老数据从原始字段兜底），保证历史资产的分类也能进提示词。
- `ai-settings.js` / `server/ai.mjs` — AI 接入界面与兼容 Chat Completions 的服务端连接；配置留在本机，密钥不回传。支持模型列表、保存与测试；`complete()` 供后续 AI 功能复用。
- `local-filters.js` — 本地库类型、任意规格文件可用性和关键词组合筛选；无保存记录不等于磁盘上没有文件。仅读取后台任务，不删除或迁移数据。
- `index.html` `#result-actions` / `app.js` `#collect-visible` / `library-view.js` 计数 — **批量入库条**：发现页结果下方常驻「当前结果 N 个未入库 · 全部加入模型库」。卡片右上角的勾选框是 `opacity:0`（hover 才显形），用户会直接判定「没有批量收藏」，所以入口必须常驻。计数只算未入库的（重复收只会得到 0）；确认弹窗写明「只保存记录，不下载文件」—— 收藏与下载是两条独立链路，未下载的资产同样能打标（标签落在 SQLite `tags` 表，只有本地包存在时才额外回写 `info.json`）。测试见 `test/library-collect-visible.test.js`。
- `library-state.js` — state schema、`mergeModels` / `collectModels`、v1→v2 迁移、UI 默认值（`sfx-library-v2` / `sfx-library-ui`）。`LIBRARY_LIMIT`（阶段 3 起 20000）是资产条数的**唯一阈值**，旧代码散落的 1000 已全部收拢到这里（2026-11-08 补：`collect()` 的 toast 文案仍写死「已达 1000 个」，已改为引用常量）。
- `server/library-schema.mjs` — **资产库内核的声明式迁移链**：只加不改的 `MIGRATIONS`（每条带 checksum）+ V1 核心表（`state_meta` / `assets` / `tags` / `collections` / `smart_collections` / FTS5 `trigram`）+ V2 规模化与协作表（词表三件套 `tag_terms` / `tag_facets` / `tag_aliases`、`asset_tags`、`asset_formats`、`audit_log`、`members`、`jobs`、`content_tags`、`tag_counts`）。新增能力 = 追加一条迁移，不动历史迁移。另集中声明 **ADR-02 四域契约**（`MAIN/USER/PROBE/SESSION_STATE_KEY` 与各域字段清单），避免同一份清单在多个文件里各写一遍、改漏一处；还导出逐域轻量版本戳的 `STATE_STAMP_PREFIX` / `stateStampKey()`。
- `server/schema/v2-scale.mjs` — V2 迁移 SQL 分片：词表（面是边不是列）、协作关系、审计、任务队列、资产列化；并从旧 `tags` 回填 `tag_terms` / `asset_tags`。V1 仍留在 `library-schema.mjs` 原地不动（checksum 已冻结，搬家只有风险没有收益）。
- `server/schema/v3-query-index.mjs` — V3 迁移 SQL 分片：查询下推用的**覆盖索引**（尾部一律带 `uid` —— 它是 TEXT 主键，不在索引里就会每行回表，20 万条 COUNT 实测 1817ms → 1ms）+ 物化列 `assets.tags_text`（标签检索文本）。索引按「WHERE 等值列在前、ORDER BY 列在后」排。
- `server/schema/v4-tag-cover-index.mjs` — V4 迁移 SQL 分片：把「覆盖索引里缺 uid / 缺筛选列 → 每行回表」这条教训用到另外两张表上 —— `asset_tags` 加 `(term_id, uid)` 与 `(uid, term_id)`（标签 COUNT 602ms → 155ms），`assets` 加**统一覆盖索引** `(state, favorite, rating, kind, platform, name, author, note, tags_text, uid)`（列筛选 COUNT 3010ms → 52ms、关键词 COUNT 3868ms → 548ms）。列顺序是实测定的：`favorite` 必须在 `rating` 之前（等值可 seek，范围会截断后续列）。同时退休 V2 遗留的两条冗余 `asset_tags` 索引（省约 180MB）。
- `server/asset-kind.mjs` — 资产类型归一的**单点**（`KIND_ALIASES` + `kindOf`）：查询层与派生层共用同一份实现，任一侧单独复制就会漂移。
- `server/library-vocab.seed.mjs` — 词表种子**数据**（6 个面 · 190 个受控值 · 别名 · 层级 · 双面词）。改标签体系只动这个文件 + 递增 `VOCAB_REV`，不碰代码。
- `server/library-vocab.mjs` — 词表**纯函数层**：`normOf`（NFKC / 空白 / 小写）、`buildVocab`（值→面、别名→值、值→子孙，带缓存）、`validateVocab`（重词 / 别名撞名 / 坏父级 / 成环 / 无面）、`searchValues`（检索文本 = 原始值 ∪ 标准名 ∪ 别名）、`compareBinary`（码点序，与 SQLite `BINARY` collation 对齐）。无 IO，前后端与测试可共用同一份行为。
- `server/vocab-sync.mjs` — 词表种子 → SQLite 的**幂等同步器**（`db_meta.vocab_rev` 做闸门）：激活 canonical 词条 → 连父级 → 重写面 → 写别名并把库里同名的旧词条**真合并**（`status='merged'` + `asset_tags` 迁移）。`refreshTagCounts()` 物化 `tag_counts`。
- `server/library-tag-facets.mjs` — 分面标签视图：读 `tag_terms` + `tag_facets` + `tag_counts`，按面分组返回「值 / 计数 / 面 / 父级」。双面词在多个面下各出现一次，计数按 uid 去重因而互相相等；没有面归属的词进 `unfiled`（审计收敛对象）。
- `server/model-probe.mjs` — `probeOfModel()` 的**零依赖单点**：写库列化与查询过滤必须对同一个 model 得到同一组宽高/色相/时长。独立成模块是为了让 `library-blob` 守住「纯转换层」，不因读个宽高而拉进整条过滤语义链（打包装配的最小闭包也会跟着变大）。
- `server/library-blob.mjs` — 整块状态 → 派生索引的**纯转换层**（models/trashed → assets、三层标签 → tags、FTS body）；V2 起在派生阶段就把 kind / 宽高 / 长边 / 体积 / 色相 / 时长 / 指纹 / `rev` 列化，并派生 `asset_formats`，查询时不必逐行解析 payload。权威字符串不重新序列化，保证前端拿到的是原本那串 JSON。`long_edge` 的口径必须与 `numericValue(probe,'longEdge')` 一致（宽高齐全才算长边），否则排序在两条路径上会错位。ADR-02 起另有 `mergeDomains()`：把四域合成派生层看得全的一份 state，**字段级覆盖**（域里没给的字段沿用主 blob，整域替换曾把用户标签无声清空）。
- `server/library-db.mjs` — `better-sqlite3` 的**唯一持有者**：动态 import + 惰性打开、迁移事务、读写、FTS5 检索（`search()` / `searchAssetRows()`）、合集表；V2 起负责**词表解析**（norm → 别名 → 未命中建 `pending` 词条）并写 `asset_tags`，旧 `tags` 表保留为 S1 期间的兼容投影。S2 起：`queryPage()` 走**两段式取页**（先取 uid 再取整行，排序器不搬运 payload）；派生时物化 `tags_text`；词表 rev 变化时自动重算检索文本；取页与 COUNT 各自按编译期给出的索引提示执行（`INDEXED BY` 满足不了时捕获并退回自然计划，绝不产出错序结果）；命中量门槛 `AV_INDEX_SCAN_MIN_ROWS`（默认 1000）决定是否强制走排序索引。ABI 不匹配返回 `null` 交给上层降级。业务不直接 import 第三方库。
- `server/query-sql.mjs` — **查询编译层**：把 `filters` + `q` + 排序 + 分页编译成一条 SQL（`{ok:true, where, params, orderBy, indexHint, countIndexHint, limit, offset}` 或 `{ok:false, reason}`）。铁律是**能精确等价才下推** —— 颜色、`categories`、`downloadable`、中文 collation 排序等一律如实拒绝，退回内存路径。标签谓词用非相关 `IN (SELECT ...)`（相关子查询会对每行重跑 JOIN，20 万条实测 3352ms）；平台/类型/标签的多选是 **OR**（与内存路径的 `some()` 同义）。两条**索引提示**的门控是实测出来的：`indexHint`（取页沿排序索引扫、凑够一页就停）只在「谓词全都能靠索引判定」时给，否则会把顺序读表变成随机读表；`countIndexHint`（COUNT 不回表）要求 WHERE 引用的列全在统一覆盖索引里。
- `server/query-sql-search.mjs` — 检索表达式 → SQL 谓词（纯函数）：字段限定、数值区间、格式精确匹配、标签文本检索。标签检索文本读物化列 `assets.tags_text`（原始值 ∪ 标准名 ∪ 别名），与内存路径 `fieldText(row,'tags')` **逐字节一致**（码点序 ≡ SQLite BINARY collation）。
- `server/library-pushdown.mjs` — 下推的执行壳：`compileQuery` → `runPushdown` → 投影成卡片/整行。uid 列表有硬上限 `UID_RETURN_CAP`（5000），超限只回当前页并标记 `uidsComplete:false`，前端据此提示「仅返回前 N 个」。
- `sketchfab-exporter-tauri/scripts/copy-sqlite-native.mjs` — 桌面版 SQLite 原生依赖装配：把 `better-sqlite3` + `bindings` + `file-uri-to-path` 的**运行期闭包**复制进 `sidecar-server/node_modules/`，构建期用安装包内置 `node.exe` 跑一次 `openLibraryDb()` 冒烟（ABI / 迁移链 / FTS5 trigram），失败即中止打包。缺它的桌面版会静默降级纯文件模式、合集路由全 503。`AV_SQLITE_MODULE` 是运行时的驱动路径覆盖缝。
- `server/library-state-files.mjs` — 状态文件层的纯函数（2026-11-08 从 `library-storage.mjs` 拆出，接入层降到 386 行不破 400 硬红线）：`MAX_STATE_BYTES` / `MAX_CATALOG_BYTES`、`stateFileFor()`、`validateValues()`、`restoreLibraryCovers()`、`mergeCatalog()`。`library-storage.mjs` re-export 公开符号，外部 import 路径不变。
- `server/library-storage.mjs` — **四域存储的接入层（ADR-02）**：一个域一个文件 `state/<key>.json`（`stateFileFor()` 导出给测试共用），写一个域只重写那个域；`library-state.json` 退化为旧版迁移源 + 导出快照，运行时不再写。逐域用 `state_meta.updated_at` 与文件 mtime 比对出权威值；`ensureIndex()` 是**所有读写路径的公共前置**（缺了它，旧单文件刚升级时定点写会打在空表上）。`save()` 走 `mergeCatalog()` 合并语义（分页前端不能把全库缩小，移进回收站的 uid 从旧 models 剔除），并带 `syncUser` 让整块写入同步用户域；`load()` 只在域确实带来新内容时把四域合并回主 blob 读视图，保住「save 后 load 逐字节还原」。`mutate(transform)` / `mutateTags(ops)` / `exclusive(action)` / `withDb()` / `readRawState()` 是上层接入缝；`MAX_CATALOG_BYTES`（目录域 1GB）与 `MAX_STATE_BYTES`（其余域 16MB）分开计量；`dataDir` / `stateDir` 供备份服务整目录带走。**端到端性能修复（2026-11-08）**：`readSnapshot()` 的缓存判据必须放在 `readFile` **之前**（以前放在 `JSON.parse` 前，241MB 域文件每次请求都重读 → 545ms）；逐域版本戳同步写进小表 `db_meta` 的 `state_stamp:<key>`，`authoritative()` / `ensureIndex()` 只查几行小记录，只有「DB 确实比文件新」或「域文件丢失」时才取 `state_meta.value` 那 209MB；一批同时写多个域时用**各自文件的 mtime**（`stamps` 参数），不共用 max stamp，否则目录域的戳被会话域抬高会误判。老库无戳时读一次 `state_meta.updated_at` 补齐，零迁移。实测记一次搜索历史 7157ms → 11.7ms，契约测试 `test/library-state-stamps.test.js`。
- `server/search-expression.mjs` — 布尔检索语法解析器（移植自 Serpent `src/shared/search-expression.ts`，MIT）：空格 AND、`|` OR、`-` 排除、`"短语"`、字段别名 `tag:` / `author:` / `rating:` / `ext:` / `color:` / `aspect:` / `width:` / `duration:` 等。纯函数零依赖；比原版多保留一个 quoted 标记，引号里的冒号与 `-` 按字面量处理。
- `server/library-query.mjs` — 查询语义的**唯一实现**：行归一化（含 `model.probe` 派生）、字段文本、clause 求值（数值字段统一支持 `>=N` / `N-M` / `<N`）、跨维 AND / 同维 OR 过滤、11 种排序（含 `collection` / 色相 / 分辨率 / 文件大小与 `sortOrder` 反转）、分页。`rowsFromState()` 从 blob 派生与 DB 同形的行；新维度谓词在 `library-filter-semantics.mjs`，由本文件转导出保证调用点零改动。
- `server/library-filter-semantics.mjs` — 颜色 / 数值范围 / 精确评分 / 收藏三态 / 标签排除的**语义单点**：`probeOfModel()`、`normalizeFilters()`、`matchesFilters()`。标签走 `tagHit()`：选中值先在词表里展开成「自身 + 子孙」再比对，所以点「木材」能筛出「橡木 / 松木」；词表里没有的值退回子串匹配，用户自造词不会失去筛选能力。SQLite 与内存降级共用，老请求不带新字段时输出与旧版一致。
- `src/library/color-filter.js` / `numeric-filter.js` — 前后端共用的色卡协议（10 预设 + HSL 盒 + 环形色相 + 相似度 / 偏好持久化）与数值范围协议（方向 / 宽高比 ±5% / 分辨率 1K-2K-4K / 五类字段、同字段 OR 跨字段 AND / NULL 规则）。算法与常量移植自 Serpent MIT 模块。
- `src/library/asset-probe.js` — 封面探测调度器：同源 `<img>` → canvas 64×64 → 4096-bin 直方图 + k-means 主色 → `state.assetProbe[uid]`；可见卡片加载即采、全库后台扫描按需启动（并发 / 批量 / 写盘节流均可配置），进度发 `assetvault:probe-progress` 事件。
- `server/library-page.mjs` — 阶段 3 按需分页的纯函数层：`simpleFtsTerm()`（只有 ≥3 字的单个正向纯文本词才允许 FTS 预筛）、`toFullModel()`、`queryAssetPage()`。2 字中文词 trigram 不成立，走 LIKE 又会漏 tags，所以必须退回全量求值。
- `src/library/state-mutations.js` — 阶段 4 **前后端共用**的增量写入协议（和 `search-options.js` 一样由 server 反向复用，保证只有一套规则）：`diffMainState()` 产出键级 op、`applyMutations()` 重放、`validateMutationValue()` 挡脏数据。`models` / `trashed` / 未知字段一变就退回整块；op 是「绝对赋值」所以幂等，且两个标签页改不同资产不会互相覆盖。
- `server/library-mutations.mjs` — 把差量请求翻译成 `storage.mutate()` 的 transform：主 blob 永远由「服务端权威值 + ops」生成（客户端不能通过附带 values 塞整块主状态），空库 / 损坏主状态抛 `MutationRejectedError` 让前端回退。`opsAffectDerived(ops)` 判定这批 op 要不要重建派生表：只有 `history` / `tasks` / `options` 与派生数据无关（搜索历史每搜一次就变一次，50 万库上整表重建要 218.5 秒，不重建只要 4.4 秒）。
- `server/library-collections.mjs` — 合集 / 智能合集 CRUD + `collectionPositions()`（uid→position）+ `action:'reorder'`。`collection_assets` 存 uid 而不是 assets 外键（派生表每次 save 都会整批重建）；智能合集只存规则、内容每次重算。依赖注入 `conn.all/run`。
- `server/library-api.mjs` — `/api/library/*` 路由分发：本地标识 + 同源校验，**`mutations`（阶段 4 增量写入）** / `query` / `query/status` / **`assets`（按需分页，返回完整 model，GET 查询串 / POST 同形；`uidScope:'page'` 只回本页 uid，默认仍是全量命中）** / **`assets/detail`（协作取数：按 uid 取回评分/备注/我的标签/AI标签/收藏）** / **`tags/facets`（分面标签：面 + 受控值 + 物化计数）** / **`tags/mutate`（S3 集合语义写入：打标签 / 改评分备注收藏，400 拒绝非法 op、409 版本冲突）** / **`events`（S3 SSE 变更广播）** / **`members`（S3 角色与成员管理；GET 额外返回 `canManage` / `canWrite` 供界面做展示门控）** / **`backups` + `backups/restore`（S3 自动备份与恢复）** / **`session`（ADR-02 会话域轻量写，只写几 KB、不重建派生表）** / **`assets/remove`（合并语义下的显式定点删除，单事务清资产/标签/FTS + 审计）** / `collections` / `collections/items` / `smart-collections` / `smart-collections/resolve`。写路由按 owner/editor/viewer 门控（`WRITE_ROUTES` + `authorize()`）；SSE 路由用更宽松的 `guardStream()`（EventSource 带不了自定义头，但跨站仍拒绝）。DB 可用走索引并对简单词启用 FTS 候选集加速，不可用退回内存引擎（结果一致、合集与分面明确 503）。
- `server/library-events.mjs` — S3 变更广播总线：每连接一队列（上限 256，满了断开而不是堆积内存）、30s 心跳注释帧、事件带自增 `seq` 并保留最近 512 条供 `Last-Event-ID` 断线续传。`emit()` 在没有连接时也要记 seq（否则客户端算错位置）。
- `server/library-members.mjs` — S3 角色权限：`ROLES` / `PERMISSIONS`（owner 读写管成员 / editor 读写 / viewer 只读）、`members` 表 CRUD（最后一名启用的 owner 不能被降级、停用、删除）、`createMemberDirectory()` 身份解析。**身份绑定在 LAN 会话（密码换来的名字）上，请求头只能收窄权限不能抬权** —— 认不出的人一律 viewer。
- `server/library-backup.mjs` — S3 自动备份：`<dataDir>/backups/<时间戳>/{library.db, library-state.json, meta.json}`，用 SQLite `backup()` API 取在线一致性快照（不停服不锁库），定时（默认 6h，`AV_BACKUP_INTERVAL_MIN`）+ 手动，保留 N 份（`AV_BACKUP_KEEP`，默认 5）。恢复前先留一份「恢复前」的现状；失败只告警不阻断。
- `src/library/library-events.js` — S3 前端订阅端：`createLibraryEvents()` 订阅 SSE，变更攒进 120ms 合并窗口（一批只重绘一次），坏帧直接丢，连不上退到 offline（最多重试 5 次）。`collectChange()` / `flushChange()` 是纯函数，可单独单测。
- `src/library/remote-sync.js` — 把别人的改动应用到本地状态：只覆盖服务端明确给出的字段（评分 / 备注 / 我的标签 / AI 标签 / 收藏），别的一概不碰；**删掉的标签要把键删干净**（不留空数组）；脏数据一律忽略。应用后**不落盘**（落盘会写回服务端形成广播回环）。
- `src/library/persistent-storage.js` — 前端持久化的**唯一**写入缝：`saveLibrary()` 仍产出完整 blob，但 `setItem()` 先交给 `tag-ops.js` 翻译成按域指令（用户域 → `/tags/mutate`、会话域 → `/session`、探测域 → 独立 key、目录域 → 纯目录 blob、回收站清空 → `/assets/remove`），高频写入不再回传 209MB 主状态；看不懂的变化 / 任一通道失败 → 永久关掉新通道并整块重放（原有 `/mutations` 差量通道作为第二级保留）。附带的大 key 按 32KB 分流单独提交。`app.js` 完全不知道这件事。
- `src/library/tag-ops.js` — **主状态 diff → 分域写入指令**的纯翻译层：标签/收藏走集合语义差集、评分备注走 `asset.set`，四域各自成包；版本号 / 未知字段 / 脏 uid / 超量一律 `fallback`。浏览器与 Node 测试共用同一套规则。
- `src/library/team-data.js` — S3 协作设置的**数据契约层**（无 DOM）：角色映射、成员/备份行模型、`permissionsOf()` 三档门控、`memberDraftToPayload()`、`teamRequest()` 请求缝（统一 `X-SFX-Local` + 从 `{error}` 取错）。行模型字段名与服务端统一为 `member_id`，另兼容 `.id` 兜底。
- `src/library/team-settings.js` — S3 协作设置的 **DOM 层**：成员列表（角色即改即存 / 停用 / 删除）与备份列表（立即备份 / 恢复）。**两个坑**：`POST /members` 不回 `me`/`canManage`、`POST /backups` 不回 `config` —— 保存后必须重新 GET，否则界面会把自己锁成只读、备份策略说明会变空。删除与恢复都要二次确认；名字一律 `textContent` 回显。测试见 `test/library-team-settings.test.js`。
- `src/library/library-page-fetch.js` — 阶段 4 服务端按页取数：`createPagedQuery()` 的 `first()` / `more()` 走 `/api/library/assets?uidScope=page`，一次只拿 60 个 uid + 完整 model；本地缺的 model 以 `_remoteOnly` 临时补进 `state.models`（`saveLibrary()` 会过滤，绝不写回 blob），`generation` 令牌丢弃过期响应，404 交回面板降级到整量 `/query`。
- `src/library/advanced-query.js` — 高级检索 / 合集面板：自建 DOM（静态 HTML 在 `advanced-query-template.js`），把命中 uid 集合写进 `state.queryUids`、**有序 uid 写进 `state.queryOrder`**；支持「合集顺序」排序与「按当前顺序重排」。`payload()` 展开 `...extraFilters` 通用扩展缝 + 顶层 `sortOrder` / `seed`；`return.controls` 额外暴露 `setQueryOptions` / `listCollections` / `applyCollection` / `createCollection` / `clearCollection`，让图标条复用既有合集能力而不另造筛选预设存储。
- `src/library/library-paging.js` — 本地大库**绘制层**分页窗口（默认 60 张，点「加载更多」+60）：筛选签名变化自动回第一页，`library-view.js` 的 `paintGrid` 检测到「旧卡片是新窗口前缀」时走增量插入。阶段 4 起有两条模式：普通浏览走绘制层分页；`state.remotePaging` 激活时 rows 已是服务端已加载页，按钮转发 `state.onRemoteMore` 去取下一页。`state.models` 仍是全量写入契约，裁掉会让评分 / 标签 / 回收站 / 全选丢数据。

## 筛选图标条（常驻维度入口）

- `src/library/filter-dimensions.js` — **维度单一事实源**：8 个维度全部 `ready:true`（颜色 / 标签 / 形状与类型 / 评分 / 收藏 / 格式 / 检索与合集 + 排序）；每项带 `short`（≤3 字，命令条悬停标签用，`label` 全称只进面板标题）；`KIND_CHIPS` / `SORT_CHIPS`（11 项，与服务端 `SORTS` 全集同义）/ `RATING_CHIPS`（6 项含未评分）/ `FAVORITE_MODES` 与 `toggleToken()` / `dimensionActive()` / 持久化纯函数。加维度只加一行。
- `src/library/filter-state.js` — **筛选状态单一事实源**：`createFilterState()` 的快照持久化（`sfx-filter-snapshot-v1`）、`filtersToPayload()`（只发生效字段）、`activeFilterChips()`（可单清的 chips）、`clearedDimension()`。面板只写 store，不再直接摸查询控件。
- `src/library/filter-visuals.js` — **视觉单一事实源**：维度 / 格式组 / 排序 / 类型 / 收藏态的图标与强调色、方向与分辨率档位、`PANEL_TIPS` tooltip、皮肤清单与 `readSkin()` / `writeSkin()`；纯数据 + 纯函数（`sliderToRatings()` / `sliderToResolutionRange()` 等）。换观感或加图标只改这张表。
- `src/library/filter-dock.js` — 图标条 UI 壳：每个维度键 = **图标 + 悬停浮出的短标签**（`.fd-label`，文字取 `dim.short`；绝对定位、不参与 flex，展开时邻居零位移）、展开 popover / ESC / 点外部关闭、激活徽标、**与图标条同行的紧凑激活 chips**、图标化 popover 头（? / 清除本维度 / 关闭）、`data-skin` 皮肤与 `setSkin()` 缝、恢复上次展开的维度、恢复筛选后重跑查询、封面 `load` 捕获阶段顺手采色。只通过 `controls` 缝读写状态。
- `src/library/filter-panel-common.js` — **控件工厂**（v2 改版后不再有文字标题 / footer / checkbox）：`iconButton()` / `iconChip()` / `sliderRow()` + `setSlider()` / `bindSlider()` / `segmented()` / `probeStatusHtml()` / `emptyState()`。所有面板零裸 HTML 控件。
- `src/library/filter-panels.js` / `filter-panel-*.js` — 面板注册表 + 5 个拆分模块：`colors`（圆形纯色色卡 / 自定义色 / 相似度滑条 / ⊘ 排除）、`shapes`（比例图形 + 分辨率滑条 + 类型图标 chip）、`tags`（搜索 + 包含/排除图标分段 + **按面分组**的数量滑条 + 右键排除；分组数据来自 `/api/library/tags/facets`，先出平铺兜底再原地升级，拿不到分面不会白屏）、`basic`（5 星 + 星级滑条 / 收藏三态图标 / 格式 / 排序图标网格）、`more`（检索式 + 数值范围滑条 + 合集图标行）。`filter-recency.js` 管标签最近使用。
- `src/library/app.css` 末尾「筛选面板 v2 视觉层」— `--fd-*` 设计令牌 + `data-skin` 变体 + 圆角色卡 / 渐变滑条轨道 / 图标 chip 发光 / 图标 tab。上面旧的 `fd-*` 段保留为结构基线，新段后置覆盖。
- 纪律：`extraFilters` 是前后端契约缝（由 `store.toFilters()` 生成，含 `colors` / `ranges` / `ratings` / `favoriteMode` / `excludeTags` 等），新增维度只需在 store 加字段 + 在 `normalizeFilters()` 加白名单；两份格式面板共享同一个 `createFormatFilterState()` 实例。排序必须在 `isEmpty()` 短路前同步 `state.sort`，且非默认排序本身不能被判成空筛选。
- **命令条（`#local-toolbar`）布局纪律**：① 默认永不换行，`@media(max-width:1480px)` 只许 `nowrap`，折行兜底留到 1180px 以下（以前 1480 就 wrap，1440 窗口一眼看过去就是两截）；② 左侧只放筛选维度 + 排序 + 激活 chips，右侧是「计数 · 磁盘包数」+ 动作图标 + 视图切换，中间留白交给 flex，不再用 `margin:auto` 把元素逐个甩到右边；③ 所有文字要么 ≤3 字，要么压成「图标 + 数字」把整句塞进 `title`（例：`#local-file-status` 只显示 `📦 13`）；④ 悬停标签一律脱离 flex 流（`.fd-label` / `.tb-label` 绝对定位），**不要**用宽度过渡展开 —— 命令条一行已排满，推挤邻居就是上一轮被否掉的「弹开其他按键」。

## 格式注册表（单一事实源）
- `src/library/format-registry.js` — 127 种格式的**唯一清单**：`FORMATS`（ext → group / kind / mime / preview / origin）、`FORMAT_GROUPS`（7 个语义组 + `text`）、`TEXT_EXTS`（43 项，由 `text` token 展开）、`KNOWN_EXTS`（`unknown` 反集）。`LOCAL_FORMAT_EXTS` 26 项本库自有格式**按语义并进标准组**（3D 模型 9 / 图像 4 / 视频 1 / 杂项 1 / 文档渲染 11），不单列「本库扩展」；`origin:'local'` 供 UI 标淡点追溯，`formatFilterGroups()` 从注册表派生 chip 清单并把 `extraGroups` 自定义组排最后。`createFormatRegistry({extraFormats, extraGroups, overrides})` 是扩展缝；`formatsOfModel()` 从 model 的路径 / format 字段 / 包内条目派生后缀。清单与分组复刻 Serpent 格式面板（MIT，见 [THIRD_PARTY.md](THIRD_PARTY.md)）。
- `src/library/format-filter-selection.js` — 逗号 token 协议纯函数：普通点击只选一个 / Shift 累加、分组三态、`text` / `unknown` / `exclude` 语义、`matchesFormatFilter()`。**前后端共用一个匹配器**：SQLite 行、内存降级行、前端本地网格结果一致。
- `src/library/format-filter.js` — 面板 UI（v2：7 个图标 tab 切组、一次只显示一组、点选即累加、⊘ 排除、键盘图标折叠自定义输入）+ `createFormatFilterState()`（localStorage `sfx-format-filter-v1` 跨重启持久化）。挂在 `advanced-query.js` 的「格式」区块与图标条「文件」图标展开面板两处（同一状态实例、同步 refresh）；`app.js` 把同一个状态实例传给 `extraCards()`，本地文件 / 资产包也跟着筛。分组三态改用 `data-state` 表达，纯函数 `formatGroupSelectionState()` 未变。
- 服务端接入：`local-browse.mjs`（fileKind / localMime / 扫描项 `format`+`group`）、`search-expression.mjs`（`ext:` / `format:` / `filetype:` 别名）、`library-query.mjs`（`row.formats` / `filters.formats` + `excludeFormats`）、`library-api.mjs`（GET `?formats=...&exclude=1`）、`library.mjs` / `thumb-cache.mjs` / `video-transcode.mjs` / `local-assets.mjs` / `asset-meta.mjs`（MIME、模型集合、图片计数、缩略图与视频分派全部从注册表派生）。
- **纪律**：新增格式只改注册表一行；`COVER_EXT` / `MODEL_PRIORITY` / `FFMPEG_EXT` 是各链路的**专用策略子集**（不是事实源），改动时先问「能不能从 `FORMATS` 派生」。相机 RAW / AI / HEIC 标 `preview:'thumb'` 走 ffmpeg 转 PNG，失败会回退原文件并给提示；USD 家族单文件暂只给明确提示，几何预览仍走包内 3D 入口。

## 本地文件预览
- `local-files.js` — `createLocalFiles`：扫描资产库里没登记成下载任务的文件，补进资产库网格；预览按 `formatOf(name).preview` 分派（native / decode-* / thumb / model / env / font / audio / video / pdf / html / text / none），不再自带四份正则。3D / 全景复用 `gltf-preview.js`，图片 / 字体 / 音频 / 视频走 `#file-preview-dialog`。**格式表只留一处**：模型与环境图的唯一分派点是 `gltf-preview.js` 的 `parseModelBuffer` / `loadEnvironmentTexture`，资源包预览和本地预览都调它们，各写一份必然走偏。
- `tiff-decode.js` — `decodeTiff`：TIFF 解码（未压缩 / LZW / PackBits / Deflate，8 位与 16 位，灰阶 / RGB / 调色板 / CMYK，chunky 与 planar，水平差分预测，多页取首页）。输出 RGBA 字节、不碰 canvas，所以能在 Node 里被测试直接覆盖。LZW 的位宽必须**提前一个码**切换（解码器的字典比编码器少一条），照标准写法差一个码就会从第 512 个条目开始整段错位。
- `psd-decode.js` — `decodePsd`：PSD 合并图像（RAW / RLE，8 位与 16 位，RGB / 灰度 / 索引色 / CMYK，带 alpha，兼容 PSB 的 8 字节偏移）。只读拼合结果，不解图层。
- `gltf-preview.js` — 3D 舞台与全景渲染器：模型按扩展名分派到 GLTF / FBX / OBJ / STL / PLY / 3MF loader，环境图走 RGBE / EXR；对本地文件的入口是 `loadLocalModel` / `loadLocalEnvironment`。
- `lazy-preview.js` — 保留预览接口，首次打开时动态加载独立 3D bundle；关闭或切换资产使待加载操作失效，加载失败可重试。构建时同步浏览器与桌面版资源。

## 文档渲染（v3.16.3，本地资产库预览能力，与 RSS 无关）
- `src/library/format-registry.js` — `ROWS` 加 11 个 `document` 组格式：`docx`/`epub` 走浏览器内渲染，`doc`/`pptx`/`ppt`/`xlsx`/`xls`/`rtf`/`odt`/`odp`/`ods` 标 `preview:'doc-pdf'` 走 LibreOffice 转 PDF。`TEXT_PREVIEW_OVERRIDES` 把 `md`/`markdown` 从 `'text'` 升级成 `'markdown'`（**加一种文本类渲染器只改这张表**，`TEXT_EXTS` 与所有调用点不动）。服务端 `local-browse.mjs` 的 `fileKind()` 直接委托 `formatKind()`，所以扫描 / MIME / 筛选 / 预览一起生效，服务端零改动。
- `src/library/local-reveal.js` — 右键菜单「打开所在文件夹」的唯一实现：`POST /api/local/reveal`，必带 `X-SFX-Local:1`（服务端只对本机窗口放开这条路由），失败把服务端那句人话原样抛出。**传文件＝打开它所在的文件夹并选中它，传目录＝直接打开目录**（素材包的 `rel` 就是目录）；目标被改名 / 删掉时服务端退一步打开父目录（父目录必须仍在已索引的根内）。`server/local-browse.mjs` 的 `resolveLocalTarget()` 是「文件或目录都收」的解析口，`resolveLocalFile()` 由它派生，越界校验只有一份。**能力位 `localRevealAndCovers`（`server/capabilities.mjs`，SERVER_VERSION 3.32.4）**：这条路由和封面三档都是新接口，不加位的话老进程永远被判定成「已是最新」——2026-11-16 实测就踩了：前端 dist 已是新版（菜单项在），后端还是几小时前的旧进程（路由 404），点右键「完全没反应」。
- `src/library/local-assets.mjs`（服务端）——**素材包封面三档**：包内现成图片（`cover`）→ 能现算一张图的文件（`derivedCover.source:'thumb'`，3D 主文件 / hdr / exr / 视频，见 `RENDERABLE_COVER_EXT` + `pickRenderableCover()`）→ 压缩包里的图（`derivedCover.source:'archive'`，`container` 是 zip 相对包的路径，zip 包自身为空，前端走 `/api/local/archive/entry` 并按 `w=384` 缩图）。只有第一档时，纯 3D 包 / HDRI 包 / 只落下 `pack.zip` 的包全都只剩类型图标 —— 2026-11-16 实机 50 个包里有 13 个是这种。`pickCover()` 现在先挑底色图（`DIFFUSE_HINT` / `CHANNEL_HINT`），避免把法线 / AO 通道当封面（一片紫、一片灰，看着像图坏了）。
- `src/library/doc-render-state.js` — 纯函数/配置层（无 DOM、无第三方库，Node 可测）：`DOC_RENDER_MODES` 分派表、marked / DOMPurify / docx / epub 选项、`markdownToHtml()`（库通过参数注入）、`hardenLinks()`（注入 `DOMParser` 构造器，注意它在 `window` 上而非 `document` 上）、中文提示与 `EPUB_RENDER_TIMEOUT_MS` / `DOC_RENDER_TIMEOUT_MS`。
- `src/library/doc-render.js` — **独立 bundle**（`build-library.mjs` 单独构建成 `/doc-render.js`，app 的 `external` 列它）：marked+DOMPurify / docx-preview / epubjs 合计约 1.2MB，**不进 app.js 主包**；`local-files.js` 里 `import('./doc-render.js')` 首次打开文档才加载（复用 `lazy-preview.js` 范式，加载失败清缓存可重试）。dispose 挂 `host.__avDispose`，`clearStage()` 通用调用，主包不需要 import 它。`renderDocument()` 只做「字节 → DOM」，取字节统一由 `local-files.js` 负责（鉴权只有一处）。
- `src/library/local-files.js` — `openFile()` document 分支按 `docRenderModeOf()` 数据驱动分派；`showDocument()` 取文本/字节交给渲染器，`showDocPdf()` 先问 `/api/doc/status` 再指向 `/api/doc/pdf` iframe；双层超时（渲染器 15s / 前端 30s）防损坏 EPUB 无限转圈。素材包卡封面统一由 `packageCoverOf()` 算：平台缩略图 → 包内图片（`packageImageUrl`，SVG/ICO 直接给原文件，因为后端缩略图通道不接它们）→ 兜底封面（3D 主文件挂 `.model-thumb`，失败后交给离屏渲染器）。
- `server/doc-convert.mjs` — LibreOffice headless 转 PDF：`DOC_PDF_EXTS` 从注册表派生（**唯一白名单**，防把任意路径喂给外部进程）、`createSofficeProbe()` 探测+缓存（可注入）、独立 `UserInstallation` 防与前台 LO 抢锁、**校验产物文件而非退出码**、mtime/size 磁盘缓存、临时目录自清理。命令统一走 `thumb-cache.mjs` 的 `externalProcessOptions()`（隐藏 Windows 控制台）。
- `server/library.mjs` — `GET /api/doc/status`（`x-sfx-local` 守卫，返回 LO 可用性与可转后缀）、`GET /api/doc/pdf`（**root 白名单**，与 `/api/local/thumb` 同口径，因 iframe 带不了自定义头）；`assets` 白名单放行 `/doc-render.js`。
- **纪律**：新增文档格式只改注册表一行；`DOC_PDF_EXTS` / `DOC_RENDER_MODES` / `TEXT_PREVIEW_OVERRIDES` 都是注册表派生的策略子集，别手写第二份清单。`marked` 输出**必须**过 DOMPurify（渲染器里有「拿不到净化器就抛错」的安全红线）。设计预案见 `design/documents/document-rendering-design.md`。

## 画板与智能收集（3.15.0，契约见 docs/board-development.md）
> 服务端已落地；前端 `board-*.js` 已可用（**主网格上方的画板卡片区** + 切换 + 选择器 + 智能收集 + **智能画板规则**）。CSS 一律 `board-*` / `bd-*`；`board-grid` / `.board-card` 已被图站 Pinterest 画板占用，不要复用。

前端（`src/library/`）：
- `board-store.js` — 画板状态源：`flattenBoards()` 树扁平化（坏数据降级顶层）、`activeId` 持久化、增删改与成员增删；**`smart` 行额外带 `rule`（q/filters/sort），卡片点「规则」不用再请求**。`saveSmart()` 是规则唯一的落库口。
- `board-api.js` — 画板与采集两套 HTTP 面的唯一出口（`/api/library/collections*`、`/api/library/smart-collections*`、`/api/collect/*`），错误归一化；`boardPreviews()` 批量取画板封面与小图。
- `board-hub.js` — 唯一装配点：建 store / picker / collect / **deck** / **actions** / **rule**，并在工具栏、批量栏挂入口；低频轮询 `syncPending`。
- `board-deck.js` — **主网格上方的画板卡片区**：一块画板一张卡（1:1 封面 + 一排 6 张小图 + 名称 / 副行计数），智能板带 ⚡ 徽章与「规则」键；点卡经 `controls.applyCollection()` 进入画板，进入后本区收起、由 `#board-crumb` 面包屑返回。监听 `assetvault:board-active` 得知进出，不自己猜状态。**尺寸必须与资产卡一致**——列宽/间距/图框比例全部走 `app.css` 末尾的 `--lib-*` 令牌（与 `.model-grid` 共用），本模块与 CSS 里都不许再写死 minmax。
- `board-actions.js` — 画板的三个写动作（新建 / 改名 / 删除）与它们的提示词、确认框；卡片区只画界面，动作统一从这里走。
- `board-rule.js` — **智能画板规则对话框**：左「画板当前规则」右「工具栏当前筛选」，主键 = 用当前筛选覆盖（新建时改名「创建智能画板」）。**不实现第二套筛选 UI**，规则内容一律来自 `controls.currentRule()` / `describeRule()`。
- `board-picker.js` — 加入画板的选择器（批量栏调用）。
- `board-collect.js` — 智能收集规则面板与待合并队列（`mergeModels` → `saveLibrary` → `ack`）；目标画板下拉**含智能画板**（采集项与规则结果求并集）。

- `server/library-api.mjs`（智能画板部分）— `/api/library/smart-collections/resolve` 返回 **规则命中 ∪ `collection_assets` 成员**：采集规则只会写成员表，不求并集的话「采到智能画板里的资产」会收进来却看不见；响应带 `manualCount` 标明并进来的条数。
- `server/library-api.mjs`（`/api/library/collections/previews`）— 画板卡片预览：一次批量取多块画板的头几项（uid / 缩略图 / 平台 / assetType）；智能板与 resolve 共用 `runQuery` 求值，并并入手动成员与 `coverAssetId` 指定的封面。
- `server/collect-rules.mjs` — 规则 / 运行记录 / `seen` 去重索引三合一仓库（`collect-rules.json`）。`normalizeRule()` 是唯一校验点，`ruleDue()` / `nextDailyAt()` 是纯函数便于假时钟测试；写操作串行排队 + `.tmp`/`rename` 原子落盘。
- `server/collect-search.mjs` — 平台注册表 `COLLECT_PLATFORMS`（9 模型 + 8 可搜索图站；5 个 `searchable:false` 只支持钉页面 URL），复用既有搜索函数与 `openPublic()`；`canonicalKey()` 去 utm/hash 并按字典序稳定，`collectUid()` 派生 32 位 uid。
- `src/library/auto-tags.js` — **客观标签自动派生（零人工、零 AI 调用）**：从 `meta`（新采集）/ 原始字段（老 payload）/ `name` 反解画板名 / `platform` 生成「画板 · 类目 · 话题 · 来源」标签，过滤格式与分辨率噪声、去重、限 6 个、确定性输出。纯函数在**三处共用**：`collect-search` 归一化（收藏即带标签）、`asset-tags.tagsFor`（历史资产界面立即可见，虚拟不写 state）、`library-blob.deriveTagRows`（tags 表 / FTS / 筛选同步，下次写库自动补齐，无需回填脚本）。同 Hydrus parent 的虚拟展开思路：`enabled:false` 即可全库撤销。`LEGACY_META_FIELDS` 声明式兼容老 payload 的 `categories`；`metaOf()` 让打标提示词也吃到老分类；`hasTextSignal()` 让批量打标跳过「来自相册」这类空名。配置缝 `AUTO_TAG_CONFIG`。测试 `test/auto-tags.test.js`。
- `server/collect-meta.mjs` — **采集元信息的唯一归一化点**：各平台原生字段名不同（Kenney `categories:[categoryLabel,seriesLabel]`、ambientCG `categories:[type]`、Sketchfab 归一后的名字数组、花瓣 `boardTitle` + `raw_text` 里的 `#话题`、小红书 `description`、500px / wallhaven `category`），`META_FIELDS` 用**字段名表**统一收口 —— 新增平台只补字段名、不改逻辑。`pickMeta()` 输出 `{board, category, description, hashtags, sourceHost}` 挂到采集条目的 `meta`，全空返回 `null`（payload 逐字节比较，空对象会被判成「有变化」）。`lookOf(probe)` 把封面采样出的主色 / 明暗 / 构图转成中文词；`metaPromptLines(meta,{probe,exclude})` 拼打标提示词的 BOARD / CATEGORY / ORIGIN / HASHTAGS / VISUAL / SUMMARY 行，按已有标签去重并整体限长（meta 与 probe 都为空时返回空串，提示词与旧版逐字一致，缓存键不变）。`platformFromUrl()` 用 `PLATFORM_HOSTS` 从地址反推平台，兜历史数据里空着的 `platform` 列。测试 `test/collect-meta.test.js`。
- `server/xhs-state.mjs` — **小红书 SSR 状态解析（纯函数，不碰网络）**：`extractXhsState()` 从页面取 `window.__INITIAL_STATE__`，`replaceLooseTokens()` 用字符状态机把**字符串外**的裸 `undefined`/`NaN` 换成 `null`（实测 27 处，全局 replace 会改坏正文词条），`unwrap()` 拆 Vue 的 `{_rawValue}` 包装（不拆就静默拿到 0 条），`normalizeXhsImage()` 把 `sns-webpic-qc` + `!nd_*` 转码后缀升成 `sns-img-qc` 原图，`pickXhsImage()` 优先 `infoList` 里的 `CRD`/`WB_DFT`。**判「没数据是不是因为没登录」用 `isXhsGuest()`（`user.loggedIn === false`），不是 `login.showLogin`（匿名一直是 false），也不能用 `web_session`（游客也有）。** resolver 在 `picture-sites.mjs`：UA 必须老版 Chrome/91、**不能带站内 Referer**（会被当 App 内跳转 302 到 `/login`）；短链要透传原始地址（`xhslink.com/o/xxx` 的 `/o/` 不能丢）。测试 `test/library-xhs-state.test.js`。
- `server/picture-sites.mjs`（图床域名）— **别拿 `file.bucket` 直接拼子域**。花瓣老 pin 的 bucket 是 `hbimg`，而 `hbimg.huaban.com` 这个裸桶域名已下线（EdgeOne 回 567 / 直连无响应），新 pin 才是 `gd-hbimg`；实测同批 key 只在 `gd-hbimg.huaban.com` 可取。所以 `HUABAN_CDN_HOST` 是 bucket→现役主机的别名表，`canonicalPictureUrl()` 把库里存量的旧地址（含带 `auth_key` 的 `gd-hbimg-edge`）改写到现役主机。
  **一张花瓣图有三代地址，按可用性排序**：① `file.url` 的签名地址（`gd-hbimg-edge` + `auth_key`）= 原尺寸且不怕限流，`huabanImageCandidates()` 优先用它，但 auth_key 小时级过期，所以**只当首选、不当清单出处**；② 裸路径 `gd-hbimg.huaban.com/{key}` 永不过期，但抓得急会被 EdgeOne **限流回 HTTP 567**（实测 294 张的板子在第 175 张开始整片失败）；③ 缩放档 `_fw1200/_fw960/_fw658/_fw480` 是边缘缓存，限流时仍 200，只能兜底。
  这套「先要哪个、再要哪个」只写在 `pictureUrlCandidates(url)` 里（已下线主机直接换域、签名地址保留、按需追加不叠后缀的缩放档），消费方：`imageRequest()`（`/api/image`、拖出原图落盘）、`image-bundle.mjs`（批量下载）。新增图站只往 `CDN_REWRITES` / 候选规则里加一条，别在调用点各写一套。
- `server/collect-guard.mjs` — 每平台令牌桶 + 500~2000ms 抖动 + `Retry-After` + 连续 3 次失败熔断 6h。**新平台从满桶起步**（不是 0 令牌），`refillBucket()` 的 `at` 用 `??` 不能用 `||`。
- `server/collect-pending.mjs` — 待合并队列 `collect-pending.json`：服务端**不直接写 `models`**（会被前端整块保存覆盖），前端拉取 → `mergeModels` → `saveLibrary` 成功 → `ack` → 重绘。ack 必须在保存成功之后。
- `server/collect-runner.mjs` — 单规则执行器：逐平台搜索 → `filterItems()` 本地过滤（`collectRow()` 必须把 URL 喂给 `formatsOfModel` 的 `filePath`，否则格式筛选恒空）→ seen 去重 → 入队 → 立即 `addToBoard`（`collection_assets` 接受未入库 uid）；`dryRun` 只返回 `preview[]` 不写任何状态。
- `server/collect-scheduler.mjs` — 60s tick / `unref()` / 串行 / 单规则锁 / 停机 >7 天过期规则重置。
- `server/collect-api.mjs` — 7 条 `/api/collect/*` 路由，与 `/api/library/*` 共用 `x-sfx-local` + 同站守卫；同规则并发 `run` 返回 409。
- `server/library.mjs` — 装配 7 个模块（数据目录 `downloads.dataDir || resolveDataDir(root).dir`）并启动心跳；`createLibraryServer({collect:false})` 是测试的关闭缝。
- `test/library-collect-{rules,search,guard,runner,scheduler}.test.js` — 39 例单测，全部注入假时钟 / 假 IO / 假 searcher / 假 `addToBoard`，不打外网。

## 视图辅助
- `gallery-view.js` — 画廊（封面瀑布流、比例自适应）；`displayGridClass()` 是展示模式的唯一来源，只有「网格 / 瀑布流」两种（紧凑列表视图 2026-11-08 已移除）。
- `masonry.js` — 瀑布流落位。**卡片坐标全靠 CSS 变量**（`--masonry-left/top/width`，默认 0px），所以「量」和「画」之间隔一帧就会看到卡片叠在左上角。两条铁律：① 整块重建 `innerHTML` 之后，绘制层必须在**同一个任务里**调 `observeMasonry()` 返回的 `flush()`，别等 rAF；② `clientWidth` 为 0（切到下载页、`#library-view` 变 `display:none`）时**什么都不写**并保留 dirty，否则会把列宽算成 0px 把卡片全压扁。回归见 `test/library-first-paint.test.js`。
- `html-esc.js` — `esc()` HTML 转义。
- `sidebar-boot.js` — **首帧脚本**（同源、不加 defer）：把 `av:sidebar:collapsed` 挂到 `<html>` 上，早于第一次绘制。不能写成内联 `<script>` —— CSP 是 `script-src 'self'`，内联脚本被直接拒绝执行（只在控制台留一条 Refused to execute inline script），表现就是每次刷新「先展开、再收起」闪一下。key 与 `sidebar-collapse.js` 共用；服务端 `assets` 白名单与 `build-library.mjs` 的复制清单都要带上它。
- `splash.js` / `splash.html` — 启动画面。
- `worker.html` — worker 宿主页。

## 样式 / 入口
- `app.css` / `index.html` / `favicon.svg` / `mascot.png`

## 测试与脚本（根目录）
- `test/*.test.js` — 单元测试（node --test）。
- `scripts/test-library-browser.mjs` — 浏览器 E2E（puppeteer + CDP，断言集中在 `#search-platform` / `#filter-rows` / `#panel-filters` / `.model-card`）。
- `scripts/build-library.mjs` — 前端打包。
- `server/library.mjs` — 本地服务端（含 `/api/search` `/api/artstation/search` `/api/scan` `/api/polyhaven/search` 等，均留 `opts` 注入缝便于测试 mock）。
- `server/capabilities.mjs` — **服务端能力契约（单点）**：`SERVER_VERSION` / `SERVER_CAPABILITIES` / `serverIsCurrent()`。`/api/downloads/capabilities` 原样返回它，启动器用它判断「正在跑的进程是不是这一版」。**新增前端要用的接口 = 在这里加一个能力位**，两侧自动同步。
- `server/image-sources.mjs` — 图片源注册表（`IMAGE_SOURCES`：sketchfab / artstation / polyhaven）。Poly Haven 源走 `polyhavenRenders()`，CDN 拼 `cdn.polyhaven.com/asset_img/renders/<id>/<name>`；`collectImageAssets(platform,{uid,url,assetId})` 把 `assetId` 透传给各源 resolve（Poly Haven 只认 `assetId`，模型 uid 是 md5 拼不出 URL）。
- `server/image-bundle.mjs` — `runImageJob`：图片任务 worker；调 `collectImageAssets` 取清单后逐张 `downloadImage`，落盘 `<名称>-images` 文件夹 + `info.json`。**清单里带标签**：顶层 `tags` 是「站点级 `plan.tags` ∪ 任务级 `job.tags` ∪ 各图标签」的合并，每张图另留自己那组（booru 的 post tag / Pexels 的照片 tag 是逐图的），一包上千张时只有图自己的标签能回答「这张是什么」。
  **并发下载（`FETCH_CONCURRENCY=6`）**：节流器管的是「什么时候允许**发起**下一个请求」，不是「什么时候能开始下一张」。它按 gap 发放槽位（见 host-throttle），拿到槽位的 worker 立刻发请求，传输与写盘落在别人的等待间隙里。**请求速率完全由 gap 决定，不受并发数影响**，所以调大并发不会更早撞限流；6 路是为了让「大图 body 还在传」时槽位不空转（12 路实测与 6 路同速，说明那时已到带宽上限）。清单靠 `results[index]` 按计划序号压实，不能按「谁先下完」排。
  - **候选主机记忆（`LAST_GOOD_HOST`）**：图床限流是**按节点**的 —— 同一时刻 `gd-hbimg-edge`（签名地址）回 567、`gd-hbimg` 或缩放档还能给图。候选顺序固定为「签名 → 裸路径 → 缩放档」，一旦签名节点被拦，每张图都会先白撞一个 567 再换候选，速度直接腰斩（实测 40 张：79 个请求里 39 个是白撞，0.91s/张；加了记忆后 43 个请求、0.57s/张）。所以 `noteGoodHost()` 记住「上一次谁真的给了图」（5 分钟内有效），`preferKnownGood()` 下一张优先它。进程内记忆、不写盘，网络一变最多多撞一次就自动纠正。
  **抓图容错**：单张取不回来只跳过并记 `failedCount`；判定用**失败率窗口**（`FAIL_WINDOW`：最近 20 次里 40% 失败 = 整片塌方）而不是「连续 N 张」—— 并发下同时在飞三张，「连续」只是调度巧合。总量超过 15% 同样判死。一张都没取到一定失败。**体积上限边下边判**（`maxBytes`）：到上限就停、包照常成功、`truncatedCount` 记进清单与 `warning` —— 1923 张 4K 原图有 8GB，等全部下完再 `if(bytes>limit)throw` 等于白跑两小时（图站任务：ZIP 4GB / 直接存文件夹 16GB，见 `downloads.mjs` 的 `PICTURE_SITE_*_BYTES`）。并发下上限判定会粗一点（同时在飞的几张都会先通过检查，最多多下 2 张），这点超发可接受。**限流不许判死**：整包级最多 6 次强制冷却（`BUNDLE_COOL_ROUNDS`，从站点规则取 30s~coolMaxMs），冷却后回到同一张继续 —— 1923 张的花瓣画板必然撞 IP 配额，靠这一层跑完，比「判死重来（要重扫上千张清单）」便宜得多。**续传**：输出目录里已有 `info.json` 时按出处（`canonicalPictureUrl` 后的稳定地址，签名地址会过期不能当出处）跳过已落盘的图，**并按清单里的 `bytes` 校验文件大小**（不逐张 fsync 之后，断电可能留下「文件在、内容半截」的成品，只判「存在吗」会把半张图当成品接回来）；清单外但符合 `NN-*.png` 命名的残留文件会被删掉 —— 否则最终校验「存在未登记的作品图片」会把整包退回。失败/取消时 `finally` 也把清单写成与磁盘一致的 `status:'incomplete'`（节流写入可能落后几张）。
  - **活清单（图片包第一张即出卡）**：`writeImageManifest()` 原子覆写、`markImageBundleIncomplete()` 标记中断。文件夹模式一拿到 `plan` 就写 `status:'downloading'` 的 `info.json` 骨架（uid / title / platform / author / url / tags），`copyOut` 每落一张图节流（**≥3s 或又多了 10 张**；1923 张时整份 JSON 约 700KB，每秒重写纯属浪费；第一张仍立即写，卡片要马上有封面和数目）增量追加 `images[]`，结束覆写不带 `status` 的最终清单给 `verifyFolder` 校验。失败 / 取消 / 服务强杀由 `markImageBundleIncomplete()` 标 `incomplete`（`downloads.mjs` 的 `run()` catch + `init()` 恢复两处兜底）。`local-assets.mjs` 的 `describe()` 透出 `status` / `imageCount` → `local-files.js` 的 `packageCard` 显示「下载中 / 未完成 · N 张」角标；`app.js` 发现新图片任务立刻 `scanLibraryFiles(true)` 绕过 15s 扫描缓存，之后 5s 增量重扫。回归见 `test/library-image-live-card.test.js`。
    **中断提示要按能不能续传说实话**：服务重启时 `init()` 把 `running` 任务标 `interrupted`，对「图片 + 文件夹输出」调 `markImageBundleIncomplete()`（它返回「清单里真有图片吗」），能续传就写「接着补下剩下的，已下好的不会重下」，否则才写「从头下载」。早先不分类型一律说「从头下载」，会让人把能接回来的画板删了重来。
- `server/picture-board.mjs` — **「只入库」远程收藏卡**：`writePictureBoardCard()` 只写一份 `info.json`（`status:'remote'`、`thumbnail` 是平台远程封面、`imageCount`、`url` 出处、`tags`），**一张图都不下载**，也**不写 `images[]`** —— 清单一旦声明图片，`verifyFolder` 就要求文件真在磁盘上、画廊也会去打开不存在的路径。卡片能出图是因为 `local-assets.mjs` 把 `thumbnail` 透出成 `thumb`，前端走 `/api/image` 代理（绕开各站防盗链）。接口 `POST /api/library/picture-board`（`library.mjs`）只写「下载根/图片」，**不接受 root 参数**；写入前用 `picture:v1:<platform>:full:<url>` 缓存键做一次全量解析拿真实张数（预览那 48 张不是总数，写成 48 就是骗人），解析失败就把 `imageCount` 记 0 而不是猜。`findRemoteBoardDir()` 让队列能**原地接管**这张卡：`downloads.mjs` 的 `resumeRemoteBoard()` 先按 `folder-name.mjs` 的命名精确探一次，命中就从同一个目录继续下，不会在旁边长出一个 `(1)` 变成两张卡。前端：`library-view.js` 画板页的「只入库不下载」按钮 → `local-files.js` 的「远程收藏 · N 张」角标 + 「下载原图」按钮（`app.js` 的 `fetchRemoteBoard()` 入队）。`download-recovery.mjs` 启动扫描时跳过 `status:'remote'` 的目录（没有可恢复内容，交给校验器只会刷一行没用的失败）。回归见 `test/library-picture-board.test.js`。
- `server/folder-name.mjs` — **落盘命名规则的唯一实现**（`cleanStem` / `cleanFolderName` / `cleanFilename`）：目录名 = 「标题 + uid 前 8 位」。下载器与远程收藏卡必须算出同一个名字，否则「下载原图」认不出那张卡的目录。`downloads.mjs` 转出这三个名字（测试仍从它 import `cleanFilename`）。
  - **免二次拷贝**：文件夹模式下 `work` 就是输出目录本身，下载 → 按字节嗅探格式 → **原地改名就位**，不再「先写 tmp、再逐张 `copyFile` 进输出」（上千张大图等于多读写 8GB）。`finally` 必须 `cleanDownloadParts()` 清掉 `.part-NN`（它就躺在输出目录里，校验器会当成未登记文件），并且 `work===liveDir` 时**绝不能删目录**。ZIP 模式仍走 `mkdtemp` 暂存。
- `server/tag-list.mjs` — **平台标签的唯一归一化点**：`tagList()` 吃字符串数组 / `{name}`（Sketchfab、ArtStation）/ `{tag}`（Pixiv）/ `{_content}`（Flickr getInfo）/ 空格分隔串（Flickr `extras=tags`，带引号短语）/ 单条分类串（500px `category.name`、花瓣画板名、整页标题），统一去重、压空白、截断（默认 24 个 × 40 字）；`mergeTags()` 合并多路。消费方：`image-sources.mjs`、`picture-sites.mjs`、`artstation-search.mjs`、`downloads.mjs`（`modelSnapshot` 把 `tags` 存进任务）、`image-bundle.mjs`（写清单）。**新增平台返回标签 = 把原生值直接递给它，不要在各适配器里自己 split / map / slice。** 没有现成 `tags` 数组的平台，**分类 / 关联信息也一律转标签**：
  - **Civitai**（`picture-sites.mjs` 的 `resolveCivitai`）：`it.tags`（提示词标签）+ `modelVersions[].model.type`（LoRA/Checkpoint…）+ `model.name`。
  - **500px**：GraphQL `Photo.category { name }`（站点分类）。`PX_PHOTO_FIELDS` 含 category，`pxGqlPhoto()` 在收到「Cannot query field」时自动去掉 category 重试（categories 字段万一被接口移除也不会让 500px 整站崩）。
  - **花瓣**：画板名（分类）+ `pin.link` 来源域名 + `raw_text` 里的 `#话题`。
  - **Pinterest**（`pinterest-proxy.mjs` + `H:/AI-Tools/pin-grabber/app.py`）：Python 端 `extract_images` 从 pin 资源捞出 `title`/`description`/`board`，JS `toItems` 转成「画板名 + 描述 #话题」标签。
  - **Designspiration**（`makeHtmlSite`）：抓 `<img>` 的 `alt`/`title`，整页 `<title>`/og:title 作共享分类标签，alt/title 里的 `#话题` 作标签。
  - 仍不接：**Wallhaven**（标签只在 `/api/v1/w/{id}` 详情，48 张预览要多 48 次请求、限流 45/分钟）。

- `server/image-store.mjs` — `downloadImage` + `IMAGE_CLIENTS` 出域白名单（sketchfab 限 sketchfab.com / artstation 限 artstation.com / polyhaven 公开无限制）。**新增图片来源 = 在 `IMAGE_CLIENTS` 登记，否则会 fallback 成 artstation 白名单被拒**（Poly Haven 当初就是这么翻车的）。
  一张图可以带 `alternates`（备用地址，按顺序试）：HTTP 状态码（404/403…）= 「这个地址给不出东西」，立刻换下一个候选，**不原地重试同一条 URL**；只有连接级失败（`socket hang up` / ECONNRESET / 超时）才原地址重试，默认 1 次、间隔 500ms。错误对象带 `status`，上层据此判断要不要整任务重试。
  **例外是限流**（碰 `throttle` 时）：花瓣 567 是按 IP 累计配额，换签名地址 / 缩放档一样被拦，所以同一地址等冷却重试（`rateLimitRounds`，预算按「一张图」算），预算用尽就抛给上层，不再挨个撞 6 个候选、白烧额度。
  **不逐张 fsync**：写的是 `.part`、写完才改名，成品半截本来就不可能；每张强刷盘要 20~80ms（上千张 = 1~2 分钟）。断电最坏留下截断文件，由续传的「按清单 bytes 校验大小」兜住。
- `server/artstation-image.mjs` — ArtStation **图片作品**（没有 `.mview` 的 2D 插画）的抓取管线。`collectImages` 的分工与 `image-bundle.collectFiles` 一致：6 路并发（节流管「何时发起」，网络与写盘落进等待间隙）、单张失败只跳过并记 `failedCount`（最近 20 次失败占比过高才判链路断）、体积**边下边判**（到 `maxBytes` 停、记 `truncatedCount`）。清单按 `NN-` 计划序号压实，不按谁先下完；`info.json` 一并写 `failedCount` / `truncatedCount`，卡片据此提示「少了几张」。
  跟图站那侧的唯一区别是**没有候选地址**：ArtStation 的 rendition（`large`）由 `artstation-cdn.mjs` 在规划阶段就定好，下载层只负责取。
- `server/public-http.mjs` — 所有出站请求的**唯一入口**（`openPublic` / `readPublic` / `publicJson`）：URL 校验 + 公网 IP 校验 + **DNS pinning**（`lookup` 注入已校验地址，防 rebinding / hosts 劫持 / Fake-IP 代理）。四处性能相关、别改坏安全的点：
  - **DNS 缓存 60s**（`DNS_CACHE`，只缓存「已通过公网校验的地址」）：批量抓图时每张都 lookup 是纯浪费（单次 2~16ms），连接级失败由 `forgetHostAddress()` 作废重解。
  - **keep-alive 连接池**（`agentFor`，key = `protocol//host`）：图床上每张重新握手 = 每张多 60~110ms，复用后 `tcp=0 tls=0`、TTFB 从 150~240ms 掉到 25~35ms。**复用不绕过校验**：socket 仍是按 `lookup` 钉住的公网地址建立的，池按 origin 隔离，不会跨站点共用连接。
  - **代理分流**（`PROXY_DIRECT_HOSTS` + `shouldBypassProxy()`）：本机开着 Clash 之类的系统代理时，花瓣这类国内图床会绕一层 CONNECT 隧道、且每次新建 —— 实测走代理 489ms/张、8.7MB/s，直连 224ms/张、19.1MB/s。所以默认让 huaban / zcool / poco 直连，境外站点（ArtStation / Sketchfab / pixiv）继续走代理。`SFX_PROXY_BYPASS=foo.com,bar.cn` 追加、`all` 全直连、`none` 关表。直连若报连接级错误会**自动回退代理一次** —— 性能偏好不许变成「打不开」。
  - **代理隧道复用**（`createTunnelAgent` + `TUNNEL_AGENTS`，key = `代理地址|目标站点`）：走代理的站点原先每张图都重来一遍 `CONNECT → TLS`，**这是境外图站最大的一笔固定开销**。每个 key 一个专属 keep-alive agent，`agent.createConnection` 时才真的建隧道，复用交给 Node。实测 pexels 同图 8 次：池关 995ms/张、8 次建 8 条隧道；池开 **316ms/张（3.1×）、只建 1 条**。诊断用 `tunnelPoolStats()`（`created` 远小于请求数 = 复用在生效）。逃生开关 `SFX_NO_TUNNEL_POOL=1` 回到每次新建。
    **别退回「`createConnection` 返回已有 socket 但不传 agent`」的写法**：Node 会把这种请求当一次性的（`Connection: close`、每次新端口），自建 free 列表也救不回来 —— 这是实测踩过的坑。
  - 这三项都只影响「怎么连」，不影响「连到哪」—— 任何放宽校验的改动都不许进这个文件。
- `server/host-throttle.mjs` — **站点节奏**（`createHostThrottle` / `sharedHostThrottle` 进程级单例）：按 host 认规则（`HOST_RULES` 数据表：花瓣 `minGapMs:350` + 抖动 100、每 300 张歇 12s、撞限流冷却 15s 起翻倍到 180s；booru 类同理），`wait()` 放行、`penalise()` 撞限流就升档降速 + 进冷却、`reward()` 成功后缓慢回落（花瓣 `gapStepMs:40` / `recoverEvery:20`，撞一次从 350 升到 700 后约 175 张能回到 350）、`coolDown()` 整包级强制休息。
  **规则表按「站点实际脾气」分两档**：① 真会限流的加间隔 —— 花瓣 350ms、booru 系（safebooru / yande.re / **konachan.com 与 konachan.net 都要**）400ms、pixiv（含 `i.pximg.net`）120ms；② 图片 CDN 宽松的不加间隔（`minGapMs` 继承 0，加了就是纯变慢），只把冷却参数按站点分开 —— wallhaven / civitai / pexels / flickr / designspiration / 500px。加新站点只加一条数据，别在调用点写 if。
  **认不出的站点也有一份默认规则**（`NO_RULE`）：不排队，但撞 429/5xx 时仍然会冷却 —— 所以「没配规则」不等于「没有保护」。
  **`wait()` 是「预约槽位」不是「排队执行」**：调用进来时同步把 `nextAt` 往后推一个 gap 占住槽位，然后各自 await 到自己的时刻。早先的 `chain.then(run)` 串行队列会让第二张等第一张整段 `wait()` 跑完 —— 单张请求只要 120ms、gap 400ms，于是下载被等待完全吞掉，实测并发峰值永远是 1，每张多付一份下载+写盘时间。JS 单线程保证「读 nextAt → 写 nextAt+gap」之间不会被插队。
  **配额是按 IP 算的，所以同站点所有子域共享一份节奏，且必须跨任务共享**（两个任务各开一个调度器 = 把同一窗口的额度拆开打）。参数全部可注入（`sleep`/`now`/`random`），测试里压到零耗时。
- `server/net-errors.mjs` — **「值不值得再试一次」的唯一判定**：`isTransientNetworkError()` 认错误码（ECONNRESET 等）+ 无码文案（`socket hang up` / `premature close` / 超时）+ HTTP 状态（408/425/429/5xx）。消费方：`image-store.mjs`（单张是否重试）、`image-bundle.mjs`（限流要不要整包冷却）、`downloads.mjs`（任务是否自动重试；状态码也会从消息里认 `HTTP 5xx/429`，因为错误对象可能只剩文案）。**别在调用点自写 `/timeout|ECONN/` 正则** —— 花瓣掐连接抛的 `socket hang up` 消息里一个关键词都没有，早先就是这么漏判、整包被判死的。
- `server/polyfork.mjs` — **唯一不解析网页的模型源**：直连 polyfork.dev 的 REST（`GET /api/assets`）。搜索只做字段归一化；下载拿 `/cdn/{id}.glb` 与 `/dl/{id}.fbx`，不做本地转换。选 FBX 时 GLB 也必下 —— 队列的内容校验认 GLB 网格。改这个文件时别照 Poly Pizza 那套去抓 HTML。
  `polyforkGenerator()` 取 `/cdn/{id}.mjs`（资产自带的生成器，7 天磁盘缓存），`patchGeneratorSource()` 把
  `import ... from 'three'` 改成从 `globalThis.__PF_THREE__` 取。**改写的理由**：页面 CSP 是
  `script-src 'self'`，blob 脚本会被拒（实测 "Failed to fetch dynamically imported module"），
  所以必须由同源 URL 发出、由 `import()` 加载；同时不要让浏览器再下一份 three。
  路由 `/api/polyfork/module` 因此**不校验 X-SFX-Local**（`import()` 无法带自定义头，内容是公开 CDN 源码）。
- `server/polyfork-zh.mjs` — 参数中文化的**字典层**：`buildPrompt()` 只把 label 与取值喂给模型（**不要把 describe 塞进去**，
  一百多词的英文说明会让本地网关 60 秒后 502，去掉后同样任务 2 秒完成），`normalizeZh()` 做白名单校验
  （键必须在 schema 里、长度夹断、非字符串丢弃），`createPolyforkZh()` 负责并发去重 + 落盘 `<数据目录>/polyfork-zh/<assetId>.json`。
  路由 `GET /api/polyfork/zh?id=&n=` 里 `n` 是资产名，给模型当上下文（否则风车的 `sail` 会翻成「船帆」）。
- `server/downloads.mjs` — 下载队列：`enqueue` / `run` / `modelSnapshot`（图片分支按平台分流，Poly Haven 用 `assetId` 而非 `uid`）。`run()` 调 `imageRunner({assetId})` 必须把 `assetId` 透传到底，否则 Poly Haven 图片源拿不到 ID。下载 kind 判定 `jobKindOf` 住 `platforms.js`，前端 `enqueueImmediate` 用 `jobKindOf(picked)` 不再写死 sketchfab。
- `server/thumb-cache.mjs` — 缩略图缓存：三层解码分工，**优先用原生插件、不 spawn 进程**。`PSD`→自有解码器；`PNG`→内置解码器（zlib+反滤波）；**`jpg/webp/avif/gif/bmp/tiff` 走 `sharp`（libvips 原生插件，零子进程，打开图集不再弹命令窗）**；**`FFMPEG_EXT` 已收窄为仅 `tga|exr|hdr` 字面量**，相机 RAW / AI / HEIC / DDS 等 `preview:'thumb'` 的注册表格式改由 `DERIVED_THUMB_EXTS`（注册表派生，零失同步）走 `ffmpeg` 兜底（`externalProcessOptions()` 统一带 `windowsHide:true`，是缩略图外部命令唯一出口）。**`canThumb()` 显式并集 `SHARP_EXT`**——所以把 jpg/webp 等移出 `FFMPEG_EXT` 后仍能判定「可缩略」，改 `FFMPEG_EXT` 时 `canThumb` 与测试断言不会漏。`getSharp()` 懒加载并缓存，没装 sharp 时标 `SHARP_UNAVAILABLE` 让 jpg 回落 ffmpeg（预览不中断）。`SHARP_EXT` / `FFMPEG_EXT` / `DERIVED_THUMB_EXTS` 路由常量已导出供测试断言（`canThumb` 同时查三者）。`CACHE_VERSION` 现为 `'5'`（v2 把光栅从 ffmpeg 切到 sharp；v3 把 sharp 的 PNG 压缩从最慢档 `c9` 降到 `c6`、关掉 `adaptiveFiltering`，单张缩略图再快约 6 倍，档位见 `PNG_COMPRESSION_LEVEL` / `PNG_ADAPTIVE_FILTERING` 常量；v4 无协议变更；**v5 把 HDR / EXR 改成先 `tonemap=hable` 再缩放**，旧缓存是过曝的线性图）。**`VIDEO_EXT`（mp4/mov/mkv/avi/webm…）也进 `canThumb`**：`ffmpegThumb()` 用 `-ss 1` 快速定位抓一帧当卡片封面（短片定位到片尾时空输出会自动去掉 `-ss` 重抓第 0 帧），`TONEMAP_EXT`（hdr/exr）先试 tonemap、失败退回线性直缩 —— 视频与天空盒以前一张封面都没有，卡片上只能挂类型图标。
- `scripts/start-library-background.mjs` — 后台启动器：先问 capabilities，够新就复用、否则自动重启（`stopOldIfNeeded` → `killPids` → 重新构建 + 起服务）。判定只看契约，不再手写能力位清单。`server/capabilities.mjs` 的 `REQUIRED_CAPABILITY_KEYS` 从 `SERVER_CAPABILITIES` 全键派生，**新增能力位（如 `sharpRasterThumbnails`）即自动纳入重启判定**——改了后端必须让启动器换掉旧进程。Windows 静默服务没有控制台，派生 ffmpeg / PowerShell / taskkill 一律带 `windowsHide:true`。
- `scripts/stop-library-background.mjs` — 停止后台服务（按 pid 文件 + 端口 + 命令行三重定位）。
- `patches/` + `vendor/upstream-src/` — 上游 sketchfab-downloader-extension 的 vendor 代码与本地补丁（`npm run patches` 重打）。

## 约定（来自主人）
- 单文件 ≤300 行（硬红线 400）；类名 / 组件 / 函数各司其职。
- 一切数据驱动：平台、结果流、筛选行都走注册表，禁止 `if/else` 长龙。
- 加平台流程：① `platforms.js` 加一项；② 服务端加 `opts.xxxSearch` 注入缝（如需）；③ 服务端路由挂 endpoint；④ **在 `server/capabilities.mjs` 加一个能力位**（否则只在跑的老进程永远不重启，用户点搜索只会看到「不存在的页面或接口」——Poly Haven 当初就是这么翻车的）；⑤ 契约测试白名单自动覆盖。
- **资产库内核纪律**：schema 只加不改（`MIGRATIONS` 带 checksum，改动历史迁移会拒绝打开库）；`state_meta` 的原始字符串是权威，`assets` / `tags` / `assets_fts` 是可重建的派生索引，**禁止手写改派生表**；合集表不是派生数据，`writeValues()` 绝不清空它；新增前端要用的接口照旧在 `capabilities.mjs` 加能力位。
- **阶段 2 查询纪律**：查询语义只在 `library-query.mjs` 落地，SQLite 与内存降级必须产出同形行（`test/library-query.test.js` 锁死一致性），禁止另写一套 SQL 版过滤；新字段别名只改 `search-expression.mjs` 的 `ALIASES`；合集 id 一律由 `saveCollection()` 生成，前端不得拼；`createLibraryServer({libraryDbImporter})` 是降级路径的测试注入缝。合集顺序由 `state.queryOrder` 传递，网格不再靠 `state.sort` 二次排序。
- **阶段 3 分页纪律**：① `state.models` 保持全量，分页只发生在 `paintGrid()` 之前，禁止裁数据；② FTS5 只是**预筛**，最终仍由 `queryAssets()` 完整求值 —— 带字段 / 排除 / OR / 短语 / 2 字词的查询一律不加速（`test/library-page-api.test.js` 逐条比对 SQLite 与内存引擎的 uids）；③ `simpleFtsTerm()` 是启用加速的**唯一**判据，别在别处另写一份；④ 条数 / 体积阈值只认 `LIBRARY_LIMIT` 与 `MAX_STATE_BYTES` 两个常量；⑤ 阶段 4 已把 `slice()` 的演进缝兑现成两条模式（绘制层 / 服务端按页取数），面板与渲染链都没有动。
- **阶段 4 增量写入纪律**：① 差量规则只在 `src/library/state-mutations.js` 落地，前后端共用，禁止再写一份「服务端版过滤」；② `models` / `trashed` 永远不进 op，它们的唯一写入路径是整块 `/api/library-state`；③ op 必须是绝对赋值且带完整值校验，服务端 `mutationTransform()` 会先干跑一次再进写队列；④ 增量请求失败必须整块重放并关掉通道，绝不丢数据；⑤ `_remoteOnly` 是只读显示标记，`saveLibrary()` 必须持续过滤它；⑥ `uidScope:'page'` 只改变 uids 的传输量，`total` 与查询语义不变。
- **桌面版原生依赖纪律**：`import('better-sqlite3')` 只认 Node 裸导入逐级向上命中的 `sidecar-server/node_modules`，**禁止改成绝对路径写死**；闭包清单与装配布局在 `copy-sqlite-native.mjs` 里数据驱动，升级依赖必须同步 `RUNTIME_PACKAGES` / `PACKAGE_LAYOUT` 并让 `validateDependencyClosure()` 通过；每次装配必须用**安装包内置 node.exe** 冒烟，不能只验文件存在（ABI 换了文件照样在）。原生依赖缺失时存储层照旧降级、合集明确 503，绝不假装成功。
- **仍未拆掉的部分**：启动时 `/api/library-state` 依旧整块 GET、下载入库依旧整块 POST。真正去掉它需要先把 `models` 的写入从 blob 移到服务端 DB 权威（新增资产走专门 op），会牵动下载完成入库 / 回收站 / 恢复 / 全选整条链路，风险远大于收益，留待后续阶段。
