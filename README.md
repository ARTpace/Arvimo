# AssetVault

本地 3D 资产工作台：搜索 Sketchfab 与 ArtStation Marmoset 资产，后台下载并转成 GLB / FBX，统一收进本地模型库。
保留 **Tampermonkey 单文件脚本**（`dist/sketchfab-exporter.user.js`，只处理 Sketchfab）。

> 3.4.0 起品牌由 Sketchvault 改为 **AssetVault**（工具早已不只是 Sketchfab 下载器）。
> 数据目录 `.sketchvault` 首次启动会自动迁移为 `.assetvault`（旧目录存在且新目录不存在时改名；改不动就继续用旧目录，不删数据）。

> 仅用于你自有或已获明确授权的模型。请遵守模型许可证与站点条款，
> 署名信息会写入输出包的 `info.json`。

## 本地模型库与下载管理 3.4.0（推荐）

Windows 双击 **`AssetVault.lnk`**（已挂好图标）或 **`Start-Library-Silent.vbs`**：全程不弹出命令行窗口，服务在后台运行。
也可以双击 `Start-Library.cmd`（会闪一下窗口后自动转入后台），
或运行 `npm run library -- --open`（前台模式，需保持该窗口开启）。
浏览器会先打开**启动画面**（`/splash.html`，带 logo 动效和进度条），就绪后自动进入工作台 **http://127.0.0.1:4178**。
后台模式日志在 `.assetvault\library-server.log`，启动器自己的记录在 `.assetvault\launcher.log`（浏览器有没有被成功交给系统，看这里）；停止服务双击 `Stop-Library.cmd`。
首次需要 Node.js 22+ 和 `npm install`；后台转换需要已安装 Chrome / Edge。

启动画面由服务自己提供（源文件 `src/library/splash.html` + `splash.js`，吉祥物图 `mascot.png`）。
它是一张同源页面，所以「就绪后跳转」这一步不会失败；要改文案或节奏调 `splash.js` 顶部的常量。

### 换新电脑后启用 Blender 导入（AssetVault Bridge）

