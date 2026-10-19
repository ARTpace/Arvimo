# AssetVault 3.4.1 — 后台下载管理、进度与路径

更新日期：2026-09-21。此版本把独立网页工作台的下载移到本机服务，保留原搜索、模型库、收藏、3D 预览和导出引擎。不是桌面安装包，也不是下载任何网站的通用下载器。

## 启动与使用

1. Windows 双击 `H:\AI-Tools\sketchfab-exporter\Start-Library.cmd`（或带图标的 `AssetVault.lnk`）。需要 Node.js 22+、已安装项目依赖，以及 Chrome 或 Edge。
2. 浏览器先显示**启动画面**（`/splash.html`，带 logo 动效和进度条），随后自动进入 **http://127.0.0.1:4178**。升级后请刷新已打开的旧页面。
3. 在「下载管理」顶部点击 **更改路径**，输入本机绝对目录（如 `H:\Models\Sketchfab`）并保存。目录不存在会创建，不可写时明确报错；只影响新任务。「其他设置」保留并发、重试及导出参数。导出内容默认 **仅模型与贴图**、输出 **ZIP**、格式 **GLB**、贴图 **保留原尺寸**。
4. 从资产卡片下载，或多选模型后点「下载选中」。确认弹窗的 **本批次保存到** 可单独指定这次下载目录，不改变默认路径。确认拥有下载与使用授权后才加入后台队列。
5. 左侧「下载管理」查看排队、转换、写入、校验、完成、失败或取消。完成后显示真实路径、大小、SHA-256 摘要，可打开所在文件夹；ZIP 导出另提供「另存副本」。

**可以关闭或刷新工作台网页；不能关闭本地服务窗口，也不能让电脑关机/休眠。** 本版本没有注册 Windows 系统服务或开机启动。后台转换使用独立的无界面浏览器资料目录，不借用你的个人浏览器登录信息。

默认保存目录：`H:\AI-Tools\sketchfab-exporter\downloads`。任务与后台设置：项目 `.assetvault\tasks.json`，另有 `.bak` 备份和进程锁。不要在服务运行时手改这些文件。收藏、模型库及导出参数仍保存在当前浏览器的本地存储；更换端口或浏览器会改变这部分存储空间。

## 下载工具行为

| 操作 | 实际行为 |
| --- | --- |
| 暂停队列 | 停止启动新任务；已在转换的任务继续。不是暂停 WASM 计算。 |
| 暂停/继续排队 | 只作用于尚未开始的任务；可批量操作。 |
| 取消 | 等待任务直接取消；正在运行的任务关闭其独立转换进程。提交最终文件的瞬间不接受取消，避免半成品被当成成品。 |
| 重试/重新下载 | 从头执行，沿用该任务原目录和导出参数；不是 HTTP 断点续传。 |
| 自动重试 | 只处理部分超时、连接失败、429/502/503/504 等临时错误，等待 5 秒或 10 秒；不无限重试。 |
| 重复提醒 | 相同模型、导出参数及目标目录若在排队/运行中则不重复添加；已有成功文件时默认跳过，可在确认弹窗勾选另下一份。 |
| 同名文件/文件夹 | 自动追加编号（`name (1)`），不覆盖已有 ZIP 或导出文件夹。 |
| 移除/清除记录 | 只删除任务记录，不删除磁盘文件。批量操作对不适用的任务给出提示。 |
| 服务重启 | 已完成记录保留；等待任务遵守持久化暂停设置；上次运行中的任务标为「服务中断」，需手动重试。 |
| 文件移动/删除 | 刷新后提示缺失，不继续展示有效文件下载按钮。不会自动寻找文件的新位置。 |
| 旧版任务 | 单独显示为「本地文件位置未核实」，不自动重跑、不冒充已验证后台文件。 |

目录和导出设置影响**新加入**的任务；不篡改已排队任务的设置快照。每批最多 50 个模型，最多保留 500 条任务记录，每个任务保留最近 160 条日志，可导出日志。无变更时通过条件请求避免重复传送整份任务日志。

## 进度与文件校验

- 转换阶段显示引擎的实际步骤和日志，不制造整体下载百分比或预计剩余时间。
- 进度区域分两层：卡片正面是「当前阶段 + 百分比 + 进度条」与进行中的实时字节；六个阶段清单（准备、接收资源、转换/打包、写入、校验、完成）、批次明细与解释性提示都收在每张卡片自己的「详情」里。任务结束后进度条不再占据正面，100% 与最终阶段仍可在「详情」中查到。资源按需加载，接收与转换可能交替。
- 接收阶段统计代理实际收到的响应体数据量、最近约 2 秒的接收速度、完成/已发起资源请求数。若服务器返回压缩响应，则统计解码后的数据量，不是网卡线速。
- 仅当当前全部传输请求都有可靠 Content-Length 时，显示**当前传输批次**百分比；不是整个模型总进度。长度未知、转换和校验阶段显示不定进度条，不伪造整体百分比/剩余时间。
- ZIP 本机写入阶段单独显示写入字节与百分比，明确标注速度非网络速度；只有文件校验并保存完成才显示任务完成 100%。
- ZIP 导出：校验 ZIP 目录、条目长度与 CRC、不安全路径/重叠、GLB 基本结构及网格、模型来源 UID，然后计算 SHA-256，再提交文件。
- 文件夹导出：没有 ZIP 中央目录可校验，改为对目录树做同等的把关——`info.json` 来源必须与任务 UID 一致、至少一个真实 glTF 2.0 网格、目录内不允许符号链接或设备文件，SHA-256 覆盖「相对路径 + 内容」，因此增删改名改内容都会改变指纹。
- SHA-256 是**初次保存时**的结果；不会持续重新计算后来被其他软件修改的文件。此校验不是完整 glTF 规范验证器，也不保证材质视觉一致。
- 当前限制：单个 ZIP、导出目录总量和解压条目总大小各不超过 2GB，GLB JSON 检查缓冲区 32MB，单次任务 30 分钟。大模型仍可能受浏览器/WASM 内存限制而失败。
- 独立工作台不执行扩展式 viewer-blit 捕获。出现 `MISSING_BLIT.txt` 或黄色材质提示时，请检查模型外观；不能把结构校验通过当作贴图完全复原。

