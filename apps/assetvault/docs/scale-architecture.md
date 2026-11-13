# 资产库规模化与协作架构（工作室商用版）

> 目标形态：**工作室私有部署**。一台常开主机跑服务端，局域网内多人用浏览器访问同一个资产库。
> 规模目标：**单库 50 万资产**，标签关系约 300 万行。商用分发（可闭源），需授权、审计、备份。
>
> 本文是施工契约，不是提案。实现必须遵守本文的「边界」与「验收」两节。

---

## 1. 约束与目标

| 维度 | 目标 | 明确不做 |
|---|---|---|
| 部署 | 单主机 + 局域网多客户端 | 不做公网 SaaS、不做多租户 |
| 规模 | 单库 ≤ 50 万资产 | 不做单库百万（靠分库承载） |
| 并发 | 多人同时浏览、打标、整理 | 不做离线冲突合并（客户端不持有写权限） |
| 授权 | 按席位/设备，离线校验 | 不做在线激活服务器 |
| 数据 | 全部留在客户机器上 | 不上传任何资产内容 |

**分库是产品能力，不是技术妥协**：单库超过 50 万提示新建库。百万级 = 2~5 个库。

---

## 2. 现状诊断（带代码位置）

| 问题 | 位置 | 后果 |
|---|---|---|
| 权威是整块 JSON，DB 只是派生 | `library-storage.mjs:109-139` | 每次写入整库序列化 + 全量重写 |
| 每次写入重建全部派生表 | `library-db.mjs:52-58` `rebuildDerived` | 打一个标签 = `DELETE` 后重插 50 万行 assets + 300 万行 tags + FTS |
| 查询全量载入内存求值 | `library-query.mjs:226-245` | 每次筛选扫描全库 |
| 每行 `JSON.parse(payload)` | `library-query.mjs:68` | 单次查询解析 50 万个 JSON |
| 标签无面/层级/别名 | `library-schema.mjs:48-54` | 归类失败：同义词散成多个 chip |
| 写入无版本号 | `library-mutations.mjs:33` | 两人同时打标，后写者覆盖前者整组 |
| 无变更推送 | `board-hub.js:83` 轮询 | 看不到别人的改动 |
| 无角色 | `lan-sharing.mjs` | 任何登录者可删库，无法追溯 |

**已有可直接复用的资产**：`schema_migrations` + checksum 迁移链（`library-schema.mjs:13-19, 108-119`）、`mutate()` 增量写入口（`library-storage.mjs:160-170`）、FTS5 trigram 索引、`collections`/`smart_collections`、`process-lock` 单实例锁、LAN 登录与会话。

---

## 3. 决策记录（ADR）

### ADR-01 不 fork Serpent，只搬设计

Serpent 是 MIT（可商用闭源），但 29.4 万行 TypeScript，单文件 `library-service.ts` 达 **51,673 行 / 147 个函数**，且**没有 HTTP 服务层**（Electron IPC）。AssetVault 的护城河（Sketchfab/ArtStation/ambientCG 采集、下载、glTF/FBX 导出、Blender 桥，约 1.5 万行）它完全没有。

搬这四处设计，不搬代码：

| Serpent 源 | 搬什么 | 落点 |
|---|---|---|
| `library-service.ts` 建表段 + `ensure*Schema` | 分段迁移 + checksum + 降级链 | `server/library-schema.mjs`（已有雏形） |
| `ensureContentFingerprintColumn`（:3391） | 内容指纹去重 | `content_tags` 表 + `asset-fingerprint.mjs` |
| `ai/protocol.ts:99-148` | 打标三闸（不在词表就丢弃、大小写归一、语言约束） | `server/ai-search.mjs` 的 `tagAssets` |
| `listTagNamesForAiPrompt`（:22127） | 候选词 = 频次 top N + 同文件夹优先 | `server/tag-vocab.mjs` |
| `jobs` 表 + `plugin-job-repository.ts` | 任务状态机 | `jobs` 表 + `server/tag-jobs.mjs` |

### ADR-02 DB 转权威，状态按域拆分（S3 收尾已落地）

- 状态不再是「一整串 JSON」，而是**四个互不拖累的域**，各写各的文件（`state/<key>.json`）：
  目录域 `sfx-library-v2`、用户域 `sfx-library-user`、探测域 `sfx-library-probe`、会话域 `sfx-library-session`。
- **用户域的权威是 SQLite**（评分 / 备注 / 收藏 / 用户与 AI 标签），前端只发集合语义 op；
  其余三域以文件快照为权威，DB 是可重建的派生索引。
- `library-state.json` 退化为**旧版迁移源 + 导出快照**：只在首次升级时读一次，运行时不再写它。
- 派生层用 `mergeDomains()` 把四域合成一份完整 state，所以查询语义不变、写入不再互相拖累。
- DB 不可用 → 自动退回纯文件模式并告警（`ensureIndex()` 会在下次恢复时自愈），绝不双权威。
- 旧前端不认新域 key：`load()` 只在域确实带来新内容时，把四域合并回主 blob 作为**读视图**，
  「save 后 load 逐字节还原」的硬契约因此仍然成立。

### ADR-03 标签写入用集合语义，不用整组替换

- 标签是集合：`tag.add` / `tag.remove` 幂等且可交换，两人同时加不同标签天然合并，无需锁
- 单值字段（名称、备注、评分、封面）用 `rev` 乐观锁，冲突返回 409 由前端提示
- 纪律：**任何写路径都不得用「设置整个数组」的方式改标签**

### ADR-04 一词多面是「边」，不是「列」

面归属是词条属性（`tag_facets` 多行），不是标签行属性。检索时：点值命中该值 + 全部子孙；点面命中 facets 含该面的所有值。统计必须按 `uid` 去重。

### ADR-05 阶段 5.1：`asset:*` op 让目录域也能定点写服务端

- **背景**：ADR-02 之后用户域权威在 DB，目录域仍以文件快照为权威；派生层按**合并语义** upsert，
  `assets` 表实际上已经是「服务端全量目录」—— blob 里没有的行原样保留（`library-db.mjs` 的
  `mergeDerived` / `removeAssets` 注释）。因此 DB 里比快照多的行是**合法历史资产**，不是脏数据：
  **禁止「以快照为准重建索引」**，那会直接删掉用户库里的资产。`/api/library/assets/remove`
  早已提供定点删除，缺的只是定点新增 / 更新与统一协议。
- **决策**：新增 `asset:add` / `asset:patch` / `asset:remove` 与 `POST /api/library/assets/mutate`。
  服务端定点写 `assets` 及其派生表（标签 / 格式 / FTS / 计数），**不写 blob**；
  整块 GET / POST 通道全程保留到 5.5。5.1 只动服务端，前端仍走整块（5.2 才切）。
- **冻结契约**：
  1. op 形状 `{op, uid, model?, patch?, rev?}`；幂等键 = `uid`；重复 `add` 等价于 `patch`。
     `model.uid` 一律以 `op.uid` 为准，杜绝写出第二条幽灵资产。
  2. `position` 由服务端分配：新增取 `MIN(position)-1`（稳居最前），`patch` 保留原值；
     `models` 顺序 = `assets.position ASC`，不再由浏览器数组下标决定（5.3 起生效）。
  3. `rev` 乐观锁：传了且与 DB 不符 → 该条记 `rev_conflict`、整批其余照常应用，
     响应 409 让前端重读后重试；写成功 `rev + 1`，每条留审计行。
  4. 回收站：沿用 `assets.state='trashed'` + `trashed_at`（**v4 已有列，不需要 v5 迁移**）。
     `asset:remove` 是彻底删除；作废 / 恢复走 5.4 单独迁移，5.1 的 `patch` 明确禁止改
     `state` / `trashedAt`，避免产生「state 变了但 trashed_at 没变」的半截状态。
  5. 兼容层：`SERVER_VERSION 3.18.0` + 能力位 `assetOps`；`AV_LEGACY_BULK=1` 时新路由返回
     409 并指回整块通道；DB 不可用返回 503 + `legacyBulk:true`，整块写入全程不受影响。
     `libraryDbAuthoritative` 留给 5.5 真正拆掉整块通道时再置 true。
- **回滚**：新路由是纯增量，不改任何已有写路径；关掉能力位或删掉路由即回到 5.0。
  能力位与版本号会让启动器自动换掉旧进程，不存在「前端调新接口撞 404」的窗口。

### ADR-06 阶段 5.2：下载入库改走 `asset:add`，过渡期主 blob 双写

- **背景**：5.1 的 `/assets/mutate` 只写 DB、不碰 blob。但前端启动 `loadLibrary` 以服务端主 blob
  为准，只发增量会让新资产刷新后从浏览器消失；更危险的是 `asset:remove` 之后旧 blob 里的行
  会在下次 `mergeDerived` 合并写入时把已删资产**复活**。
- **决策**：`applyAssetOps` 新增 `syncBlob` 选项（默认 `false`，保住 5.1 纯 DB 语义）；
  HTTP 路由固定 `syncBlob:true`，由服务端在**同一事务内**把新增 / 修改 / 删除的 model 同步进
  主 blob 的 `models` / `trashed`，并推进 `db_meta` 域戳（否则 readValues 会误判文件快照更新）。
  5.5 拆掉整块通道后停双写。
- **前端分流**：`translateStateChange` 新增 `adds` 字段，仅当「旧 models 逐条字节一致且只在
  尾部追加、trashed 不变、removes 为空、uid 合法、≤200 条」时才拆成 `asset:add`；
  其余任何变化照旧整块 `catalog`。`postDomains` 顺序改为
  `adds → 用户域 op → session → probe → removes → catalog`，保证 `tag.add` 不会打到还不存在的资产。
- **兼容层**：新路由 404 / 405 / 409 / 503 或抛错 → 只关掉 `assetOpsEnabled`、本次整块重放
  完整主状态，其余分域通道不受影响。`SERVER_VERSION 3.19.0` + 能力位 `assetIngestIncremental`。
- **取舍**：服务端下载 job 里没有完整 model 字段，所以**没做**「下载完成回调由服务端自动入库」，
  仍由前端 `collectModels()` 触发增量；等 5.3 启动读改按页后再评估是否把入库完全搬到服务端。
- **已知窗口**：主 blob 与 DB 仍双轨（过渡期故意保留），5.3 才拆；`asset:patch` 仍禁止改
  `state` / `trashedAt`，回收站迁移留给 5.4。

### ADR-07 阶段 5.3a：读侧目录域改由 DB 权威合成