Blender 导入靠一个 **startup 脚本**，不是 addon —— 所以**在 Blender 的插件列表里找不到它**，也不需要勾选启用。
脚本名 `assetvault_bridge_startup.py`，位置是 `<Blender 配置目录>\<版本>\scripts\startup\`。
Blender 一启动它就跑，在 `127.0.0.1:47752` 开一道本地小门，AssetVault 点「Blender」时从这道门把模型送进**当前场景**。

三种装法，任选：

1. **什么都不做**：AssetVault 在你点「Blender」时会自动装到本机**所有** Blender 版本目录（含被做成符号链接的配置目录）。
   代价是那一刻 Blender 已经开着，装完还得重启 Blender 才生效。
2. **推荐**：打开 Blender 之前先双击 **`Install-Blender-Bridge.cmd`**。它会列出每个版本目录的新装/更新情况，
   装完再开 Blender —— 直接就能用，不用重启。
3. **手动兜底**：把 `server\blender-bridge.py` 复制到
   `%APPDATA%\Blender Foundation\Blender\<版本>\scripts\startup\`，改名为 `assetvault_bridge_startup.py`，重启 Blender。

装完想知道好没好，看工作台里的 **「导出设置」→「Blender 连接」**：它会直接报出当前状态
（已连接 / Blender 已打开但桥接没生效 / 还没装），并挂着同一个「安装 / 更新」按钮，不用回到命令行。
点下去会看到安装过程本身：进度条 + 五个真实步骤（读源脚本 → 找版本目录 → 逐个写入 → 回读校验 → 探活端口），
每个目录写成了哪一份、校验是否一致都照实列出；装完是绿色勾选的动效，失败则标红并把原因（写不进去的路径、
系统错误码、或「找不到任何 Blender 目录」）留在面板里，按钮变成「重试安装」。
排错：桥接的运行日志在 Blender 控制台里，搜 `AssetVault Blender Bridge` 开头的行（`listening` / `listener lost, rebinding` / `could not listen`）。
⚠️ 不要用 Blender 的 **Reload Scripts（Ctrl+Shift+R）** 来加载它：部分插件（例如 BlenderGIS）会因此让 Blender 崩溃，直接重启 Blender 更稳。

- 发现页只有**一个搜索框**：左侧选平台、右侧输关键词。「全部平台」同时检索两边并按平台交错展示，
  状态行逐源报进度、副标题分别报出各平台拿到多少。
- **两个快捷按键代替去下拉里挑平台**：左侧栏顶部的「模型模式」停在全部平台、把 ArtStation 源锁到「Marmoset（可转 3D）」——
  Sketchfab 的模型和 A 站的 3D 资产都进来，纯图片作品不出现；此时筛选合并成一棵**统一分类树**，两平台共用一套分类/排序/范围（`src/library/merged-filters.js`，A 站分类按映射派生）；「图片模式」只看 ArtStation 作品并按原图比例排成瀑布流；
  再点一次当前模式即退出（A 站的类型选择会被还原）。
- **筛选是左侧栏里的树**（不带外框，直接长在侧栏底色上）：全部平台下 Sketchfab 与 ArtStation 两组都在（各带平台标牌、各管各平台的结果），
  选中单个平台就只剩它的一组；按字段长成可折叠的分支 —— 分类下面按主题分五组
  （生物 / 场景 / 人文 / 造物 / 生活，组名旁带数量），组里才是 19 个分类；排序与范围平时折着、只把当前值写在标题右边，点开即改。
  窄屏时整棵树（连同两个模式按键）折起来回到搜索卡片下方。
  ArtStation 的分类与资产类型是官方英文清单，界面上显示成中文（`src/library/filter-labels.js` 只改显示，请求值原样发）。
- **最近检索改成点搜索框才出现**：左侧栏不再常驻历史列表；点一下搜索框会弹出最近检索浮层，列出搜过的关键词（带平台 · 分类 · 排序）
  与解析过的链接，方向键选、回车即回到那一次，还能就地清除。记录只保存在这台电脑的浏览器里。
- 「全部平台」的 ArtStation 侧检索全站 Marmoset Viewer 分面（11 万+ 作品）。
  封面走 ArtStation CDN 的渲染尺寸规则（自动去掉方形缩略图多出来的时间戳目录，并带尺寸降级），不会出现“有的缩略图加载不出来”。
- 搜索框下面是**一个链接框**，按域名自动判定平台：ArtStation 作品页直接识别内嵌 Marmoset 场景（给出缩略图与体积），
  Sketchfab 作者/合集页与普通网页检索其中的模型链接。解析结果单独占用结果区，点「返回搜索结果」即可交还给平台搜索。
- 两个平台共用**同一条下载队列**：ArtStation 作品由 mviewer 把 `.mview` 转成 GLB/glTF 再打包 ZIP，
  但入队、并发、暂停、重试、取消、ZIP/GLB 校验、SHA-256 与“所在文件夹”都和 Sketchfab 任务是同一套，
  因此**“转换”就是“入队”**，不用先点转换再点下载压缩包；粘贴单个作品地址识别完直接进同一个确认框。
  同批仍只接受同一平台（Sketchfab 50 个 / ArtStation 20 个），混选时提示分两批。
- “发现资产”与“我的模型库”独立；主动加入或收藏后才入库，原列表/收藏/任务兼容保留。
- 展示真实缩略图卡片；点击进入可旋转 3D 预览。
- 支持分页去重、搜索筛选、收藏、多选、后台下载、任务日志、取消和重试。
- 独立后台浏览器复用原导出引擎；关闭工作台网页仍继续，电脑和本地服务必须保持运行。
- 下载页直接设置默认路径，确认下载时可为本批次单独指定目录。显示实际接收字节/速度、当前传输批次百分比及转换/校验阶段，未知总量不虚报进度。
- 下载目录、任务记录落盘保存；支持排队暂停、批量操作、1–2 并发、有限网络重试、重复提醒、打开所在文件夹。
- ZIP/GLB 结构与 CRC 校验后保存，记录 SHA-256；同名不覆盖。中断任务可从头重试，不宣称断点续传。
- 3.4.0 界面：**「搜索资产 / 解析网页 / ArtStation Marmoset」三个页签合成一个搜索界面**。
  平台选择器（全部平台 / Sketchfab / ArtStation Marmoset）决定“谁来回答”，关键词框、链接框、结果网格、收藏与下载流程从此只有一套。
  「全部平台」**并行**检索两个平台并把结果**交错合并**（否则第一个平台的长列表会把另一个整个压到看不见），
  状态行逐源报进度、副标题分别报出各平台数量；筛选树按当前平台显隐，全平台时两棵树并排（各管各平台，分类体系互不干扰）。
  链接框按域名判定平台，ArtStation 作品页仍走识别、其余走网页解析，
  解析结果独占结果区并提供「返回搜索结果」。平台清单 / 推荐词 / 占位文案 / 链接规则集中在 `src/library/platforms.js`，
  合并与文案规则在 `src/library/discovery-view.js`（纯函数，可单测）；新增平台只需改注册表，不必动 `app.js`。
- 3.4.0「解析链接」栏**默认收起**（搜索才是主路径）：搜索区的「解析链接」小按钮与面板标题条是同一个开关的两个入口，
  展开状态跨刷新记忆；点历史记录或真正解析链接时会把这一栏自动展开，不会把结果藏在收起的面板里。
- 3.6.3 界面：**侧栏的分类清单不再一次铺满**。ArtStation 官方有 59 个分类，平铺出来是一列看不到头的清单；
  现在按用途归到 6 组（角色与生物 / 场景与环境 / 道具与工业 / 题材与风格 / 插画与平面 / 游戏影视与技术），
  组默认折着、只有当前选中的那一组会自动展开，官方以后新增的分类落进「其他」组而不是凭空消失。
  Poly Haven / ambientCG / FreeStylized / Kenney 的分类来自各自接口（ambientCG 有 95 个材质分类、Poly Haven 还混着
  `collection:` 前缀的合集），词表既长又互不相通，没有可依赖的手工分组表，于是用同一套渲染折成「前 12 个常驻 + 更多分类」——
  这些清单本身就按官方热度排序，折起来的正好是长尾。两种折叠都只看**显示文案**，请求参数一个都没改
  （两张表都在 `src/library/filter-groups.js`，加平台不用动渲染器）。
- 3.6.1 修复：**在跑的后台服务是旧版本时，新增的平台会搜不出东西**。服务是常驻进程，代码更新后进程不会自己重启；
  而启动器判断「要不要重启」只看一份手写的布尔清单，加了新接口却忘了同步那份清单，旧进程就会被判成「已是最新」，
  一直不换。现象是：界面里明明有「Poly Haven」，提交搜索却回一句「不存在的页面或接口」。
  现在服务端与启动器共用一份能力契约（`server/capabilities.mjs`），`/api/downloads/capabilities` 原样返回它、
  启动器用它判定——**加一个前端要用的接口 = 在那里加一个能力位**，没有第二处要记得改的地方，
  版本号或能力位任一不匹配都会在下次启动时自动换上新的进程。
- 3.6.2 修复：**Poly Haven 资产下载高清图（图片任务）之前回「Poly Haven 资产 ID 缺失」/「ArtStation 流程只允许访问 artstation.com」**。根因是图片链路三处都没把 Poly Haven 的真实资产 ID（`assetId`）透传到底：① `run()`→`imageRunner`→`runImageJob`→`collectImageAssets` 一路只传了 `uid`（模型 uid 是 md5，拼不出 Poly Haven URL）；② `collectImageAssets` 的 `assetId` 透传；③ `downloadImage` 的出域白名单 `IMAGE_CLIENTS` 只有 sketchfab/artstation，Poly Haven 被 fallback 成 artstation 白名单，导致 `cdn.polyhaven.com` 被拒。现在三处都补上、`IMAGE_CLIENTS` 加了 `polyhaven:{}`，图片任务下载 Poly Haven 官方渲染图（orth/clay 等多视角的 `images/` 文件夹 + `info.json`）已验证落盘。
- 3.6.0 新增：**批量下载资产的高清图片**。勾选任意张卡片后，多选栏的「下载高清图」会把每个资产自己变成一个 `images` 任务；
  卡片上的图片图标与预览弹窗里的按钮是同一个入口的单张版本。每张资产导出成一个 `<名称>-images` 文件夹（也可 ZIP），
  里面是 `images/` 加一份 `info.json`（登记每张图的像素、字节、原址）。尺寸按平台能取到的最大档：
  **Sketchfab 取公开封面最宽的一档（1920px，API 只发布同一张封面的多档尺寸，多余的只会是重复文件）**，
  **ArtStation 取作者上传的每一张、`large` 档**（`original` 对非作者一律 403）。平台差异全部收在
  `server/image-sources.mjs` 的注册表里，新增来源不需要碰打包与队列；下载落盘与「按字节命名」在
  `server/image-store.mjs`（与 ArtStation 图片作品管线共用）。图片任务不转 FBX、不进 Blender，去重与模型导出互不干扰。
- 3.5.0 界面：**Blender 按钮只属于已经下载到本地的资产**。在此之前每张卡片（含在线结果）都挂着一个「Blender」按钮，
  点了其实是「先下载、下载完再导入」，在线模型点一次就要走完整条下载流程。现在按钮由「本地有没有文件」决定
  （`src/library/blender-send.js` 的 `findLocalJob`：任务已保存且文件还在磁盘上），没下载过就不显示；
  点击走 `POST /api/downloads/tasks/:id/send-blender`，**只把磁盘上的那个文件交给已打开的 Blender**（AssetVault Bridge），
  不进队列、不重新下载。服务端会再查一次文件是否还在，被删掉就明确报错而不是假装发送成功。
- 3.4.1 界面：**下拉菜单改为自绘**。原生 `<select>` 的弹出层由操作系统绘制，样式表够不到，深色界面里总会弹出一块浅色系统菜单；
  现在 `select` 退居数据源（`.value`、`options`、`onchange` 全部照旧），露脸的是按钮 + listbox（`src/library/picker.js`），
  键盘（↑↓/Home/End/PageUp/PageDown/Enter/Esc）、打字定位、点击外部关闭都按原生习惯实现，选项可带一行说明小字
  （平台说明来自 `platforms.js` 的 `hint`，经 `data-hint` 传给菜单）。菜单挂到 `body` 上定位——搜索卡片是 `overflow:hidden`，
  留在原地会被裁掉。长列表（分类有 19 项）由代码自己算 `scrollTop`，不用 `scrollIntoView`（后者会顺带滚动祖先乃至整页）；
  页面滚动时菜单重新贴回按钮下方，菜单自己滚自己则不动。搜索区内的 5 个下拉（平台 / 分类 / 排序）统一生效，
  新增下拉只要写进 `#search-panel` 就自动升级。