## 3.4.0 界面：三个页签合成为一个搜索界面（3.4.1 起下拉自绘）

**问题**：「搜索资产 / 解析网页 / ArtStation Marmoset」是三个页签，各带一套输入框与按钮。
用户得先决定“我要用哪种方式找”，而这三者其实是同一个意图——找到资产。同一个关键词要重复输入，
同一批结果散在三个互不相干的视图里。

**改法**：页签消失，只留一个搜索区 + 一个链接区。

| 元素 | 行为 |
| --- | --- |
| 平台选择器（搜索框左侧） | `全部平台` / `Sketchfab` / `ArtStation Marmoset`；决定由哪几个结果流共同回答 |
| 内容模式按键（左侧栏顶部） | `模型模式` = 全部平台的模型（S 站模型 + A 站 Marmoset 可转 3D，不混纯图片）；`图片模式` = ArtStation + 瀑布流；再点一次当前模式回到全部平台（`src/library/content-modes.js`） |
| 关键词框 | 只有一个，所有平台共用；推荐词与占位文案随平台切换 |
| 筛选 | 不带外框直接长在侧栏底色上（宽屏）/ 搜索卡片（窄屏，那边保留盒子样式）。模型模式下一棵统一树（19 个统一分类带 A 站映射、排序/范围两边联动，`#filters-merged` / `src/library/merged-filters.js`）；其余按平台显隐两棵树（`#filters-sketchfab` / `#filters-artstation`，各管各平台）。ArtStation 分面显示中文、请求值不变 |
| 链接框 | 只有一个，按域名自动判定：ArtStation 作品页 → 识别 Marmoset 场景；Sketchfab 与普通网页 → 检索其中的模型链接 |
| 结果网格 | 只有一个；搜索时是当前平台各流交错合并的结果，链接解析时独占并附「返回搜索结果」 |

**筛选住哪**：`app.js` 的 `placeFilters()` 把 `#filters-sketchfab` / `#filters-artstation` / `#filters-all` 三个节点搬进
`#filter-rows`（左侧栏，宽屏）或 `#panel-filters`（搜索卡片，≤780px 侧栏收成图标条时）。搬的是同一批节点，
事件与当前选中值都跟着走，不复制第二份 DOM；顺手调 `filterTrees.setNarrow()`，窄屏把整棵树折起来只留分支标题。

**筛选画成树**：`src/library/filter-tree.js` 把每个字段渲染成一根可折叠的分支：分类下面按主题分五组，
组里才是分类项（19 个分类一组不漏，没被分组表收进去的会兜进「其他」，官方以后加新分类也不会从树上消失）；
排序、范围与 ArtStation 的艺术家各是一根分支，折着的时候把当前值写在标题右边。折叠用 `grid-template-rows: 0fr → 1fr`，
不靠 JS 量高度；缩进用一条虚线导轨指路。

原生控件（`#online-category` / `#online-sort` / `#art-*`）一个不动地留在 DOM 里当值容器，只是被搬进 hidden 的
`.ftree-src`（因此也跳过了自绘下拉：树里的控件自己有显示层）。于是读值、`重置筛选`、历史回放那些代码一行都没改。
三个同步点与自绘下拉同一套思路：选项被 `innerHTML` 整体重写 → `MutationObserver`；代码直接写 `value` / `checked`
（不派发事件）→ 拦下实例上的访问器；点树的叶子 → 写回 `value` + 派发 `change`，走原来那条 `onchange` 通道。
「自动展开选中项所在的分组」只在选中值真的变了时才做，用户手动折上的分组不会被下一次同步弹开。

**筛选里的中文**：ArtStation 官方分面（59 个分类、6 种资产类型）名字全是英文，`src/library/filter-labels.js`
做显示层的中英对照；值一个不改（分类是数字 id、类型是 `marmoset` 这样的串），查不到就回落英文原文——
官方新增分类时界面只会多一行英文，不会空格也不会变 undefined。Sketchfab 的分类本来就是中文，不过这张表。

**识别链接只弹一条提示**：粘贴 ArtStation 作品链接后，作品名作为 `note` 并进入队结果那条 toast
（`已识别 ArtStation 作品《xx》，已加入 N 个 ArtStation 转换任务`）。toast 只有一个槽位，结果消息总会顶掉先弹的提示，
所以上下文必须并进最终那条，不能自己弹一条再被冲走。

