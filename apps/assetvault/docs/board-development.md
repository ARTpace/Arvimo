# 画板体系与智能收集画板开发文档

> 本文把两件事合成一条主线：**让画板成为资产库的组织主轴**（花板式），以及**让画板能按规则自动去平台采集**（智能收集）。
> 前者是产品层改造，后者是采集回路；两者的连接点只有一个字段：`boardId`。
> 通用内核契约见 [资产库开发文档](asset-library-development.md)（schema v1 / 查询 / 差量 / 分页），本文只冻结画板与采集这两层新增契约。
> 功能 → 文件索引见 [CODEMAP.md](CODEMAP.md)，目录规范见 [project-structure.md](project-structure.md)。
> 适用基线：`SERVER_VERSION 3.15.0` / schema v1 / 2026-11-07。

---

## 0. 一页速览

| 项 | 结论 |
| --- | --- |
| 画板数据层 | **已经齐了**：`collections` 表带嵌套 / 封面 / 颜色 / 排序，`collection_assets` 是多对多 + 手动顺序，`/collections/items` 四种动作全有 |
| 画板问题 | 不在模型，在**产品层**：合集被当成高级检索里的一个筛选条件，不是一等公民入口；卡片右键没有「加入画板」；没有画板首页与封面拼图 |
| 智能收集问题 | `smart_collections` 只重算**本地已有资产**，永远不会主动去平台找新东西 |
| 连接点 | 采集规则挂在画板上（`rule.boardId`），结果直接落到这个画板，不需要二次选择目标 |
| 已决策 | ① 自动入库入板 + 只存元数据（不下载原文件）② 手动 + 每天一次 ③ 首批 P0+P1 ④ 规则先过候选/去重再入板 |
| 已落地 | 服务端 P0+P1（规则 / 统一搜索 / 守卫 / 执行器 / 待合并队列 / 调度器 / API）+ 前端智能收集面板、待合并合并、右键 / 批量加入画板；新增 66 例单测全绿，真实浏览器与真服务端冒烟通过 |
| 下一步 | 画板阶段 1 剩余部分（侧栏树 / 画板首页 / 封面拼图），随后阶段 2~4 |
| 红线 | 画板若成为主组织轴，**备份必须带上 `collections`**；纯文件模式（无 SQLite）下画板不可用必须显式提示，不能静默 503 |

---

## 1. 需求与决策记录

### 1.1 主人已确认的四项决策

| 决策 | 取值 | 带来的约束 |
| --- | --- | --- |
| 结果处理 | 自动入库入板，**只存元数据 + 缩略图** | 不接 `DownloadManager`，不自动落盘原文件；占盘与风控风险最低 |
| 触发频率 | 手动「立即收集」+ 每天固定小时一次 | 只要 `manual` / `daily` 两种频率，不上 cron、不上分钟级调度 |
| 首批范围 | P0（规则→搜索→去重→入板闭环）+ P1（调度 / 配额 / 熔断 / 运行记录） | 服务端先行，前端面板后置但必须同批交付 |
| 安全闸门 | 每平台配额 + 随机抖动 + 429 退避 + 连续失败熔断 | **上线前置条件**，不是优化项；默认多平台开启会在几分钟内被打成 429 |

### 1.2 两条需求的连接点

```
画板（Collections）  ←── rule.boardId ──  采集规则（Collect Rules）
   ↑ 卡片右键 / 批量加入                        ↓ 平台搜索 → 去重 → 待合并队列
   └──────────────── 同一个 /collections/items 'add' ──────┘
```

- 手动采集和自动采集**写同一张 `collection_assets`**，不另造「智能画板专用表」。
- `smart_collections`（本地重算规则）与 `collect-rules.json`（平台采集规则）是两套独立机制，**不要合并**：前者每次重算现有库，后者主动引入新资产。
- 一个画板可以挂多条采集规则；一条规则只属于一个画板。

### 1.3 借鉴边界与许可

