# Changelog

功能与修复的版本记录。README 只保留「是什么、怎么用」，详细变更集中在此。

## 3.29.2（Uiverse 403：换浏览器指纹）

- 修：Uiverse 的列表 / 详情 / 代码三个通道，Node 原生 TLS 一律被 Cloudflare 回 403
  （同一地址系统 curl 能 200），表现为「点 UI 模式什么都不显示」。
  `openPublic` 新增 `browserPrint` 选项：403 时改用 curl-impersonate 的浏览器指纹重试一次；
  `uiverse.mjs` 三处读站点都打开它。实测搜索 24 条 / 总数 4510、列表 5 条、代码 html 1607B + css 1058B。
- 说明：这个开关只对显式声明的站点生效（ArtStation 走原有 `artstation` 分支，行为不变）。

## 3.29.1（视频站链接路由与单条视频）

- 修：`pexels.com` / `civitai.com` / `pixabay.com` 的图片站与视频站同域，视频站没登记 `hosts`，
  `/videos/…` 一律先命中图片站 —— 粘视频页会看到「Pexels 这串链接里找不到摄影师或作品编号」，
  而且下拉被悄悄拨回图片站，之后每次加载都报同一个错。
  现在图站注册表支持 `paths`（路径前缀），路由表按「带路径的排前面」匹配。
- 修：Pexels 单条视频页改为 `/download/video/{id}/` 取 302 的 mp4 直链
  （文件名带 `_宽_高_fps`），顺带得到真实分辨率；取不到才退回搜索认领，认不到仍如实报错。
- 测试：`library-platforms` 的链接通道白名单补上图站 / 视频站 / UI 站（原来只认 artstation / web）。

## 3.29.0（视频模式接入四个在线源）

`SERVER_VERSION 3.28.1 → 3.29.0`。**要重启服务**：新增能力位 `videoSites`；前端需重新 `build:library`。

「视频」模式此前只能留在发现页做链接解析，现在有四个真站点可浏览、可搜词：

| 站点 | 免 key | 能搜关键词 | 备注 |
|---|---|---|---|
| Pexels 视频 | 是（网页端内置 secret-key） | 是 | 空关键词 = 热门流 |
| Coverr | 是 | 是 | 实拍 / 动画短片，多为 10 秒循环镜头 |
| Civitai 视频 | 是（公开 `?type=video`） | 否 | 站点没有关键词维度，只能浏览 + 作者主页 |
| Pixabay 视频 | 否，需免费 API key | 是 | 没 key 时明确提示，不撞 Cloudflare |

**没有新开端点**：四个站注册进 `PICTURE_SITES`，走既有的 `/api/picture-site/resolve` → 前端瀑布流 → `/api/video` 代理 → 下载管线。视频卡与小红书 / Civitai 的 mp4 是同一份 `pictureCardHtml`（`type:'video'` + `play` + `url` 三件套），所以播放、悬停静音预览、收藏、下载全部现成。视频站在平台注册表里标 `kind:'video'`，只进视频模式的池子 —— 图片模式与「全部平台」都看不到它们。

**逐个踩过的坑**

- Pexels：`/v3/videos/{id}` 单条接口 307 到 v2 后 **404**，网页端确实没做单条视频；视频页 HTML 对 Node 直连又回 **403**（curl 能过，Node 的 TLS 指纹被拦）。所以单条链接改为「拿 slug 当关键词搜一次、按 id 认领」，认领不到就**明说找不到**，绝不把搜索第一条冒充成你粘的那条。
- Civitai：`/api/v1/videos` 是 404，视频混在 `/api/v1/images` 里，必须带 `?type=video` 才只出 mp4；另外 `civitai.com/videos` 过去会被当成「用户名 videos」，已加栏目路径保留字。
- Coverr：直链是固定命名 `{base}/{1080p|720p}.mp4`，**540p 实测 404**，所以按素材的 `max_height` 挑档位；付费素材直接跳过，不摆出来当免费。
- 预览代理：`/api/video` 只放行 CDN 白名单，补了 `coverr.co` 与 `pixabay.com`；Pexels 与 Civitai 的视频落在已有域名子域上，无需再加。

**Pixabay 的 key**：`platform-settings.json` 新增唯一的字符串配置 `pixabayKey`（其余仍是布尔开关，校验逻辑没放宽）。设置 → 平台模块 → 视频素材 组底部有输入框，也可用环境变量 `PIXABAY_API_KEY`。`GET /api/platforms` 只回 `pixabayKeySet`，key 明文不出服务端。

**文本模式仍然是链接解析**（没有可搜关键词的文本源），行为与 3.28.1 一致。

**测试**：`test/video-sites.test.js` 钉住「前后端注册表一一对应 / 只进视频池 / 设置页分组 / 可搜关键词标志」四组约束；真实抓取用隔离服务冒烟验证（Pexels / Coverr / Civitai 各 200 出 `type:video`，`/api/video` 回 206 `video/mp4`，`/api/image` 回缩略图，Pixabay 无 key 回 400 + 中文提示）。

## 3.28.1（发现页「文本 / 视频」不再跳资产库）

纯前端修复，服务端版本不变。前端需重新 `build:library` 并 Ctrl+F5。

模式轨上的五个键在两个页面干两件事，这是设计；但「文本 / 视频」过去把**发现页**也当成了资产库：`applyModeTab` 里 `route('library')` 会强制换页，用户在发现页点一下就被从结果流里踢走（2026-11-12 反馈）。

- 新增 `LINK_PLATFORM`（`platforms.js` 虚拟平台）：label「链接解析」，`feeds: []`，不进 `PLATFORMS` 清单，因此不参与模式池推导、不出现在设置页的平台开关里。它的唯一入口是 `submitLink` → `feeds.web`。
- `mode-presets.js` 给文本 / 视频加 `linkOnly`：`platformPoolFor` 返回且只返回这一枚。`localOnly` 保留 —— 它在资产库页仍然要按本地文件类型筛，两个字段各管一面，由路由决定用哪面。
- `applyModeTab` 去掉 `route('library')`；`linkOnly` 走「留在发现页 + 平台切到链接解析 + 清空关键词框」（这一模式不认关键词，留着旧词只会像「搜了没结果」）。资产库里点同一枚图标仍是原地筛类型，行为不变。
- 配套四处：`route()` 切回发现页时纠正平台（否则出现「高亮说文本、下拉说 Sketchfab」）；`adoptPlatform` 在 link 下不再把下拉拨到 Sketchfab（粘链接时状态行会谎报归属）；`exitContentMode` 退出时把平台还原成全量；空状态与搜索提示改成「粘链接」，不再套用「所有平台已关闭」。

**已知**：链接解析只认页面 / 直链能被 `scan` 解析出来的资产，不保证视频站一定解析出播放源；要在发现页按关键词浏览视频，仍需接真实在线源。

## 3.28.0（实时监控 · 开机自启 · 外观 · WebDAV 云同步）

`SERVER_VERSION 3.27.0 → 3.28.0`。**要重启服务**：新增能力位 `folderWatch` / `webdavSync`；前端需重新 `build:library`（设置页多出「外观」「云同步」两张卡）。桌面版另需重新打包才带开机自启命令。

**文件夹实时监控**（`server/scan-cache.mjs`）

递归监听本来就在（增量索引靠它拿 `changedPaths`），缺的是「变化之后通知谁」。这次补上两层：

- 变化经 800ms 合并窗口广播成 SSE `kind:'local'`（不带绝对路径，只给根目录名），前端收到后走**非强制**重扫 —— 强制 `force=1` 会全量重扫，几十万资产下等于卡住主线程。
- **噪音过滤**是这次的关键：设了同步盘的用户（微力同步 / OneDrive）每写一个文件都会产生 `.sync-conflict-*` / `.tmp` / `.crdownload` 一串事件。不过滤的话索引被反复作废、前端不断重扫，看起来像「一直在扫描」。实测：真文件写入 1 次通知；写 `x.sync-conflict-*.txt` 与 `c.tmp` 0 次。

**开机自启（仅桌面版）**

写 `HKCU\...\Run` 一个字符串值（不引入 autostart 插件，少一个依赖与一份 capability 配置）。值带 `--autostart`：开机拉起时窗口只留在托盘，不弹启动画面；托盘建不起来就不隐藏，否则窗口藏了没法找回。设置 → 应用 → 启动与后台。每次打开都回读注册表真实状态（用户可能在任务管理器里禁用过，或程序搬了家而注册表还指着旧路径）。

**外观：背景与面板不透明度**

三个 CSS 变量：底色、背景图、面板 alpha。刻意不做整套主题引擎 —— 界面几百处颜色是硬编码深色，全量变量化要重写样式表，收益（能改主色）与风险（对比度崩、每个面板都要重测）不成比例。背景图缩到 1920 宽转 JPEG 后存 localStorage（原图会撞 5MB 配额），走 `multiply` 混合压暗，深色卡片上的文字对比度始终由底色兜住。存本地不跟库同步：同一份库在台式机与笔记本上可以有不同壁纸。

**WebDAV 云同步**

同步单元是**整库快照**（`exportLibrary` 产物：资产、用户域、合集与智能合集），不是 `state/*.json` —— ADR-09 之后目录与用户域的权威在 SQLite，主 blob 的目录字段恒为空，同步那些文件换台机器打开就是空库。

- 冲突策略用 `merge` 而非覆盖：`importLibrary` 的 merge 语义是「新资产吃种子、已存在的资产保留本机标注」，两台机器各自整理过标签也不会互相抹掉；覆盖式同步只要有一台没同步完就丢数据，不能做成定时任务。
- 收敛靠 `library.meta.json` 的 `rev`：远端 rev 变了先拉下来合并，合并结果作为新快照上传，再记住这个 rev。两端一致时什么都不做（`noop`）。实测四态：首传 `uploaded` → 二次 `noop` → 远端换 rev `merged`（合并后两边资产都在）→ 再跑 `noop`。
- 客户端零依赖（`fetch` + Basic Auth），六件事：PROPFIND / MKCOL / PUT / GET / HEAD / 列表；401、404、405、507 各有中文文案。密码只进不出，`status` 只回 `hasPassword`；留空保存表示沿用旧密码。
- 自动同步默认 10 分钟、可关、可调 1~1440 分钟；定时器 `unref`，没配地址时根本不起。访客一律 403。

**待办**：桌面版需重新打包才能用上开机自启；`sync` 不传原始资产文件与缩略图缓存（那些是本机路径与可重建数据）。


## 3.17.0（小红书列表页改走浏览器通道）

`SERVER_VERSION 3.16.3 → 3.17.0`。**要重启服务**：新增能力位 `pictureXiaohongshuBrowser`；前端需重新 `build:library`（图站空状态多了登录入口）。

**问题**：用户反馈「登录了还是提示要登录、也搜不到」。实测确认**不是登录的问题** —— 小红书网页版（web build 6.61.3）把搜索结果、推荐流、笔记详情**全部改成客户端异步拉取**：

| 通道 | 实测结果 |
|---|---|
| SSR `window.__INITIAL_STATE__` | 搜索页 `search.feeds` **恒为空数组**（登录态下也是）；笔记详情页干脆 `hasState:false` |
| 纯 HTTP 直调 `edith.../v1/search/notes` | `code:300011 当前账号存在异常` —— 签名（x-s）校验在拦 |
| 借浏览器的页面状态 | 搜索 **44 条** / explore **31 条** / 主页 **29 条**，标题、作者、封面、`xsec_token` 齐全 |

「需要先登录」这句是**误报**：判据是游客态，而它跑在「能不能拿到内容」之前，通道死了就必然喊错话。

**解法：借浏览器当签名器**（不逆向 x-s，不去维护那套灰色依赖）

