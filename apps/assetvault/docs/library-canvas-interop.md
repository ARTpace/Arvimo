# 资产库 × 画布 互通：现状与开发切片

状态：设计文档，三个切片均未实施。日期：2026-11-13。

本文只处理「资产库」与「画布（Artflow iframe）」之间的数据流，不涉及发现页采集和下载队列。

## 一、已经通的通道（别重复造）

| 方向 | 机制 | 证据 |
| --- | --- | --- |
| 库 → 画布 | 引用导入 `assetvault:import-refs`，只传 `{uid,src,name,kind,mimeType}`，画布以 src 实时取图 | [artflow-embed.js:264](../src/library/artflow-embed.js#L264) |
| 画布 → 库 | 画布内 `blob:` / `data:` 素材存档前 POST `/api/library/drop-import`，落进同一张 `assets` 表 | [artflow-embed.js:80](../src/library/artflow-embed.js#L80) |
| 画板 ↔ 合集 | 画板与资产库合集同 ID、同成员，服务端双向对齐增删 | [canvas-boards.mjs:107](../server/canvas-boards.mjs#L107) |

所以「拖进去能看、画布里加的会进库」这两件事已经成立。下面三处是断点。

## 二、三个断点

1. **元数据不回流**：画布节点只有 uid + 图，标签、评分、收藏、备注在画布上完全不可见。
2. **失效引用只能看不能修**：资产被删或目录搬走，画布显示占位，必须切回资产库手动找。
3. **画布产物回不了库**：框选/整板快照没有出口，只能截图丢桌面。

## 三、三个切片共同的约束

- **单一真相**：资产行在 `assets` 表，画布文档在 `canvas_project`。宿主与 iframe 都不新建第二份素材记录。
- **画布只存引用**：任何新通道都不许把像素烤成 data URL 塞进存档。
- **只走 postMessage**：新增消息带版本字段，旧画布收到不认识的消息必须静默忽略，不能报错中断。
- **只读访客不触发写**：局域网访客的只读总闸在 [lan-sharing.mjs](../server/lan-sharing.mjs) 里，新接口默认不进白名单。

---

## 切片 A：节点元数据角标

**目标**：画布上每个引用资产库的节点，角落显示收藏星、评分、用户标签数、AI 标签数；资产已失效时显示「失效」角标（同时成为切片 B 的入口）。

**数据源（现成，不需要新端点）**：`POST /api/library/assets/detail`，请求 `{uids:[...]}`，返回 `{details:[{uid,rating,note,favorite,userTags,aiTags}]}`。硬上限 200 个 uid。见 [library-api.mjs:621](../server/library-api.mjs#L621)。

**实现点**

1. 宿主 `artflow-embed.js`：在 `pull()` 完成、`import-refs` 之后、板切换时，收集当前板节点里的 `uid`（去重、分批 200），请求 detail。
2. 新增宿主 → 画布消息 `assetvault:asset-meta`，载荷 `{v:1, items:[{uid,favorite,rating,tags,aiTags,stale}]}`，`stale` = detail 里查不到该 uid。
3. Artflow 侧（`embed/embed-host.ts` + 元素渲染层）：把 items 存进一个 Map，节点渲染时读角标；未命中就按 `stale` 画失效标记。
4. 刷新时机：进入画布、板切换、`assets/detail` 返回后。**不要**在拖动/缩放过程中请求。

**验收**

- 在库里给某资产点收藏，回画布刷新，该节点出现星标。
- 删除库里的资产，画布节点显示失效角标，且不报错、不空白。
- 350 个节点的板只发 2 次 detail 请求（200 + 150）。

**不做**：不传整行资产模型，不传向量与预览图，不在画布侧做标签编辑（写入仍回库）。

---

## 切片 B：失效引用就地重连

**约束（必须守）**：`/api/library/relink-file` 只接受**已登记导入根**内的相对路径，且只信任本机同源页 + `X-SFX-Local: 1`，见 [library.mjs:832](../server/library.mjs#L832)。所以在 iframe 里「猜路径自动修复」既做不到，也不该做。

**做法**

1. 画布上点失效角标 → postMessage 回宿主 `assetvault:relink {uid}`。
2. 宿主打开现有的重连面板（导入根 + 目录浏览，复用 relink 的既有 UI），不新写文件选择器。
3. 成功后：重新推一次 `assetvault:asset-meta`，并把该节点 src 换成新 URL（`assetvault:refresh-src {uid,src}`）。

**关键**：重连只换 locator，**uid 不变**，收藏、标签、所在合集都不丢。这条是它值得做的唯一理由，实现时别顺手重新生成 uid。

**验收**

- 资产目录整体搬家 → 画布占位 → 重连 → 节点恢复图，库里的标签/收藏/合集成员关系原样。
- 重连失败（文件不在所选根下）给一句可执行提示，不留白、不静默。

---

## 切片 C：画布产物入库（带 provenance）

**现状**：`snapshot` 只回元素矩形（`api.snapshot()` → `elements`），**没有像素**，见 [embed-host.ts:159](../../artflow/embed/embed-host.ts#L159)。

**方案 C1（推荐，画质与画布一致）**

1. Artflow 侧加 `api.exportImage({scope:'board'|'selection'})` → 返回 PNG `Blob`/dataURL（本体已有渲染层，导出走同一套绘制）。
2. 新消息 `assetvault:snapshot-image` → `assetvault:snapshot-image-result {v:1, png}`。
3. 宿主 POST `/api/library/drop-import`（`X-AV-Drop-Name` 带板名+时间戳），入库返回 `{asset:{uid,url,thumbnail,bytes}}`。
4. 写 provenance：`{boardId, sourceUids:[...]}` 落到资产 note 或扩展字段，方便以后反查「这张图从哪块板来」。

**方案 C2（不改 Artflow）**：宿主按 elements 的 x/y/w/h/rot 自己 canvas 合成。要重新下载全部图、自己处理旋转与 z 序，容易和画布所见不一致，只在 C1 排期不上时考虑。

**边界**

- `drop-import` 单文件上限 512 MB，超限返回 413，不要在前端截断。
- 入库走 SHA256 去重；重名默认 keep-both，不要覆盖已有资产。
- 快照命名不要用纯时间戳，至少带板名，否则库里一堆 `snapshot-1730xxxx.png`。

**验收**

- 快照入库后立刻出现在资产库网格，可搜索、可打标、可再次拖回画布。
- 同一块板连续两次快照生成两条资产，不互相覆盖。
- 只读访客点快照按钮时被拦（不落盘、不写库）。

---

## 之后可能接的（本文不实现）

| 方向 | 依赖 |
| --- | --- |
| 智能合集：同色系/同标签/同来源自动进板 | 复用 [board-rule.js](../src/library/board-rule.js) 规则引擎，需要合集侧支持规则型成员 |
| 画布接生成：板上参考图直接进 ComfyUI img2img | 库 → 生成通道已通，画布缺一段导出 |
| 板级 AI：整板参考图归纳配色/材质、反写 prompt | 依赖 AI 通道与现有 ai-settings |
| 只读分享板：队友浏览器看板、批注 | 复用 LAN 只读总闸，需要板级权限 |
| 资产版本与画布历史对齐 | `operationHistory` 已存，缺版本切换语义 |
| 下载完成自动落「收集箱」板 | 复用 [board-collect.js](../src/library/board-collect.js) |

## 风险清单

- **200 uid 上限**：大板必须分批，否则整块 meta 静默丢失。
- **iframe 版本漂移**：画布是独立构建（`SFX_ARTFLOW_SRC`），宿主与画布要能各自升级；所有新消息必须带 `v` 且可缺省。
- **写入权限**：新端点默认不开给局域网访客，避免「只读」被侧门绕过。
- **性能**：meta 只在板内容变化时拉，拖动中一次都不发；否则大板会掉帧。