**最近检索**：不再常驻左侧栏。点搜索框（`#asset-query`）弹出 `#history-pop` 浮层，由 `src/library/search-history.js` 负责
渲染、定位与键盘选中；浮层挂在 `body` 上（`position:fixed`），因为搜索卡片是 `overflow:hidden`，留在里面会被裁掉。

**多源合并**：`src/library/discovery-view.js` 的 `combine()` 把若干结果流投影成一个只读视图，
`interleave()` 让两个平台**交错**出现——直接拼接会让第一个平台的长列表把另一个整个压到看不见。
聚合规则：`busy` = 任一源在跑，`error` = 所有源都失败，`pages` = 取最大，`pending` / `warnings` = 合并去重，
`controller.abort()` = 逐个停。单源时原样透传，保留 `request` / `next`，分页语义不变。

**为什么全平台不摆筛选**：Sketchfab 的分类是 slugs（`characters-creatures`），ArtStation 的是数字 id（`21`），
排序键也不同。给一个混合筛选会做出“看起来生效、其实只作用于一边”的假功能，所以全平台只说明、不摆放。

**链接判定**：`src/library/platforms.js` 的 `LINK_ROUTES` + `routeLink()`。域名比较是「等于或 `.` 前缀」，
所以 `artstation.com.evil.example` 不会被误判成 ArtStation（有回归断言守着）。
不匹配任何规则时落到通用网页解析——新增站点只有在它需要*不同*处理时，才需要写一条规则。

**回归覆盖**：`test/library-discovery-view.test.js`（交错、合并、状态行与文案）、
`test/library-platforms.test.js`（注册表合法性、链接判定与伪装域名）；
浏览器 E2E 新增：全平台搜索确实向两个平台各发一次同关键词请求、两平台结果同网格且计数正确、
全平台隐藏平台筛选行、切回单平台后网格与筛选行同步收敛、普通网页链接走解析通道并占用结果区、可交还。

## 3.6.2 修复：Poly Haven 资产下载高清图报「资产 ID 缺失」/ 被 ArtStation 白名单拒

**现象**：Poly Haven 搜索能出结果、点卡片上的「下载高清图」却报错——要么 `Poly Haven 资产 ID 缺失`，要么 `ArtStation 流程只允许访问 artstation.com HTTPS 域名`。

**根因**：图片下载链路（模型 → `images` 任务）三处都没把 Poly Haven 的真实资产 ID 透传到底：
1. `server/downloads.mjs` 的 `run()` 调 `imageRunner({uid,platform,url})` 时漏传 `assetId`，而 Poly Haven 图片源只认 `assetId`（模型 uid 是 md5，拼不出 Poly Haven URL）；
2. `server/image-bundle.mjs` 的 `runImageJob` 调 `collectImageAssets(platform,{uid,url})` 时也没透传 `assetId`；
3. `server/image-store.mjs` 的 `IMAGE_CLIENTS` 只有 `sketchfab`/`artstation` 两个客户端，`downloadImage` 对未知客户端 fallback 成 `artstation` 白名单，于是 `cdn.polyhaven.com` 被 artstation.com 白名单拒绝。

**修法**：① `downloads.mjs` 的 `imageRunner` 调用补 `assetId:j.assetId`；② `image-bundle.mjs` 的 `collectImageAssets` 调用补 `assetId`；③ `image-sources.mjs` 的 `collectImageAssets` 把 `assetId` 透传给各源 resolve；④ `image-store.mjs` 的 `IMAGE_CLIENTS` 加 `polyhaven:{}`（公开 CDN，无域名限制）。防回归断言见 `test/library-image-store.test.js`（polyhaven 客户端登记在册且不下发 artstation 白名单）。

## 3.6.1 修复：后台服务是旧进程时，新平台会「搜不出来」

**现象**：界面里已经能选「Poly Haven」，提交搜索却在状态行看到一句「不存在的页面或接口」。

**根因**：服务是常驻进程，改了代码它不会自己重启。启动器 `scripts/start-library-background.mjs` 每次会先问
`/api/downloads/capabilities`，凭回答决定「复用还是重启」——但那份回答和启动器的期望**分别写在两个文件里**，
判断用的是 `pickFolder && fixedExportDefaults && …` 这样一条手写的布尔长链。加了 Poly Haven 检索接口、
却没人同步这串布尔值时，旧进程（接口还没出生）的每一项都仍然为 true，于是被判定成「已是最新」，
**永远不会被换掉**。前端是新的、进程是旧的，就出现了「界面认识这个平台、服务端不认识这条路由」。

**改法：把这份判断收成一个契约单点。**
- 新增 `server/capabilities.mjs`：`SERVER_VERSION`、`SERVER_CAPABILITIES`（能力位全在这里）、
  `serverIsCurrent(cap)`（版本相符 **且** 每个能力位都为 true 才算够新）。
- `server/library.mjs` 的 `/api/downloads/capabilities` **原样返回**这份契约，不再手写一份；
  `/api/health` 的版本号也取自 `SERVER_VERSION`，全项目只留一个版本字符串。
- 启动器 `import {serverIsCurrent}` 用它判定，两处硬编码的布尔长链删掉。

于是**加一个前端要用的新接口 = 在契约里加一个能力位**，服务端与启动器自动同步；
只升版本、或只加能力位，任一种不一致都会在下次启动时触发重启。旧进程的
`version` 是上一代的 `2026-09-blender-install-progress`，与版本号对不上，因此也会被换掉。