- 新增 `server/xhs-browser.mjs`：在**共用同一个 profile（同一份登录态）**的浏览器里开一张背景页签跑页面，三档取材按可靠性排序 —— ① hydration 后的页面状态（主力）② 页面发出的接口响应体（补 `xsec_token`）③ 渲染后的 DOM 卡片（兜底）。页面状态带 Vue 响应式包装与循环引用，所以取状态的是**页面内的一段小程序**：自己解包、只挑解析器认得的字段、压成扁平 JSON 再吐回来。
- `server/cdp.mjs` 新增 `openPageTarget()`：**借一张新页签**而不是导航走用户那一页（登录窗口可能还停在首页）。
- `server/browser-session.mjs` 新增 `watchPage()`：已有实例（含用户开着的登录窗口）就借它一张页签，没有才起 headless；全程 `serialize()`，同 profile 不给两个进程用。
- 搜索 / 博主主页 / 首页推荐 / 笔记详情四条入口全部接入，SSR 那一级保留为快路（主页带 `xsec_token` 时 0.8s 就能出 29 条，省一次开浏览器）。
- **修掉一个老 bug**：主页的 `user.notes` 是按 tab 分的二维数组（实测 `[29,0,0,0,0]`），原来当成一维卡片用 → 29 篇的作者只解析出 1 条。拍平前排除元组卡片 `[id, card]`（首项是字符串 id）。
- 列表卡片补 `authorId`（点作者名才能进主页——过去只给名字）与 `xsec_token`（无 token 的笔记地址**打不开**，实测确认）。
- 错误文案改对：本地**有**登录 cookie 时不再喊「需要先登录」，改为说明「页面返回的是未登录的壳，多半弹了人机验证或结构变了」；浏览器通道自身故障（没有可用浏览器）会明确说出来，不再借登录文案蒙混。

**前端配套**：图站的空状态/失败卡/无结果卡上都给了「登录 / 扫码登录」入口（`site-login.js` 统一开窗 → 轮询到关窗 → 原地重跑那一次解析），卡片标题按 `search:true` 分「搜索 X」还是「X 按链接解析」（过去一律写「按链接解析」，让可搜的站看起来搜不了）；小红书补 `home` = `/explore`，切过去就能看到首页推荐。

**代价**：列表页首次解析要等浏览器把页面渲染出来（实测 12~20 秒），结果前端缓存 10 分钟；单篇笔记与带 token 的主页仍走纯 HTTP 快路。

## 3.16.3（本地资产库文档格式支持）

`SERVER_VERSION 3.16.2 → 3.16.3`。**要重启服务**：新增能力位 `docRenderBundle` / `docConvertPdf`；前端需重新 `build:library`（多出一个独立 bundle `/doc-render.js`）。

> 这是**工具自身的本地资产库预览能力增强**，与 RSS 订阅阅读器是两条独立线，不互相依赖。

本地文件查看器新增 12 类文档的完整渲染（原来 `.md` 只是纯文本、Office/EPUB 完全没有预览）：

| 格式 | 渲染方式 | 依赖 |
|---|---|---|
| `.md` / `.markdown` | Markdown 排版渲染（标题/表格/代码块/图片/链接） | `marked` + `DOMPurify` |
| `.docx` | 浏览器内高保真分页渲染 | `docx-preview` |
| `.epub` | 电子书阅读器（分页、可翻页） | `epubjs` |
| `.doc` / `.pptx` / `.ppt` / `.xlsx` / `.xls` / `.rtf` / `.odt` / `.odp` / `.ods` | 本机 LibreOffice 转 PDF → 复用现有 pdf iframe | LibreOffice（检测+引导安装，不打包） |

**架构要点（复用优先，不造轮子）**
- 格式清单只在 `format-registry.js` 的 `ROWS` 加行 + `TEXT_PREVIEW_OVERRIDES` 改 md 策略；服务端 `fileKind()` 直接委托注册表，扫描/MIME/筛选/预览一起生效，**服务端零改动**。
- 渲染库合计约 1.2MB，做成**独立 bundle `/doc-render.js` 懒加载**（复用 `lazy-preview.js` 范式），主包 `app.js` 不增重；桌面版构建同步该资源。
- LibreOffice 转换复用 `video-transcode.mjs` 的探测范式与 `externalProcessOptions()` 隐藏控制台；白名单从注册表派生，**校验产物文件而非退出码**（soffice 退出码不可信），按 mtime/size 落缓存。
- 能力位 + 静态资源白名单缺一不可：旧进程既没有新路由，也不会放行 `/doc-render.js`，必须靠能力位换进程。

**实测抓到并修掉的三个坑**（真浏览器 CDP 冒烟，Node 单测抓不到）
| 现象 | 真因 | 修法 |
|---|---|---|
| 浏览器里 markdown 整条渲染链断掉 | `hardenLinks()` 传 `window.document` 却调 `new document.DOMParser()`；`DOMParser` 挂在 `window` 上 | 直接注入 `DOMParser` 构造器 + 补 Node 单测 |
| 打开损坏/受 DRM 的 EPUB 永远「正在渲染…」 | `rendition.display()` 永久 pending | 渲染器内 15s + 前端兜底 30s 双层超时，给明确中文错误 |
| DOMPurify 拿不到实例 | esbuild 走 `browser` 字段选中 UMD **工厂函数**（`sanitize` 为 undefined） | `DOMPurify(window)` 取实例 + 「拿不到净化器就抛错」安全红线，绝不注入未净化 HTML |

**验证**：新增 22 条单测（纯策略层 8 / 转换逻辑 11 / HTTP 端点 3）+ 3 个既有格式测试同步更新；相关 56 条全过。真浏览器实测 markdown 净化（`<script>` 被清、外链 `noopener`）、docx/epub 库调用链正常。`build:library` 通过，桌面版资源已同步。设计预案见 `design/documents/document-rendering-design.md`。

## 3.16.2（Uiverse UI 动效平台接入）

`SERVER_VERSION 3.16.1 → 3.16.2`。**要重启服务**：新增能力位 `uiverseSearch` / `uiverseCodePreview` / `uiverseElementDownload`；前端同时要重新 `build:library`。

Uiverse 是社区 UI 组件库（按钮、加载动画、开关等动效代码）。它的产出不是 3D 模型，而是**可直接复制使用的界面动效代码** —— 所以走的是独立管线，不与模型管线混用。

**站点是 Remix 应用，三个数据通道全部匿名可读**（实测无需登录，这是它比小红书省事的地方）：

| 通道 | 地址 | 用途 |
|---|---|---|
| 列表 | `GET /elements?_data=routes/$category&search=&theme=&page=` | 检索与分类浏览 |
| 详情 | `GET /{user}/{slug}?_data=routes/$username.$friendlyId` | 元数据（作者 / 标签 / 浏览量） |
| 代码 | `GET /resource/post/code/{id}?v={version}` | html + css 原文 |

排查过程中踩到并解决的三个坑：

| 现象 | 真因 | 修法 |
|---|---|---|
| 列表与搜索全 403，详情却正常 | `URLSearchParams` 把**已预编码**的 `routes%2F%24category` 二次编码成 `routes%252F%2524category`，Remix 认不出路由名 | 常量改存未编码的 `routes/$category`，交给 `URLSearchParams` 编码一次 |
| `/loaders` 返回非 JSON | 类型路径表由单数别名取反构造，`loaders` 与 `loader` 都映射到 `loader`，后者胜出 → 请求 `/loader`（站点不认） | 显式列出复数路径表，不再取反 |
| `/elements?type=loader` 照样返回全部 4508 条 | 站点**只认路径段**过滤类型，`type` 参数是死的 | 按类型换路径（`/loaders`），类型过滤落到服务端换路径 |

**预览不用外挂引擎**：Tailwind 元素自带的 css 头部是 `tailwindcss v3.4.16`，含编译好的 utility 类与 `--tw-*` 变量。

**渲染分两层，各有理由**：

- 卡片 → **Shadow DOM**。`:root` 在 Shadow DOM 里匹配不到任何东西（它指向文档根），元素依赖的 CSS 变量会全部失效 —— 所以按官方前端的做法把 `:root` 换成 `:host`。几十张卡片各跑各的动画，互不污染。
- 弹窗 → **iframe + srcdoc + sandbox**。独立文档，元素的 CSS 一点都漏不到主界面；sandbox 不给 `allow-scripts`（社区代码不该有执行权），而 CSS 动画本来就不需要脚本，动效照跑。

**不用静态封面图**：官方封面图在 Cloudflare Images（imagedelivery.net），本网络下 TLS 直接断（不是 403、不是超时）。但更关键的是 —— UI 元素的卖点就是「会动」，给一张静态截图最值钱的部分就没了。所以卡片上放的是现场渲染的真东西，代码按 `IntersectionObserver` 懒加载（滚进视口才取），几十张卡片不会一上来就全跑动画。

**落盘形态**：`index.html` + `style.css` 两个文件（样式用相对路径 `<link>` 引，与 style.css 同目录即可工作），外加 `README.md`（出处 / 作者 / 许可 / 标签 / 浏览量 + 代码全文）与 `info.json`。

新增文件：

- `server/uiverse-state.mjs` — 解析层（纯函数、零网络、可单测）：链接四种形态、类型路径映射、`:root`→`:host`、`@import` 提前、预览文档与落盘文件组装
- `server/uiverse.mjs` — 网络层：三个通道 + 403 退避重试 + 发现页检索流 `uiverseSearch()`
- `server/uiverse-job.mjs` — 落盘执行器 `runUiverseJob()`
- `src/library/ui-element-preview.js` — 前端预览：Shadow DOM 挂载、iframe srcdoc、IntersectionObserver 懒加载、源码拼装
- `test/library-uiverse-state.test.js`（16 例）+ `test/library-ui-element-preview.test.js`（4 例）

顺带修掉的两个真问题：

- **HTML 注释注入**：元素标题来自社区站，能带 `-->`，会提前闭合复制出去的注释 —— 现在标题与来源统一洗过一遍（测试抓到后修的）。
- **筛选面板清单分叉**：`FILTER_ROWS` 原本在 `library-view.js` 与 `app.js` 各有一份，加平台时必打架 —— 现在是单一来源（`library-view.js` 导出、`app.js` 导入），并把「一行行手写显隐」改成按注册表逐行显隐。

## 3.16.1（首帧与切页的「闪一下 / 卡一下」）

`SERVER_VERSION 3.16.0 → 3.16.1`。**要重启服务**：`/sidebar-boot.js` 加进了静态白名单，老进程不认这个路径会 404；前端同时要重新 `build:library`。

三个成因，互相独立，都带实测数据：

| 现象 | 根因 | 修法 |
|---|---|---|
| 每次刷新侧栏「先展开再收起」 | 首帧脚本写成了内联 `<script>`，而页面 CSP 是 `script-src 'self'` —— 内联脚本**根本没执行**，class 只能等 `app.js` 加载完才挂上 | 拆成同源 `/sidebar-boot.js`，不加 defer、放在 `<link rel="stylesheet">` 之后（并行的样式请求不被它挡住） |
| 切页面 / 切瀑布流 / 切内容模式时整屏闪一下 | 卡片坐标是 CSS 变量（默认 0px），`grid.innerHTML=` 之后要等下一帧才量，中间那一帧所有卡片叠在左上角、网格高度还是 0 | `observeMasonry()` 返回 `flush()`，绘制层写完 DOM **在同一个任务里**摆位 |
| 切到下载页再切回来位置错乱 | `#library-view` 变 `display:none` 时 `#grid.clientWidth` 归零，布局照常量算 ⇒ 列宽 0px、卡片全压扁 | 量不出宽度就跳过这一轮并保留 dirty，等 `ResizeObserver` 在重新可见时再算 |
| 切页面卡一下（3000 条库实测 25~31ms） | `renderGrid()` 末尾 `syncStickyOffset()` 读 `offsetHeight` = **强制同步布局**，刚写完 60 张卡片就要先排一遍整树，绘制时又排一遍 | 测量合并进 rAF，这一帧只排一次 |