- **背景**：把读路径摆清楚后发现两个事实。① 目录域的读视图仍来自 `state_meta` 主 blob，
  而 5.1 之后 `assets` 表是合并语义的服务端全量目录 —— 实测 DB 52 active / blob 48，
  那 4 条合法历史资产**前端永远看不见**，下载入库定点写出来的行也可能因 blob 落后而不可见。
  ② ADR-05 契约 2 约定 `models` 顺序 = `assets.position ASC`，但读视图还按 blob 数组下标，
  服务端分配的新增位置（MIN-1 置顶）在刷新后会被打回原样。
- **决策**：`createLibraryDb` 新增 `readCatalog()`，按 `state` 分组、`position ASC, rowid ASC`
  还原 `models` / `trashed`；`libraryStorage.load()` 在 DB 可用时把它合成进主 blob 的**读视图**，
  仅当内容真的变化才替换字符串，保住「save 后 load 逐字节还原」的 diff 硬契约。
  写路径一行不改，整块 GET / POST 通道照旧。
- **安全闸**（三条，缺一不可）：
  1. DB 目录为空时**不接管**读视图 —— 索引刚建 / 尚未同步时不能拿空表盖掉文件里的资产；
  2. `readCatalog()` 逐行 `JSON.parse`，坏 payload 只跳过该行；
  3. `AV_LEGACY_CATALOG=1` 或 `options.catalogDbAuthoritative:false` 立即回到 blob 读视图，
     DB 不可用也自动回退。`/api/health.storage.catalog` 如实标明当前来源。
- **为什么「首屏按页」不放在本轮**：整块 GET 同时是前端 `lastParsed` 的 diff 基准和
  `saveLibrary()` 的写入源，而按页补进来的模型带 `_remoteOnly`、保存时被过滤。只拆读侧，
  「删除 / 移入回收站」会在下一次 diff 里被误判成 `asset:remove` 彻底删除。所以首屏按页必须
  与 5.4（回收站 / 全选改定点 op）、5.5（停双写、拆整块通道）作为一个原子改动一起切。
  本轮先把读侧权威和顺序语义钉死，让那一刀不必同时兼顾数据回灌。
- **兼容层**：`SERVER_VERSION 3.20.0` + 能力位 `catalogDbAuthoritative`。读取失败只告警并
  沿用文件快照，不阻断启动；回滚只需关能力位或删掉 `load()` 里的合成段。

### ADR-08 阶段 5.4：回收站改定点 op，全选留到 5.5

- **背景**：5.3a 之后目录读视图以 DB 为权威，但作废 / 恢复 / 清空回收站仍由浏览器改
  `state.models` / `state.trashed` 后整块回写 catalog。按页启动一旦落地，`saveLibrary()`
  会过滤掉 `_remoteOnly` 模型，「移入回收站」在下一次 diff 里就只剩「model 消失」这一个信号，
  与彻底删除无法区分 —— 这是 5.3 推迟首屏按页的直接原因，本轮拆掉它。
- **决策**：新增 `asset:trash` / `asset:restore` 两种 op（形状沿用 `{op,uid,model?,rev?}`，
  `model` **可选**，不传则由服务端从 DB payload 还原，按页前端只发 uid 也能工作）。服务端在
  5.1 的同一个事务里改 `assets.state` + `trashed_at`、按目标状态重算这一条派生行、推进
  `rev` / 审计 / SSE，并复用 5.2 的 `syncBlob` 把 model 在 blob 的 `models` / `trashed` 之间搬好。
  `asset:patch` 仍禁止改 `state` / `trashedAt`，杜绝「state 变了但时间没变」的半截状态。
- **前端分流**：`translateStateChange` 新增 `trash` / `restore`，只认**纯移动**形状：所有 model
  的 uid 合法、留下来没动的部分逐字节一致、无彻底删除、≤200 条。清空回收站（purge）若只减少
  `trashed` 且 `models` 不变，则只发既有 `removes`、不回传 catalog。任何混合改动一律整块。
  `postDomains` 把 `adds + trash + restore` 合成**一批** `/assets/mutate`，顺序天然是「先入库再移动」；
  404 / 405 / 409 / 503 或异常 → 关掉该通道、把 catalog 改回完整主状态整块重放。
- **顺带修掉一个真 bug**：旧差量逻辑把「回收站里消失的 uid」直接当成彻底删除，于是
  **恢复资产**也会被列进 `removes`、误发 `asset:remove`。现在只有「既不在 trashed、也不在 models」
  的 uid 才算彻底删除。单测钉死「恢复时 removes 为空」。
- **业务层零改动**：`trashModels` / `restoreModels` / `purgeModels` 与所有 UI 按钮保持原样，
  变化全在持久化边界，这是 ADR-02 分域翻译层本来就该承担的活。
- **全选为何推迟**：全选当前是 `filtered().forEach(...)`，依赖浏览器里的全量 `state.models`；
  只有首屏按页之后它才必须改成「向服务端要当前筛选命中的 uid 集合」。因此全选与 5.5
  （停双写 + 拆整块通道 + 按页启动）是同一个原子改动，不单独做半截。
- **兼容层**：`SERVER_VERSION 3.21.0` + 能力位 `assetTrashOps`；回滚 = 关能力位或删掉翻译层分流，
  整块 catalog 通道全程保留。

### ADR-09 阶段 5.5：DB 单一写入权威 + 启动按页 + 整块通道收口

- **背景**：5.1～5.4 已把目录写改成定点 op、读视图改成 DB 权威，但 5.2 的 `syncBlob` 仍把每条
  资产双写进主 blob，且 `GET /api/library-state` 仍一次性下发整份目录。过渡期结束条件已齐：
  回收站、下载入库、删除都已有定点 op，主 blob 不再是目录的容灾副本。
- **决策（四刀同一事务语义）**：
  1. **停双写**：`/assets/mutate` 不再传 `syncBlob:true`，`assets` 表成为目录的唯一写入权威。
     `AV_SYNC_BLOB=1` 可临时恢复过渡期双写用于排障。
  2. **整块通道收口**：`commitValues()` 统一在写盘前把主 blob 的 `models` / `trashed` 置空，
     非目录字段以本次写入为准、缺的从当前快照补齐。**放在公共写函数而非 `save()`**，是因为
     `mutate()` / 降级重放 / 旧差量通道都会经过它；只改 `save()` 会漏。这样 `mergeDerived`
     与 `ensureIndex` 再也拿不到过期目录，已作废 / 已删除的资产不会被回灌复活。
     DB 未探测成功或已降级时不剥离，文件模式仍按旧双轨工作。
  3. **启动按页**：`GET /api/library-state?catalog=paged` 返回瘦身读视图（只保留完整回收站 +
     非目录域），新增 `GET /api/library/catalog/page`（SQL `LIMIT/OFFSET`，按 `position` 排序）
     与 `/api/library/catalog/uids`（全选只用 32 字节 uid）。前端第一页阻塞启动，其余页后台补。
  4. **全选服务端化**：先等目录补齐，再取服务端 uid 集合与本地筛选结果求交，按页也不会漏选。
- **正确性关键**：`saveLibrary()` 写出的仍是**完整目录**，`translateStateChange` 的 diff 基准
  `lastParsed` 必须在每补一页时同步更新（同一同步块内更新 cache + 基准 + `state.models`）。
  否则「尚未补齐」会被判成删除、误发 `asset:remove` —— 这正是 5.3 不敢单独拆读侧的原因。
  按页补进来的 model 是**真数据**（不带 `_remoteOnly`），因此筛选 / 评分 / 回收站 / 标签
  全部沿用原路径，业务层零改动。
- **降级**：老服务端忽略 `?catalog=paged` 且不回 `catalogPaged`，前端自动走原全量路径；
  新服务端分页接口失败时重新整块 GET 并重放完整目录。DB 挂了时 `/api/health` 的
  `storage.writer` 显示为 `legacy`，此时不剥离主 blob，文件模式照常可读。
- **边界（不假装做完）**：筛选 / 排序 / 计数仍在浏览器本地求值，补齐完成后 `state.models`
  仍是全量工作集，因此**大库内存占用没有下降**；首屏快了、整块传输拆了、写入单一权威了，
  但筛选下推与内存裁剪是 5.6（需与 `filtered()` 的 8 个本地维度一起原子重写，单独切会坏语义）。
- **契约变更**：整块 `POST /api/library-state` **不再承担资产入库**。所有新增资产必须走
  `asset:add`；前端「下载任务自愈」恢复的 `recovered` 也因此补发一批 `asset:add`，否则会被
  剥离逻辑静默丢弃。旧浏览器若仍靠整块 catalog 入库，需要先升级到 5.2 之后的前端。
- **已知影响**：DB 成为目录唯一权威后，主 blob 不再可作目录容灾副本；DB 文件损坏时的恢复路径
  是 `/api/library/backups`，不是旧快照。冷启动 `health.storage.engine:"pending"` 首次查询后转 `sqlite`。
- **兼容层**：`SERVER_VERSION 3.23.1` + `libraryDbAuthoritative` / `catalogSingleWriter` /
  `catalogPaged` 三个能力位；回滚 = `AV_LEGACY_BULK=1` 或 `AV_SYNC_BLOB=1` + 关能力位换回旧进程。

#### ADR-09 补丁（3.23.1）：请求体超限必须回 413，定点写入必须分批

**故障**：升级到 5.5 后应用**卡在启动画面 92%**，表现为「登录后进不去」，无任何报错。
根因是一条**静默吊死**的请求：启动时把下载任务恢复出来的资产补发 `asset:add`，这一批
序列化后 319KB，而 `/assets/mutate` 用的仍是 `readBody` 的 128KB 默认上限 —— 服务端在
`for await` 里 `throw` 时客户端还在上传，连接既没有答复也没有断开，`fetch` 永远 pending。
而这一步是 `await` 的，于是 `createPersistentStorage()` 不返回 → `setup()` 不执行 →
`assetvault:ui-ready` 永不触发 → 启动界面在 92%（`70 + 22` 的天花板）停住，且因为没有任何
异常抛出，连 `assetvault:ui-error` 都不会报。

**修复（两层，都要）**：
1. **服务端**：`readBody` 超限后**继续把剩余数据读完**再抛 413（附 `status`），路由层捕获后
   直接回复；`/api/library-state` 的整块读取同样处理。各路由上限分开：整库导入 64MB、
   定点写入 16MB（单条 model 上限 512KB × 64 条一批）、其余 2MB。宁可回 413，绝不吊死连接。
2. **前端**：`chunkOps()` 按「≤64 条且 ≤2MB」切批发 `/assets/mutate`；`postDomains` 与启动
   补发都走它，只有全部批次被接受才算成功，中途抛错仍整块重放（绝不因为分批而丢写入）。
   启动补发放进 15 秒超时兜底 —— 补发下载资产只是顺手登记，不配拖住启动。

**顺带**：补发前先与已读到的目录（`catalogSeen`）比对，已有的不再重传，正常启动一批都不发。

---