**顺带修掉的体验问题**：本地服务端的 404 只有一种含义——进程比前端旧。此前前端把服务端原文
「不存在的页面或接口」直接显示给用户，既漏了内部实现、又没给出路。现在
`src/library/discovery-view.js` 的 `feedErrorMessage()` 会把它换成一句能照做的事
（说明是哪个来源没有接口、要重新打开 AssetVault）。该函数经 `ctx.feedError` 注入
`discovery-feed.js`——与 `describeArt` 同一套注入方式，子模块之间不互相 import。

**回归覆盖**：`test/library-capabilities.test.js`（7 条）——契约自洽、旧进程必须被判为旧、
读不到回答时不能乐观当成功、端点必须原样吐契约，以及两条**面向未来**的断言：
「每个前端能请求的结果流在服务端都有路由」与「启动器必须用契约判定、不能又手写一份清单」。

## 3.6.0 能力：批量下载资产的高清图片

**需求**：工具里能看到的图片资产（Sketchfab 封面、ArtStation 作品图）要能批量下载，而且要原站能拿到的最大尺寸，
不是界面上那张 720px 缩略图。

**改法**：新增一种任务类型 `images`，与模型导出共用同一条队列（持久化、去重、重试、取消、校验全复用），
只是分派到新的 picture runner：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 来源注册表 | `server/image-sources.mjs` | 每个平台回答「有哪些图、最大能取哪一档」，新增平台只改这里 |
| 落盘 | `server/image-store.mjs` | 流式写盘 + 大小上限 + **按字节嗅探命名**（与 ArtStation 图片作品管线共用） |
| 打包 | `server/image-bundle.mjs` | 下载计划里的每张图 → `images/` + `info.json` → 文件夹或 ZIP |
| 队列 | `server/downloads.mjs` | `JOB_KINDS` 加 `images`；`imageOptions` 与模型 options 完全不重叠（去重键因此天然区分「这个资产的图片」和「这个资产的模型」） |
| 界面 | `src/library/image-download.js` | 卡片按钮 / 预览弹窗按钮 / 多选栏批量入口共用同一套判定 |

两个平台的最大档不一样，这是事实而不是偏好：

- **Sketchfab**：公开 API 只发布**同一张封面**的多个尺寸（实测 64/256/720/1024/1920），所以只有最宽的一档有意义，
  其余都是重复文件 → 取 `width` 最大的那张（1920×1080）。
- **ArtStation**：`assets[]` 里是作者上传的每一张，改指到 `large` 档；`original` 对非作者一律返回 403，
  所以 `large` 就是事实上的原图像素。

**不做什么**：图片任务不转 FBX、不送 Blender（`imageBundle` 标记覆盖两种来源），
被要求进 Blender 时会在任务里留一条说明而不是假装成功。

**回归**：`test/library-image-sources.test.js`（两平台的取图规则 + 未知来源拒绝）、
`test/library-image-bundle.test.js`（文件夹与 ZIP 都能通过**现有**校验器：声明的文件必须在、未声明的不能有）、
`test/library-image-jobs.test.js`（同一资产可同时有模型任务与图片任务、批次上限 50、平台留存）、
`test/library-image-download.test.js`（哪些资产有按钮、入队参数、无图/离线/重复的提示）。
反向验证：把「取最大档」改成取最小档，三条测试同时失败。

## 3.5.0 交互：Blender 按钮只属于已经下载到本地的资产

**问题**：每张卡片（连在线搜索结果也算）都挂着一个「Blender」按钮，但它的真实含义是
「**先下载，下载完再导入**」。于是：在线模型点一次要走完整条下载与转换流程，
已经躺在磁盘上的资产却没有任何「直接送进 Blender」的入口。

**改法**：按钮改由「本地有没有文件」决定（`src/library/blender-send.js`）：

| 判定 | 条件 |
| --- | --- |
| 可发送 | 存在 `state==='saved'` 且 `fileExists!==false` 的任务（同一个模型导出过多次时取最后一次） |
| 不显示 | 未下载、正在下载、已失败、文件被移走 |

点击走 `POST /api/downloads/tasks/:id/send-blender` → `DownloadManager.sendBlender(id)`：
**只把磁盘上那个文件交给已打开的 Blender**（AssetVault Bridge），不进队列、不重新下载。
服务端会**再查一次文件是否还在**，被删掉就抛「请先导出到本地」而不是假装发送成功；
桥接失败把真实原因写进任务的 `warning` 与日志，前端 toast 原样显示。

原来那条「下载完自动导入」的通道（`openInBlender`）只保留在后端，用于兼容历史任务记录；
前端不再有入口，避免同一个按钮有两种语义。

**回归**：`test/library-blender-button.test.js`（按钮渲染条件，纯函数）、
`test/library-blender-send.test.js`（后端校验 + HTTP 分支）、
浏览器 E2E 新增 4 条：未下载时网格里**一个** Blender 按钮都没有 → 注入一个真实存在的导出目录后按钮出现 →
点击后后端收到一次发送且没有产生新任务 → toast 报告成功。已做反向验证：
把按钮改成无条件显示，E2E 精确失败在「未下载时按钮应隐藏」这条。

## 3.4.1 界面：下拉菜单自绘，并修回被 CSS 藏起来的两块界面