改后实测（headless Edge + CDP，3000 条假资产，同一台机器）：切到资产库的同步耗时从 25~31ms 降到空载时 6.8~9.1ms（机器被压满时会回到 20~38ms，绝对数字波动大，别当基准）。更可靠的证据是 CPU 采样：`syncStickyOffset` 自耗从 **40.4% 降到 5.1%**，且不再有任何单点热点。首帧验证：`DOMContentLoaded` 时 `<html>` 已是 `side-collapsed`，控制台无 CSP 报错，切页往返 33 张卡片、网格高度 6256px 前后一致。

新增 `test/library-first-paint.test.js`（4 例）：内联脚本禁令 + `sidebar-boot.js` 必须同步阻塞且与 `sidebar-collapse.js` 同 key + 重建后当帧落位 + 零宽度时不许改写坐标。

## 3.16.0（小红书图站接入）

`SERVER_VERSION 3.15.0 → 3.16.0`；新增能力位 `pictureXiaohongshu`。**必须重启服务**，老进程的 `PICTURE_SITES` 里没有这个 id，解析会直接报「这个图站暂时不支持抓取」。

四条通道，全部走**网页端 SSR 状态**（`window.__INITIAL_STATE__`），**不碰 `x-s` / `x-t` 签名**（那套是 JSON API 用的，随版本变，属不可维护的灰色依赖，本工具不引入）：

| 入口 | 是否需登录 | 说明 |
|---|---|---|
| 单篇笔记 `/explore/{id}`（含 `xsec_token`） | **不需要** | 笔记自带的 `xsec_token` 就是访问凭证 |
| 分享短链 `xhslink.com/…` | **不需要** | 跟随 302 后如已是笔记页就直接解析，不请求第二次 |
| 博主主页 `/user/profile/{id}` | **需要** | 站点不做 SSR，游客拿到的是空壳（`userPageData:{}`、`notes` 全空） |
| 关键词搜索 | **需要** | 同上；游客 `searchContext.feeds` 是空数组 |

登录一次后 cookie 进 jar，之后走纯 HTTP 自动带，不必每次开浏览器；未登录访问这两类页面时给出明确提示（而不是"没有结果"）。

**三个「照抄会翻车」的点**（都写进注释了，别当冗余）：

- **UA 必须用老版 Chrome/91**：小红书按 UA 分档风控，新 UA 和移动 UA 直接送验证码。`openPublic` 的默认 UA 是 `SketchfabLocalLibrary/1.0`，不覆盖必然被拦。
- **绝不能带站内 Referer**：带了会被当成 App 内跳转、302 到 `/login`。素材下载器 2026-10 实测「游客态必被拦」，原因就是这个头。
- **`login.showLogin` 一直是 `false`**：匿名页面里它不置 true，判「没数据是不是因为没登录」只能看 `user.loggedIn === false` / `userInfo.guest === true`。另外游客 cookie 里**也有** `web_session`，所以不能拿它当登录判据 —— 小红书暂时没有可靠的登录态判据，UI 保持「存了 cookie、无法确认」，靠「能不能抓到内容」验证。

状态解析的三个坑（`server/xhs-state.mjs`）：

- 状态里有**裸 `undefined` 字面量**（实测 27 处），`JSON.parse` 必报错 → 字符状态机只在字符串外替换，正文里出现 "undefined" 这个词的词条不会被改坏。
- 列表字段可能是 Vue 的 **`{_rawValue: [...]}`** 包装，直接当数组用会静默拿到 0 条（"页面有数据但解析出空"的典型原因）。
- 图给的是压缩档 `sns-webpic-qc` + `!nd_dft_wlteh_webp_3` → 换 `sns-img-qc` 并去掉转码后缀才是原图；`infoList` 里 `CRD` / `WB_DFT` 更清晰。

配套改动：

- `server/picture-sites.mjs` 加 `resolveXiaohongshu` + `PICTURE_SITES` / `PICTURE_LOGIN_URLS` / `PICTURE_CDN_HOSTS`（`xhscdn.com`）。
- `server/image-store.mjs` 的 `IMAGE_CLIENTS` 加 `xiaohongshu`（CDN 走 `openPublic`，按域名带 Referer）。
- `src/library/platforms.js` 加一条「设计灵感」组站点（分组 / 链接路由 / 登录按钮 / 收藏采集全部自动派生，前端零 if/else）。
- `server/collect-search.mjs` 的 `pictureItem()` 支持抓取层显式给 `key`：**一篇笔记多图时 `pageUrl` 全相同**，没有这个键 `collectUid` 会把它们算成同一张、去重后只剩一条。
- 新增 `test/library-xhs-state.test.js`（14 例：裸 token 清洗、转义引号、状态提取、`_rawValue`、原图升级、四种链接、笔记/主页/搜索解析、拦截原因、游客态判定）。

## 3.15.1（侧栏层级整理 · 仅前端，无需重启服务）

侧栏底部原来堆了「AI 接入 / 导出设置 / 帮助与反馈 / 收起侧边栏」四条，越往下越像"杂物抽屉"。这次把**入口收敛到该在的位置**：

- **折叠键上移**：`#sidebar-toggle` 从底部整条按钮改成**图标键**，放到「工作区」标题右侧（`side-label-row`）；折叠后它跟着图标列居中，仍可一键展开。窄屏（≤780px）本来就是图标态，该行隐藏。
- **使用说明 + 帮助与反馈合并**：顶部 `?` 打开同一个 `#help-dialog`，内部两个页签（`使用说明` / `问题反馈 / 功能建议`）。新增 `help-panel.js` 只管切页签，`feedback.js` 的表单迁进 `index.html` 的静态面板（`#help-panel-feedback`），不再运行时造 dialog；草稿恢复改为每次载入只跑一次，避免每次打开覆盖正在写的内容。
- **入口不丢**：合并后帮助只剩顶部一个入口，所以折叠态把品牌行改成竖排、把 `?` 留在 logo 下方（窄屏同理），不再随折叠消失。
- **改名去箭头**：「导出设置」→「设置」（弹窗标题同步，AI/Blender/队列/导出目标早就不只"导出"），并去掉横向箭头——它是弹窗不是跳转。底部帮助入口随之移除。
- **顺带修**：折叠态品牌块宽度按 `max-content` 撑到 128px（文字 `opacity:0` 仍占位）导致 logo 被裁一半 → 钉成 34px 小方块，文字不参与布局。
- 新增 `test/library-help-panel.test.js`（4 例：默认页、反馈直达、点页签切回、未知页签回落）。

## 3.15.0（智能收集画板：服务端 P0 + P1）

`SERVER_VERSION 3.14.0 → 3.15.0`；新增能力位 `collectRules` / `collectScheduler` / `collectPendingMerge` / `collectPlatformSearch`。**必须重启服务**，老进程没有 `/api/collect/*` 路由。

新增统一开发文档 [docs/board-development.md](board-development.md)：把「花板式画板体系（阶段 0~4）」与「智能收集（P0~P3）」合成一条主线，冻结 §4 契约层（画板数据模型 / 前端 state 与 `bd-*` 命名 / 两套 HTTP API / 规则 schema / 去重键 / 守卫配额 / 待合并队列 / 能力位 / 目录红线），并给出按 owner 切分的并行任务表 A~H。

服务端新增 7 个模块（均 ≤300 行）：

- `collect-rules.mjs` — 规则 / 运行记录 / `seen` 去重索引三合一的 `collect-rules.json`；串行写队列 + `.tmp` + `rename` 原子落盘；`daily` 到点判定、停机 >7 天过期规则重置。
- `collect-search.mjs` — 9 个模型平台 + 8 个可搜索图站的注册表，复用既有搜索函数与 `openPublic()`，不写第二套抓取逻辑；`canonicalKey()` 去跟踪参数、`collectUid()` 派生稳定 32 位 uid。
- `collect-guard.mjs` — 每平台令牌桶（模型 30/h、图站 12/h）、500~2000ms 抖动、`Retry-After` 优先、连续 3 次失败熔断 6 小时；新平台从满桶起步。
- `collect-pending.mjs` — **待合并队列**：服务端不直接写 `models`（会被前端整块保存覆盖），结果先入 `collect-pending.json`，前端拉取 → `mergeModels` → `saveLibrary` → `ack` → 重绘。零新增写库通道、零迁移、失败可重放。
- `collect-runner.mjs` — 单规则执行：逐平台搜索 → 本地过滤（只让有数据的 4 个维度参与）→ 去重 → 入队 → 立即 `addToBoard`；`dryRun` 只给预览不写状态。
- `collect-scheduler.mjs` — 60s tick、`unref()`、串行、单规则锁。
- `collect-api.mjs` — 7 条 `/api/collect/*` 路由，与 `/api/library/*` 共用 `x-sfx-local` + 同站守卫。

`library.mjs` 装配 7 个模块并启动心跳（`createLibraryServer({collect:false})` 供测试关闭）；`capabilities.mjs` 升版本并加 4 个能力位。新增 `test/library-collect-{rules,search,guard,runner,scheduler}.test.js` 共 **39 例全绿**（假时钟 / 假文件系统 / 假 searcher，不打外网）。

修复 4 个自测发现的真 bug：守卫首次请求永远 0 令牌、`refillBucket` 的 `at:0` 被 `||` 吞掉、采集结果格式派生恒为空、模型名未 trim。

> 前端智能收集面板与画板阶段 1 尚未完成，见文档 §6 任务表。

## 筛选面板视觉改版（3.14.0 之后的前端 bundle，服务端版本不变）

主人反馈「面板太丑、文字太多、交互繁琐」。**只改前端**：后端协议、能力位、`SERVER_VERSION` 全部保持 3.14.0，刷新页面即可看到（桌面安装版重跑 `build-installer.cmd`）。

- **少文字**：删掉所有重复面板标题、大段 `fd-hint` 说明、底部「未选择 / 清除本维度」文字按钮；说明全部进 `?` tooltip 与 `title`，popover 头只留「维度图标 + 名称 + 激活小圆点 + ? + 清除 + 关闭」。
- **图标 + 颜色**：新增 `filter-visuals.js` 视觉注册表与 `filter-panel-common.js` 控件工厂；色卡改纯色圆形（选中白边 + ✓ 勾）、评分改 5 颗星、收藏/类型/排序改图标 chip、格式 7 组改图标 tab 一次只显示一组、激活 chips 与图标条同行、「清除全部」改垃圾桶图标。
- **参数用滑条**：相似度、最低星级（0~6，映射到 `ratings` 精确数组，协议不变）、分辨率档位、标签显示数量、数值范围阈值全部用统一 `sliderRow()` 渐变轨道 + 数值气泡；比例用按真实宽高比绘制的图形按钮。
- **减负**：点选即累加（不再需要 Shift）、复选框全改图标按钮、排除改 ⊘ 图标、标签两个逗号输入框收成图标展开的单行输入、格式组三态改用 `data-state` 颜色表达。
- **可替换**：`--fd-*` 设计令牌集中在 `.fd-dock`，`data-skin="lime｜violet｜amber"` 热切换 + `sfx-filter-skin-v1` 持久化 + `dock.setSkin()` 入口缝；视觉层独立成 `app.css` 末尾一段，将来抽成皮肤文件不动面板逻辑。
- 新增 `test/library-filter-visual.test.js` 8 例；更新 `library-format-selection.test.js` 的 UI 契约；Edge headless 真实 DOM 冒烟 8 面板 `errors:[]`、色卡零文字、面板零说明段落 / 零复选框；全量回归 **1082 / 1066 / 16 红**，与既有 16 红基线一致，零新增红。

## 3.14.0（筛选图标条补齐：颜色 / 形状 / 标签 / 评分 / 收藏 / 更多 / 排序）

`SERVER_VERSION 3.13.1 → 3.14.0`；新增能力位 `libraryColorFilter` / `libraryNumericFilter` / `libraryProbeMetadata` / `librarySortDirection`。