### ADR-10 整库导出 / 导入：只搬语义，不搬目录

**问题**：备份（ADR-02 的 `/api/library/backups`）只能在本机回退，搬不走。
换机、合并两台机器的库、事故后从别处的副本重建，都缺一条通道。
直接复制 `data/` 也不行：里面混着数据库、分域状态、临时文件与端口记录，换台机器必炸
（绝对路径、node ABI、端口号全会打架）。

**决策**：新增一份**可移植 JSON 快照**，只装语义，不装物理布局。

```js
// GET /api/library/export（只读）
{format:'assetvault-library', version:1, exportedAt,
 counts:{assets, trashed, collections},
 assets:[...], trashed:[...], collections:[{id,name,parentId,uids,...}], user:{...}}

// POST /api/library/import（写权限）
{snapshot, mode:'merge'|'replace', confirm:true /* replace 必填 */}
→ {added, removed, trashed, collections, conflicts, seeded, notes, safety}
```

- **导出**：一次 DB 连接读 `readCatalog()` + `readUserDomain()` + 合集，
  用户域作为「种子」并进每条资产（`rating` / `note` / `favorite` / `userTags`），
  所以一份快照拿去新库，标注跟着走。`assetCount` 这类派生结果不进快照。
- **导入**：**绝不直接 INSERT**。全部走 `asset:add` →（回收站）`asset:trash`，
  复用 5.1-5.4 的派生索引、审计、`rev` 与状态机。回收站必须两步：
  `asset:trash` 要求资产已存在，直接把 model 塞进 trashed 会绕过状态机。
- **用户域的补空缺**：`asset:patch` 按 ADR-02 的协作保护规则不碰 `rating/note/favorite`，
  导入端因此新增 `applyUserSeeds()`（SQL `CASE WHEN 当前为空`）——**本机已有标注永远优先**，
  旧快照改不回去。这是「合并两台机器」时最关键的边界。
- **合集**：先建全部合集再挂 items（子树导入时父 id 可能排在子后面）；
  父合集不在快照里就降级成根节点，而不是整份导入失败。
- **replace**：先 `readCatalogUids('active')` 分批 `asset:remove`，且服务端**先自动备份**
  一份现状再动手（`safety` 会回给前端）。必须 `confirm:true`，否则 400。
- **诚实的边界**：AI 标签不迁移（要过词表解析与 FTS 重建，另外可由 AI 重新生成）；
  用户标签只在新资产首次入库时作为种子（`deriveTagRows` 认 `model.userTags`），
  已存在资产的标签保留本机。
- **体积**：`POST /api/library/import` 的 body 上限单独抬到 64MB（其余路由仍是 128KB），
  单份快照最多 20 万条资产、单条 model ≤512KB。

**为什么不和自动备份合并**：备份是「整目录 + SQLite 在线快照」，用于本机回退，保真但不可移植；
导出是「只装语义」，可移植但需要重新派生。两件事的服务对象不同，混成一个会两边都将就。
设置里因此分为两张卡：「自动备份」（`team-settings.js`）与「导出与迁移」（`backup-panel.js`）。

**兼容层**：`SERVER_VERSION 3.23.0` + `libraryPortableExport` 能力位；
老进程没有这两条路由，前端会撞 404，所以必须靠能力位换进程。

**#7 导入根断链重连**（同一轮）：`import-roots.json` 新增 `status()` 与 `relink(from,to)`。
本地包是按「根 + 相对路径」**实时读盘**的，不往库里写绝对路径，所以素材搬家后
**只换扫描根 + 重扫**，卡片自动回来——不需要改写任何资产记录，这是「只读认领」架构的红利。
离线根只标状态（`missing` / `denied`），不删配置、不自动移除；`relink` 会把新位置补进
`local-roots` 白名单，否则重扫认出包了、缩略图却被 403 挡住。

---

### ADR-11 阶段 5.6：筛选下推闭环 + 目录内存裁剪

**背景**：5.5 把目录写入收口成 DB 单一权威后，还剩两个「架构没闭环」的点：

1. **筛选条上还有两个维度会让整条查询退回全表 JS 求值**（`categories` / `downloadable`）。
   用户在筛选条点一下「分类」，服务端就要把整库读进内存跑一遍 —— 50 万资产时这不是慢，
   是**不可用**。回退本身是对的（语义不变），但它是静默的，没有实测数据时根本看不出来。
2. **目录工作集仍然背着下载任务的重字段**。实测本机 54 条真实资产 = 213KB，
   其中 `logs` 71KB、`verification` 56KB —— **59% 的体积与卡片渲染毫无关系**，
   而且随资产数线性增长（50 万条 ≈ 700MB 纯下载日志）。

**决策一：把两个 payload 派生值列化（schema v5）**

- `ALTER TABLE assets ADD COLUMN category_text TEXT` / `ADD COLUMN downloadable INTEGER`。
  `category_text` = `categories[] ∪ category ∪ assetType ∪ kind` 的小写拼接，
  与 `library-query.mjs` 的 `categoriesOf` **同源**（共用 `library-blob.categoryTextOf`）。
- 编译侧改 `instr(lower(category_text), ?)` + `downloadable = 1`，与内存路径的
  `anyHit(categories)` / `model.downloadable === true` 逐条同义。
- **回填**：老库两列是空的，不回填的表现不是「慢」而是「筛不到」，且与内存降级路径分叉。
  由 `backfillDeriveColumns()` 逐行 `JSON.parse` 复用同一个 `categoryTextOf`，
  用 `db_meta.derive_v5` 做一次性标记。**故意不在 SQL 里用 `json_extract` 复刻一套** ——
  那就是第二套分类语义，迟早漂移。
- 结果：筛选条 10 个维度里，**只剩颜色**（HSL 距离计算）会回退，这是刻意保留的。

**决策二：回退可见化**

`/api/library/assets` 在 `pushdown:false` 时回传 `reason`（编译器的 `plan.reason`），
前端状态条显示「索引下推 / 全表回退（原因）」。静默变慢是最难查的一类问题，
一行文案的成本远低于事后定位。

**决策三：目录读投影瘦身（内存裁剪）**

`readCatalog()` / `readCatalogPage()` 统一走 `slimCatalogModel()`，只剥 `logs` 与 `verification`：

- 卡片与右键菜单真正读的 `filePath` / `bytes` / `bytesWritten` / `fileExists` **原样保留**；
- 下载详情要看日志时走下载任务接口（jobs 域），不从目录里捞；
- 间接影响：整库导出的快照也不再带下载日志 —— 它本来就该是「语义快照」（ADR-10）。

**为什么仍然不裁 `state.models` 的条数**：`library-paging.js` 的注释已经钉过这件事——
`state.models` 是**写入契约的工作集**，裁成当前页会让评分、标签、回收站、全选、`findModel`
一起丢数据。要把条数裁掉，前提是「本地筛选维度全部下推 + 详情按 uid 水合」，
那是 5.7 的独立改动；本轮先把**单条体积**降 59%，收益确定、风险为零。

**顺手修掉的真 bug（本轮测试顶出来的）**：`commitValues()` 在 5.5 里把「写文件的剥离版」
同时喂给了 DB 索引。单一写入权威开启时，`mergeDerived` 收到的是 `models: []` ——
**老库首次保存会把整库索引清空**（`counts.assets` 直接变 0）。现在文件写剥离版、
索引写本次真实值（`indexPatch`），两件事各走各的路径。
这个 bug 只在「全新 DB + 单一写入权威」组合下暴露，日常增量写入（`asset:add`）不会触发，
所以是测试而不是用户先发现的。

**兼容层**：`SERVER_VERSION 3.24.0` + 能力位 `pushdownCategories` / `catalogSlim`。
v5 迁移是两条 `ADD COLUMN`（可重入、不改历史迁移 checksum）；回填失败只告警，
分类筛选取不到值时表现为空集而不是报错。

**验收（本机真实数据）**：分类 / 可下载下推后 `check()` 对照用例 7 条全绿；
目录体积 213KB → 87KB（-59%）；健康检查 `schemaVersion: 5`。

---

### ADR-12 借格式与外部库：ZIP 内嵌浏览、图片序列、Eagle / Billfish 迁移

这三个缺口原本被归在「预览器不够全」，实际验证下来字体 / 音频 / HTML / PDF 早就做完了
（`local-files.js` 的 `openFile()` 里按注册表分派，字体还能 `FontFace` 渲染中文样本），
真正缺的是**结构上的三种新读法**：

1. **ZIP 内嵌浏览**：`server/archive.mjs` 只读中央目录（`listArchiveEntries`），
   预览单条时才解压那一条（`extractArchiveEntry`）。**不解整包**——一个 2GB 素材包
   列个目录就要几十秒的话，这个功能没人会用。ZIP64 直接拒绝，不做半吊子支持。
2. **图片序列**：`src/library/image-sequence.js` 把「同目录 + 同前缀 + 尾部编号」
   且 ≥3 张的图片折叠成一张序列卡，点开是带帧率与逐帧控制的播放器。
   判定刻意保守：撞号（`a_1` 与 `a_01` 同时存在）整组作废、非图片类型不参与——
   宁可少折叠，也不能把用户无关的图从网格里吞掉。
3. **Eagle / Billfish 迁移**：`server/import-eagle.mjs` 只读对方的 `metadata.json`
   与 `images/<id>.info/`，映射为标签 / 星级 / 备注 / 文件夹链，原图**复制**进
   `<dataDir>/imports/<库名>/`。写入**复用 `importLibrary` 那条快照路径**，
   不新开一条能写坏数据的口子（ADR-10 的价值就在这里：第二个导入器零成本接上）。

**兼容层**：`archiveBrowse` / `thirdPartyLibraryImport` 能力位。老进程没有
`/api/local/archive` 与 `/api/library/import/eagle*`，双击压缩包或点迁移卡片只会 404。

**验收**：单测 19 条（序列分组 7 / ZIP 目录 6 / Eagle 映射 6）；真服务探测接口返回
`items:1 · folders:1 · samples:[knight/盔甲/5星]`。

---

### ADR-13 多资源库：注册表 + 重启生效，不做热切换

`dataDir` 是**进程级一次性决定**的：`library-storage`、备份、采集、下载记录、
`manager.lock` 全挂在 `resolveUserPaths()` 的返回值上（账号与机器令牌原本也在，ADR-14 把它们提到了库外）。
想在进程内换库，
就得把这十几个模块改成惰性取目录 —— 漏一个的症状是「两个库串数据」，而且不会立刻报错。

所以选择：**切库 = 改注册表里的 activeId + 重启进程**。

**注册表位置**：`%APPDATA%/AssetVault/libraries.json`（`resolveUserPaths().base`）。
不能放进 `dataDir` —— 切到别的库之后就再也列不出清单了，这是最容易踩的一次性错误。
默认库（`base/data`）永远在清单里，即使它从没被写进文件。