- 3.4.1 修复：**「解析链接」按钮与整块面板曾被两条遗留的 `display:none!important` 规则藏住**（3.3.0 重构时留下，3.4.0 把面板加回来却没删规则）。
- 3.4.1 修复：下拉长菜单的滚动条也改为主题色（系统滚动条会在深色面板里横插一条灰杠）。
- 3.4.1 修复：**下载 E2E 曾静默瘫痪**——授权弹窗（`#authorize-*`）早已从界面移除，脚本却还在点它，第 44 行就抛错，
  51 条断言里只跑了 5 条（当时只数 `PASS` 行，误报成通过）。现已按「点卡片直接入队 / 重复任务靠参数比对 / 每批目录改由 API 建任务」重写，
  真跑到 51/51；同时把「必须同时看 `FAIL`、`Error:` 与退出码」写进测试纪律。
  旧端到端断言当时断言的是「面板必须 `display:none`」，于是功能不可见而测试全绿。现已删除这两条死规则，
  并把断言改为**渲染后的真实尺寸**（`getBoundingClientRect().height`）——CSS 属性不能当作可见性的替身。
- 3.2.0 新增**导出内容 / 输出方式 / 模型格式 / 贴图尺寸**四项独立选择（下载管理 → 导出设置）：
  - **下载内容**：`仅模型与贴图`（默认，只留 `<name>.glb` + `textures/**` + `info.json`，跳过 Sketchfab 原始 osgjs 场景、重复的外部 gltf/bin 与说明文件）/ `仅 GLB` / `完整包`。
  - **输出方式**：`ZIP 压缩包`（默认）或 **`不压缩 · 直接输出文件夹`**——写出真实目录树，可直接拖进 Unity；同名文件夹自动加序号。
  - **模型格式**：`GLB`（默认）或 **`FBX`**——用本机 Blender 无头转换（`SFX_BLENDER` > 便携版 `vendor/blender/` > 已安装的 Blender；`npm run fetch:blender` 可自动下载便携版）。没有 Blender 时任务明确报错，不会假装成功。
  - **贴图尺寸**：默认 **保留原始像素**；压缩到 2K/4K 必须手动选，不做静默降采样。
  - 文件夹导出同样校验：`info.json` 来源比对 + 真实 glTF 2.0 网格 + 覆盖「相对路径 + 内容」的 SHA-256；任务卡徽标直接说明落地形态（如 `模型+贴图 · FBX 文件夹`）。
  - 文件夹导出不再出现「另存副本」；单文件接口对目录明确返回 400，而不是把错误内容当 ZIP 交付。