- **先补元数据，再补功能**：颜色筛选需要主色、形状筛选需要宽高，原资产模型两者都没有。新增 `src/library/asset-probe.js`：同源封面用 canvas 64×64 采样，4096-bin 直方图 + 加权 k-means 取代表主色（算法移植自 Serpent `palette-extractor.ts`，MIT），同时记宽/高；卡片 `img` 加载即采（零额外请求），面板里也可手动全库后台扫描（可停止、有进度、可重建）。结果写 `state.assetProbe[uid]`，走既有差量写入通道；`deriveAssetRows()` 注入 payload，SQLite 与内存降级同形，schema 不动。
- **颜色维度不再是「待接入」说明页**：10 个预设色卡 + 自定义色（≤12）+ 相似度滑杆 0-100 + 排除模式；HSL 盒 + 环形色相距离，移植自 Serpent `color-filter-presets.ts` / `color-hsl.ts`。未采样资产在包含模式不命中、排除模式保留。
- **形状维度补上真实筛选**：资产类型 + 横图/竖图 + 5 种宽高比（±5%）+ 1K/2K/4K 分辨率 + 自定义范围；协议 `ranges:[{field,min,max}]` 同字段 OR、跨字段 AND，支持宽高/长边/时长字段与排除。
- **其余面板逐项补齐**：标签包含/排除（右键排除）、最近使用、计数与名称/次数排序、搜索与手动输入；评分精确星级多选 + 未评分 + 排除；收藏三态；更多面板加入数值范围、合集/智能合集列表（复用既有能力，不另造预设存储）、语法说明与清除全部；排序补到 11 种（+ 色相/分辨率/文件大小，含升降序与可复现随机种子）。
- **统一状态与 chips**：`filter-state.js` 收拢所有维度状态并持久化（`sfx-filter-snapshot-v1`），新增可单独点掉的激活筛选 chips 与「清除全部」；面板拆成 5 个模块守住单文件行数红线。`advanced-query.js` 新增 `setQueryOptions` / 合集复用缝，`isEmpty()` 不再把「只改排序」误判成空筛选。
- **协议可扩展**：`filters.colors/colorSimilarity/excludeColors/ranges/excludeRanges/ratings/excludeRating/favoriteMode/excludeTags` + `sortOrder/seed`；检索新增 `color:` / `aspect:` / `width:` / `height:` / `resolution:` / `duration:` 字段与数值比较；GET `/api/library/assets` 同样支持。
- 测试新增 5 个文件 33 例；Edge headless DOM 冒烟覆盖 8 个面板打开、点选、chips、清除；构建产物 `dist/library/app.js` 与桌面版 `app.js` 哈希一致。

## 0.1.15（2026-10-29）

- 更新应用 Logo 和启动动画，在启动期间准备分类、配置和首屏布局。
- 优化搜索栏小猫互动，将版本检查、更新提醒和更新操作移入气泡。
- 恢复中文原词、英文译词及相近词独立检索并合并结果。
- 修复多平台搜索卡片反复重建、加载明暗闪动和吸顶区域透出卡片。
- 资产库使用独立的类型与分类筛选，支持标签分类和卡片右键操作。
- 完善 ArtStation 的 3D 与图片预览、下载和导出交互。
- 新增多软件导出配置、安装检测及脚本安装流程，改善 Houdini 导入。
- 完善平台管理、图片站点及局域网相关能力；详细开发记录见下文。

## 3.19.0（软件更新页改卡片式：状态徽标 + 滑块开关）

- **软件更新页重排为三张独立卡片**：主状态卡（软件图标 + 当前版本 + 上次检查时间 + 状态徽标 + 主按钮）、自动检查更新（右侧滑块开关）、退出应用（仅桌面版出现）。
- **状态徽标跟着真实阶段走**：待检查 / 检查中… / 已是最新（绿）/ 可更新 1.2.5（亮绿）/ 下载中… / 等待安装 / 检查失败（红）。主按钮文案在发现新版本时变成「查看更新」。
- **自动检查从一个小方块复选框换成 44×25 的滑块开关**，开关文案补上「安装前仍会确认」，避免用户以为会自动装。
- 去掉了这一页多余的折叠组：页面标题已经是「软件更新」，原来的 `details` 展开后又是一个一模一样的「软件更新」标题，三层重复。
- 卡片最大宽度 860px —— 全宽铺满时左侧文字到右侧按钮之间空出半屏，收窄后更像一张卡片。
- 网页版（浏览器模式）显示「不可用」徽标与「查看说明」，不再出现退出应用的入口；窄屏下主按钮换行满宽。

## 3.18.0（卡片右键菜单：对资产直接操作）

- **资产库网格里的卡片支持右键菜单**：右键一张卡弹出操作菜单（不是浏览器的原生菜单），被右击的卡片有一圈淡绿描边标出作用对象。菜单按卡片类型与当前状态给出可用动作：
  - 远端资产卡：打开预览 / 下载到本地 / 打开下载文件夹 / 发送到其它软件… / 收藏 / 加入模型库（或从模型库移除）/ 标签与评分 / 复制官方链接 / 在浏览器打开官方页面
  - 回收站里的卡片：放回模型库 / 彻底删除记录（红色危险项）
  - 本地素材包卡：打开素材包 / 下载为 ZIP / 登记 info.json / 复制路径
  - 资产库里没登记成任务的零散文件：打开文件 / 复制路径
- **菜单项复用卡片按钮那套 `data-action` 约定**，靠事件冒泡交给既有的点击分发执行 —— 预览、下载、收藏、移除这些行为与卡片上的按钮完全同一套逻辑，不会两处分叉。只有「复制链接」「打开官方页面」这类没有对应动作的用独立回调。
- **菜单挂在 `<body>` 上**（`position:fixed`）：卡片同时有 `overflow:hidden` 与 hover `transform`，留在卡片里会被算成相对卡片定位再裁掉，表现就是「右键了什么也没出来」。
- 「能不能下载 / 能不能导出 / 能不能打开文件夹」直接读卡片上已渲染的节点（下载键、`.export-control`、`.open-folder`），菜单与卡片显示的状态天然一致，不另判一套。
- 访客不显示「加入模型库 / 从模型库移除」（那是改主机资产库的动作）；键盘可用 `Shift+F10` / 菜单键打开同一菜单，`↑↓` / `Home` / `End` 导航，`Esc` 关闭；输入框、下拉与选中文字上右键仍走浏览器原生菜单。
- 新增 `trash` 图标（删除用垃圾桶造型，与「关闭」的叉区分）。

## 3.17.4（分类可手动折叠：默认展开 + 点标题能收起）

- **修复「分类始终展开、点不动」**：上一轮为了在抽屉里撑开分类，CSS 无条件把分支 body 设成 `display:block`，把 `.open` 类彻底架空了 —— JS 的折叠切换还在跑，但 CSS 不理它，于是父级分支永远展开。改成由 `.open` 类驱动（收起 `display:none`、展开 `display:block` + 淡入），默认展开改为由 JS 给父级 section 加 `.open` 实现。
- **点击以 DOM 为准**：`filter-tree.js` / `merged-filters.js` 的分支标题点击改成读 DOM 上的 `.open` 类（不再读内部 state），抽屉外部加的类与内部状态不会再失同步，点第一次就有反应。
- 子分组仍默认折叠（`setGroupOpen(wrap,false)`），父级默认展开 —— 列表长度可控且随时能手动收起。

## 3.17.3（抽屉贴侧栏右缘展开，不再遮挡侧栏按键）

- **遮挡修复**（用户反馈抽屉盖住侧栏其它按键）：抽屉面板从屏幕最左（`left:0`）改为贴着折叠侧栏右缘展开——容器 `inset:0 0 0 var(--side-rail)`（65px 起）且 `overflow:hidden`，滑入动画被裁在侧栏右侧，视觉上像从侧栏背后抽出，全程不挡侧栏任何按键。
- **让位联动**：`main` 让位改为 `calc(65px + 面板宽)`，内容区右缘与面板右缘对齐。
- **变量整理**：新增 `--side-rail:65px`，`--drawer-w` 改为 `min(360px, calc(100vw - 65px))` 防窄屏溢出。

## 3.17.2（抽屉分类只展开父级，子分组折叠）

- **分层展开**（用户反馈「拉的太长」）：抽屉里只强制展开**父级分支**（分类/类型/艺术家/排序/范围），**子分组默认折叠**、点击才展开。列表长度可控。
- 实现：CSS 强制展开从 `.filter-drawer .ftree-body`（全部）收窄为 `.ftree-sec>.ftree-body`（仅父级）；分组 `.open` 时直接切 `display:block` 撑开。`filter-tree.js` 分组默认不展开。
- 保留：父级默认展开、选中项自动展开其所在分组。

## 3.17.1（分类抽屉打磨：非模态 + 默认展开 + 放大字号）

- **非模态 / 不变暗**（用户要求）：抽屉不再加暗色遮罩、也不拦截点击——去掉 scrim，容器 `pointer-events:none` 只让面板本身可点。可以一边选分类一边继续搜索 / 操作其它区域。
- **主内容让位**：抽屉开着时 `main` 整体右移 `--drawer-w`（360px），露出完整搜索/内容区，和分类面板并排、同时可用。（`main` 的 `margin-left` 有多条同特异性规则，用 `!important` 锁定让位优先。）
- **分类默认展开**（用户要求）：抽屉里所有分支/分组默认展开、不折叠。用 `display:block;height:auto` 直接撑开，绕开 `.ftree-body` 的 `grid 0fr→1fr` 折叠技巧在抽屉 flex 链里撑不开的问题；分类清单撑满抽屉、消掉大片空白。侧栏内联的折叠交互不受影响。
- **字号放大 + 排版收紧**：分支/叶子/标签从 11px 放大到 13.5–14px，chip 12px；行距、间距、模式键尺寸一并放大。
- 改文件：`app.css`（抽屉块重写）、`index.html`（去 scrim、去 `aria-modal`）、`filter-drawer.js`（`filter-drawer-open` 类驱动让位）、`filter-tree.js`（根分支/分组默认展开，长列表「更多分类」折叠组除外）。

## 3.17.0（折叠态分类改抽屉 + 修按键错位）

- **修按键错位**（用户反馈的回归）：折叠态分类/筛选区因为 `#side-filters{display:flex}`（ID 级）压过了折叠隐藏规则，仍被塞进 65px 轨道，内容按展开尺寸（按钮 `min-height:72px` 等）挤成拉长错位的方块。改为 `html.side-collapsed .sidebar #side-filters{display:none}`（只在仍嵌侧栏内才隐藏），错位随之消失。
- **折叠态分类改抽屉**（用户要求）：折叠后侧栏不再硬塞分类 UI，改为一枚「分类」漏斗图标键；点它从左侧滑出抽屉面板，展示完整的分类 / 筛选界面（模型/图片模式键 + 筛选树）。关抽屉或展开侧栏会把分类移回侧栏。
- **单实例 portal**：抽屉复用同一个 `#side-filters` 节点（打开时移进抽屉体、关闭时移回侧栏），所有按 ID 绑定的筛选逻辑（`#filter-rows` / `#side-modes` / 筛选树事件）无需改动。
- 改文件：`app.css`（折叠 hide 特异性 + 触发键 + 抽屉）、`index.html`（触发键 + 抽屉 DOM）、新增 `filter-drawer.js`、`app.js`（挂载）、`icon-set.js`（加 `filter` 漏斗图标）。

## 3.16.1（侧边栏折叠态美化 + 平滑过渡）