**问题一（下拉样式）**：搜索框左侧的平台下拉用的是原生 `<select>`。它的**弹出层是操作系统画的**，
`background` / `color` / `border-radius` 一概无效——深色界面里点开就是一块浅色系统菜单，和旁边所有控件都不是一套。

**改法**：`select` 保留为**唯一数据源**，只在它旁边画一个同风格的按钮 + listbox（`src/library/picker.js`）：

| 同步点 | 机制 |
| --- | --- |
| 选项被整体重写（`innerHTML` / `appendChild`，如 ArtStation 分类接口回来时） | `MutationObserver` |
| 代码直接写 `select.value`（不触发事件，如 `writeSearch()`、`renderPlatform()`） | 在实例上重定义 `value` 访问器，写入后补一次刷新 |
| 用户点选 | 写回 `value` 并派发 `change`，走原来的 `onchange` 通道 |

因此所有业务代码（`readSearch` / `writeSearch` / `artstation-ui.js`）**一行都不用改**。
键盘按原生习惯实现：↑↓ 绕回、Home/End、PageUp/PageDown、Enter 选择、Esc 关闭并交还焦点、Tab 关闭、
打字定位（**按包含匹配**，因为选项文字是「中文 + 英文」混排，只认开头就打英文缩写定位不到）。
菜单**挂到 `body` 上**用 `position:fixed` 定位：搜索卡片与搜索框都是 `overflow:hidden`，留在原地会被裁掉；
下方放不下时自动翻到按钮上方。选项的第二行小字来自 `platforms.js` 的 `hint`（经 `data-hint` 传给菜单），
平台说明只维护一份。搜索区内的 5 个下拉（平台 / 分类 / 排序）统一生效，新增下拉只要写进 `#search-panel` 就自动升级。

**长列表的滚动**：分类有 19 项，菜单要比按钮高得多，所以自己算 `scrollTop` 把高亮项滚进视野，
不用 `scrollIntoView`——后者会顺带滚动祖先乃至整页。页面滚动时不是关掉菜单，而是重新 `place()` 贴回按钮下方；
菜单自身滚动（高亮项自动滚入）不触发重新定位。
诚实说明：无头浏览器在没有帧更新时不会派发滚动事件，所以「滚动即关闭」那种写法在 E2E 里无法被区分出来，
这条断言守的是「高亮项确实滚进视野、且整页 `scrollY` 仍为 0」。

**问题二（两块界面根本看不见）**：`app.css` 里留着两条 3.3.0 时代的死规则——
`.panel-extra{display:none!important}` 与 `.source-panel,.source-disclosure{display:none!important}`。
3.4.0 把「解析链接」面板加回来时没有删掉它们，于是**搜索区的「解析链接」按钮和整块面板都被 `!important` 藏死**。

**为什么测试没拦住**：当时的 E2E 断言写的是 `getComputedStyle(#source-panel).display==="none"`,
即「面板必须是隐藏的」——它把 bug 当成了需求，功能不可见而套件全绿。
现改为断言**渲染后的真实尺寸**（`getBoundingClientRect().height`、`offsetParent`），
并补上「按钮可点 → 面板展开 → 再点收起 → 标题条仍在」的完整链路。
反向验证：把两条规则任意一条加回去，断言立刻失败；把菜单从 `body` 挪回原地（重新被 `overflow:hidden` 裁切），断言同样失败。

**回归覆盖**：`test/library-picker-model.test.js`（选项快照、方向键绕回、打字定位、按键归类）、
`test/library-discovery-view.test.js` 新增 `describeRequest` 文案、浏览器 E2E 新增 8 条下拉与面板可见性断言。

## 3.2.3 界面：下载卡片默认精简，细节一键展开

**问题**：任务卡片一次把进度条、六个阶段、字节统计、保存路径、校验指纹和日志摘要全铺出来，一屏放不下几条任务；
已完成的卡片尤其吵——它把状态栏已经说明过的「已保存到本机…」又写了一遍，还为 100% 画了一条不会再动的进度条。

**现在的信息分层**：

| 位置 | 内容 |
| --- | --- |
| 卡片正面（始终可见） | 缩略图、模型名、导出徽标（如 `完整包 · GLB ZIP`）、状态、体积与耗时、失败原因、警告 |
| 卡片正面（仅进行中） | 当前阶段、百分比、进度条、实时字节（接收速度，或本机写入进度） |
| 「详情」折叠块 | 六个阶段清单（当前阶段高亮）、批次与请求明细、解释性提示、保存路径、SHA-256 校验摘要；完成后的 100% 进度条也在这里 |
| 「任务日志」折叠块 | 与之前一致：条数、作者、时间、导出日志、原始日志 |

同时收敛了几处重复：已完成的卡片不再重复那句校验结论；`尝试 N 次` 只在真的重试过之后出现；排队中的任务不再画一条空进度条；
阶段标签由「转换 / 打包中 · 总进度暂不可计算」这类长句缩短为阶段名，「为什么没有整体百分比」移入「详情」。
信息一条没少，只是各自差一次点击。

折叠状态在列表重建后保持（切换筛选、任务状态变化都不会把已展开的卡片合上），且「详情」与「任务日志」各自独立记忆。
回归覆盖：`test/library-download-card.test.js` 直接对卡片模板断言「正面不含阶段清单/路径/SHA-256，且这些仍在详情内」；
浏览器端 E2E 另加 4 条（进行中卡片正面无阶段与路径、完成卡片默认折叠、展开后能看到路径与校验、展开状态在列表重建后保持）。