- 3.2.3 界面：**下载卡片默认精简**。卡片正面只留模型名、导出徽标、状态、体积/耗时，以及进行中的实时进度条；
  六个阶段、传输明细、保存路径与 SHA-256 校验全部折进每张卡片自己的「详情」，任务日志仍是独立折叠块。
  已完成的卡片不再重复「已保存到本机…」（状态栏已说明），只有真重试过才显示「尝试 N 次」，排队任务也不再画一条空进度条。
  折叠状态在列表重建后保持。信息一条没少，只是各自差一次点击。
- 3.2.2 修复：**FBX 里所有材质的贴图都变成同一张**（衣服用到身体的贴图）。Blender 的 glTF 导入器给内嵌贴图留的是**空 filepath**，
  而 FBX 导出器的媒体路径取自该路径的 basename——为空时所有贴图塌陷成同一个 `<模型名>.fbm`，于是所有材质指向同一张图，
  且导出器的"每个文件只嵌一次"去重让**只有第一张图被真正嵌入**（实测旧 FBX 15 个贴图节点仅 1 个有内容）。
  现于导出前给每张图分配唯一合法文件名，内嵌图不产生额外磁盘写入；修复后 15/15 全部嵌入且路径互不相同。
  注意 FBX 是自带贴图的，体积≈所用贴图之和，想压小请调「贴图尺寸」或改用 GLB。