- **补动效**：折叠 / 展开从「瞬间硬跳」改成 `.28s` 缓动过渡——侧栏宽度与内容区让位（`main` 的 `margin-left`）一起平滑收放，文字随 `overflow:hidden` 裁切，不再溢出到主区。chevron 旋转本就有 `.22s`，现在整体一致。
- **折叠轨道做精致**：折叠后侧栏比主区略亮（`#0e151e`）+ 右缘柔影，不再是和背景分不清的黑条；logo 加圆角底板、图标居中统一留白、hover 浮起放大、选中项淡底 + 左缘强调条；展开键在折叠态描边成清晰的可点方块；顺手把折叠态内容区位移从 61px 修正为 65px（原来和侧栏 65px 差 4px，内容会压到侧栏下沿）。
- 顺带裁掉折叠态残留的版本号文字（旧版 `#app-version` 溢出），`overflow:hidden` 后不再出现截断的「ArtSt」。
- 改文件：`src/library/app.css`（折叠态块 + `.sidebar`/`main` 过渡；未动任何 DOM 与交互类名）。

## 3.16.0（导出改成两步式：先选目标，再点图标导出）

- **交互重做**（用户要求）：「发送到」从封面右下角**移到缩略图下方的信息行**，与「标签」同一行、靠右。点它弹出目标清单，选中后**按键上直接显示对应软件名**（如 Unity）；**选中不会立即导出** —— 旁边另有一枚**纯图标的导出键**（绿色向上箭头），**点它才真正导出**到所选软件。两步走是为了避免手滑把成品直接推给错误的软件。
- **目标名胶囊 + 图标导出键**：胶囊显示当前生效的目标软件（默认 Blender），点击换目标；导出键是圆形的纯图标键，不带文字。当前生效的那一项在菜单里带 ✓。
- **选择按资产记住**：挑过的目标存起来，卡片因为队列脉冲、筛选切换整片重渲染后，按键上仍是同一个软件名。
- **封面彻底干净**：已下载的卡片不再渲染底栏（下载键消失后底栏没内容了，留着会显示成一条空的渐变斜角）；未下载的卡片底栏只保留下载键。
- **访客权限**：访客在详情面板里同样只看到「推到自己电脑的 Blender」这一个目标（此前 `library-view.js` 没传 `isVisitor`，会漏出引擎目标）。
- 详情面板 / 预览面板的导出入口同步换成新控件（`preview-actions.js` 的参数 `blenderButton` → `exportControl`）。
- 新增 `export` 图标（向上箭头出容器，与 `download` 的向下箭头区分）。
- **测试**：新增 `test/library-export-targets.test.js`（8 项，锁住两步式结构、默认目标、访客过滤、菜单打勾）；`test/library-preview-actions.test.js` 同步到新参数。
- 改文件：`src/library/export-targets.js`（选择状态 + 两步式控件）、`card-view.js`（控件移到信息行）、`card-shell.js`（空底栏不渲染）、`app.js`（`export-pick` / `export-go` 两个动作）、`library-view.js`（传 `isVisitor`）、`preview-actions.js`、`icon-set.js`、`app.css`。

## 3.15.2（卡片底栏精简到 1 个键 + 修「发送到」菜单被裁）

- **修 bug**：「发送到」菜单此前留在卡片里，被 `.model-card` 的 `overflow:hidden`（圆角裁切）和 hover 的 `transform` 双重干掉 —— transform 会让 `position:fixed` 的子元素改成「相对卡片」定位，菜单被算进卡片坐标再裁掉，表现就是「点了没反应」。现在菜单在点击时**挂到 `<body>`** 上，关闭即移除（不留孤儿节点）。
- **卡片底栏精简**（用户要求）：已下载的资产**不再显示「✓ 已下载」键**，也**不再显示「从模型库移除」✕ 键** —— 已下载的卡片底栏只剩一个「发送到」胶囊。
- 发送键改用独立的 `card-export` 类（不再复用 `card-download` 的圆形样式），显示为 71×26 的胶囊「发送到」，hover 保留绿色识别色。
- 回收站里的「放回模型库 / 彻底删除」保留（移除操作改到详情面板与模型库筛选页）。
- **测试修复**：`test/library-card-view.test.js` 的 mock 仍传 `blenderSendButton`（3.15.0 重构遗留，导致该文件 22 项全红），已改为 `sendControl`；并把「已下载 → 下载键禁用」等旧断言同步到新语义（已下载 → 不存在下载键）。
- 改文件：`src/library/app.js`（菜单挂 body）、`export-targets.js`（只渲染入口按钮 + 菜单 HTML 导出）、`card-view.js`（去掉已下载/移除键、改用 `card-export`）、`app.css`（`.card-bottom button.export-toggle` 胶囊）、`test/library-card-view.test.js`。

## 3.15.1（修复「发送到」点不开 + 卡片缩略图去冗余）

- **修 bug**：`toggleExportMenu` 的开关判断写反了（`if(!open)` 且 `open` 取的是「是否带 hidden」），导致菜单永远打不开、点「发送到」毫无反应。改为 `isOpen = !hasAttribute('hidden')` 后正确开合，再点一次也能收起。
- **去冗余**：卡片缩略图叠层原来堆了 6 个控件（标签 + 材质格式 + 精度 + 下载 + 发送到 + 移除），改为只在封面上保留 3 个核心键（下载 / 发送到 / 移除）；标签、材质格式、精度选择下沉到缩略图**下方常驻区**（`card-meta-actions`，`.card-meta` 改为可换行）。
- **更清晰**：发送键在封面上显示为带文字的胶囊「发送到」（不再是一个看不懂的图标）；弹层顶部加「选择导出软件」标题，点开即见目标清单。
- 改文件：`src/library/app.js`（toggle 逻辑 + export 样式）、`card-view.js`（拆分 metaActions）、`card-shell.js`（新增 metaActions 字段）、`export-targets.js`（菜单标题 + 提示文案）、`app.css`（`.export-control` 胶囊、`.card-meta-actions`、`.export-menu-head`）。

## 3.15.0（多软件导出：发送到…）

把原来写死的「发送到 Blender」单键，改成声明式的多目标导出。卡片 / 预览面板 / 详情页的
导出入口统一为「发送到 ▾」下拉，列出所有适用目标（按本地成品类型过滤：材质、模型、HDRI）。

- 目标注册表在两端各一份、保持一致：`server/export-targets.mjs`（服务端，`TARGETS`）+ `src/library/export-targets.js`（前端）。
- **Blender**：沿用既有桥接推送（主机走 `downloads.sendToBlender`，访客走本机桥接），物料在 Blender 内建 Principled BSDF 材质。
- **引擎（Unity / Unreal / Godot）**：手动指定工程根目录（设置 → 导出目标），后端把已下载的成品（FBX + PBR 贴图文件夹）复制到 `<工程>/Assets/AssetVault/<名称>/`。
  - Unity 额外写入 `Assets/Editor/AssetVaultImporter.cs`（AssetPostprocessor）：导入时按文件名关键词（albedo/diffuse/basecolor、normal、roughness、metallic、ao/arm、height、emissive）把贴图接到 URP/HDRP/Standard Lit 材质，并生成预制体。金属度/粗糙度打包为近似处理。
- **其它 DCC（Maya / 3ds Max / Houdini / C4D）**：手动指定内容 / 导入目录，后端复制成品过去；这些软件原生导入 FBX + 散贴图。
- 新增接口：`GET /api/exports/targets`（目标 + 已配置路径）、`POST /api/exports/configure`（保存路径）、`POST /api/exports/send`（投递）。均限本地（X-SFX-Local）且拒绝访客写入。
- 访客只能把整包模型推到自己电脑上的 Blender，引擎 / DCC 的目录写入对访客关闭。

## 3.13.5（缩略图恢复 1:1）

3.13.1 把 `.card-media` 改成了 5:4，和各平台回传的预览图对不上（平台原图是方的，
`object-fit:cover` 在 5:4 容器里会把上下裁掉一截）。改回 `aspect-ratio:1`。

- 画廊视图（`.gallery .card-media{aspect-ratio:auto}` + `.gallery .thumbnail{aspect-ratio:1}`）
  与列表视图（`.compact .card-media{aspect-ratio:1}`）本来就是方的，不受影响。
- 代价：卡片变高约 25%，1600×937 下一屏仍是 3 行（第三行露出顶部）。

## 3.13.4（卡片动作键改为悬停显示）

用户要求「鼠标悬停在卡片上时才显示下载和标签按键」。`.model-card>.card-bottom` 默认
`opacity:0 + translateY(5px) + pointer-events:none`，`:hover` / `:focus-within` 时淡入上浮（.16s）。
用 opacity 而非 display：卡片高度不跳、网格不重排。

- 触屏（`@media (hover:none)`）常显 —— 触屏上不存在悬停，收起来等于按钮消失。
- 列表（紧凑）视图常显 —— 那里底栏是 grid 第 3 行，收起来只会空出一行。
- 收藏（`.favorite`）保持原行为不变。

## 3.13.3（搜索面板还原）

3.13.1 把搜索区压成了扁平工具栏，用户要回原来那张圆角渐变卡片。只还原 `.search-panel` 本身
（22/24/18 内边距、18px 圆角、radial + linear 双层渐变、58px 字段、原分隔与投影）；
侧栏宽度、卡片尺寸、底栏圆形图标键继续保留 3.13.1 / 3.13.2 的结果。

## 3.13.2（卡片放大 + 底栏全图标化）

用户反馈「卡片偏小、下载键不明显、不需要显示下载和标签的文字」，照着圆形图标组的参考改：

- 卡片列宽阈值 184 → 228px（1600 宽 5 列、1080 宽 3 列），标题 13px、作者 11px。
- 底栏一律圆形图标键：30px 深色半透明圆底 + 细白描边图标；「下载 / 标签 / 发送到 Blender /
  移除」的文字收进 `<span>` 由 CSS 隐藏（DOM 里留着给无障碍与测试读），不再显示任何按钮文字。
- 下载键：34px 实心 accent 圆点 + 深色图标 + 投影，是这张卡唯一的高亮，扫一眼就能定位；
  悬停提亮并微微上抬。精度/格式下拉做成同名胶囊，不混进圆形键里。
- 新增 `tag` 图标（`icon-set.js`）：原来「标签」按钮是个 ✦ 字符，图标化后和旁边同套观感。

## 3.13.1（界面重做：一屏多一行，卡片回归「图 + 两行字」）

对照专业素材站的密排观感做的一轮纯 CSS 调整（不动 DOM、不改交互类名）：

- 顶部搜索从「大圆角渐变卡片」压成一条 44px 工具栏（去渐变、去投影），侧栏 226→208px，
  模型/图片两个大竖牌换成并排小 chip —— 三者合计把纵向空间让出约 90px。
- 卡片缩略图 1:1 → 5:4（3D 资产在方图里上下大量留空），列宽阈值 218→184px，1600 宽下 5 列变 6 列。
- 卡片底栏不再单独占一行：用 grid 与 `.card-media` 叠在同一行，浮到缩略图右下角，
  一屏从 2 行变 3 行。紧凑（列表）视图显式排除，那里仍走独立底栏。
- 图上角标（类型胶囊、收藏、文件夹）去掉底框与毛玻璃，改用投影浮在图上。
- 卡片文字改成「标题独占一行 + 作者/许可第二行」；视图切换当前项给绿底；快捷键提示提亮。

## 3.13.0（参数中文化：规则词表先上屏，模型字典补长尾）

Polyfork 的 `-params.json` 只有英文 `label` / `describe`，官方没有多语言字段。面板上原本只有一张
`LABELS` 白名单硬映射，命中几十个 key，其余原样显示英文。

现在分两层：

| 层 | 位置 | 做法 | 覆盖 | 成本 |
|---|---|---|---|---|
| 规则 | `src/library/polyfork-zh.js` | key 表 → 整串短语表 → 逐词拼（全词命中才拼） | 抽样 348 个参数覆盖 61% | 零请求 |
| 字典 | `server/polyfork-zh.mjs` | 打开预览时异步请求，模型翻一次落盘 | 补齐剩余长尾 | 首次 ~5s，之后读文件 |