- 参考源 `H:\AI-Tools\Serpent`（MIT）。画板阶段 1~3 计划复用其纯函数：`asset-drag-drop.ts` 的 `resolveCollectionDrop` / `resolveNewCollectionMembers`、`CollectionPickerMenu.tsx` 的 recent-first、`unified-directory-nav.ts` 的树排序、`FolderCard.tsx` 的 2×2 collage、`bounded-write-command.ts` 的 add/remove diff + history。
- Serpent **没有**画板首页、封面拼图、「从筛选结果生成静态画板」——这三处只需薄 UI 自研。
- 采集层复用本库既有 9 个模型平台 + 8 个可搜索图站的搜索函数，**不写第二套抓取逻辑**，出站统一走 `openPublic()`。

---

## 2. 现状盘点：为什么这么改

### 2.1 画板三层盘点（源码级诊断结论）

| 层 | 现状 | 判定 |
| --- | --- | --- |
| 数据层 | `collections(collection_id, parent_id, name, description, cover_asset_id, icon, color, position, created_at, updated_at)`；`collection_assets(collection_id, asset_id, position)`；`smart_collections(query, filters, sort)` | **齐** |
| 查询层 | `library-api.mjs` 先用画板成员缩候选集，再与其它筛选一起求值；`sort:'collection'` 支持手动顺序 | **齐**（画板内二次筛选 / 排序服务端天然支持） |
| 产品层 | 唯一入口在高级检索弹窗 + 图标条「更多」小列表；选画板 = 塞 `filters.collection` → `state.queryUids` → `filtered()` | **主次反了** |

四处断层：

1. **画板不是一等公民**：花瓣是「先看到画板、再看到卡片」，本库是「先跑检索、再顺手筛一下」。
2. **采集主链路断了**：`card-context-menu.js` 无加入项；批量栏只有收藏 / 下载 / 下图；唯一写入是 `advanced-query.js` 的 `addCurrent()`，且只能整批灌 `lastUids`；`remove` / `set` 服务端现成但前端零调用。
3. **画板本身没长相**：新建用 `window.prompt()`、删除用 `confirm()`；`listCollections()` 计数只数直接成员；`collection_assets` 无 `added_at`，不能按加入时间排。
4. **可靠性风险**：合集全链路依赖 SQLite，纯文件模式统一 503；`collections` 表不在 `state_meta` blob 权威里，**只拷 `library-state.json` 会丢掉全部画板关系**。

### 2.2 智能收集的三根缺柱与解法

| 缺口 | 原状 | 本轮解法 |
| --- | --- | --- |
| 服务端不能写 `models` | `/api/library/mutations` 白名单不含 `models`，只能整块 `POST /api/library-state`；而前端每 200ms 可能整块覆盖一次 | **待合并队列**：服务端只写 `collect-pending.json`，前端拉取 → 合并 → 自己走既有整块保存 → `ack` 删除。零新增写库通道、零迁移、失败可重放 |
| 没有统一搜索编排 | 多词并行 / 翻译 / 翻页 / 合并只活在 `discovery-feed.js`，强依赖 `state` 与 DOM | `collect-search.mjs` 注册表：平台 id → 既有搜索函数，结果归一化为采集条目 |
| 没有规则 / 调度 / 去重 | `smart_collections` 只存本地查询规则；无 cron；图站 uid 是「一次搜索页」的哈希 | `collect-rules.json`（规则 + 运行记录 + `seen` 索引原子落盘）+ 60s 调度器 + `platform:canonicalKey` 两级去重键 |

### 2.3 两个必须先知道的坑

- **拖拽**：桌面版 `drag-out.js:139` 在捕获阶段对所有 `.model-card[data-uid]` 的 `dragstart` 打 `preventDefault()`，会把页面内拖到侧栏的 DnD 整条掐死。阶段 3 前必须先让它只在「拖出窗口」时接管。
- **命名冲突**：`board-grid` / `.board-card` 已被**图站 Pinterest 画板**占用，且 `renderPictureSite()` 会整体接管 `#grid`。新 UI 一律用 `bd-*` 前缀，禁用 `board-*`。

---

## 3. 总体架构