- 3.2.1 修复：**ArtStation（MARMOSET）任务必然瞬间失败**。两个 worker 都用 `process.argv.includes('--worker')`
  判断自己是不是被 fork 的工作进程，而 ArtStation worker 会（经 `artstation.mjs`）连带到 `export-worker.mjs`，
  于是它的 worker 块被 import 副作用激活、抢走了同一条 IPC 消息，并报出
  `The "path" argument must be of type string ... Received undefined`。现改为按「模块是否就是被启动的入口」
  判断（`server/worker-entry.mjs`），结构上杜绝这类串扰；worker 也会回传堆栈，不再只剩一句错误文案。
  同时补上 ArtStation 侧原本缺失的**文件夹交付**（此前会 `EISDIR`）。
- 3.1.1 修复：多个材质共用同一贴图基名时，烘焙贴图按内容唯一命名（`-2`/`-3` 后缀）；ZIP 校验遇到重名、加密或不受支持的条目会明确指出条目名。
- 仅处理已授权模型。不执行外部网页脚本，不保证发现动态/登录内容中的全部模型。
- 独立工作台不进行扩展式 viewer-blit 捕获，出现贴图警告请检查输出外观。

当前下载管理使用、限制与验收：**[3.2.0 后台下载说明](docs/mcp-download-manager.md)**（含导出内容 / 输出方式 / FBX / 贴图尺寸各组合的行为与回归覆盖）。
关键词搜索与模型库说明保留在 [2.0 历史文档](docs/mcp-model-library-v2.md)，其旧浏览器下载方式已被后台队列替代。
ArtStation Marmoset 搜索的接口、过滤规则与安全边界见 **[ArtStation Marmoset 搜索](docs/artstation-marmoset-search.md)**。

## 安装（Tampermonkey）

1. 安装 Tampermonkey（Chrome / Edge）。
2. 打开 `dist/sketchfab-exporter.user.js`，Tampermonkey 会提示安装。
3. 打开任意 Sketchfab 模型页（`sketchfab.com/3d-models/*`），点右下角 ⬇，
   勾选是否下载贴图后点“下载”。

## 开发

```sh
npm install
npm test        # 补丁 + 本仓库回归 + 上游测试集
npm run build   # 输出 dist/sketchfab-exporter.user.js
npm run build:library  # 独立工作台 dist/library/
npm run test:library   # 网页发现/服务器/安全回归
npm run test:artstation # ArtStation Marmoset 搜索/游标/归一化回归
npm run test:library:browser  # 搜索/收藏/迁移 UI 回归
npm run test:downloads:browser # 合成 ZIP / 导出文件夹 / FBX 的下载管理 UI 回归
npm run test:downloads:live    # 联网真实转换 + 关闭工作台页面
npm run test:downloads:lifecycle # 联网真实取消 + 服务进程异常退出
npm run fetch:blender          # 下载便携版 Blender 到 vendor/blender/（FBX 导出用，可选）
```

上游源码固定在 `vendor/upstream-src/`（见 `THIRD_PARTY.md`），不要手改；
改动一律写成 `patches/*.mjs`。

## 目录

- `src/userscript/` — 油猴脚本：入口、面板、网络回退、WASM 内联垫片
- `src/library/`、`server/` — 独立工作台与本地扫描/代理服务
- `scripts/build-userscript.mjs` — esbuild 打包（单文件 IIFE + 用户脚本头）
- `patches/` — 对上游的构建时补丁
- `test/` — 本仓库回归测试
- `vendor/upstream-src/` — 上游固定提交的 pristine 源码
- `dist/` — 构建产物（可直接安装）

## License

GPL-3.0-only（上游为 GPL-3.0，本仓库为衍生作品，见 `LICENSE`）。
