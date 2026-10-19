# ArtStation 搜索、按作者浏览与作品入库（本地工作台）

在发现页把搜索平台切到 **“ArtStation”**（或选“全部平台”同时检索两边），
即可把 ArtStation 当作可搜索资产库使用：默认只筛 **Marmoset Viewer** 作品，
也可以切到 **“全部作品”** 检索全站（含 2D 插画与纯图片作品）。
行为与 Sketchfab 在线搜索对齐：同样的卡片、多选、收藏、模型库与后台队列。
与“粘贴作品网址 → 识别 → 加入队列”的单件流程共用同一套转换器，只是入口不同——
3.3.0 起两者共用同一个链接框，粘贴后按域名自动分流。
另有一个按作者浏览的入口：填用户名即可翻看 TA 的**作品**或**点赞**列表。

## 两类作品，两条入库链路

| 作品 | 判定（`icons.marmoset`） | 下载得到 |
| --- | --- | --- |
| 内嵌 Marmoset Viewer | `true` | `.mview` → GLB（+ 可选 FBX），与 Sketchfab 同一套交付与校验 |
| 无 3D 场景（2D 插画、纯图片） | `false` | 作者上传的**全部作品图片**（最大可获取尺寸）+ `info.json` 清单 |

判定结果以 `hasMarmoset` 随任务一起**持久化**，所以 `runArtstationJob` 与
`runArtstationImageJob` 由 forked worker 在启动时按它分派，重启后恢复队列无需再问一次网络。
两条件都写进同一个 `DownloadManager` 队列：同一套 uid、同一套校验器、同一套重试与保存策略。

## 为什么能一次筛出全部 Marmoset 作品

ArtStation 站点自身的搜索模块向 `/api/v2/search/projects.json` 提交：

```json
{"query":"","page":1,"per_page":48,"sorting":"relevance","pro_first":true,
 "filters":[{"field":"asset_types","method":"include","value":["marmoset"]}],
 "additional_fields":[]}
```

关键点：

- `asset_types = marmoset` 就是站点自己的 **Marmoset Viewer** 分面（约 119,000 个作品）。
  因此关键词搜索不需要先把非 3D 结果翻一遍再挑可嵌入的——这是**默认**筛选，不是硬编码：
  选择「全部作品」时这个 filter 整个不发，分面清单里有什么就筛什么。
- 该接口从本地发起 **POST 会被 WAF 挂住**，同样参数改用 **GET** 正常返回；
  `filters` 在 GET 下以 JSON 字符串形式传递即可。
- 分面选项清单来自 `/api/v2/search/projects/filter_fields.json`，**由服务端缓存 6 小时**并原样转发给前端，
  分类/排序不会写死在代码里。
- 结果项自带 `icons.marmoset` 与 `hash_id`；封面只有方形小图，
  按同一 CDN 规则把 `/smaller_square/`、`/micro_square/` 换成 `/medium/` 得到更清晰的缩略图。

## Cloudflare 与出站层

`/projects/<hash>.json`、`/users/<u>/*.json` 这类接口在 ArtStation 的托管型 Bot Management 后面，
判定依据是 **TLS 指纹（JA3/JA4）**，不是 UA：Node 原生 `https`、系统 curl、
手搓 cipherSuites/sigalgs/ecdhCurve 全部拿到 403 挑战页，只有浏览器指纹能过。

因此 `server/curl-impersonate.mjs` 负责这条出站路径：

- 内置 `vendor/curl-impersonate/curl-impersonate.exe`（`npm run fetch:curl-impersonate` 拉取，
  与 `fetch:mviewer` 同一套约定）；
- **指纹顺序是 Safari/Firefox 在前、Chrome 在后**：实测 `safari184 / firefox147 / safari260 / firefox144`
  在受保护端点上全部 200，而 `chrome136 / chrome142` 仍然 403。顺序写死在
  `ARTSTATION_FINGERPRINTS`，逐个试到非挑战响应为止；
- 挑战判定必须**同时**认两种页面：JS 挑战（`challenge-platform`/`Just a moment`）
  与拦截页（`cf_challenge_text_small`）；此外「本该是 JSON 却回了 HTML」也算挑战，
  少认一种就会让降级链在中途静默断掉；
- `server/public-http.mjs` 的 `openPublic` 在拿到 403 时**自动降级**到这条路径，
  调用方（搜索 / 单件解析 / 作者浏览 / 图片清单）都无需知道自己走的是哪条路。
  `GET /api/artstation/health` 会回一份 `outbound` 状态，便于确认二进制是否就位。

降级是兜底而不是主路：Sketchfab、图片 CDN、`/projects/<hash>.json` 的常规请求仍走原来的 Node 出站，
只有真的被 403 拦下才切指纹。