要点：

- **规则层优先，字典只补空缺**。模型把 windmill 的 `cap pitch` 译成「机头坡度」（按风力发电机理解），
  反倒不如规则层的「顶盖坡度」；`sail` 在给了资产名作上下文后才从「船帆」纠正成「风帆」。
- **不给模型喂 describe**。一百多词的英文说明喂进去，本地网关 60 秒后直接 502；只给 label 与取值，
  同样任务 2 秒完成。describe 留原文当悬浮提示，信息不丢。
- 字典白名单校验：键必须在 schema 里、长度夹断、非字符串丢弃 —— 模型编出来的东西进不了 DOM。
- 译名存 `<数据目录>/polyfork-zh/<assetId>.json`，纯缓存，删掉只会退回规则层。
- 面板先按规则层渲染完再异步换字（就地改文本，不重渲染，正在拖的滑杆不会被打断）。

## 3.12.0（参数改到本地重建：5ms 出几何，拖动滑杆即时跟手）

上一版改几何参数要回服务端烘焙 `/cdn/{id}-remix.glb`，实测 **1.5~2.0 秒**，还吃匿名每小时 40 次的额度，
所以只能等松手才请求 —— 拖起来就是「松手 → 等两秒 → 变一下」。

这一版把资产自带的生成器取回浏览器直接跑。它本来就长这样（官方 QUICK START 就是这么写的）：

    import { createAsset } from './windmill-3aad49.mjs';
    scene.add(createAsset());

| 路径 | 耗时 | 请求 | 额度 |
|---|---|---|---|
| 服务端烘焙 `-remix.glb` | 1500~2000ms | 1 | 1 次/参数 |
| **本地生成器 `createAsset()`** | **4~5ms** | 0 | 0 |

Node 侧连建 10 次（不同 tallness）总共 27ms。所以现在滑杆是**边拖边变**：input 事件按 rAF 合并，
一帧重建一次，松手不需要再发任何请求（实测拖动 12 帧，`/api/polyfork/variant` 请求数为 0）。

三级策略，从快到慢，前一级失败自动落到下一级：

1. 本地生成器（`pf.gen`）—— 4~5ms，零请求零配额；
2. 本次会话烘焙过的同一档 GLB（内存里留 8 份）—— 一次 parse；
3. 服务端烘焙 —— 1.5~2 秒，只在上面两级都不可用时发生。

技术要点：

- **CSP 是硬约束**。页面 `script-src 'self'`，`import(blobUrl)` 会被直接拒
  （"Failed to fetch dynamically imported module"）。所以生成器由 `/api/polyfork/module` 以同源 URL 发出；
  该路由**不校验 `X-SFX-Local`**，因为 `import()` 无法附加自定义请求头（内容是公开 CDN 源码）。
- **不要为跑生成器再下一份 three**。服务端把 `import * as THREE from 'three'` 改写成
  `const THREE = globalThis.__PF_THREE__;`，`mergeGeometries` 同样注入 —— 用的是页面里已有那份。
  改写不动（有别的裸依赖）就返回 415，前端退回服务端烘焙。
- **生成器源码 7 天磁盘缓存**（30~80KB/个），首次 0.8s、之后 7ms。
- 换几何走轻量路径 `pfSwap()`：不重建地面、不动机位、不重设近远平面 —— 滑杆每帧都会进这里，
  走完整 `pfMount()` 的话那些开销乘上 60fps 就是肉眼可见的卡。

## 3.11.1（修复：Polyfork 筛选没进侧栏、三个平台分类加载报 `esc` 未定义）

- **Polyfork 的筛选面板漏搬**：`library-view.js` 的 `FILTER_ROWS` 少写 `#filters-polyfork`，
  宽屏下它的「类别 / 排序」还挂在搜索框下面，左侧栏空着。补进清单，并加一条守卫测试
  （html 里每个 `.online-filters` 都必须在 `FILTER_ROWS` 里，以后加平台漏写会直接失败）。
- **Poly Haven / Kenney / ambientCG 分类加载失败**：`category-options.js` 的 `fillOptions`
  要 `esc` 参数，但这三个 UI 工厂没解构、`app.js` 创建时也没传，运行期报
  `esc2 is not a function`（开了这两个平台就弹一条 toast，分类下拉永远是空的）。三处补上。

## 3.11.0（Polyfork 参数化预览：旋钮接进 3D 预览）

Polyfork 的资产是「程序」而不是冻结的网格：2600 多个资产各带一份 `-params.json`，改参数就换造型。
这一版把这些旋钮接进预览弹窗右侧，**拖一下就能看到变化**。

两类旋钮的成本差三个数量级，所以走两条完全不同的路：

- **颜色**（`color` 旋钮 + `colorway` 成套配色）：GLB 里存的是顶点色 `COLOR_0`（线性空间）。
  浏览器一次性把每个顶点按「默认色最近邻」归类到色区，之后改色就是就地写顶点色 ——
  实时、零请求、零配额。实测 5526 个顶点 100% 归类，`iron #3c4550` 与 `interior #363f4a`
  这种只差 0.017 的相邻色也能正确分开（阈值收紧到 0.008 + 取最近，不是「近似就收」）。
- **几何**（`range` / `toggle` / 改网格的 `choice`）：只能回服务端重建
  （`GET /api/polyfork/variant?id=&p=`，转发到官方 `/cdn/{id}-remix.glb?p=`）。
  `range` 只在**松手**（`change`）时请求，拖动过程只更新数字 —— 否则拖一次就是几十次烘焙。

其他要点：
- 取回来的是 `-remix.glb`（不是 `/cdn/{id}.glb`）：后者是已发布的静态文件，带 query 也返回同一份字节。
  只有 `-remix` 才会按 `p` 重建。
- 重建后**保留相机机位**，否则每拖一下滑杆视角就飞走。地面阴影跟着新包围盒重算。
- 连拖两次只认最后一次响应（`seq` 丢弃过期回包），不会停在中间那一档。
- 重建失败不清场：旧几何与颜色都留着，只在面板上提示一句。
- 面板在 `#model-details` 里，类名用 `.pf-meta` 而不是 `.author-name` ——
  后者会被 `app.js` 换成「作者按钮」，整行副标题会被吞掉（实际踩过）。
- 能力位 `polyforkParams`，`SERVER_VERSION` 3.11.0。
- 新增 `test/library-polyfork-params.test.js`：颜色/几何分类、空清单、变体 URL 拼接、接线完整性。

已知边界：`sails` 这类改网格的 `choice` 也会重建，无法在本地预判是否真的改了顶点；
`night`（夜间发光色区）只取到了字段，没做 UI。

## 3.10.0（Polyfork：程序化低模库）

新平台 **Polyfork**（polyfork.dev）。它是本仓库第一个完全走官方 JSON 接口的模型源，不打网页、不解析 DOM：

- **检索**：`POST /api/polyfork/search` 转发到 `GET /api/assets`，支持关键词、官方 9 个类别
  （道具 / 建筑 / 载具 / 角色 / 动物 / 附件 / 地形 / 手持物 / 超低模）、按面数排序。
  匿名可用，浏览与下载都不消耗它家的「生成变体」配额。
- **下载**：`kind:'polyfork'` 走独立 runner。**不需要任何本地转换** —— GLB 从 `/cdn/{id}.glb`
  直取，FBX 用它在服务端转好的 `/dl/{id}.fbx`（顶点色已烘焙成具名材质，正好是 Unity 想要的）。
  选 FBX 时 GLB 仍会下一份：队列的内容校验认 GLB 网格，预览与 Blender 桥也靠它。
- **卡片**：来源标签走 `platformLabel`，封面经 `/api/image` 代理（白名单新增 `polyfork.dev`）。
  许可统一标注「商用免署名 · 禁止再分发文件」。
- **分类树**：`#filters-polyfork`（类别 + 排序）登记进 `filter-tree.js` 的 SPECS。
- 能力位 `polyforkSearch` / `polyforkDownload`，`SERVER_VERSION` 3.10.0 —— 不加这一位老进程不重启，
  点搜索只会撞上「不存在的页面或接口」。

## 3.9.1（资产库管理三件套：评分备注、我的标签、回收站）

参考 Serpent（开源 DAM）的资产管理思路，按 AssetVault「单人本地 + 资产包即真相」的底子裁剪落地，
不搬数据库、不搬 Eagle 生态：

- **评分与备注**：资产库记录新增 `userMeta`（rating 0-5 + note）。标签面板里点星即存、
  备注失焦保存，都不要额外保存键；有评分时卡片信息行显示星级，悬停带备注摘要。
  评分写入浏览器状态的同时异步补一份进磁盘 `info.json` 的 `user` 段（包即真相），
  ZIP 包与未登记包静默跳过。排序新增「我的评分」。
- **「我的标签」层**：标签从「平台 + AI」两层扩成三层。平台标签仍只读；AI 标签带 ✦；
  新增的 `userTags` 可手动增删（面板里回车或点添加，× 移除），并并入本地搜索。
- **标签管理面板**：工具栏新增入口，支持跨资产重命名、合并（目标已存在时自然合并）、
  删除，以及一键清除全部 AI 标签（AI 标签可再生，不值得逐个管）。
- **回收站**：卡片移除键从「确认后立即删记录」改为「一键进回收站」（资产筛选里选「回收站」），
  暂存记录连评分/备注/我的标签一起搬迁，支持恢复与彻底删除（彻底删除需二次确认，
  仍不删除已下载文件）。上限 200 条。
- **服务端补路由**：新增 `POST /api/local/meta-patch`（沿用登记的校验链：只认扫描包根、
  拒 ZIP、要求已登记），把 AI 标签（`ai` 段）与用户评分/备注（`user` 段）写进 info.json；
  此前 `patchAi` 已实现但无路由调用，AI 标签只活在浏览器里。
- 数据模型向后兼容：`loadLibrary` 对缺失的 `userMeta`/`userTags`/`trashed` 给默认值，
  旧库直接升级，无迁移步骤。测试 66 项全绿。

## 3.9.0（把三处重复的界面逻辑收成共用模块）

- **安装类面板合并**：设置里的「Blender 连接」和「运行环境 · 后台浏览器」原本是同一套代码
  抄了两遍（函数名都同名）。现在共用 `install-panel.js`：检测 → 建任务 → 按 id 轮询 →
  分步进度 → 收尾横幅 / 超时兜底 / 失败原因留面板，流程只有一份；
  两个面板各自只提供「说什么话」（`describe` / `renderBanner` / `copy`）。
- **进度条骨架三处共用**：`progressMarkup()` 同时供 Blender、后台浏览器、依赖准备向导使用，
  依赖向导原来的 `stepMark` / 勾叉 SVG 也改为复用，不再各存一份。
- **平台侧栏分类下拉**：Kenney / FreeStylized / PolyHaven / ambientCG 四处「拉分类 → 填 select →
  保留已选项 → 失败提示」合并为 `category-options.js` 的 `localJson` / `fetchCategories` / `fillOptions`。
- **字节格式化**：本地素材库不再自带 `fmtBytes`，统一用下载任务卡的 `sizeText`（NaN 显示 — 而不是 0 B）。
- 顺带修复：`vendor/upstream-src/lib/pipeline.js` 被清空成 0 字节导致 `npm run build:library`
  的补丁步骤报错，已从版本库恢复（内容未变）。
- 行为不变：卡片、进度条、按钮文案均与上一版一致；测试 51 项全绿。

## 3.8.9（卡片模板合并成一份）

- 资产卡与本地素材包卡不再各写一套 HTML：新增 `src/library/card-shell.js`（`assetCard` / `cardMedia` /
  `cardNote`），两类卡片都往里填「封面、角标、标题行、底部操作区」，DOM 结构与 class 完全一致。
- 于是下载键位置和样式统一了：素材包卡从「右上角小图标」改成和资产卡一样的底部「下载」按钮，
  类型角标（图片素材 / PBR 材质…）也统一成左上角 `card-type`；「登记」变成左下角的文字键。