**解析优先级**：`SFX_DATA_DIR`（显式，桌面版与测试都靠它定向）> 注册表 active > `base/data`。
选中的库目录消失（U 盘拔了 / 目录被删）时**当场回退默认库**，不让服务指向一个不存在的目录——
否则下次启动会在 `mkdir` 或 `sqlite` 上炸得莫名其妙。
解析结果按 `libraries.json` 的 `mtime+size` 缓存：`resolveUserPaths` 被十几个模块反复调用，
每次 stat + 读 JSON 没必要，而切库必然改文件，缓存不会阻隔生效。

**重启怎么做**：不借外部启动器，用 `process.argv` 拉起一个同参数的新进程。顺序是硬约束：
1. `server.close()` + `closeAllConnections()` —— 放端口，否则新进程 `EADDRINUSE`；
2. `await downloads.close()` —— 放 `manager.lock`，否则新进程撞「已由另一个服务使用」；
3. 再 `spawn(execPath, argv, {detached:true})`，stdout/stderr 写进 `library-server.log`；
4. 1.5 秒后父进程 `process.exit(0)`。

任一步顺序颠倒，结果都是「旧进程退了、新进程起不来」——服务真的没了，比不重启严重得多。
`--open` 会被过滤掉，避免重启又弹一个浏览器标签。

**边界**：`remove` 只摘清单，磁盘一个字节都不删；默认库与正在使用的库不允许移除；
目录重复登记直接拒绝（Windows 下大小写不敏感归一化后比较）。

**兼容层**：`SERVER_VERSION 3.25.0` + 能力位 `multipleLibraries`。
老进程没有 `/api/library/stores*`，资源库卡片会一直显示「读取失败」。

**验收**：`test/library-stores.test.js` 5 条（默认库 / 改选跟随 / 非法操作拒绝 /
坏文件容错 / 目录消失回退）+ 隔离环境实测重启：旧 PID 退出、新 PID 接管同一端口、
健康检查恢复。

---

### ADR-14 多库共用一个账号：认证文件移出库目录

ADR-13 落地后立刻暴露一个问题：账号文件 `auth-users.json` 和机器令牌 `auth-token`
住在 `dataDir` 里，而切库换的正是 `dataDir`。结果是——**切到新库就等于没账号，要重新注册**。
这跟「多资源库」的产品直觉相反：库是资料，人是操作者，换资料不该换人。

**决策：账号住在库外面**，`resolveUserPaths().accountsDir`：

| 场景 | accountsDir |
|---|---|
| 正常启动（认注册表） | `%APPDATA%/AssetVault/accounts` |
| 显式 `SFX_ACCOUNTS_DIR`（启动器 / 桌面版） | 该值为准 |
| 显式 `SFX_DATA_DIR`（测试、便携实例） | `<dataDir>/accounts` |

第三条是刻意的：显式指定数据目录 = 「我要一个完全独立的实例」，
测试不能去读写用户的真实账号文件（这条在本轮真的救了一次 —— 有测试无参调用
`resolveUserPaths()`，把真实账号迁移了一遍；内容一致所以没损失，但那是运气）。

**所以 `SFX_ACCOUNTS_DIR` 必须显式钉住**。启动器与 Tauri 桌面版都会设 `SFX_DATA_DIR`，
只设这一个的话，服务端会认为「数据目录是人为指定的」，把账号算回 `<dataDir>/accounts`，
切库又丢账号。两个入口都补了这一行。

**迁移**：启动早期 `migrateAccountFiles()` 做一次性搬迁 ——
目标不存在才复制，复制成功后把源文件改名为 `auth-users.json.migrated-<ms>`（留档不删）。
迁移失败只吞掉异常：读不到账号文件时 auth 会当成「未注册」，那是可恢复的，
而因为迁移失败让服务起不来是不可接受的。

**会话为什么不用重新登录**：`av_session` 是 HMAC 无状态 cookie，密钥 `secret` 就存在
`auth-users.json` 里。文件共享 = 密钥共享 = 切库后旧 cookie 依然验得过。
这也是为什么不能只共享用户列表、给每个库发独立 secret。

**兼容层**：`SERVER_VERSION 3.26.0` + 能力位 `sharedAccounts`。
老进程仍把账号绑在 `dataDir` 上，必须换进程才生效 —— 能力位在这里不是装饰。

**验收**：`test/library-accounts.test.js` 5 条（默认位置 / 迁移与留档 / 不覆盖已有 /
`SFX_DATA_DIR` 跟随 / `SFX_ACCOUNTS_DIR` 优先）+ 隔离环境实测：
`data/auth-users.json` 迁成 `accounts/auth-users.json`（内容逐字节一致）、
`auth-token` 同步、`/api/library/stores` 无令牌 401 / 有令牌 200。

---

### ADR-15 语义搜索与找相似：云端向量 + 独立派生表

关键词检索解决不了「我知道我想要什么，但不知道它叫什么」：搜「能骑的幻想坐骑」，
资产名里写着 `Eastern Dragon Mount` 的那条永远命中不了。这是唯一必须靠向量的场景。

**决策一：不内置模型，用已有的 OpenAI 兼容 `/embeddings`**

本地跑 embedding（bge / m3e 之类）要么带一个 Python 运行时，要么带 ONNX 权重，
两条路都会把安装包和启动时间抬一个量级。而用户的 AI 接入里已经配好了 baseUrl + key，
多填一个「向量模型」就够。没填时整块功能安静地不出现（`ready:false` + 一句原因），
不会假装能搜然后给空结果。

**决策二：向量住独立表 `asset_vectors`（schema v6）**

| 列 | 作用 |
|---|---|
| `uid` | 主键，与 assets 一一对应（不建外键：资产删除后向量由 JOIN 自动失效，不必级联） |
| `model` | 哪个 embedding 模型产的；换模型 = 旧向量原地不认，不用先清空 |
| `dim` | 维度，读回时校验 |
| `hash` | 参与 embedding 的**文本**的 sha1 —— 增量构建的唯一依据 |
| `vec` | Float32 小端 BLOB（512 维 = 2KB） |

不塞进 `assets` 的原因很实在：目录查询（卡片、全选、计数）是全库最高频的操作，
把 2KB 向量塞进行里等于每次读目录都多搬几十 MB 的无关数据。
而向量本身是**可再生派生数据** —— 表被删掉、模型换了，重新构建即可，不动任何用户输入。

**决策三：构建按批推进，靠 hash 跳过**

一次 `build` 最多处理 `maxBatches × batch` 条（默认 8×16），前端循环调用直到
`pending = 0`。理由是每个批次都是一次真的计费请求，一个 HTTP 请求挂几分钟既会被
代理/浏览器掐断，用户也看不到进度。流程是「读一批 → 网络 → 写一批」，不整库读进内存：
5 万条 payload 解析就是几百 MB，而且 better-sqlite3 是同步的，长事务会把整个服务卡住。

**决策四：检索就是全表扫描 + 余弦，阈值 0.15**

万级资产一次全扫是几毫秒到几十毫秒，上 ANN 要先有个索引服务，收益不成比例。
`0.15` 这个门槛是为了不返回「毫不相干」的尾部命中 —— 没有它，任何查询都会返回
「前 40 个」，用户会以为整个库都长得像。50 万级再谈分片，写下这里免得以后重复讨论。

**命中为什么连完整卡片一起返回**：语义命中可能落在首屏之外，前端 `state.models`
只有已加载的页，只给 uid 就是「搜到了但画不出卡片」。服务端把命中的 model
（剥掉 logs / verification）一起回，前端用既有的 `mergeRemoteModels` 合并成 `_remoteOnly`，
写入契约一点都不污染。

**关键词必须让位**：`state.semanticMode` 为真时 `filtered()` 把 `state.search` 传空。
否则用户输入「能跑的坐骑」会先被向量选出候选，再被关键词过滤一遍（资产名里没有「坐骑」二字）
—— 结果全空，而且看起来像语义搜索坏了。

**兼容层**：`SERVER_VERSION 3.27.0` + 能力位 `semanticSearch`。
老进程没有 `asset_vectors` 表和 `/api/library/semantic/*`，语义开关点了只会 404。

**没做的**：图像向量（需要多模态 embedding，另一次选型）、ANN 索引（留到 50 万级）、
向量压缩（float16 能省一半，但要先有规模压力）。

**验收**：单测 8 条（向量文本 / 增量构建 / 排序与阈值 / 找相似排除自身 / 换模型 /
embeddings 通道 3 条）；端到端冒烟用假 embedding 服务跑真接口 ——
`assets:3 → pending:3 → embedded:3 → remaining:0`，搜「龙」返回
`[青龙雕像 1.0, 龙纹石碑 0.7089]`（只含「石」的那条被阈值挡掉），
二次构建 `skipped:3`，`asset_vectors` 表 3 行 / dim 3 / migrations 6。

---

## 4. 目标架构

```
┌──────────────────────────────────────────────────┐
│ 浏览器前端（多客户端）                             │
│   现有 src/library/*，改为服务端分页 + SSE 增量     │
└───────────────────┬──────────────────────────────┘
                    │ HTTP（LAN，已有 lan-sharing 会话）
┌───────────────────▼──────────────────────────────┐
│ 服务端（主机单进程）                               │
│  ┌────────────┬─────────────┬──────────────────┐ │
│  │ 查询层      │ 写入层       │ 后台队列          │ │
│  │ SQL 编译    │ 集合语义+审计 │ jobs + 租约       │ │
│  └────────────┴─────────────┴──────────────────┘ │
│  ┌──────────────────────────────────────────────┐│
│  │ Repository 接口（唯一可替换边界）              ││
│  └──────────────────────────────────────────────┘│
└───────────────────┬──────────────────────────────┘
                    │
        ┌───────────▼───────────┐
        │ SQLite（权威，WAL）    │  素材与缩略图在文件系统/NAS
        └───────────────────────┘
```

**Repository 边界规则**（为将来换 Postgres 留缝）：

- 业务层只调用 `library-db.mjs` 导出的方法，不直接 `prepare` SQL
- 不使用 `WITHOUT ROWID`、`PRAGMA`、`json_extract`、`GROUP_CONCAT` 等 SQLite 专有语法承载语义
- 全文检索抽象为 `search(term)`；向量检索抽象为 `similar(vector)`
- 事务边界由仓储层提供 `transaction(fn)`，业务不感知驱动

---

## 5. Schema V2

V2 是**追加迁移**，V1 一个字节都不改（checksum 保护）。派生表可重建，权威表不可丢。

### 5.1 新增表