## 身份与去重

ArtStation 的 `hash_id` 是 4–20 位字母数字，而模型库沿用 Sketchfab 形状的身份规则
`^[a-f0-9]{32}$`。所以搜索结果用 `md5("artstation:" + hash_id")` 生成 **稳定 32 位十六进制 id**，
收藏、模型库去重、任务记录、卡片选中这套既有机制无需任何改动即可复用；
反向仍由 `platform === 'artstation'` + `artId` 还原作品地址。

## 按作者浏览

输入用户名可以翻看 TA 的**作品**（`/users/<name>/projects.json`）或**点赞**（`/users/<name>/likes.json`）。
两者复用搜索那套归一化，所以结果直接进现有卡片、多选、收藏、模型库与下载队列。

- **翻页必须显式钉住 `per_page`**（48）。接口不传时默认 50，但那样“每页多少条”就成了隐含约定；
  更麻烦的是最后一页通常不满页，拿本页条数当页大小会算多一页。钉住之后
  `consumed = (page-1)*perPage + items.length` 才是精确的（198 个作品 = 4 满页 + 1 不满页，测试有覆盖）。
- 游标只回放自己那两种地址：`validateArtistCursor()` 要求
  `/users/<name>/(projects|likes).json`，并校验页码与 `per_page`。
- `projects` 列表不带内嵌 user 对象，所以作者名用被浏览的用户名补齐；`likes` 保留原作者。
- 作者资料卡（头像/简介）是**尽力而为**：拿不到就只显示列表，不影响浏览。

## 图片作品：没有 `.mview` 时怎么入库

非 Marmoset 作品的下载链路只做三件事，其余全部复用共用队列：

1. 读 `/projects/<hash>.json`（同一个出站层，会自动降级到浏览器指纹）；
2. 取 `asset_type === 'image'` 且 `has_image !== false` 的资产，把 `image_url` 一律重指到
   **`large`** 渲染件——`original` 对非作者**一律 403**，所以 `large` 才是一般人能拿到的原图。
   这一步是 `server/artstation-cdn.mjs` 的 `downloadUrl()`：**非 ArtStation CDN 主机的 URL 直接拒绝**，
   被篡改的作品 JSON 无法把这条链路指向任意服务器；
3. 下载、打包、写 `info.json`。

规则与边界：

- **扩展名按字节决定，不看 URL**：下载后嗅探魔术字节（JPEG/PNG/GIF/WebP/AVIF/BMP/TIFF），
  用同一份规则（`server/archive.mjs` 的 `imageFormat()` / `inspectImage()`，与校验器共用）命名文件。
  改名过的 CDN 对象因此不会写出「扩展名与内容不符」的交付物。
- 上限：单文件 48MB、整个交付物 512MB、单作品最多 60 张（超出以 `skippedCount` 如实记进 `info.json`，
  不静默丢弃）。越界在下载阶段就报错，不必等校验器去解释一个尺寸问题。
- 交付形态与 Marmoset 链路完全一致：`deliver: 'folder'` 写散文件、`'zip'` 写一个压缩包，
  由 `server/deliverable-writer.mjs` 统一写盘，两条链路共用同一份写入与进度逻辑。
- **图片任务不转 FBX、也不发送到 Blender**：没有网格可转。若用户勾了「发送到 Blender」，
  任务照常保存并给出一条明确警告，而不是失败。

### 图片交付物怎么校验

`info.json` 里 `kind: 'images'` 是「这是图片包」的声明，`images` 数组**就是**来源凭证：

- 每个声明过的文件必须真的在包/目录里 —— 少一个说明传输被截断；
- 每一个 `images/` 下的文件必须被声明过 —— 多一个说明有没人担保的内容；
- 每个文件都要通过魔术字节嗅探；
- 仍然校验 `info.json.uid` 与任务 uid 一致，并计算整包 SHA-256。

两个校验器（`archive.mjs` 的 ZIP 校验、`folder-archive.mjs` 的目录校验）用**同一份**实现，
所以 ZIP 与文件夹两种交付的接受标准不会漂移。模型包（没有 `kind` 字段）语义完全不变：
仍然必须有有效 GLB。

## 与 Sketchfab 共用的下载队列

两个平台的“下载”是**同一条后台队列**，没有第二套任务注册表、也没有第二个任务面板：

- ArtStation 转换是**普通下载任务**（`kind: 'artstation'`），走 Sketchfab 那套
  `DownloadManager`：持久化、并发、暂停队列、重试、取消、ZIP/GLB 校验、保存去重、
  “所在文件夹”全部共用。因此**“转换”就等于“入队”**，不需要先点转换再点下载压缩包。