```mermaid
flowchart LR
  subgraph UI[浏览器前端]
    BH[画板首页 / 侧栏树<br/>bd-* 命名]
    CARD[资产卡片<br/>右键 / 批量]
    PANEL[智能收集面板<br/>规则 CRUD / 运行记录]
    MERGE[待合并合并<br/>mergeModels + ack]
  end
  subgraph API[本地服务]
    COLL["/api/library/collections*<br/>（复用，零改动）"]
    CAPI["/api/collect/*<br/>（3.15.0 新增 7 条）"]
    SCHED[60s Scheduler]
    RUNNER[Collect Runner]
    GUARD[Guard 令牌桶 / 熔断]
    SEARCH[Collect Search 注册表]
    PENDING[(collect-pending.json)]
    RULES[(collect-rules.json)]
  end
  subgraph DATA[(SQLite v1)]
    C[(collections<br/>collection_assets)]
    S[(smart_collections)]
  end
  BH --> COLL
  CARD --> COLL
  PANEL --> CAPI
  MERGE --> CAPI
  CAPI --> RULES
  CAPI --> PENDING
  SCHED --> RUNNER
  CAPI --> RUNNER
  RUNNER --> GUARD --> SEARCH
  RUNNER --> PENDING
  RUNNER -->|addToBoard| C
  RUNNER --> RULES
  MERGE -->|整块保存| STATE[(library-state.json)]
```

**关键取舍**：入板是服务端可直接做的（`collection_assets` 接受尚未入库的 uid），所以「画板里先看到」立即生效；「资产卡片出现」要等前端下一次合并。这是绕开 `models` 写所有权的一致性方案，不是缺陷。

---

## 4. 冻结契约层（改动必须串行 + 版本提升）

> 这一层是**多 AI 并行开发的前提**：契约冻结后，各任务只依赖签名，不依赖别人的实现进度。契约变更走 ADR + 版本提升 + 兼容层，且串行执行。

### 4.1 画板数据模型（SQLite schema v1，只读，不新增字段）

| 表 | 主键 | 关键字段 | 语义 |
| --- | --- | --- | --- |
| `collections` | `collection_id TEXT` | `parent_id` / `cover_asset_id` / `icon` / `color` / `description` / `position` / `created_at` / `updated_at` | 嵌套画板；`position` 是同级排序 |
| `collection_assets` | `(collection_id, asset_id)` | `position INTEGER` | 多对多；一个资产可属多个画板；`position` 是画板内手动顺序 |
| `smart_collections` | `collection_id` | `query` / `filters JSON` / `sort` | 本地重算规则，**与平台采集规则无关** |

阶段 3 若要「按加入时间排序」，必须追加迁移 v2 补 `collection_assets.added_at`，遵守 `MIGRATIONS` 只加不改 + checksum 规则。

### 4.2 前端 state / 命名 / 事件契约

| 面 | 冻结内容 |
| --- | --- |
| state | `state.activeBoardId`（`''` = 画板首页 / 全部资产）；`state.boardIncludeChildren`、`state.boardView` |
| CSS | 一律 `bd-*`；**禁止** `board-*` / `.board-grid` / `.board-card`（已被图站占用） |
| 事件 | `assetvault:board-changed`（画板树变更，payload `{reason}`）、`assetvault:board-selected`（payload `{id}`）、`assetvault:collect-changed`（规则 / 运行结束） |
| 持久化 | `sfx-active-board-v1`（上次选中画板）、`sfx-board-recents-v1`（选择器最近使用）；坏存档一律退化空态 |
| 分页 | `library-paging.js` 的 `fingerprint()` 必须包含 `activeBoardId`，否则换画板不回第一页 |