```sql
-- 词表：canonical 值。parent 建层级，status=pending 表示待归并
CREATE TABLE tag_terms (
  term_id    INTEGER PRIMARY KEY,
  value      TEXT NOT NULL UNIQUE,
  norm       TEXT NOT NULL UNIQUE,          -- 小写 + 去空格，用于查重
  parent_id  INTEGER REFERENCES tag_terms(term_id),
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','pending','merged')),
  merged_into INTEGER REFERENCES tag_terms(term_id),
  created_at INTEGER NOT NULL
);

-- 面：一词多面 = 多条边
CREATE TABLE tag_facets (
  term_id INTEGER NOT NULL REFERENCES tag_terms(term_id),
  facet   TEXT NOT NULL,
  PRIMARY KEY (term_id, facet)
);

-- 别名：wood / wooden / 木头 → 木材
CREATE TABLE tag_aliases (
  alias_norm TEXT PRIMARY KEY,
  term_id    INTEGER NOT NULL REFERENCES tag_terms(term_id),
  created_at INTEGER NOT NULL
);

-- 资产-标签关系（替代旧 tags 表；协作与审计的载体）
CREATE TABLE asset_tags (
  uid           TEXT NOT NULL,
  term_id       INTEGER NOT NULL REFERENCES tag_terms(term_id),
  source        TEXT NOT NULL CHECK (source IN ('platform','ai','user')),
  model_version TEXT,        -- AI 标签：模型 + 词表版本
  created_at    INTEGER NOT NULL,
  created_by    TEXT,        -- 成员名；system 表示采集/迁移
  PRIMARY KEY (uid, term_id, source)
);
CREATE INDEX asset_tags_term_idx ON asset_tags (term_id, source);
CREATE INDEX asset_tags_uid_idx  ON asset_tags (uid);

-- 内容指纹 → 打标结果复用。同图多副本只问一次 AI
CREATE TABLE content_tags (
  hash          TEXT PRIMARY KEY,
  tags          TEXT NOT NULL,     -- JSON 数组，canonical 值
  model_version TEXT,
  vocab_rev     INTEGER,
  tagged_at     INTEGER NOT NULL
);

-- 审计：谁、何时、对哪个资产做了什么
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  uid     TEXT,
  term_id INTEGER,
  detail  TEXT,
  rev     INTEGER
);
CREATE INDEX audit_log_at_idx  ON audit_log (at DESC);
CREATE INDEX audit_log_uid_idx ON audit_log (uid, at DESC);

-- 成员与角色
CREATE TABLE members (
  member_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- 任务队列（AI 打标、缩略图、探测统一走这里）
CREATE TABLE jobs (
  job_id     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN
             ('queued','running','paused','succeeded','failed','cancelled')),
  priority   INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL DEFAULT '{}',
  progress   REAL NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX jobs_state_priority_idx ON jobs (state, priority DESC, created_at);
CREATE INDEX jobs_kind_state_idx     ON jobs (kind, state);

-- 物化计数（S2 启用；先建空表，避免以后再加迁移）
CREATE TABLE tag_counts (
  term_id     INTEGER PRIMARY KEY,
  asset_count INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER
);
```

### 5.2 资产列化（只加筛选/排序真正需要的）

```sql
ALTER TABLE assets ADD COLUMN kind         TEXT;      -- models/textures/hdris/images/packs
ALTER TABLE assets ADD COLUMN width        INTEGER;
ALTER TABLE assets ADD COLUMN height        INTEGER;
ALTER TABLE assets ADD COLUMN long_edge    INTEGER;
ALTER TABLE assets ADD COLUMN bytes        INTEGER;
ALTER TABLE assets ADD COLUMN color_h      INTEGER;
ALTER TABLE assets ADD COLUMN duration     REAL;
ALTER TABLE assets ADD COLUMN content_hash TEXT;
ALTER TABLE assets ADD COLUMN rev          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN updated_at   INTEGER;

CREATE INDEX assets_kind_idx      ON assets (kind, added_at);
CREATE INDEX assets_long_edge_idx ON assets (long_edge);
CREATE INDEX assets_bytes_idx     ON assets (bytes);
CREATE INDEX assets_color_h_idx   ON assets (color_h);
CREATE INDEX assets_hash_idx      ON assets (content_hash);

-- 一资产多格式
CREATE TABLE asset_formats (
  uid TEXT NOT NULL,
  ext TEXT NOT NULL,
  PRIMARY KEY (uid, ext)
);
CREATE INDEX asset_formats_ext_idx ON asset_formats (ext);
```

### 5.3 旧数据映射

| 旧位置 | 新位置 | 规则 |
|---|---|---|
| `state_meta['sfx-library-v2']` | 仍是权威（S1 期间） | S2 后降级为导出格式 |
| `tags(uid,kind,tag)` | `asset_tags` | 按 `tag` 查 `tag_aliases`/`tag_terms`，命中用 term_id；未命中建 `pending` 词条 |
| `model.tags` | `asset_tags(source=platform)` | 同上，`created_by='system'` |
| `data.aiTags[uid]` | `asset_tags(source=ai)` | `model_version='legacy'` |
| `data.userTags[uid]` | `asset_tags(source=user)` | `created_by='legacy'` |
| `model.assetType` | `assets.kind` | 用 `KIND_ALIASES` 归一 |
| `model.probe.width/height/hex` | `assets.width/height/color_h` | 无 probe 时留 NULL |
| `model.formats` | `asset_formats` | 复用 `formatRegistry` |

**迁移必须可重入**：中途失败重跑不产生重复行（`INSERT OR IGNORE` + 幂等映射）。

### 5.4 词表种子（已落地）

首批 6 个面，190 个受控值，作为 `library-vocab.seed.mjs` 数据文件（不改代码即可调整词表）：

`style` 风格 · `subject` 题材 · `material` 材质 · `usage` 用途 · `mood` 氛围 · `tech` 技术

双面词（材质 ∩ 题材）单独标注：木材、石材、布料、玻璃、金属、皮革。

### 5.5 词表同步与归一化（S1b 已落地）

词表是**产品数据**，不走迁移链（否则每改一个词都要发一次 schema 版本，而历史迁移被 checksum 冻死）。
同步靠 `db_meta.vocab_rev` 做幂等闸门：

| 步骤 | 行为 |
|---|---|
| 1 | canonical 词条落地并激活（V2 迁移先建成 `pending`，这里转正） |
| 2 | 连父级（`parent` 用 value 写，解析成 `term_id`；父级可能排在子级后面，故第二轮） |
| 3 | 面归属整体替换（从种子里删掉的面必须真的消失，不能残留） |
| 4 | 写别名，并把库里**以别名身份存在的旧词条合并**（`status='merged'` + `asset_tags` 迁移到 canonical） |

写入侧（`library-db.mjs` 的 `resolveTerm`）顺序固定：别名 → canonical → 未命中建 `pending`。
未命中绝不拒绝，归一化是后台审计的事，不能成为用户打标的前置条件。

读取侧（`library-filter-semantics.mjs` 的 `tagHit`）：

- 选中值在词表里 → 展开成「自身 + 全部子孙」按 canonical 精确比对（点「木材」筛出「橡木 / 松木」）
- 选中值不在词表里 → 退回子串匹配（用户自造标签不会失去筛选能力）

**纪律：面由词表定，不由写入方定。** AI 只输出值，面的归属永远查词表；否则换模型就会让体系漂移。

---

## 6. 查询下推（S2，已落地）

S2 把 `queryAssets` 一分为二：

1. **SQL 编译层**（`server/query-sql.mjs` + `server/query-sql-search.mjs`）：把 `filters` + `q` 编译成 `WHERE` + `ORDER BY` + `LIMIT/OFFSET`，一条查询只返回当前页；同时产出**索引提示**（哪条索引能省掉回表 / 排序）
2. **JS 语义层保留**（`server/library-query.mjs`）：用于内存降级路径，也是 SQL 层的**结果校验基准**
3. **执行壳**（`server/library-pushdown.mjs`）：编译 → 执行 → 投影，与 HTTP 无关，可脱离网络单测

### 6.1 铁律：能精确等价才下推

编译失败就返回 `{ok:false, reason}`，API 如实退回内存路径。宁可慢，也不能出现「SQL 路径比内存路径少几条」——那种 bug 用户永远发现不了，但结果就是错的。

目前**明确拒绝下推**的条件：颜色筛选（HSL 距离）、`categories` / `downloadable`（依赖 payload）、`category:` / `metadata:` / `path:` 字段检索、排序 `name`（中文 collation）/ `popular`（likes 在 payload）/ `random`（哈希）/ `collection`（合集手序）。

### 6.2 等价性怎么守住

`test/library-query-pushdown.test.js` 是 S2 的核心验收：同一批数据分别走 SQL 与内存路径，断言 `total` 与 `uids` 逐条一致。用例刻意覆盖边界（缺宽高、缺体积、缺色相、trashed、词表外标签、大小写、排除子句、**多选 OR 语义**）。

已经踩到并修掉的坑：

| 坑 | 现象 | 结论 |
|---|---|---|
| `long_edge` 口径 | 派生层「只有宽就用宽」，`numericValue` 要求宽高齐全 → 排序错位 | 列化口径必须与 `numericValue` 逐字对齐 |
| 标签检索文本 | SQL 侧只输出 canonical，内存侧是原始文本 → `tag:stone` 命中 0 条 | 检索文本 = 原始值 ∪ 标准名 ∪ 别名，两侧同源 |
| 多选语义 | 内存路径 `some()`（OR），SQL 编成 AND → 命中数少一大截 | 平台/类型/标签的多选一律 OR |
| 排序并列 | JS 稳定排序保留输入顺序，SQL 没有 tiebreaker | 每个排序都补 `a.rowid` 作为最后一级 |

### 6.3 检索文本物化（`assets.tags_text`）

标签检索文本 = **原始标签 ∪ 词表标准名 ∪ 该词的全部别名**，按码点序排序。它体现「词表是唯一事实源」：资产写的是 `stone`，面板显示的是「石材」，两个词都得能搜到。

物化成列而不是每次用相关子查询拼：20 万条实测 **1635ms → 191ms**。

排序规则用 `compareBinary`（码点序），与 SQLite 的 `BINARY` collation 逐字节一致 —— 两条路径拼出的字符串必须完全相同，否则同一个查询会在一边命中、另一边落空。

词表版本变化时（`db_meta.vocab_rev`）自动重算这一列（一条 UPDATE，20 万条约 4.3s）。

### 6.4 覆盖索引：这次最贵的一课

`uid` 是 TEXT 主键，**不在二级索引里**。COUNT 时每一行都要回表读 uid，20 万行就是 20 万次随机读。把 `uid` 放进索引尾部后，同一条 COUNT 从 **1817ms 掉到 1ms**。