## 3.2.2 修复：FBX 里所有材质的贴图都变成同一张（贴图媒体路径塌陷）

**现象**：格式选 **FBX** 下载后导入 Unity，多个部件的材质贴图**全都变成同一张**，衣服用的是身体的贴图。

**根因（Blender glTF 导入器留空 filepath → FBX 媒体路径全部塌陷）**：Blender 的 glTF 导入器对
GLB 内嵌贴图会置 `image.filepath = ""`（像素已 packed，不需要磁盘文件）。而 FBX 导出器
`export_fbx_bin.py` 的媒体路径是**从 `image.filepath` 的 basename 推出来的**：

```python
# _gen_vid_path() -> bpy_extras.io_utils.path_reference(..., path_mode='COPY', subdir='<模型名>.fbm', ...)
filepath_cpy = os.path.join(subdir_abs, os.path.basename(filepath_abs))   # basename 为空
```

basename 为空时 `filepath_cpy` 退化成**只剩目录**，于是 15 个 Video 节点的 `RelativeFilename`
和 `Filename` **全部是同一个 `Scifi_Girl_v_01.fbm`**。由此连带两个后果：

- 所有材质指向同一个媒体路径 → Unity 认为它们共用一张图；
- 导出器"每个文件只嵌入一次"的去重键正是这条路径（`fname_abs not in embedded_set`）→
  **只有第一张图被真正嵌入**，其余 14 张 `Content` 为空。实测旧 FBX：33.3MB、15 个 Video 里
  **仅 1 个有内容**；Unity 于是把 body 的贴图铺到了所有部件上。

**修复**：导出前给每张图分配**唯一且合法**的文件名（`server/gltf-to-fbx.py` 的
`name_every_texture()`）。已有真实文件的图原样保留，只处理 filepath 不可用的（即内嵌图），
因此正常情况下**不产生任何额外磁盘写入**——像素本来就在包里。

```python
image.filepath_raw = os.path.join(target_dir, distinct_filename(image, taken))
```

名字做了 Windows 非法字符替换（`<>:"/\|?*` 与控制字符）、补齐扩展名、并在本次导出内去重
（`name-2.png`），同时保留可读主干，因为 Unity 会把文件名显示为贴图名。

**修复后实测**（同一个 142MB 模型）：18 张图重命名、0 次磁盘写入；FBX 33.3MB → **115.3MB**，
15 个 Video 节点 **15/15 全部嵌入**、**15 个互不相同的 `RelativeFilename`**，材质映射为
`body→body_diff_01`、`cloth→cloth_diff_01`、`hair_outer→hair_outer_alpha_01` 等。
再把这个 FBX **回导 Blender** 做闭环核对：每个材质的贴图各不相同，26 个图像数据块无重复。

**代价与取舍**：FBX 是**自带贴图**的（`embed_textures=True`），修好之后它必须真的把每张图都装进去，
于是体积等于所用贴图之和。4K 贴图模型几百 MB 属正常；想压小就把导出参数里的**贴图尺寸**设成
2048/4096（`maxTextureEdge`），或改用 GLB。

**回归覆盖**：`test/gltf-fixture.mjs` 现场生成一个双材质、两张不同内嵌贴图的微型 GLB；
`test/fbx-inspect.mjs` 是一个不依赖 Blender 的二进制 FBX 读取器，直接断言
「不同材质不得共用同一贴图路径」「每个 Video 都必须有嵌入内容」「媒体路径互不相同」。
未安装 Blender 时该用例自动跳过而不是失败。已做反向验证：撤掉修复后该断言精准失败。

## 3.2.1 修复：ArtStation 任务必然瞬间失败（子进程入口串扰）

**现象**：ArtStation（MARMOSET）任务入队后**立刻**失败（0 秒），日志只有两行：

```
[09:11:47] 第 1 次尝试，独立后台执行
[09:11:47] The "path" argument must be of type string or an instance of Buffer or URL. Received undefined
```

重试同样失败，且连第一条进度都没有；Sketchfab 任务完全不受影响。

**根因（两个 worker 抢同一条 IPC 消息）**：两个 worker 都用 `if(process.argv.includes('--worker'))` 判断
"我是不是被 fork 起来的工作进程"。但 `artstation-worker.mjs` 会 `import artstation.mjs`，后者为了 `browserPath`
又 `import export-worker.mjs` —— 于是 ArtStation 子进程一加载，**export-worker 的 worker 块也被当作 import
副作用激活了**。两个模块各注册一个 `process.on('message')`，同一条 `start` 消息被两边同时收到：

- Sketchfab 那个拿到的却是 ArtStation 的 job：没有 `profile`、也没有 `output`（那是 Sketchfab 的字段），
  第一行 `fsp.mkdir(path.dirname(output))` 直接抛错 —— 这正是上面那条报错；
- 它还在 `finally` 里 `process.disconnect()` 掐断 IPC 通道，真实任务因此连一条进度都发不出来。

**为什么进程内调用却完全正常**：直接在服务进程里调 `runArtstationJob()` 时 argv 里没有 `--worker`，
第二套 handler 根本不会注册。这也解释了为什么之前的单元测试全绿却漏掉了它 —— 那些测试用的是假执行器。

**修复**：