- 入队接口是 `POST /api/downloads/tasks`，请求里带 `kind`；任务的下载进度、SHA-256、
  日志与 Sketchfab 任务在同一个列表里显示（格式徽标区分：Marmoset 作品是
  `MARMOSET → GLB ZIP`，图片作品是 `作品图片 ZIP`）。
- 单个作品粘贴地址后**识别完直接弹出同一个授权确认框**，确认即入队。
- 来源校验靠任务 `uid`：`info.json.uid` 必须等于入队时的 uid。
  uid 由任务下发给转换器（而不是各自再算一遍），
  `md5("artstation:" + hash_id)` 是全流程唯一的身份来源。

## 封面图：只给方形缩略图，且它多一层时间戳目录

搜索接口只返回 `smaller_square_cover_url`，而且**方形渲染件被塞在时间戳目录里**，其它尺寸都是该目录的兄弟：

```
…/p/assets/images/images/013/225/918/20181004021932/smaller_square/name.jpg   ← 搜索接口给的
…/p/assets/images/images/013/225/918/medium/name.jpg                          ← 兄弟（正确）
…/p/assets/images/images/013/225/918/20181004021932/medium/name.jpg           ← 只替换尺寸名 → 403
```

**只替换尺寸名会保留时间戳**，等于向 CDN 要一个从未存在过的对象，S3 回 `403 application/xml`。
实测 300 个 Marmoset 作品：**116 个（38.7%）是这种带时间戳的形状**，其余 184 个正常——
这就是「有些缩略图加载失败」的全部原因。

规则集中在 `server/artstation-cdn.mjs`，而且**按结构匹配、不写死尺寸名**：

- 路径尾部固定是 `<渲染尺寸>/<文件名>`；
- 若它前面还有一层 `YYYYMMDDHHMMSS` 目录，换成兄弟尺寸时必须**一并去掉**；
- 网格要 `medium`（方形图中位 53 KB，medium 约 235 KB，清晰得多）。

CDN 偶尔对某个渲染件回 403/404（该尺寸没生成），所以图片代理 `/api/image` 会按
`ARTSTATION_COVER_LADDER`（`medium → large → small`）依次重试，全部失败才报「缩略图不可用」。
**请求的原始地址永远是第一个候选**：非 ArtStation 的图（如 Sketchfab）不会被改写，也不会多打一次请求。

> **断言封面不能只看 `<img src>`**：URL 正确但被 CDN 拒绝时，图片一样是空的。
> 所以浏览器测试断言 `.thumbnail` 的 `naturalWidth > 0`，并且假出站层只提供「去掉时间戳的 medium」
> 那一个 URL——能画出像素，就证明整条链路（网格 → `/api/image` → CDN 路径规则）都跑对了。

## 画廊视图：按原图比例排的瀑布流

ArtStation 平台的结果可以切到**画廊**（`.display-tools` 里的第三个按钮 `#gallery-view`，只在
ArtStation 平台出现）：封面按各自的宽高比排成多列瀑布流，卡片只留图片，标题、作者、收藏与勾选
在悬停时才浮现。判据集中在 `src/library/gallery-view.js`——「按钮显不显示」与「视图生不生效」
共用同一个 `galleryAvailable()`，两者不可能各说各话；切平台或离开发现页一律回到网格。

两件事决定了它只能这么做：

- **档位**：A 站的等比档只有 `small` / `medium` / `large`。`micro`、`thumbnail`、`card` 之类在桶里
  **根本没有对象**（回 403 `application/xml`），`smaller_square`/`small_square` 是方形裁切、排不出瀑布流。
  画廊点名要 `small`（固定宽 800、高按比例，平均约 130 KB，比 medium 轻三分之一）：
  请求走 `/api/image?…&rendition=small`，而**档位必须在 `ARTSTATION_COVER_RENDITIONS` 白名单里**，
  名单外的值按原样请求，绝不照着编一个不存在的地址出来。
- **比例**：搜索行**不带宽高**（只有 9 个字段，也没有 `assets` 数组，作品内的多张图拿不到）。
  所以瀑布流先按 1:1 占位，图片解码后由 `load` 回调把真实比例写回 `img.style.aspectRatio`。
  视口外的封面是 `loading="lazy"`，因此**断言只能写成「已解码的那几张」**，等「全部加载完」永远超时。

极简之后有一处必须照顾：勾选框要挪到顶部，否则会被悬停时浮现的底部遮罩压住、点不到。

**没有 Marmoset 场景的作品不进预览弹窗。** 这种作品（全站搜索会搜到的 2D 插画）本来就没东西可预览，
弹窗里只有一句「没有内嵌场景」，点一次白点一次。所以媒体区的入口按类型分流：有场景的照旧开 3D
预览弹窗，纯图片的直接 `window.open` 官方作品页。网格和画廊共用同一套规则（两种视图的卡片都有这个
入口），`artstation.has3dScene()` 这一个判定同时决定按钮文案（`交互式 3D 预览` / `打开作品页`）与点击行为
——文案和行为不能各判一次，否则迟早出现「写着预览、点了跳外链」。