V3 的索引全部是覆盖版本（尾部带 uid）。取页也分两段：先只取 uid（排序器不必搬运 payload），再按 uid 取整行 —— 单段 `SELECT a.*` + ORDER BY 要 4146ms，两段只要 1239ms。

**V4 把这条教训又用了两次**（同一个错误形状、不同表）：

| 表 | 原二级索引 | 少了什么 | 后果 | 修法 |
|---|---|---|---|---|
| `assets` | `(state, added_at, position, uid)` | uid 在尾部 ✓ | — | V3 已修 |
| `asset_tags` | `(term_id, source)` | **缺 uid** | 9.2 万次回表 → COUNT 602ms | `(term_id, uid)` → 155ms |
| `assets` | `(state, rating, ...)` | **缺 platform / kind / 文本列** | 24 万次回表 → COUNT 3010ms | 统一覆盖索引 → 52ms |

判断口径很简单：**二级索引里没有的列，谓词就一定逼着引擎回表。** `instr(lower(platform), ?)` 这种子串谓词尤其致命 —— 它没法用索引定位，但**只要该列在索引里，就能在索引上直接求值**，不必回表。

### 6.5 索引提示：编译期给，执行期用

`compileQuery()` 除了产出 `WHERE` / `ORDER BY`，还产出两条**索引提示**：

| 提示 | 作用 | 生效条件 | 失效时 |
|---|---|---|---|
| `indexHint` | 取页时强制走排序索引，沿索引顺序扫、凑够一页就停 | 排序键在索引里 **且** 所有谓词都能靠索引判定 | 回退自然计划 |
| `countIndexHint` | COUNT 时强制走统一覆盖索引，不回表 | WHERE 引用的列**全部**在索引里 | 回退自然计划 |

两条提示的门控都不是拍脑袋，而是实测出来的：

- **取页提示**：一旦有谓词要回表，强制走索引就把「顺序读表」变成「随机读表」—— 50 万条实测文本检索从 1.0s 涨到 5.1s。所以只在「纯标签 / 合集 / 指定 uid」这类谓词下才给。
- **COUNT 提示**：反过来，它可以承受更多谓词，但引用的列必须在索引里。引用了数值列（宽高 / 时长）或 `url` 就不给。

还有一道**命中量门槛**（`AV_INDEX_SCAN_MIN_ROWS`，默认 1000）：命中太少时沿索引扫很久才凑不满一页，反而比「物化命中集再排序」慢。门槛以下维持原样 —— 即使门槛定错，最坏也只是没拿到加速，不会比原来更差。

提示**只影响走哪条索引，不改 `ORDER BY`**；索引满足不了 `ORDER BY` 时 SQLite 在 prepare 阶段就报「no query solution」，执行壳捕获后退回自然计划 —— 这是安全失败路径，绝不产出错序结果。`test/library-query-pushdown.test.js` 里有一条用例专门断言「带提示与不带提示的 uid 序列逐条一致」。

### 6.6 实测

**规模对比**（20 万条 / 709MB，下推 vs 全量内存路径）：

| 查询 | 下推 | 内存路径 | 倍数 |
|---|---|---|---|
| 首屏 60 条（recent） | 17ms | 5895ms（含全量读） | **347×** |
| 单标签筛选 | 740ms | 6346ms | 8.6× |
| 平台+类型+评分 | 201ms | 5841ms | 29× |
| 按分辨率排序 | 193ms | 5873ms | 30× |
| 双标签 + 排除 | 2129ms | 6634ms | 3.1× |
| 关键词搜索 | 342ms | 6326ms | 18× |
| 收藏 + 评分 | 178ms | 5811ms | 33× |

内存路径那一列 = 「全量读行 + JSON.parse 派生」（5.8~6.5s）+ JS 求值。下推只碰当前页。

**50 万条 / 2.1GB 的结构事实**：

- 旧的**全量内存路径在这个规模上直接把 Node 堆跑爆**（50 万行 + 364 万标签行同时进 JS 内存，4GB 堆 OOM）。下推路径峰值堆 **8~10MB**。
- 所有查询的 `EXPLAIN QUERY PLAN` 都是 **COVERING INDEX**（不回表）。这是可验证的结构性保证，不受磁盘缓存状态影响。

**同进程交替 A/B**（50 万条，带提示 vs 不带提示，各 5 轮取中位数）：

> 必须交替执行：单独测 A 再单独测 B，差值可能全来自磁盘缓存冷热，不来自代码。
> 交替让两次测量共享同一份缓存状态，倍数才有意义。

| 用例 | 带提示 | 无提示 | 倍数 | 一致性 |
|---|---|---|---|---|
| 首屏 60 条（recent） | 157ms | 3541ms | **22.6×** | ✓ |
| 第 3 页（offset 120） | 107ms | 2560ms | **23.9×** | ✓ |
| 单标签筛选 | 297ms | 764ms | **2.6×** | ✓ |
| 双标签 + 排除 | 1848ms | 3881ms | **2.1×** | ✓ |
| 关键词搜索 | 1594ms | 1750ms | 1.10× | ✓ |
| 收藏 + 评分 | 183ms | 175ms | 0.96× | ✓ |

首屏与翻页的 22× 来自 `indexHint`：`ORDER BY added_at DESC, position DESC, rowid DESC` 的 tiebreaker 是 `rowid`，而索引尾部是 `uid` —— 索引**给不出这个顺序**，SQLite 于是放弃索引、全表扫描再排序。强制指定后，SQLite 沿索引顺序扫、凑够 60 条就停。

### 6.7 剩余瓶颈

- **按分辨率 / 体积 / 评分排序**必须全量排序：排序键是 `CASE WHEN long_edge IS NULL THEN -1 ELSE long_edge END` 这种表达式，索引里根本没有这个值。50 万条实测 2.5s。
- **COUNT 仍随命中规模线性变化**：标签筛选的 COUNT 要把命中集物化成 uid 列表再探测覆盖索引。
- **插入变慢**：索引从 6 条涨到 12 条，写入时每条索引都要维护。批量导入需要实测确认。

### 6.8 已知限制

- `uid` 列表超过 5000 时按契约只回当前页并标记 `uidsComplete:false`（前端已如实提示「仅返回前 N 个」）。主界面走的是 `uidScope:'page'` 分页模式，不受影响。
- 智能合集 `/smart-collections/resolve` 已改走下推（`uidScope:'all'`），50 万条时不再 OOM；超 5000 条仍会截断并如实标记。
- 词表被人工合并后，SQL 侧读 DB 的词条、内存侧读种子词表，两边会分叉。合并功能属于 S3，届时要统一。

---

## 7. 写入路径（S1/S3）

### 7.1 事务批

- 单条写：直接 `transaction(fn)`
- 批量写（打标、导入）：每 500~1000 行一个事务，事务间 `await setImmediate()` 让出事件循环
- **禁止**在循环里调用 `commitValues`

### 7.2 标签写入协议（已落地）

```
POST /api/library/tags/mutate
{ ops: [
    { op: 'tag.add',    uid, value, source, by },
    { op: 'tag.remove', uid, value, source, by },
    { op: 'asset.set',  uid, field, value, rev },   // 单值字段：rating / note / favorite
  ] }
```

- `tag.add/remove` 幂等；重复提交不产生重复行、不报错
- `asset.set` 带 `rev`；服务端比对失败返回 `409`，冲突码 `rev_conflict`，并附服务端当前值
- 平台标签（`source:'platform'`）只读：用户删了它，下次采集又加回来 —— 直接 400 比「删了又冒出来」好
- 每次写追加一条 `audit_log`（谁、何时、对哪个资产做了什么）

**定点写，不重建整表**：老路径 `rebuildDerived` 要删表再插 400 万行（50 万资产时一次打标等于几分钟），
而且多人协作时一个人的写入会抹掉另一个人的结果。S3 改成只动受影响的资产：

> **实测（50 万条 / 2.06GB 库，同一台机器）**：老路径整表重建 **242.7s**；
> 新定点写 `tag.add` **9.5~19.8ms**、`asset.set` **1.9ms** —— 约 1.2 万倍的差距，
> 而且差距会随库变大继续拉开（老路径是 O(全库)，新路径是 O(受影响行)）。

| 受影响的表 | 动法 |
|---|---|
| `asset_tags` | 只插 / 删受影响的那几行 |
| `tags` | 同上；删除时按原值与归一化值各删一次（用户存 "wood"、标准名 "木材" 两种写法都要删干净） |
| `assets.tags_text` / `assets.rev` | 只更新被改的资产（覆盖索引 `(term_id, uid)` 让计数只扫该词命中行） |
| `assets_fts` | 按 `rowid` 精确替换一行（`rowid` 与 `assets.rowid` 对齐，不必全表扫 FTS 找 uid） |
| `tag_counts` | 只重算受影响的词条 |
| `audit_log` | 追加一行 |

**blob 与派生表同源**：同一批 op 语义同时作用于 blob（`applyOpsToState`）与派生表（`applyTagOps`），
所以两边不会漂移。批量操作时 blob 只序列化一次（每条 op 各写一次 16MB 是不可接受的）。

**超限降级**：blob 有前端契约上限（16MB），而 50 万条时主状态实测 **209.6MB** —— 根本装不下。
这时**不能整条写失败**：派生表才是权威（ADR-02），blob 只是导出快照。
所以超限时只更新派生表并在响应里回 `blobSkipped:true`，blob 等前端下次整块写时自然覆盖。

> **已切换（S3 收尾）**：前端不再回传整块 blob，见 §7.7。
> 上面的「超限降级」是 ADR-02 之前的过渡策略：现在用户域权威在 DB，
> 定点写**根本不写 blob**，所以 `blobSkipped` 恒为 `false`（字段保留只为兼容旧客户端），
> 209MB 的主状态一个字节都不会被碰到。

> 已知限制：词表被人工合并后，SQL 侧读 DB 词表、内存侧读种子词表，两边会分叉。S4 处理。

### 7.3 只改无关字段，不重建派生表

派生表（`assets` / `tags` / `asset_tags` / `assets_fts`）由哪些字段决定？答案是：
**模型主体 + 标签 + 评分备注收藏 + 封面探测**。而 `history` / `tasks` / `options`
**不参与任何一行派生数据的计算** —— 它们只是界面的附属状态。

可搜索历史是「每搜一次就变一次」的高频字段。旧路径每次保存都无条件整表重建，
于是「记一次搜索历史」在 50 万库上要 **218.5 秒**。现在按 op 涉及的字段判定：

| op 涉及字段 | 派生表 |
|---|---|
| `aiTags` / `userMeta` / `userTags` / `assetProbe` / `favorites` | 必须重建 |
| `history` / `tasks` / `options` | **不重建**（只更新权威原串） |