- 新增 `server/worker-entry.mjs` 的 `isWorkerEntry(moduleUrl)`：只有 `process.argv[1]` 与模块自身 URL 一致时
  才算入口。**"导入别人的 worker" 永远不等于 "自己是被启动的 worker"**，所以这类串扰在结构上不再可能发生。
- 两个 worker 的 catch 现在把 `e.stack` 一起回传，父进程还原为完整堆栈。此前只回传 `message`，
  一个能一行定位的问题被放大成"猜一下午"。

**同时补上 ArtStation 侧一直缺失的文件夹交付**：`runArtstationJob` 原来只会写 ZIP，而文件夹模式下 `output`
是**目录**路径，`fsp.open(output,'wx')` 必然 `EISDIR`。现在抽出 `writeArtstationDeliverable()`：按 `deliver`
写出单文件 ZIP 或松散目录树，两种形态携带同一批条目，因此下游校验与「FBX + ZIP」打包都不需要分情况。

**回归覆盖**：

- `test/library-worker-entry.test.js` —— 一个模块导入两个 worker 时 `process.listenerCount('message')` 必须为 0；
  `isWorkerEntry` 只在真入口为真；真入口仍能应答 `start`（正向对照）。
- `test/library-artstation-deliver.test.js` —— 文件夹 / ZIP 两种交付各自的形状，且都通过
  `verifyFolder` / `verifyArchive`（文件夹交付不低于 ZIP 的验收标准）。
- `library-artstation-jobs.test.js` 新增「ArtStation + 文件夹 提交目录并告知执行器交付形态」。
- 真浏览器 `npm run test:downloads:browser` 新增 4 条 ArtStation 文件夹断言；两个 E2E 的假执行器都已按
  `deliver` 契约分支（否则 E2E 根本覆盖不到文件夹路径）。

**反向验证**：把守卫改回 `process.argv.includes('--worker')`，第一条断言立刻以 `MESSAGE=1` 失败，
确认断言不是摆设。

**实测（真实联网，走生产 API）**：`artwork/YK90wP` → 15 MB `.mview` → mviewer 26 个 mesh → ZIP 保存并通过校验；
同一作品切文件夹模式落地 `scene.glb`（23.4 MB）+ 6 张贴图 + `info.json`（`verification.folder=true`，8 个条目）。

## 3.2.0 导出内容、输出方式、FBX 与贴图尺寸

导出设置现在有四个独立选择，互不耦合；它们作为任务快照保存，之后改设置不影响已入队任务。

| 设置 | 取值 | 实际行为 |
| --- | --- | --- |
| 下载内容 | `仅模型与贴图`（默认）/ `仅 GLB` / `完整包` | 默认只保留 `<name>.glb`、`textures/**` 与 `info.json`，跳过 Sketchfab 的原始 osgjs 场景（`file.osgjs`、`model_file.bin`）、与之重复的外部 `model.gltf`/`model.bin` 以及 `README.txt`。`仅 GLB` 只要内嵌贴图的 GLB。`完整包` 保留原始场景与说明，便于排查。 |
| 输出方式 | `ZIP 压缩包`（默认）/ `不压缩 · 直接输出文件夹` | 文件夹模式写出真实目录树，不再二次打包；`info.json`、`textures/` 层级与 ZIP 内一致，可直接拖进 Unity。同名文件夹自动加序号。 |
| 模型格式 | `GLB`（默认）/ `FBX` | FBX 由本机 Blender 无头转换（`import_scene.gltf` → `export_scene.fbx`，`path_mode=COPY`、贴图内嵌、烘焙动画、不生成多余骨骼）。没有 Blender 时任务明确失败并给出获取方式，不会降级成假成功。 |
| 贴图尺寸 | `保留原尺寸`（默认）/ `压缩到最高 2K` / `4K` | 默认 `0` = 用平台提供的原始像素，**不做静默降采样**；需要更小的包必须手动选 2K/4K。 |

组合行为：`FBX + ZIP` 会先落一盘松散文件、转换完成后统一打包成 ZIP（因此 ZIP 内同时含 GLB、FBX 与贴图）；`FBX + 文件夹` 直接输出含两者的目录。

Blender 解析顺序：`SFX_BLENDER` 环境变量 → 便携版 `vendor/blender/blender[.exe]` → 已安装的 Blender（Windows `C:\Program Files\Blender Foundation\…`、macOS 应用包、`/usr/bin/blender` 等）。`vendor/blender/` 缺失时运行 `npm run fetch:blender` 会自动下载便携版（可用 `SFX_BLENDER_URL` 指定镜像；官方源与镜像均不可达时给出明确指引）。

其它行为变化：

- 任务卡徽标直接说明落地形态，例如 `模型+贴图 · GLB ZIP`、`MARMOSET → FBX 文件夹`。
- 文件夹导出不再显示「另存副本」——该链接走单文件接口，对目录无意义；后端 `GET /api/downloads/tasks/:id/file` 对文件夹导出返回 `400 {"error":"这是导出文件夹，请用\"所在文件夹\"打开"}`，而不是把错误内容当成 ZIP 交付。
- 旧的浏览器本地存储（`optionsVersion` 小于 2）只会把**当时就是默认值**的项迁移到新默认（`完整包 → 仅模型与贴图`、`2048 → 保留原尺寸`），显式选过的值保持不动。