## 边界与安全

- **只读公开接口**：不登录、不带 Cookie，只请求搜索、作品 JSON、作者列表这几类公开端点。
- **翻页游标只回放自己的地址**：`validateCursor()` 只放行搜索接口，
  并对每个 filter 走白名单（`asset_types`/`category_ids` 必须是 include、`editor_pick` 必须是 equal），
  页码 1–400、`per_page` ≤ 75；作者浏览走 `validateArtistCursor()`。其余一律拒绝（防 SSRF 与筛选逃逸）。
- **筛选值白名单**：排序只接受 `relevance | popular | newest | ranking`；
  分类必须是数字 id；精选是布尔值；资产类型匹配 `^[a-z0-9_]{1,32}$` 且由分面清单提供。
- **图片只从 ArtStation CDN 取**：`downloadUrl()` 拒绝任何其它主机，作品 JSON 无法把链路指向外部。
- **成人内容与残缺行直接跳过**（`is_adult_content` / `hide_as_adult` / 无合法 `hash_id`），
  跳过数量以 `warnings` 形式如实上报，不静默吞掉。
- 一批最多 **20 个** ArtStation 作品（Sketchfab 为 50），两种来源**不允许混批**，
  混选时明确提示分两批。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/artstation/filters` | 分类、排序、资产类型分面清单（服务端缓存） |
| GET | `/api/artstation/artist?username=` | 作者资料卡（尽力而为，拿不到不影响列表） |
| POST | `/api/artstation/search` | `{q,sort,category,assetType,picked,cursor}` → 归一化后的模型列表 |
| POST | `/api/artstation/search` | 作者浏览：带 `{artist:{username,tab,page}}` 或作者列表游标 → 归一化后的模型列表 |
| POST | `/api/artstation/resolve` | 单件：解析作品内嵌 Marmoset 场景（含稳定 `uid`） |
| GET | `/api/artstation/health` | mviewer 状态 + 出站层（curl-impersonate）状态 |
| POST | `/api/downloads/tasks` | 入队（带 `kind: "artstation"`）→ 交给共用下载队列 |

写接口都需要 `X-SFX-Local: 1`。

内嵌预览的 CSP 由 `server/library.mjs` 的 `FRAME_HOSTS` 清单派生（一行一个平台的预览域名）。
ArtStation 嵌入的是作者自己的 `https://www.artstation.com/embed/<id>`（该页面**没有**禁嵌响应头，
可以安全内嵌；作品页本身带 `X-Frame-Options: SAMEORIGIN`，所以只嵌 embed 页）。
**漏掉任一行，对应平台的 3D 预览就会被浏览器拦成「已阻止此内容」，而 iframe 的 `src` 看起来仍然正常**——
排查时先看 `frame-src`，不要只看 `src`。

## 回归测试

```sh
npm run test:artstation        # 单元：参数校验、URL 构建、游标限制（搜索 + 作者）、id/归一化、失败上报、缓存
                               #      + 封面 CDN 规则（时间戳目录、尺寸阶梯、下载尺寸与主机白名单）
                               #      + 作者浏览：分页边界（198 个作品）、点赞保留原作者、资料卡尽力而为
                               #      + 图片链路：资产筛选、扩展名按字节、上限、ZIP/文件夹两种交付、
                               #        清单双向比对、非图片内容被拒、队列分派与不做 FBX/Blender
                               #      + 共用下载队列：uid 来源校验、GLB 缺失、重试/暂停/取消/持久化
npm run test:core              # 单元：画廊判据（可用范围、档位请求、比例回写）与
                               #       `/api/image` 的档位白名单（名单外不发明地址、非 A 站不重写）
npm run test:library:browser   # 真浏览器：平台切换、跨平台合并、筛选转发、翻页、授权文案、共用任务卡片、预览 iframe、
                               #           封面真的画出像素（naturalWidth）、以及"预览没有被自己的 CSP 拦掉"
                               #           + 画廊：CSS 列真的生效、chrome 藏到悬停、请求的是 small 档、
                               #             解码后比例被写回、3D 作品仍写 3D
                               #           + 入口分流：纯图片作品点开的是官方作品页（window.open 收到 /artwork/
                               #             地址）而不是 3D 预览弹窗，网格与画廊同一套规则
```

> `npm run fetch:curl-impersonate` 会拉取出站层用的 `curl-impersonate.exe`。
> 单元测试不依赖它（假出站层注入即可），但真机验证 Cloudflare 拦截端点需要它。