> **实测（50 万 / 2.06GB 库）**：整表重建 **218.5s** → 只改搜索历史 **4.4s**（50×）。
> 剩下的 4.4s 是「重写 209MB 主状态」本身的代价；ADR-02 落地后会话域独立成几 KB 的文件，
> 这 4.4s 也随之消失（见 §7.7）。

### 7.4 角色权限（已落地）

| 角色 | read | write | manage |
|---|---|---|---|
| owner（主管） | ✓ | ✓ | ✓ |
| editor（编辑） | ✓ | ✓ | ✗ |
| viewer（只读） | ✓ | ✗ | ✗ |

**身份识别为什么不能只看请求头**：`x-sfx-member` 是客户端自报的，任何人都能伪造。
拿它当授权依据 = 任何访客把 header 改成 owner 的成员号就直接拿到写权限。所以规则是
**请求头只能收窄权限，不能抬高权限**：

- 有 LAN 会话 → 以会话里的名字为准（密码换来的，唯一可信来源）；请求头与会话对不上时忽略请求头
- 没有 LAN 会话（主机本地）→ 默认 owner
- 认不出的人 → viewer（拼错不该放行）

**门控点**：`/api/library/mutations`、`/tags/mutate`、`/collections*`、`/smart-collections`、`/backups`
（写权限）；`/api/library/members` 的写与 `/backups/restore`（主管权限）。读路由一律不门控。

**成员管理**：`members` 表（V2 已建）承载 `owner/editor/viewer`。
最后一名启用的 owner 不能被降级、停用或删除 —— 否则就没人能再管成员了。

### 7.5 变更广播（已落地）

`GET /api/library/events`（SSE）：

```
id: 12
data: {"kind":"tags","uid":"...","rev":12,"actor":"m-1a2b3c4d","seq":12}
```

- **单向通知用 SSE 不用 WebSocket**：走普通 HTTP、浏览器原生支持、断线自动重连，不需要额外依赖与握手
- **每连接一队列 + 上限 256**：慢客户端直接断开（浏览器自动重连），而不是无限堆积内存
- **心跳**：注释帧 `: ping`（30s），让中间设备不掐连接，也能发现死连接
- **断线续传**：每条事件带自增 `seq`，事件流保留最近 512 条；重连带 `Last-Event-ID` 就能补齐空档，
  不必为了一次瞬断重拉整页。补发窗口之外的客户端只能整体重拉
- **跨站拒绝**：EventSource 带不了自定义头，所以守卫比普通路由宽松，但带 `Origin` 必须同站、
  `Sec-Fetch-Site: cross-site` 一律拒绝 —— 不能因为放宽就成了「任意网页都能读资产库」

**前端**（`src/library/library-events.js` + `remote-sync.js`）：

- 变更攒进 120ms 合并窗口，一批只重绘一次
- 带 uid 的事件 → 只拉这些 uid 的「用户可变部分」（`POST /api/library/assets/detail`：
  评分 / 备注 / 我的标签 / AI 标签 / 收藏），不搬整行模型
- 粗粒度事件（整块写入、恢复备份）→ 重新取当前页（`state.onRemoteRefresh`），不整库刷新
- 应用远端改动后**不落盘**：落盘会写回服务端，等于把别人的改动再广播一遍，形成回环

> 已知限制：本地用户对同一资产有「未提交的改动」时，远端覆盖会盖掉它。
> 当前没有做逐字段的脏标记（要跟踪 pending 本地写），S4 视需要补。

### 7.6 自动备份与恢复（已落地）

- 目录：`<dataDir>/backups/<时间戳>/{library.db, state/, library-state.json, meta.json}`
- **DB 与各域快照一起备**：SQLite 存用户域权威 + 派生索引，`state/` 存目录 / 探测 / 会话三个域的文件快照 ——
  只备 DB 会丢目录，只备快照会丢用户数据。`library-state.json` 作为导出快照一并带走（旧版备份也能被认出来）
- 在线一致性快照：用 SQLite 的 `backup()` API，运行中也能拿到一致副本，不停服、不锁库
- 定时（默认 6 小时）+ 手动（`POST /api/library/backups`）；保留 N 份（默认 5）
  （`AV_BACKUP_INTERVAL_MIN` / `AV_BACKUP_KEEP` 可覆盖）
- **恢复前先留一份「恢复前」的现状**：恢复本身可能恢复错，没有这份回退副本，一次手滑就真没了
- 失败只告警不阻断：备份挂了不能影响打标签、下载、浏览
- 恢复会覆盖当前库 → 只给主管；恢复后广播粗粒度事件让所有人重新拉

### 7.7 ADR-02 落地：四域分离 + 前端写入通道切换（S3 收尾）

**问题**：旧架构把「目录 + 用户数据 + 探测缓存 + 会话现场」揉成一串 JSON。50 万资产时它是 **209.6MB**，
于是打一个标签、记一次搜索都要重写整串，而写进去又撞 16MB 前端契约上限 —— 越大的库越写不动，是死循环。

**解法**：一域一个文件、一个写入者、一种写入代价。

| 域 | key | 权威 | 写入通道 | 代价 |
|---|---|---|---|---|
| 目录 | `sfx-library-v2` | 文件快照 | 整块 `POST /api/library-state`，只带 `version/models/trashed` | ∝ 本地目录条数，低频 |
| 用户 | `sfx-library-user` | **SQLite** | `POST /api/library/tags/mutate`（集合语义 op） | ∝ 受影响行数 |
| 探测 | `sfx-library-probe` | 文件快照 | 独立小 key（可重建） | ∝ 探测过的资产数 |
| 会话 | `sfx-library-session` | 文件快照 | `POST /api/library/session`（`derived:false`） | 几 KB，与库大小无关 |

**前端零改动**：业务代码仍调 `saveLibrary()` 产出完整 blob。`src/library/tag-ops.js` 在持久化边界上
把「前后两份主状态」翻译成上表的指令，看不懂的变化（版本号 / 未知字段 / 脏 uid / 超量）一律
`fallback` 到整块写入 —— 宁可多传，绝不悄悄丢内容。

| 变化 | 发出去的请求 |
|---|---|
| 只改评分 | 一个 `asset.set`，几十字节，主 blob 一个字节都不回传 |
| 只改搜索历史 | 一个 `/session`，几 KB |
| 增删标签 | 差集 `tag.add` / `tag.remove`，带 `user` / `ai` 来源 |
| 目录变化 | 纯目录 blob（剥离用户 / 会话 / 探测字段） |
| 回收站清空 | 额外一个 `POST /api/library/assets/remove` |

**降级**：任一细粒度通道失败（含老进程 404/405）→ 永久关掉新通道并整块重放完整 blob，
数据不丢；原有 `/api/library/mutations` 差量通道作为第二级保留。

**几个必须记住的坑**：

- **合并语义**：前端只持有它看到的那部分目录（分页），直接替换会把服务端全库缩小。
  `mergeCatalog()` 做的是合并；同名以新为准，被移入回收站的 uid 从旧 models 里剔除。
  真正要删的资产必须走 `asset.remove` 定点通道，否则「blob 里少了」会被当成「没看到」补回来。
- **读视图**：旧前端的 `loadLibrary()` 只认 `sfx-library-v2`。`load()` 仅在域确实带来新内容时
  把四域合并回主 blob；内容没变就原样返回原字符串，保住「save 后 load 逐字节还原」。
  合并是**字段级**覆盖：域里没给的字段沿用主 blob，不会被无声清空。
- **索引就绪是所有读写路径的公共前置**：`ensureIndex()` 逐域比较 `state_meta.updated_at` 与文件 mtime。
  少了这一步，旧版单文件刚升级时集合语义写入会作用在空表上 —— 「打标签成功但资产不存在」。
- **遗留整块通道**改用户域时带 `syncUser`，显式授权派生层以 blob 为准重建该资产的用户域；
  目录域变更不带这个标记，DB 里的用户数据就不会被旧 blob 覆盖回去。
- **同批 ops 的 rev**：`applyTagOps` 只对**显式带了版本号**的 `asset.set` 做冲突检测；
  不带 `rev`（或字段缺失）一律放行，否则「打标签 + 改评分」会被自己推高的 rev 误判成冲突。

**验收**：`test/library-tag-ops.test.js`（翻译层）、`test/library-persistent-storage.test.js`（通道调度与降级）、
`test/library-domains.test.js`（四域存储、合并语义、读视图、定点删除）、
`test/library-collab-api.test.js`（`/session` 路由）共 20+ 项新用例。
50 万库上的端到端写入计时待下一轮压测复测；结构性保证是「高频写不再触碰 209MB 目录文件」。

### 7.8 协作管理界面（S3 收尾）

设置面板新增「协作与备份」分类，两张卡片：**成员与权限**、**自动备份**。

| 约束 | 做法 |
|---|---|
| 权限来源 | `GET /api/library/members` 直接给 `canManage` / `canWrite`；前端**只做展示门控**，不在浏览器里从角色字符串反推权限（鉴权始终在服务端） |
| 三个门分开 | 管成员要 `manage`、立即备份只要 `write`、恢复备份要 `manage`；编辑能备份但不能管人也不能恢复 |
| 危险操作 | 删除成员、恢复备份都要二次确认；恢复文案明确「当前库会被覆盖，系统先自动留一份恢复前快照」，所有人需刷新 |
| 可见范围 | **仅主机**：LAN 访客的设置面板整体是隐藏的（既有设计），这里不读本机目录也不该改别人权限 |
| 代码分层 | `src/library/team-data.js` 纯数据契约（角色映射 / 行模型 / 请求缝）↔ `src/library/team-settings.js` DOM 层，各自 <300 行，前者可脱离浏览器单测 |

**两个真的会踩的坑**：

- `POST /members` 只回 `{member, members}`，**不带** `me` / `canManage` / `canWrite`。拿它直接渲染
  会把权限清空、把刚改完的面板锁成只读；`POST /backups` 同理不回 `config`。
  两个保存动作都必须**重新 GET 一次**再渲染。
- 行模型一开始叫 `id`、请求体读 `member_id`，改角色时 ID 丢失会被服务端当成「新增成员」。
  现统一成服务端的 `member_id`，`memberDraftToPayload()` 另外兼容 `.id` 兜底。

**验收**：`test/library-team-settings.test.js` 9 项（权限矩阵、脏数据降级、请求缝、增删改、
备份恢复、二次确认、错误降级）；`test/library-collab-api.test.js` 补 `canWrite` 契约断言。

---

## 8. 性能预算（验收标准）