- 素材包卡的标题行：有作者显示作者，没有则显示「多少个文件 · 体积」；更新时间、磁盘份数、路径
  收进右侧说明键，悬停才显示。
- 修一个连带的 bug：`library-view.js` 增量重绘只认 `.model-card[data-uid]`，否则本地包卡（用
  `data-package` 当主键）会被记成 undefined 互相覆盖、旧卡残留在网格里。

## 3.8.8（局域网登录页去掉底部说明）

- 登录页表单下面那两行「名字会显示在主机上的访问记录里…操作与文件保存在主机上」删掉，
  只留标题、一句说明和两个输入框，页面更干净。

## 3.8.7（素材包整包下载成 ZIP）

- 资产卡片右上角新增「下载」图标键：点一下把整个素材包下载成 ZIP（主机和局域网访客都有），
  访客拿到的是自己电脑上的一个压缩包，不需要主机再拷来拷去。
- 新增 `server/zip-stream.mjs`：现场打包、直接推给浏览器，**不落临时文件**。只做 store（不二次压缩，
  图片和 PSD 本来就已经压过），每文件读两遍算 CRC 后流式发送；支持中文/空格文件名（UTF-8 标记），
  单个文件读不了就跳过而不是发一个 CRC 错误的坏包，客户端取消就停止读盘。
- 新端点 `GET /api/local/package-zip?root&rel=`：只认扫描结果里真实存在的包根；ZIP 包直接发原文件
  （不再套一层）；超过 4GB 直接报错说明（ZIP64 未实现）。
- 卡片右上角「登记」与新的下载键并成一组，平时半透明、悬停卡片才明显。

## 3.8.6（所有缩略图统一走缓存）

- 新增 `server/thumb-cache.mjs`：缩略图不再「PSD 一套、其它格式拉原图」——
  PNG 走内置解码器（zlib + 反滤波，输出灰度/RGB/RGBA），PSD 走自己的合并图像解码器，
  其余光栅格式（jpg/webp/avif/gif/bmp/tif/tga/exr/hdr）交给 ffmpeg；
  SVG 这类做不了的原样透传，功能不断。
- 缓存统一落在系统临时目录，key 含「绝对路径 + 大小 + 修改时间 + 目标宽度 + 算法版本」，
  源文件一改就重新生成；**上限 512MB，超出按最久未用淘汰到 80%**（命中时会 touch）。
- 同一个 key 的并发请求只算一次（缩略图墙一次会发几十个请求），ffmpeg 并发限 2 路。
- 素材包缩略图条从「拉原图」改成 256px 缩略图，卡片封面 512px；大图仍给原文件
  （JPG 转 PNG 只会更大），只有 PSD 这类必须转码的才走 2048px 转码。

## 3.8.5（PSD 素材包也能看缩略图了）

- 新增 `server/psd-preview.mjs` + `GET /api/local/thumb?root&rel&w`：服务端解 PSD 的合并图像
  （RAW / RLE / ZIP 三种压缩，8·16 位，灰度 / RGB / CMYK），缩到指定尺寸后编成 PNG，
  按「路径 + 大小 + 修改时间 + 尺寸」缓存在系统临时目录里。
- 图片素材包的可预览格式加入 `.psd`：缩略图条取 256px、大图取 2048px，40 个 8MB 的 PSD
  不再需要搬几百 MB 原始文件；其它格式仍然直接读原文件。
- 卡片封面也接受 `.psd`（走同一个转码端点）；转码失败时大图区给出提示，不留一张破图。

## 3.8.4（一个资产一个 info.json：登记 + 稳定 uid）

- 新增 `server/asset-meta.mjs`：本地素材包可以「登记」——写一份 schema v1 的 `info.json`，
  记录 `uid / title / kind / source / package{entry,cover,fileCount,bytes,images} / importedAt`。
- `uid` 由「主文件相对路径 + 大小 + 前 1MB 内容」派生（前缀 `local-`，与平台 uid 区分），
  写一次就固定：之后改名、加贴图、移动目录都不换身份。
- 写盘只走三条规则：已有能解析的 `info.json` 整份不改写；`.tmp → 校验 → rename` 原子替换；
  只写扫描判定出来的包根目录。ZIP 包不给登记入口（内部写不进去）。
- AI 派生数据统一挂在同一个文件的 `ai` 子对象里，`patchAi()` 只补这一段，事实字段原样保留。
- 卡片右上角给未登记的包一个「登记」按钮；扫描本身仍然只读。
- 修：目录里有一个坏掉的 `info.json` 时，图片素材包会识别失败（元信息文件被当成内容文件
  一起参与「全是图片」的判定），现在判定会跳过它。

## 3.8.3（素材包预览：大图 + 右侧信息 + 底部缩略图条）

- 布局按 3D 预览的样子重排：上面左边是大图，右边是素材包信息（类别、图片数、包大小、
  当前图片名与大小、磁盘路径），弹窗底部一条通栏缩略图，横向滚动，当前项高亮。
- 大图滚轮以光标为中心缩放、按住拖动平移、双击或「适应」复位；`←` `→` 也能换图。
- 缩略图文件名默认隐藏，悬停才浮出。

## 3.8.2（素材包预览：去掉中间的只读提示，锁住背后滚动）

- 大图上方不再压「资产包预览 · 只读」那行字。
- 弹窗打开期间锁住背后的页面滚动，弹窗内滚到边不会再带跑整页。

## 3.8.1（没有 info.json 的素材文件夹也是一张卡）

- 目录里没有 `info.json`，只要「里面除了图片什么都没有（≥2 张）」，就算一个图片素材包：
  以前一包 70 张 alpha 会变成 70 张没有缩略图的行卡，现在是 1 张卡 + 封面。
- 目录里只有一两个模型文件、旁边跟着贴图子目录时，整包算一个模型资产；同一层摊着十几个模型的
  「模型合集」仍然逐个文件出卡。
- `PNG/` + `SVG/` 这类格式子目录会合成一个包，不再同名出两张卡。
- 打开图片素材包是缩略图墙（最多 120 张，懒加载），点一张进大图，大图上可返回素材包。
- 包内清单按自然序排列（`Ornament2` 在 `Ornament10` 之前），不再依赖 readdir 的返回顺序。

## 3.8.0（按资产包扫描本地文件）

资产库的本地扫描原本是逐文件列卡片的：一个下载资产里的 30 张贴图 + 1 个 fbx 会变成 31 张卡，和下载任务卡完全重复；而「清理记录」后连任务记录都没了，整个下载目录会炸成几百张卡。

现在以「资产包」为单位扫描（`server/local-assets.mjs`）：

- 目录里有 `info.json` 就是一个资产，整棵子树归它，不再逐文件出卡；`.unpacked` 解包缓存不进统计也不进清单。
- 只有 ZIP 的交付（没有同名目录）也识别：只读中央目录判断包根有没有 `info.json`，不解压；包内文件清单随卡片一起返回。
- 按 `info.json` 的 `kind` / `assetType` 分成模型、材质、天空盒、图片素材四类，与类型筛选对应；没有 `title` 的包（FreeStylized）用 `assetId` 兜底并剥掉 `-pack-<hash>` 这批落盘后缀。
- 封面优先用 `info.json` 里的官方 `thumbnail`（走现有 `/api/image` 代理，CSP 只允许 self），其次用包内图片（图片包首图、材质包 Color/albedo 贴图）。
- 同一 uid 在磁盘上出现多份（含早期编码错误写出的重复目录）只出一张卡，卡片上标「磁盘上 N 份」。
- 已有下载任务或已在库里的资产不再从磁盘重复出卡；不属于任何包的文件才继续按零散素材展示。
- 目录里 `info.json` 自身不算包内文件，不进清单、不计入文件数。

## 3.7.1（局域网访客要留名字）

局域网登录从「只认密码」变成「名字 + 密码」。名字不参与鉴权，是给主机看的标签：多人共用一个共享密码时，主机终于能分清「谁在用」。

- 登录页（`server/lan-sharing.mjs`）加「你的名字」输入框，放在密码之前并聚焦；密码错时把已填的名字回填，不用重打。
- 名字白名单校验 `^[\p{L}\p{N}_.\- ]{1,24}$`（中英文、数字、空格、下划线、点、连字符），不合法直接回登录页且不回填——顺带让回填进 `value` 属性天然安全，不会成为反射型 XSS 的入口。
- 设备记录（`sharing.json.clients.json`）每台设备多存 `usernames`：同一 IP 换名字登录会追加，最近保留 6 个。旧记录没有该字段也能读，按空列表处理。
- `/api/lan/clients` 每项多返回 `usernames` 与 `onlineUsers`（当前活跃会话的名字），设置面板的「访问设备」一行显示 `IP · 名字 a、b（在线：b）· 状态 · 时间`。
- 登录失败计数仍只算密码错误：名字缺失/格式错的请求在校验密码之前就退回，不消耗 5 次额度。
- 测试补三项：缺名字被拒、名字带标签脚本被拒、同一 IP 追加第二个名字且未登录设备显示空名字。
- 服务端能力契约版本推到 3.7.1，旧进程会被启动器换掉，否则前端拿到的仍是只认密码的登录页。

## 3.7.0（补齐预览格式）

上一版把资产库扩成了「什么素材都能认领」，但认领进来的文件有三种打不开：TIFF 与 PSD 只会说一句「浏览器解不了」，mov/avi/wmv/mkv 只能建议你自己转 MP4。这一版把这三种补上——六类素材（模型 / 环境贴图 / 图片 / 字体 / 音频 / 视频）里，**不再有认领了却打不开的格式**。

- **TIFF**（`src/library/tiff-decode.js`）：自己解。浏览器至今不认 `image/tiff`，three 也没有 TIFFLoader。覆盖未压缩 / LZW / PackBits / Deflate 四种压缩，8 位与 16 位两种深度，灰阶（含 WhiteIsZero 反相）/ RGB / 调色板 / CMYK 四种色彩，chunky 与 planar 两种排布，外加水平差分预测；多页 TIFF 显示第一页并在提示里注明总页数；超过 8000 万像素直接拒绝，避免标签页被一张图拖死。
- **PSD**（`src/library/psd-decode.js`）：读「合并图像」，也就是 Photoshop 里看起来的那一张。RAW 与 RLE 两种压缩、8 位与 16 位深度、RGB / 灰度 / 索引色 / CMYK、带 alpha 通道，PSB（大文档）的 8 字节偏移也认。图层、智能对象不解——为预览解图层不值得，提示里会说清「只显示拼合结果」。
- **视频容器**（`server/video-transcode.mjs` + `GET /api/local/play`）：mov/avi/wmv/mkv 交给 ffmpeg 边转边发 fMP4。判断依据是 ffprobe 而不是扩展名：**能拷流就拷流**（换容器不换编码，近乎瞬时），只有编码本身浏览器不认（hevc / prores / wmv3 / mpeg2）才真正重编码。容器是 mp4 但装 hevc 时前端会先失败一次，然后往转封装退。
- 找不到 ffmpeg 时回 501 并给明确文案，不空屏；ffmpeg 所在的查找顺序是 `SFX_FFMPEG` 环境变量 → `vendor/ffmpeg/bin/` → PATH。
- 转封装响应没有 `Content-Length`（fMP4 边生成边发），所以进度条只能在已缓冲范围内拖。这是为了「不落临时文件、不等收尾」付的代价，预览场景值得。
- 服务端能力契约加 `mediaTranscode` 位、版本推到 3.7.0：旧进程没有 `/api/local/play`，靠这一位让它被换掉，否则视频会一直失败在「放不了」上。
- 测试 `test/library-media-decode.test.js`（12 项）：自造 TIFF/PSD 覆盖未压缩、PackBits、LZW、16 位、反相、RAW、RLE、灰度带 alpha，以及转封装决策（拷流 / 重编码 / 无音轨 / 无视频流）、ffmpeg 参数收敛、路由接线。LZW 那项特意造了超过 1600 字节的样本，专门守着 9→10 位那一次切换——写错一个码就会从第 512 个条目开始整段错位。
- 解码器验证用的是 PIL 生成的真实文件（LZW / PackBits / Deflate / 16 位灰阶 / 调色板 / CMYK / 带预测器的 LZW），逐像素比对全对；services 层端到端 12 项（扫描认领、MIME、Range、探测、mkv 拷流、avi 重编码、未索引根 403）全过。

