# CODEMAP — src/library（AssetVault 本地库前端）

> 功能 → 文件 索引，AI 首读。新增 / 移动文件必须同步本表。
> 依赖单向向下：`app.js` 装配一切；子模块经 `createX(ctx)` 工厂拿依赖，互不 `import` 对方、也不 `import app.js`。

## 入口与装配
- `app-updates.js` — 桌面版签名更新：自动检查提示、下载进度、任务保护、重启安装；浏览器模式只显示说明。
- `app.js` — 主入口。持有 `state`、路由、事件绑定，把各工厂拼起来。重构后只保留装配 + 顶层交互，渲染/检索已下移到子模块。

## 本次重构从 app.js 切块拆出的模块
- `card-view.js` — `createCardView`：单张模型卡片的 HTML（封面 / 统计 / 操作按钮 / Blender 标记 📦）。卡片上的**来源标签**一律经 `platformLabel`（从 `platforms.js` 注入）取，绝不写死 `Sketchfab`——Poly Haven 资产（无面数无点赞）此前因此误标。统计末格（浏览/点赞）仅在 `m.views||m.likes` 有时才渲染，避免空统计。单测见 `test/library-card-view.test.js`。
- `icon-set.js` — `icon(name)`：SVG 图标集（lucide 风格），唯一导出，全局复用。
- `library-view.js` — `createLibraryView`：网格 / 状态条 / 计数 / 分页 / 布局 / 预览 渲染层；`placeFilters()` 负责宽屏→左栏、窄屏→搜索卡片的 DOM 搬运。
- `discovery-feed.js` — `createDiscoveryFeed`：检索发起三件套 `requestFeed` / `startSearch` / `submitLink`；endpoint 走 `platforms.js` 注册表，不再三元链。
- `discovery-view.js` — 检索文案 / 视图辅助：`statusText` / `subtitleText` / `describeRequest` / `feedLabel`。
- `platforms.js` — 平台注册表：`PLATFORMS` / `FEEDS` / `feedEndpoint` / `routeLink`。**加平台只改这里**（声明 feeds、filters、placeholder、suggestions 即可），契约测试白名单也从 `PLATFORMS` 派生。

## 平台 / 源
- `artstation-ui.js` — ArtStation 预览 / 作品页 UI（3D Viewer 与图片两种形态）。
- `search-history.js` — 搜索历史下拉。
- `search-options.js` — 搜索选项（排序 / 范围记忆等）。

## 筛选
- `filter-tree.js` — 侧栏筛选树（各平台的分类 → 分组 / 折叠 → 可点项）。字段带 `groups`（手工分组表）就按组画、带 `fold`（长列表）就按热度折成长短两截、两者都没有才平铺。
- `filter-groups.js` — 分类清单的分组 / 折叠表：ArtStation 的 6 个用途组（按官方英文分类名声明，中文经 `filter-labels.js` 派生）+ 长列表折叠阈值 / 纯函数 `foldLongList`。**加平台只改这里，渲染器不再认识任何平台名。**
- `filter-labels.js` — 分类标签中文文案。
- `merged-filters.js` — 模型模式统一筛选树（两平台共用一套分类 / 排序 / 范围）。

## 模式
- `content-modes.js` — 模型 / 图片模式切换；高亮只由 `state`（platform + modelOnly + gallery）推出。

## 下载
- `download-ui.js` / `download-card.js` / `download-progress.js` — 下载列表与单条卡片 / 进度。
- `image-download.js` — 图片下载器（作品图 / 封面，带校验）。

## 导出引擎
- `engine.js` — 导出管线代理（拦截外部域名走 `/api/proxy`）+ GLB 校验，调 vendor `pipeline.js`。
- `blender-bridge.js` / `blender-send.js` — 与本地 Blender 的桥接与发送（仅已下载资产显示按钮）。

## 选择器
- `picker.js` / `picker-model.js` — 自绘下拉：原生 `<select>` 作唯一数据源，旁边画统一风格按钮 + listbox；业务代码零改动。

## 状态 / 存储
- `settings-panel.js` — 统一偏好设置：左侧分类、右侧可折叠分组；复用原导出与 AI 控件，分类切换保留未保存值，AI 配置按窗口会话懒加载。
- `search-translation.js` / `server/ai-search.mjs` — 中文关键词 AI 翻译、并发合并与缓存；发现页使用英文检索，本地库同时匹配原词与译词；失败保留原词。
- `ai-settings.js` / `server/ai.mjs` — AI 接入界面与兼容 Chat Completions 的服务端连接；配置留在本机，密钥不回传。支持模型列表、保存与测试；`complete()` 供后续 AI 功能复用。
- `local-filters.js` — 本地库类型、任意规格文件可用性和关键词组合筛选；无保存记录不等于磁盘上没有文件。仅读取后台任务，不删除或迁移数据。
- `library-state.js` — state schema、`mergeModels` / `collectModels`、v1→v2 迁移、UI 默认值（`sfx-library-v2` / `sfx-library-ui`）。

## 视图辅助
- `gallery-view.js` — 画廊（封面瀑布流、比例自适应）。
- `html-esc.js` — `esc()` HTML 转义。
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
- `server/image-bundle.mjs` — `runImageJob`：图片任务 worker；调 `collectImageAssets` 取清单后逐张 `downloadImage`，落盘 `<名称>-images` 文件夹 + `info.json`。
- `server/image-store.mjs` — `downloadImage` + `IMAGE_CLIENTS` 出域白名单（sketchfab 限 sketchfab.com / artstation 限 artstation.com / polyhaven 公开无限制）。**新增图片来源 = 在 `IMAGE_CLIENTS` 登记，否则会 fallback 成 artstation 白名单被拒**（Poly Haven 当初就是这么翻车的）。
- `server/downloads.mjs` — 下载队列：`enqueue` / `run` / `modelSnapshot`（图片分支按平台分流，Poly Haven 用 `assetId` 而非 `uid`）。`run()` 调 `imageRunner({assetId})` 必须把 `assetId` 透传到底，否则 Poly Haven 图片源拿不到 ID。下载 kind 判定 `jobKindOf` 住 `platforms.js`，前端 `enqueueImmediate` 用 `jobKindOf(picked)` 不再写死 sketchfab。
- `scripts/start-library-background.mjs` — 后台启动器：先问 capabilities，够新就复用、否则自动重启（`stopOldIfNeeded` → `killPids` → 重新构建 + 起服务）。判定只看契约，不再手写能力位清单。
- `scripts/stop-library-background.mjs` — 停止后台服务（按 pid 文件 + 端口 + 命令行三重定位）。
- `patches/` + `vendor/upstream-src/` — 上游 sketchfab-downloader-extension 的 vendor 代码与本地补丁（`npm run patches` 重打）。

## 约定（来自主人）
- 单文件 ≤300 行（硬红线 400）；类名 / 组件 / 函数各司其职。
- 一切数据驱动：平台、结果流、筛选行都走注册表，禁止 `if/else` 长龙。
- 加平台流程：① `platforms.js` 加一项；② 服务端加 `opts.xxxSearch` 注入缝（如需）；③ 服务端路由挂 endpoint；④ **在 `server/capabilities.mjs` 加一个能力位**（否则只在跑的老进程永远不重启，用户点搜索只会看到「不存在的页面或接口」——Poly Haven 当初就是这么翻车的）；⑤ 契约测试白名单自动覆盖。