| 场景 | 上限 | 测量方式 | 50 万实测 |
|---|---|---|---|
| 首屏 60 卡片 | 800ms | 服务端计时 + 浏览器 FCP | 157ms ✓ |
| 任意筛选一次（50 万库） | P95 300ms | 同进程交替 A/B，5 轮取中位数 | 标签 297ms ✓ / 列筛选 183ms ✓ / 关键词 1594ms ✗ |
| 标签面板打开 | 200ms | 同上 | 标签 COUNT 约 150ms ✓ |
| 打一个标签 | 100ms | 单请求往返 | DB 层定点写 9.5~19.8ms ✓（老路径整表重建 218.5s） |
| 改评分 + 打标签（同一批 op） | 100ms | **真实 HTTP API** 往返，3 轮中位数 | 35.9ms ✓ |
| 记一次搜索历史 | 100ms | 同上 | **11.7ms ✓**（修复前 7157ms；对照：整块重写 209MB 目录域 12.5s） |
| 协作取数 `/assets/detail` | 100ms | 同上 | 18.7ms ✓（修复前 729ms） |
| 身份与权限 `GET /members` | 100ms | 同上 | 19.1ms ✓（修复前 835ms） |
| 全库备份 | 60s | `db.backup()` | 2.06GB 库 19.6s ✓；本轮 2.21GB 12.2s ✓ |
| 冷启动打开库 | 2s | 进程启动到首个查询返回 | 待 S4 实测 |

**端到端复测（2026-11-08，48.5 万条 / 2.21GB 库副本）**：走 `createLibraryApi.handle()` 的真实请求链，
不用只量 `db.applyTagOps()` 的裸内核数字 —— 前端到落盘之间还有守卫、身份、权威读取、文件写入。
装置把 209MB 目录 blob 同时放进 `state/` 域文件与 `state_meta`，版本戳精确对齐文件 mtime（生产形态）。

- 结构性验收：连打标签、改评分、记搜索历史之后，**241MB 目录域文件的 size 与 mtime 一个字节都没变** ✅，
  样本资产 `rating=4` / 新标签「木材」确实落库 ✅。高频写代价与库大小无关。
- 复测第一轮发现**端到端延迟崩了**：`/session` 7.2s、`/assets/detail` 729ms、`GET /members` 835ms。
  逐段分解（见下）定位到两个纯 bug，修复后分别降到 11.7 / 18.7 / 19.1ms。

| 分段（修复前，3 轮中位数） | 耗时 | 原因 |
|---|---|---|
| `readRawState()` | 545ms | 快照缓存判据放在 `readFile` **之后** —— 241MB 每次都重读，缓存形同虚设 |
| `SELECT key,value,updated_at FROM state_meta` | 680ms | `authoritative()` 无条件搬 209MB 目录域原串 |
| `SELECT key,updated_at FROM state_meta` | 210ms | 同一行太大，只取时间戳扫表也贵 |
| `new Database()` + pragma | 4.8ms | 不是瓶颈（原先的猜测被实测否掉） |

**修法（零迁移）**：① 缓存判据挪到 `readFile` 之前；② 逐域版本戳同步写进小表 `db_meta`
（`state_stamp:<key>`），`authoritative()` / `ensureIndex()` 只查几行小记录，只有「DB 确实比文件新」
或「域文件丢失」时才取那一行的 `value` —— 保住「快照丢失从 DB 恢复」的既有契约；
③ 一批同时写多个域时用**各自文件的 mtime**，不再共用 max stamp，否则目录域的戳会被会话域抬高而误判。
老库没有戳时读一次 `state_meta.updated_at` 补齐，行为不变。契约测试见 `test/library-state-stamps.test.js`。

**未达标的项**：关键词检索（1594ms）与分辨率排序（2.5s）。前者是子串匹配的本质成本（没有 trigram 可用时只能扫），后者是 `CASE` 排序键无法进索引。两者都需要产品侧取舍（限制检索长度 / 改用列排序），不是靠加索引能解决的。

---

## 9. 实施计划

| 阶段 | 内容 | 可上线判据 |
|---|---|---|
| **S1a** | Schema V2 + 派生层双写（词表、asset_tags、资产列、审计、jobs、指纹） | 老库自动迁移，5540 条数据无损，旧查询结果不变 |
| **S1b** | 词表种子 + 归一化投影 + 标签面板分面 | ✅ 已完成：190 词 / 6 面激活，别名与旧词条真合并，面板按面分组，点父级能筛出子级 |
| **S2** | 查询下推 SQL + 分页 + 停双写（DB 转权威） | ✅ 已完成：50 万条压测下峰值堆 8~10MB（旧路径 OOM）、首屏 22.6×、翻页 23.9×、标签筛选 2.6×，全部查询计划为覆盖索引 |
| **S3** | 集合语义写协议 + 角色 + SSE + 自动备份 + ADR-02 四域分离 + 管理界面 | ✅ **全部完成**：定点写 9.5~19.8ms（老路径 242.7s）、备份 2.21GB 库 12.2s、角色门控 / SSE / 四域分离 / 前端写入通道切换 / 成员与备份界面 / **50 万库端到端写入复测**全部有测试与实测（见 §7.7、§7.8、§8） |
| **S4** | 视觉打标（视频拼帧/模型三视图）+ 候选词注入 + 指纹复用 | 标签准确率对比基线提升，AI 调用量下降 |

**纪律**：每个阶段结束时，现有数据必须能正常打开。做不到说明拆分错了，停下来重拆。

---

## 10. 风险与回退

| 风险 | 缓解 |
|---|---|
| 原生模块 ABI 不匹配 | 已有 `openLibraryDb` 降级（`library-db.mjs:128-140`）；保留 `AV_SQLITE_MODULE` 覆盖口 |
| 迁移中途失败 | 全部迁移在单事务内；迁移前留 `library-state.pre-db.json` 快照 |
| DB 成为单点 | S3 定时 `db.backup()` 到 NAS，保留 N 份，GUI 一键恢复 |
| 主机磁盘故障 | 素材在 NAS；DB 每日备份；`.db` 绝不放网络盘（WAL 会损坏） |
| 双写期间不一致 | S1 期间以 JSON 为准，派生表可随时整表重建；S2 切换前先做一致性校验脚本 |

---

## 11. 文件索引

| 文件 | 职责 |
|---|---|
| `server/library-schema.mjs` | 迁移链（V1 冻结，V2~V4 追加） |
| `server/schema/v2-scale.mjs` | V2 迁移 SQL 分片（词表 / 协作 / 审计 / 队列 / 列化） |
| `server/schema/v3-query-index.mjs` | V3 迁移 SQL（物化检索文本 + 覆盖索引） |
| `server/schema/v4-tag-cover-index.mjs` | V4 迁移 SQL（asset_tags 覆盖索引 + 统一覆盖索引 + 冗余索引退休） |
| `server/asset-kind.mjs` | 类型归一的单点（查询层与派生层共用） |
| `server/model-probe.mjs` | 宽高 / 色相 / 时长取值的单点（零依赖） |
| `server/library-vocab.mjs` | 词表解析：值→面、别名→值、值→子孙（纯函数，可单测） |
| `server/library-vocab.seed.mjs` | 词表种子数据（数据不是代码，改词只动这里 + 递增 `VOCAB_REV`） |
| `server/vocab-sync.mjs` | 词表种子 → SQLite 的幂等同步器（激活 / 父级 / 面 / 别名合并）+ `refreshTagCounts()` |
| `server/library-tag-facets.mjs` | 分面标签视图（面分组 + 物化计数 + `unfiled` 待归并池） |
| `server/library-blob.mjs` | 前端 blob → 派生行；`mergeDomains()` 把四域合成一份完整 state |
| `server/library-schema.mjs` | 迁移链 + 四域 key / 字段清单（契约层） |
| `server/library-state-files.mjs` | 状态文件层纯函数：体积上限 / 域路径 / 入参校验 / 封面恢复 / 目录合并 |
| `server/library-storage.mjs` | 按域落盘、合并语义、权威判定（逐域轻量戳）、`ensureIndex()`、备份换库 |
| `server/library-api.mjs` | 细粒度路由（写入 / 查询 / 成员 / 备份 / SSE / 会话 / 删除） |
| `server/library-db.mjs` | SQLite 唯一持有者（Repository 边界） |
| `server/library-query.mjs` | 查询语义（S2 拆出 SQL 编译层） |
| `server/library-tags-write.mjs` | 集合语义写入 + 审计（S3） |
| `server/library-events.mjs` | SSE 广播（S3） |
| `server/library-members.mjs` | 角色权限与成员目录（S3） |
| `server/library-backup.mjs` | 自动备份与恢复（S3） |
| `server/library-portable.mjs` | 整库导出 / 导入：只搬语义的可移植快照（ADR-10） |
| `src/library/backup-panel.js` | 设置里的「导出与迁移」卡片（ADR-10） |
| `src/library/library-events.js` | 前端订阅端：合并窗口 + 降级（S3） |
| `src/library/remote-sync.js` | 远端改动应用到本地状态（S3） |
| `src/library/tag-ops.js` | 主状态 diff → 分域写入指令（纯函数，ADR-02） |
| `src/library/persistent-storage.js` | 持久化边界：按域调度写入 + 失败整块重放（ADR-02） |
| `src/library/team-data.js` | 协作设置的数据契约：角色映射 / 行模型 / 请求缝（纯函数，S3） |
| `src/library/team-settings.js` | 成员与备份设置界面：权限门控 / 增删改 / 二次确认（DOM 层，S3） |
| `src/library/settings-panel.js` | 设置面板分组装配，挂载「协作与备份」分类（S3） |
| `test/library-tag-ops.test.js` | 翻译层的差集 / 域拆分 / fallback |
| `test/library-domains.test.js` | 四域存储、合并语义、读视图、定点删除 |
| `test/library-persistent-storage.test.js` | 通道调度、老进程降级、大 key 分流 |
| `test/library-team-settings.test.js` | 权限矩阵 / 成员增删改 / 备份恢复 / 错误降级（S3） |
| `test/library-state-stamps.test.js` | 逐域版本戳 / DB 原串污染不覆盖 / 老库补齐 / 快照丢失恢复（端到端性能修复） |
| `test/library-collab-api.test.js` | 角色门控 / 写入路由 / SSE / 协作取数（S3） |
| `test/library-events-client.test.js` | 前端订阅端（S3） |
| `test/library-remote-sync.test.js` | 远端改动应用（S3） |
| `test/library-backup.test.js` | 备份 / 恢复 / 保留份数（S3） |
| `test/library-portable.test.js` | 整库导出 / 合并导入 / 不覆盖本机标注 / replace（ADR-10） |
| `test/library-vocab.test.js` | 词表归一化 / 层级展开 / 种子自检 |
| `test/library-vocab-sync.test.js` | 词表同步、别名合并、分面视图计数 |
| `test/library-tag-filter.test.js` | 标签筛选的层级展开与子串兜底 |
| `test/library-schema-v2.test.js` | V1→V2 迁移与老数据映射 |
