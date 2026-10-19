# Changelog

功能与修复的版本记录。README 只保留「是什么、怎么用」，详细变更集中在此。

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