回归覆盖：`test/library-folder-output.test.js`（文件夹落盘、ZIP 保持归档、FBX+ZIP 打包、文件夹校验拒绝缺 `info.json`/UID 不符/无 GLB/目录不存在、`commitFolder` 不合并同名、单文件接口拒绝文件夹）、`test/library-fbx.test.js`（`SFX_BLENDER` 优先、缺 Blender 明确失败、缺 GLB 在启动 Blender 前就报错）、以及真实浏览器脚本 `npm run test:downloads:browser` 中新增的 8 项文件夹/FBX 断言。

## 3.1.1 重复烘焙贴图修复

现象：Study（Miki Bencz，UID `9b3f278bacc54f219addd98215008ceb`）这类模型有多个材质共用同一张基础色贴图、却分别使用不同透明度图。烘焙（tint/alpha）产物此前只按基础色基名命名，三个不同内容都叫 `textures/bw_diffuse_alpha.png`：后一次烘焙覆盖前一次的查找键，三个材质绑定同一张图，ZIP 出现重名条目并被严格校验拒绝（“ZIP 条目不安全或不受支持”）。油猴脚本与工作台共用同一引擎，修复前同样存在重名条目问题，只是没有校验拦截、保存时不报错。

修复（补丁 15/16，`server/archive.mjs` 错误细化）：

- 烘焙产物按内容分配唯一文件名：字节相同共用一个名字，不同则加 `-2`、`-3` … 后缀（如 `bw_diffuse-2_alpha.png`），保留 `_alpha`/`_tint` 结尾以兼容按名查找。
- 外部 glTF 贴图写入 ZIP 前增加同名护栏：任何来源的重名条目只写一次。
- ZIP 校验错误按重名、路径不安全、加密、压缩方式分别报错并指明条目名。
- 新增离线回归测试 `test/unique-baked-names.test.js`，并用 Study 公开模型实测重新导出验证。

证据：`H:\AI-Tools\_tmp_pja\sketchfab-study-zip-fix-20260919\`（升级前 135 个源文件备份与哈希、修复前后导出对比、acceptance/integrity 清单）。

## 3.1 进度和路径验收

本次新增真实代理流字节统计测试、未知长度处理、进度显示、路径错误提示、单批次中文/空格路径实际落盘和默认目录不变等检查。新证据保存在 `H:\AI-Tools\_tmp_pja\sketchfab-progress-path-20260919\`，升级前 132 个源文件及哈希独立备份，未覆盖 3.0 基线。

## 验收与复现

先运行 `npm run build:library`，再执行：

```sh
npm test
npm run build
npm run verify
npm run test:library:browser
npm run test:downloads:browser
npm run test:downloads:live
npm run test:downloads:lifecycle
```

前两个 UI 脚本使用明确标识的合成数据，不把它们算作真实平台下载。`test:downloads:live` 使用公开 CC Attribution 的 Cube Fracture，在转换运行时真正关闭工作台页面目标，等待后台完成，再打开新页面核对任务和 ZIP。`test:downloads:lifecycle` 用公开 CC Attribution Cube 验证实际后台浏览器取消、强制终止服务后的浏览器清理和中断状态恢复。

详细的最终检查数、真实文件字节数与哈希见项目外验收目录的 `acceptance.json`：

`H:\AI-Tools\_tmp_pja\sketchfab-download-manager-20260919\`

其中 `final-*` 是最终验收产物；前期失败的 smoke / lifecycle 目录保留为调试记录，不作为通过证据。中途曾修复 fork 继承 `--input-type`、界面语法，以及异常终止后临时资料目录的清理问题。

## 故障、安全与范围

- 未找到后台浏览器：安装 Chrome/Edge，或通过 `SFX_BROWSER` 指定可执行文件后重启服务。
- FBX 导出失败：本机未找到 Blender。安装 Blender、运行 `npm run fetch:blender` 下载便携版到 `vendor/blender/`，或用 `SFX_BLENDER` 指定可执行文件后重启服务。GLB 导出不受影响。
- 目录不可写/空间不足：查看任务错误，选用本机可写目录。共享网络路径和磁盘根目录不支持。
- 状态文件损坏：尝试恢复上次备份并保留损坏文件；无法恢复时拒绝启动，不静默清空记录。
- 不要同时启动两个使用同一数据目录的服务；已有服务时直接打开网址即可。
- `SFX_PORT`、`SFX_DATA_DIR`、`SFX_DOWNLOAD_DIR` 可覆盖默认值。数据目录应当是本工具专用目录。
- 服务只监听回环地址，并继续保留 Host/Origin、本地请求标识、远程公开地址检查。不新增登录、私有模型或其他平台绕过机制。
- 「可下载」筛选不等于商业使用许可；请遵守模型原许可、署名要求及平台条款。
- 仅支持现有 Sketchfab 引擎；不支持 Fab、私有/登录限制资产，也不保证搜索数量/排序与官网完全一致。

## 备份与回滚

升级前 122 个项目文件及哈希已保存在同一验收目录的 `backup\` 和 `original-hashes.json`，保持不变。

回滚前停止本地服务，另行保留 `.assetvault` 和下载目录；按基线恢复改动文件，并移除本次新增源文件，重新构建工作台。**不要删用户下载文件或清除浏览器存储。** 旧版不会读取 3.0 后台任务数据库，也不具备关页下载能力。最终文件差异和 SHA-256 清单见 `integrity-manifest.json`。