### 4.3 画板 HTTP API（既有，零改动）

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/library/collections` | GET / POST / DELETE | 列表 / 新建或改名（含 `parentId` / `coverAssetId` / `color` / `icon` / `position`）/ 删除 |
| `/api/library/collections/items` | GET / POST | `action: add \| remove \| set \| reorder`，`uids: string[]`；允许写入尚未入库的 uid |
| `/api/library/smart-collections` | GET / POST | 本地重算规则 |
| `/api/library/smart-collections/resolve` | POST | 解析为 uid 集合 |

纯文件模式（`engine:"memory"`）下以上 4 条统一 503，前端必须显式提示「画板需要资产库内核」，不能静默空白。

### 4.4 收集规则契约（`collect-rules.json` v1）

```js
{
  version: 1,
  rules: [{
    id, boardId, boardName, name,
    platforms: string[],          // ≤12，来自 COLLECT_PLATFORMS 且 searchable:true
    query,                        // ≤300
    expand: boolean,              // 预留：中文扩词（当前未接 ai.translateSearch）
    filters: {formats, tags, excludeTags, kinds},   // 只有这 4 个维度有数据，不假装支持评分/颜色
    limit: 1..60, frequency: 'manual'|'daily', hour: 0..23,
    mode: 'auto'|'review', enabled,
    createdAt, updatedAt, lastRunAt, nextRunAt,
    lastStatus: ''|'ok'|'partial'|'failed', failStreak, totalAdded
  }],
  runs: [{id, ruleId, boardId, at, dryRun, found, added, skipped, failed, platforms, warnings}],
  seen: {'platform:key': timestamp}
}
```

- 上限：`rules ≤ 50` / `runs ≤ 200` / `seen ≤ 20000` / 文件 ≤ 8MB（`COLLECT_LIMITS`，改常量即可，不写死在调用点）。
- 为什么不放 SQLite：规则低频写、体量小，独立文件让「规则能看 / 能改 / 能停」不被内核可用性绑架；`seen` 同文件保证「一次采集 = 一次原子写盘」。
- 写操作全部串行排队（`commit()`），读缓存只在写盘成功后替换；`.tmp` + `rename` 原子落盘；坏文件退化空态不崩。

### 4.5 采集 HTTP API（`/api/collect/*`，3.15.0 新增 7 条）

| 路由 | 方法 | 入参 | 返回 |
| --- | --- | --- | --- |
| `/api/collect/status` | GET | — | `{engine, scheduler, pending, platforms, limits}` |
| `/api/collect/rules` | GET | `?ruleId&limit` | `{rules, runs, platforms, limits, pending}` |
| `/api/collect/rules` | POST | 规则对象 | `{rule, rules}`；校验失败 400 |
| `/api/collect/rules` | DELETE | `?id` | `{removed, rules}` |
| `/api/collect/run` | POST | `{id, dryRun?}` | `{run}`；同规则并发 409；`dryRun` 返回 `preview[24]` 且不写任何状态 |
| `/api/collect/runs` | GET | `?ruleId&limit` | `{runs}` |
| `/api/collect/pending` | GET | — | `{models, count, updatedAt}` |
| `/api/collect/pending/ack` | POST | `{uids}` | `{removed, count}` |

**守卫**：请求头 `x-sfx-local: 1` + `Origin` 与 `Host` 同站，跨站 / 局域网访客一律 403（与 `/api/library/*` 同一条规则）。

### 4.6 身份键与去重契约

| 来源 | key | uid |
| --- | --- | --- |
| 模型平台 | `${platform}:${assetId \|\| uid \|\| canonicalKey(url)}` | 平台已有 32 位 uid 则复用，否则 `md5(platform:key)` |
| 图站 | `${platform}:${canonicalKey(pageUrl \|\| url)}` | `md5(platform:key)` |

- `canonicalKey()` 去掉 `utm_*` / `from` / `refer` / `spm` 与 hash，`searchParams.sort()`，返回 `hostname + pathname + search`。
- `seen` 索引按 key 去重，`rules.seenHas(keys)` → `Set`；`dryRun` **不消耗** seen；一次真实采集结束由 `recordRun()` 原子写入。
- 下载落盘后的 `sha256` 内容去重属 P3，不在本批。

### 4.7 采集守卫与调度契约

| 面 | 冻结值 |
| --- | --- |
| 配额 | `model: 30/h, burst 6`；`picture: 12/h, burst 3`（`COLLECT_BUDGETS`，可调） |
| 抖动 | 每次请求前 500~2000ms 随机（`jitterMinMs/jitterMaxMs`） |
| 失败 | `Retry-After` 优先；无头时连续 3 次失败熔断 6 小时；成功一次清零 |
| 首次调用 | **新平台从满桶开始**（`burst`），不得从 0 令牌起步 |
| 调度 | 60s tick、`unref()`、同一 tick 内串行、单规则锁、`daily` 到点、停机 >7 天的过期规则重置 |
| 可注入 | `now` / `sleep` / `random` / `setTimer` / `search` / `addToBoard` 全部走参数注入，测试不碰真实时钟与外网 |

### 4.8 待合并队列契约（`collect-pending.json`）

```js
{version: 1, models: [{uid, name, author, thumbnail, url, platform, assetType,
                       tags, license, downloadable, source:'collect', collectedAt}], updatedAt}
```

- `uid` 必须 32 位十六进制；单模型 ≤16KB；队列 ≤2000，超限时**丢最旧**保留新采集。
- 前端合并顺序固定：拉 `/pending` → `mergeModels(state.models, models)` → `saveLibrary()` 成功 → `POST /pending/ack` → `renderGrid()`。**ack 必须在保存成功之后**，否则崩溃会丢资产。
- 入板失败不回滚队列：资产仍可在面板里重试入板，运行记录里记 warning。

### 4.9 能力位与版本契约

`SERVER_VERSION 3.15.0`；新增 `collectRules` / `collectScheduler` / `collectPendingMerge` / `collectPlatformSearch` 四个能力位。
老进程没有 `/api/collect/*` 路由，面板一打开就 404 —— **必须重启服务**，不能只刷新页面。`createLibraryServer({collect:false})` 只给测试关闭心跳用。

### 4.10 目录 / 命名 / 行数红线

| 类别 | 约定 |
| --- | --- |
| 服务端 | `server/collect-*.mjs`，一个职责一个文件，≤300 行（当前最大 `collect-rules.mjs` 252 行） |
| 前端 | `src/library/board-*.js`；画板 UI 用 `bd-*` 类名；面板复用 `filter-panel-common.js` 的图标 / 滑条控件与 `--fd-*` 令牌 |
| 测试 | `test/library-collect-<模块>.test.js` / `test/library-board-<模块>.test.js`，一对一镜像被测模块；**生产目录禁放测试** |
| 临时 | 探查 / 冒烟脚本一律 `scratch/<日期>_<主题>/`，用完即弃；截图等证据归档 `artifacts/` |
| 索引 | 新增 / 移动文件必须同步 `docs/CODEMAP.md`；契约变更必须同步本文 §4 |

---

## 5. 已落地实现（3.15.0，服务端 P0 + P1）

| 文件 | 行数 | 职责 | 关键契约 |
| --- | --- | --- | --- |
| `server/collect-rules.mjs` | 252 | 规则 / 运行记录 / seen 三合一仓库 | `normalizeRule` `ruleDue` `nextDailyAt` `pruneSeen` `createCollectRules` |
| `server/collect-search.mjs` | 150 | 平台注册表 + 结果归一化 | `COLLECT_PLATFORMS` `canonicalKey` `collectUid` `createCollectSearch().search` |
| `server/collect-guard.mjs` | 106 | 令牌桶 / 抖动 / 退避 / 熔断 | `COLLECT_BUDGETS` `refillBucket` `createCollectGuard` |
| `server/collect-pending.mjs` | 97 | 待合并队列 | `PENDING_LIMIT` `createCollectPending().add/ack/list/status` |
| `server/collect-runner.mjs` | 154 | 单规则执行器 | `collectRow` `collectModel` `filterItems` `createCollectRunner().run` |
| `server/collect-scheduler.mjs` | 72 | 60s 心跳 | `COLLECT_TICK_MS` `createCollectScheduler` |
| `server/collect-api.mjs` | 139 | HTTP 面 | `ROUTES` `createCollectApi().handle` |
| `server/library.mjs` | 装配 | 注入 `collectDir`（`downloads.dataDir \|\| resolveDataDir(root).dir`）、装配 7 个模块、路由挂载、启动心跳 | `createLibraryServer({collect})` |

**平台覆盖**：注册表共 **22 项** = 9 个模型平台（sketchfab / artstation / polyhaven / ambientcg / polypizza / kenney / freestylized / polyfork / simready）+ 13 个图站；其中 **17 项支持关键词采集**（9 模型 + 8 图站）。`pixiv` / `civitai` / `zcool` / `designspiration` / `500px` 标 `searchable:false`，只支持钉作者页 / 画板页 URL，规则里选中会被明确拒绝。端点 `/api/collect/status` 的 `platforms` 字段是前端唯一数据源，禁止另抄一份清单。

**单测**：`test/library-collect-{rules,search,guard,runner,scheduler}.test.js` 共 **39 例全绿**（假 searcher / 假时钟 / 假文件系统注入，不打外网）。

### 5.1 前端已落地（同批交付）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/library/board-api.js` | 63 | 两套 base 的统一 HTTP 面；`createBoardApi({fetchImpl})` 可注入假 fetch；非 2xx 归一化成带 `status` 的 Error，404 能被面板识别成「旧进程」 |
| `src/library/board-store.js` | 175 | 画板状态源：`flattenBoards()` 树扁平化（防环 / 孤儿降级顶层）、`searchBoards()`、偏好持久化、最近使用、写入动作；纯函数与副作用分离 |
| `src/library/board-picker.js` | 111 | 右键 / 批量共用的画板选择器：搜索、层级缩进、多选、内联新建、加入 / 移出双模式；自建 `<dialog>`，不改 `index.html` |
| `src/library/board-collect-template.js` | 94 | 面板骨架：滑条、分段、图标 chip、规则卡片、运行记录、试运行预览；零说明段落 |
| `src/library/board-collect.js` | 264 | 规则 CRUD / 试运行 / 立即收集 / 暂停 / 二次确认删除 / 运行记录 / **待合并合并**；`syncPending()` 幂等且严格按 `mergeModels → persistNow → ack → renderGrid` 顺序 |
| `src/library/board-hub.js` | 91 | 唯一装配点：工具栏按钮、批量栏按钮、右键 `actions` 缝、60s 轮询合并、聚焦补合并、能力位探测（capabilities 不可用时不误报） |

**接线**：`card-context-menu.js` 的 `assetMenuItems(ctx)` 新增两项 `run` 型画板动作（未注入 `onBoardPicker` 或访客模式自动缺席，**不改 `app.js` 的 action switch**）；`app.js` 只加 1 个 import + 1 个 `let boardHub` 占位 + `cardContextItems` 传一个回调 + `if(!visitor)` 块里一行装配；`index.html` 零改动；`icon-set.js` 补 5 个 SVG path；`app.css` 末尾追加 `bd-*` 视觉层。

**验证**：`test/library-board-{api,store,contract}.test.js` 27 例 + 服务端 39 例 = **66 例全绿**；Edge headless 真实 DOM 冒烟 `errors:[]`（11 平台 chip / 2 画板 / 规则保存 / 试运行 2 张预览 / 幂等合并 / 选择器加入）；真 `createLibraryServer` 端到端 `/api/collect/*` 全通（SQLite 引擎、规则 CRUD、跨站与缺头均 403）。

---

## 6. 待开发任务（并行沙箱）

> 冲突量 ≈ 共享面 × 变更频率。共享面只有 §4 契约与 `app.js` 装配行；各任务独占目录，契约冻结后可直接并行。
> `app.js` 装配行是唯一共享写点，由 owner A 统一落，其他任务只导出工厂函数。

### 6.1 任务切分表

| ID | 任务 | 状态 | owner / 独占文件 | 依赖契约 | 验收 |
| --- | --- | --- | --- | --- | --- |
| A | 前端智能收集面板 + 待合并合并 | ✅ 完成 | `board-collect.js` `board-collect-template.js` | §4.5 §4.8 | 规则 CRUD / 立即收集 / dryRun 预览 / 运行记录 / pending 合并与 ack |
| B | 画板状态源 | ✅ 完成 | `board-store.js` | §4.2 §4.3 | 拉 `/collections`、树扁平化、选中态、持久化、变更事件 |
| C | 画板选择器 | ✅ 完成 | `board-picker.js` | §4.2 | 搜索 + 层级 + 多选 + 内联新建 + 加入 / 移出 |
| C2 | 封面拼图 | ⏳ 待做 | `board-cover.js` | §4.2 | `cover_asset_id` 优先，否则成员前 4 张缩略图 2×2（参考 Serpent `FolderCard.tsx`） |
| D | 画板侧栏树 / 画板首页 | ⏳ 待做 | `board-panel.js` `board-home.js` | §4.2 | `bd-*` 命名、嵌套展开、新建 / 改名 / 改色 / 删除、封面拼图 |
| E | 卡片与批量接线 | ✅ 完成（部分） | `card-context-menu.js` `app.js` `app.css` `board-hub.js` | §4.2 §4.3 | 右键 / 批量加入与移出已通；`route()` 显隐与 `fingerprint()` 加 boardId 留到 D 一起做（还没有画板主视图，提前改分页指纹无意义） |
| F | 画板首页成为主视图（阶段 2） | ⏳ 待做 | `board-view.js` | §4.3 | 面包屑、包含子画板、从筛选结果建板（`action:'set'`） |
| G | 拖拽 / 按加入时间排序（阶段 3） | ⏳ 待做 | 拖拽模块 + `library-schema.mjs` | §4.1 | 先让 `drag-out.js:139` 让路；追加迁移 v2 |
| H | 备份带上画板 / 降级提示（阶段 4） | ⏳ 待做 | 导出模块 + `board-store.js` | §4.3 | 整库导出含 `collections`；纯文件模式显式提示 |

### 6.2 A 任务规格（已落地，作为后续面板的实现范式）

- 面板入口：`#local-toolbar` 追加 `bd-toolbar-btn`（⚡ 图标），批量栏追加 `bd-selection-btn`；自建 `<dialog>` 不改 `index.html`。视觉沿用「少文字 + 图标 + 颜色 + 滑条」：`bd-*` 令牌独立一段 CSS，不复用 `filter-panel-common.js`（避免筛选面板改版牵连画板）。
- 表单：画板下拉来自 `store.flat()`（层级缩进 + 过滤智能画板）、平台多选芯片来自 `api.rules().platforms`（`searchable:false` 置灰）、关键词、上限滑条、频率分段 + 小时、启用开关、四类过滤条件（折叠）。支持内联新建画板，**不用 `window.prompt`**。
- 列表：规则卡片显示状态色点 / 频率 / 累计新增，操作全是图标（试运行 / 立即收集 / 暂停 / 编辑 / 删除）；删除走**二次点击确认**，不用 `window.confirm`；展开显示最近 5 条运行记录与异常平台。
- `dryRun` 预览用卡片网格展示 `preview[]`，不写任何状态；真实 `run` 成功后自动触发 `syncPending()`。
- 待合并合并：启动时、面板打开时、每 60s、窗口聚焦、`assetvault:collect-changed` 各触发一次 `syncPending()`；严格 `mergeModels → persistNow → ack → renderGrid`，**幂等**（`merging` 闸门 + `mergeModels` 按 uid 覆盖，ack 失败可重放）。
- 能力位检测：先拉 `/api/downloads/capabilities`；该路由在下载服务未启动时可能 503，所以拿不到能力位时**再直接探 `/api/collect/status`**，只有 404 才提示「请重启服务到 3.15.0」，不误报。

### 6.3 画板阶段 1~4 规格

| 阶段 | 内容 | 服务端改动 |
| --- | --- | --- |
| 0 契约先行 | 本文 §4 冻结 `activeBoardId` / `bd-*` / 事件名 / 能力位 | 零改动 |
| 1 采集 + 侧栏 | 右键 / 批量加入与移出、选择器、侧栏树、封面拼图、新建 / 改名 / 改色 / 删除 | **零改动、零迁移** |
| 2 主视图 | 画板首页、详情网格 + 面包屑 + 包含子画板、从当前筛选结果一键建板、存为智能画板 | 零改动 |
| 3 效率 | 拖卡片到侧栏、画板内拖拽排序（`action:'reorder'`）、Shift 连选 / 框选、按加入时间排序 | 追加迁移 v2 |
| 4 可靠性 | 整库备份带上 `collections`、纯文件模式明确降级、加入 / 移出可撤销 | 导出 + 能力位 |

### 6.4 依赖顺序

```
§4 契约（本文，已完成）
   ├── 服务端 P0+P1（已完成）
   ├── B 画板状态源 ──┬── A 收集面板（可降级手输 boardId）
   │                  ├── C 选择器 / 封面
   │                  └── D 侧栏 / 首页
   └── E 卡片接线（等 B/C 的工厂签名，装配行由 E 统一落）
        └── F → G → H
```

A 与 B 可并行（A 用降级路径），C / D 等 B 的导出签名，E 最后统一装配。

---

## 7. 测试策略与验收基线

| 层 | 位置 | 规则 |
| --- | --- | --- |
| unit | `test/library-collect-*.test.js` | 纯内存；注入 `now` / `sleep` / `random` / `io` / `search` / `addToBoard`，**禁止真实时钟、外网、DB** |
| contract | `test/library-board-*.test.js` | 静态断言钉住 CSS 前缀、事件名、API 路径、状态键，防「改了契约没同步文档」 |
| integration | 后续 | 真 `createLibraryServer({collect:false})` + 临时数据目录 + 假平台 searcher |
| 视觉 / DOM | `scratch/<日期>_<主题>/` | Edge headless，用完即删；截图归档 `artifacts/` |

- **基线判据是「零新增红」**：工作区既有 16 红（ArtStation、卡片文案、平台注册、LAN、Blender FBX、DOM 等）与内核无关。当前全量 `1082 / 1066 / 16 红`。
- 定向回归**必须串行**：`node --test --test-concurrency=1`，否则多文件抢 `SFX_DATA_DIR`。
- 采集模块当前 `39 / 39 全绿`。

---

## 8. 开发工作流与 Checklist

```bash
node --test --test-concurrency=1 test/library-collect-*.test.js   # 采集定向
node --test --test-concurrency=1 test/*.test.js vendor/upstream-src/test/*.test.js  # 全量
npm run build:library                                            # 同步 dist 与桌面版
```

改动前：
- [ ] 读本文 §4 与 [资产库开发文档](asset-library-development.md) §3，确认不碰冻结契约
- [ ] CSS 用 `bd-*`，不是 `board-*`
- [ ] 新增平台只改注册表，不写 `if-else` 长龙

改动后：
- [ ] `docs/CODEMAP.md` 同步新增文件
- [ ] 单文件 ≤300 行，测试一对一镜像
- [ ] 定向 + 全量回归，比对 16 红基线
- [ ] `npm run build:library`，核对 `dist/library/app.js` 与 `sketchfab-exporter-tauri/src/app.js` 哈希一致
- [ ] 服务端契约变更 → 升 `SERVER_VERSION` + 能力位 + 本文 §4
- [ ] 桌面安装版需重跑 `build-installer.cmd`

---

## 9. 风险与故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板 404 / 规则列表空 | 老进程没有 `/api/collect/*` | 重启服务，确认 `/api/downloads/capabilities` 含 `collectRules` 且版本 `3.15.0` |
| 第一次采集一条都收不到 | 守卫新桶从 0 令牌起步（已修） | 确认 `check()` 首次返回 `{ok:true}` |
| 采集结果按格式筛选全空 | `collectRow` 没把 URL 喂给 `formatsOfModel`（已修） | 确认 `collectRow(item).formats` 非空 |
| 画板里看到了、卡片没出现 | 设计如此：待合并队列要等前端合并 | 打开面板或刷新触发 `/api/collect/pending` → ack；查 `pending.count` |
| 同一批资产反复入队 | `seen` 未写入 / ack 未回 | 查 `rules.recordRun()` 是否被调用；`dryRun` 不应消耗 seen |
| 多平台瞬间 429 | 守卫失效或未启用 | 查 `COLLECT_BUDGETS` 与 `guard.snapshot()`；确认规则经 `runner` 而非直连 search |
| 只备份 `library-state.json` 后画板全空 | `collections` 不在 blob 权威里 | 阶段 4 修；当前必须连 SQLite 文件一起备份 |
| 拖卡片到侧栏无反应 | `drag-out.js:139` 捕获阶段 `preventDefault()` | 阶段 3 先改成只在「拖出窗口」时接管 |
| 纯文件模式画板空白 | 合集路由统一 503 | 前端显式提示需要资产库内核，不静默 |

---

## 10. 参考

- [资产库开发文档：路线 B 内核契约](asset-library-development.md)
- [CODEMAP：功能 → 文件索引](CODEMAP.md)
- [平台清单](platforms.md) / [用户数据目录](user-data-storage.md)
- [完整变更记录](CHANGELOG.md)
- 外部参考：`H:\AI-Tools\Serpent`（MIT）画板与拖拽纯函数；本项目主体 GPL-3.0-only