已知边界：JPEG-in-TIFF 与 CCITT 传真压缩（扫描件）不做，遇到明确报错而不是画错色；PSD 的 Lab 色彩模式与 32 位图不支持；音轨是 pcm 时即便视频能拷也会走重编码（单声道容器的硬拷贝会被浏览器判为无声）。

## 3.6.9（资产库自动认领本地素材）

资产库现在会扫自己的目录：把模型、贴图、材质、HDRI、图片、字体、音频、视频拷进资产库文件夹（默认 `downloads/`，以及各任务自己的下载根），它们会直接出现在资产库网格里，和下载来的资产排在一起，点开就能预览。**没有第二个「本地库」，也没有「选一个文件夹」这一步**——根由资产库自己决定，不必先声明来源。

之所以要补这一条：资产库的卡片来自下载任务记录（`downloads.mjs` 的 `jobs`），目录恢复也只认带 `info.json` 或能过 `verifyArchive` 的本工具产物（`download-recovery.mjs`）。自己拷进去的素材没有任何记录，原本永远看不见。

- 后端 `POST /api/library/scan`：扫 `downloads.defaultFolder` 与各任务的 `downloadRoot`，跳过 `node_modules` / `.git` / `$RECYCLE.BIN` 与隐藏文件，最大深度 8 层、单根 2000 个文件封顶；只收素材类（模型 / 环境贴图 / 图片 / 字体 / 音频 / 视频），readme、日志、脚本这类文档不进列表；已被下载任务占用的路径不重复入列；结果按修改时间倒序。
- 取文件仍走 `GET /api/local/file`：只认扫描时登记过的根，`..` 与 `resolve` 前缀双校验挡穿越，支持 `bytes=a-b` / `bytes=a-` / `bytes=-n` 三种 Range，越界回 416，正常分段回 206。索引根白名单是必要的——`<img>`/`<video>` 带不了自定义请求头。
- 前端：本地文件作为额外卡片接在资产库网格后面（`paintGrid` 的 extras，参与网格签名），不是另起一个网格；搜索框与类型筛选对两种条目同时生效；模型 / 全景走 3D 舞台（与资源包预览共用同一张格式表），图片、TGA、字体、音频、视频走通用预览弹窗，字体用 `FontFace` 渲染字形样例。
- 工具条上有「扫描本地文件」按钮与计数，启动时静默扫一次。
- 服务端能力契约加 `localFolderIndex` 位、版本推到 3.6.9：正在跑的旧进程没有 `/api/library/scan`，靠这一位让它下次启动时被自动换掉。
- 守卫测试 `test/library-local-browse.test.js` 守住跳过规则、截断、越界、Range、MIME，以及「不许再拆出独立导航页、也不许让用户选文件夹」。

## 3.6.5（预览格式）

参考 Serpent 的格式注册表，资源包预览不再只认 glTF/FBX：

- 模型新增 **OBJ / STL / PLY / 3MF** 本地渲染（`vendor/three/loaders/` 按 r160 补齐 loader，3MF 复用已有的 `libs/fflate`）。STL/PLY 只有几何，包一层中性标准材质；OBJ 的 Phong 材质升成 Standard，光照才和场景里其它资产一致。没有 UV 的格式不再硬套包内贴图。
- 环境全景新增 **EXR**：资源包天空盒与 Poly Haven HDRI 两条路都走 `EXRLoader`（支持 PIZ/ZIP/RLE/DWA），不再抛「暂不支持在线预览」。
- 后端配合：`PREVIEW_MIMES` 补 obj/mtl/stl/ply/3mf/fbx，FreeStylized 的包内挑选从「glTF > FBX」扩到「glTF > FBX > OBJ/STL/PLY/3MF」，`kind` 统一报 `model`。
- 守卫测试 `test/library-pack-formats.test.js` 守住分派表与 vendor 文件；实测 OBJ/STL/PLY 解析与 2048×1024 PIZ EXR 解出 half-float 数据。

## 3.6.4（修复）

ambientCG 天空盒送进 Blender 后世界环境整片爆粉（洋红）。根因是整包 ZIP 里的 HDRI 解到了系统临时目录，桥接一回话就 `rmSync` 删掉，而 Blender 的 Image 数据块只记路径、像素懒加载，源文件一没就退化成「缺失贴图」洋红。现在解包目录固定在压缩包旁边（`<包名>.unpacked/`，重复导入复用），环境图与材质贴图都不再清理；顺带修掉同一目录里 TONEMAPPED 的 LDR 全景图被当成 HDRI 的选文件顺序（`.hdr/.exr` 优先）。桥接侧加载后强制重读一次，读不出像素直接报错，不再把一个坏的世界环境留给用户。（`server/blender-import.mjs`、`server/blender-bridge.py`）

## 3.6.3（界面）

侧栏分类清单不再一次铺满：ArtStation 官方 59 个分类按用途归到 6 组（角色与生物 / 场景与环境 / 道具与工业 / 题材与风格 / 插画与平面 / 游戏影视与技术），组默认折着、只自动展开当前选中组，新增分类落进「其他」组。
Poly Haven / ambientCG / FreeStylized / Kenney 的分类词表既长又互不相通，统一折成「前 12 个常驻 + 更多分类」。两种折叠都只看显示文案，请求参数未改（两张表在 `src/library/filter-groups.js`）。

## 3.6.2（修复）

Poly Haven 资产下载高清图（图片任务）之前回「Poly Haven 资产 ID 缺失」/「ArtStation 流程只允许访问 artstation.com」。根因是图片链路三处都没把真实 `assetId` 透传到底，且 `IMAGE_CLIENTS` 白名单缺 polyhaven。现已补上，`cdn.polyhaven.com` 放行，图片任务（多视角 `images/` + `info.json`）已验证落盘。

## 3.6.1（修复）

后台服务是旧版本时，新增平台会搜不出东西。根因是启动器仅看手写布尔清单判定是否重启，漏改就会把旧进程判成最新。现服务端/启动器共用能力契约（`server/capabilities.mjs`），`/api/downloads/capabilities` 原样返回，加接口即加能力位，版本或能力位不匹配下次启动自动换进程。

## 3.6.0（新增）

批量下载资产的高清图片。勾选卡片后多选栏「下载高清图」把每个资产变成 `images` 任务；卡片图片图标与预览弹窗按钮为单张入口。每张导出成 `<名称>-images` 文件夹（或 ZIP），内含 `images/` + `info.json`。尺寸取平台最大档：Sketchfab 取公开封面最宽档（1920px），ArtStation 取作者上传每张的 `large` 档。平台差异收在 `server/image-sources.mjs`，落盘在 `server/image-store.mjs`。图片任务不转 FBX、不进 Blender。

## 3.5.0（界面）

Blender 按钮只属于已下载到本地的资产。由「本地有没有文件」决定（`src/library/blender-send.js` 的 `findLocalJob`），未下载不显示；点击走 `POST /api/downloads/tasks/:id/send-blender`，只把磁盘文件交给已打开的 Blender，不进队列、不重下。服务端会再查文件是否存在，被删明确报错。

## 3.4.1（界面 + 修复）

- 下拉菜单改为自绘：原生 `<select>` 弹出层由系统绘制、深色界面会弹浅色菜单；现 `select` 退居数据源，露脸的是按钮 + listbox（`src/library/picker.js`），键盘/打字定位/点击外部关闭按原生习惯实现，选项可带说明小字。挂到 `body` 定位避免被 `overflow:hidden` 裁剪。
- 修复「解析链接」按钮与面板曾被遗留 `display:none!important` 规则藏住。
- 修复下拉长菜单滚动条主题色（系统滚动条在深色面板里横插灰杠）。
- 修复下载 E2E 静默瘫痪：授权弹窗已移除但脚本仍在点它，断言只跑 5/51 条且误报通过。已重写为「点卡片直接入队 / 重复靠参数比对 / 目录改由 API 建任务」，真跑 51/51；断言改为渲染后真实尺寸，删除两条死规则。

## 3.4.0（界面 + 品牌）

- 品牌由 Sketchvault 改为 **AssetVault**；旧数据目录 `.sketchvault` 首次启动自动迁移为 `.assetvault`。
- 工作台界面：搜索资产 / 解析网页 / ArtStation Marmoset 三个页签合成一个搜索界面。平台选择器决定「谁来回答」，关键词框、链接框、结果网格、收藏与下载流程统一为一套。「全部平台」并行检索两平台并交错合并（避免一长列表压住另一平台）。
- 「解析链接」栏默认收起（搜索为主路径），展开状态跨刷新记忆。
- 「本地模型库与下载管理」成为推荐入口：双击 `AssetVault.lnk` / `Start-Library-Silent.vbs` 后台运行，浏览器先开启动画面（`/splash.html`）再进工作台。

## 3.2.3（界面）

下载卡片默认精简：正面只留模型名、导出徽标、状态、体积/耗时与进度条；六阶段、传输明细、保存路径与 SHA-256 折进每卡「详情」。已完成卡片不再重复「已保存」，仅真重试过才显示「尝试 N 次」，排队任务不画空进度条。折叠状态在列表重建后保持。

## 3.2.2（修复）

FBX 里所有材质贴图变成同一张（衣服用到身体的贴图）。Blender glTF 导入器给内嵌贴图留空 filepath，FBX 导出器 basename 取空导致所有贴图塌陷成同一 `.fbm`，且去重让仅第一张被嵌入（实测 15 个贴图节点仅 1 个有内容）。现导出前给每张图分配唯一合法文件名（无额外磁盘写入），修复后 15/15 全部嵌入且路径互不相同。FBX 自带贴图，体积≈所用贴图之和。

## 3.2.1（修复）

ArtStation（Marmoset）任务必然瞬间失败：`process.argv.includes('--worker')` 判断串扰，ArtStation worker 经 `artstation.mjs` 连带 `export-worker.mjs` 抢走 IPC 消息。现改为按「模块是否就是被启动入口」判断（`server/worker-entry.mjs`），杜绝串扰并回传堆栈；同时补上 ArtStation 侧缺失的文件夹交付（此前 `EISDIR`）。

## 3.2.0（新增）

导出设置新增四项独立选择：
- **下载内容**：仅模型与贴图（默认）/ 仅 GLB / 完整包。
- **输出方式**：ZIP 压缩包（默认）或 不压缩直接输出文件夹（可直接拖进 Unity，同名加序号）。
- **模型格式**：GLB（默认）或 FBX（本机 Blender 无头转换；无 Blender 时明确报错）。
- **贴图尺寸**：默认保留原始像素；压缩到 2K/4K 须手动选，不做静默降采样。

## 3.1.1（修复）

多个材质共用同一贴图基名时，烘焙贴图按内容唯一命名（`-2`/`-3` 后缀）；ZIP 校验遇到重名、加密或不受支持条目会明确指出条目名。

## 其他说明

- 仅处理已授权模型；不执行外部网页脚本，不保证发现动态/登录内容中的全部模型。
- 独立工作台不进行扩展式 viewer-blit 捕获，出现贴图警告请检查输出外观。
- 后台下载管理详解见 `docs/mcp-download-manager.md`；关键词搜索与模型库历史见 `docs/mcp-model-library-v2.md`；ArtStation Marmoset 接口/过滤/安全边界见 `docs/artstation-marmoset-search.md`。
