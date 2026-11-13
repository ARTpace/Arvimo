# RSS 集成设计预案 · AssetVault（方向 B · 消费阅读器）

> 状态：调研方案 v2（未实现）· 目标读者：主人（ARTpace）
> 决策记录：前一轮已把 Uiverse 接入为第三类资产（代码型）。本轮经讨论，**确定做方向 B（RSS 消费端 / 阅读器），且首期不含微博**（微博需 RSSHub 自建桥接，列为后续扩展）。聚焦 **播客 + 资讯网站** 两类源。
> 调研依据（真实代码）：`src/library/platforms.js`（FEEDS 注册表）、`server/uiverse-state.mjs` / `server/uiverse.mjs`（纯解析层+网络层拆分范式）、`server/library.mjs`（路由+`x-sfx-local` 守卫）、`server/capabilities.mjs`（能力位铁律）、`server/collect-scheduler.mjs`（60s 心跳调度范式）、`server/platform-settings.mjs`（原子写落盘）、`server/data-dir.mjs`（用户数据目录 `dataDir`）。

---

## 1. 目标与范围（B，首期）

把 AssetVault 变成一个**能添加外部 RSS 源的轻量阅读器**：订阅的播客/资讯源聚合进既有卡片网格，按可配置间隔轮询、靠 `guid` 去重发现新条目，并显示未读角标/通知。

| 源类型 | 首期支持 | 实现方式 |
|--------|----------|----------|
| 🎙️ **播客** | ✅ | RSS 原生就是播客格式（每集 `<item>` + `<enclosure audio/mpeg>`），解析即所得；卡片内嵌 `<audio>` 播放器 |
| 📰 **资讯网站** | ✅ | 原生 RSS 站点直连；中文站（澎湃/观察者/36氪/财新/华尔街见闻/早报等）经 RSSHub 路由桥接（**仅把 RSSHub 当数据服务指向其输出，不抄代码**） |
| 💬 **微博** | ❌ 本期不做 | 无原生 RSS，须 RSSHub 自建实例桥接，有运维成本 → 列为后续扩展 |

**不做（明确划界）**：A 方向（把 AV 自家资产生成 RSS 给别人订阅）本期不做；WebSub 秒级推送不做（绝大多数源不支持）；付费墙/登录专属内容无法经 RSS 获取。

---

## 2. 可行性结论

**能做，复用度极高，且比 A 更贴合你"统一网格"的定位。** 关键事实：

1. `FEEDS` 契约（`{models, next, total}`）与 RSS `channel+items` **同构**；RSS 解析结果天然就是一批 `model` 卡片。
2. 项目已有 `uiverse-state.mjs`（纯解析层+单测）与 `uiverse.mjs`（网络层）的**双文件拆分范式**，RSS 照抄即可、离线可测。
3. 已有 `collect-scheduler.mjs` 的**60s 心跳串行调度**范式，RSS 轮询直接镜像，不引入 cron 依赖。
4. 已有 `platform-settings.mjs` 的**原子写**与 `data-dir.mjs` 的 `dataDir`，订阅源配置落盘零新概念。

---

## 3. 技术选型

| 用途 | 方案 | 许可证 | 处置 |
|------|------|--------|------|
| **RSS/Atom 解析** | **`rss-parser`** (npm) | **MIT** ✅ | 直接 `npm i`；支持自定义字段（`itunes:image`、`enclosure`、`media:thumbnail`），零负担 |
| 架构范式参考 | RSSHub（`DIYgod/RSSHub`） | **AGPL-3.0** ⚠️ | **仅当数据服务用**（指向其 RSS 输出 URL），**严禁 vendoring 源码**（消费输出不触发 copyleft） |

> 首期只需 `rss-parser`。`feed` 库（生成器用）本期不引入。

---

## 4. 数据模型与持久化

### 4.1 RSS 订阅源（Source）

```js
{
  id: string,              // uuid
  title: string,           // 自动从 feed <title> 取，可改
  url: string,             // feed URL（播客/资讯 XML）
  kind: 'podcast' | 'news',// 决定卡片渲染与 enclosure 处理
  pollIntervalMin: number, // 默认 15，范围 5–60
  enabled: boolean,        // 默认 true
  lastGuids: string[],     // 最近 N 条 guid，用于去重（环形，cap≈200）
  lastPolledAt: number,    // 时间戳
  lastError: string|null,  // 上次轮询错误（展示在管理面板）
  etag: string|null,       // 条件 GET，省流量
  createdAt: number
}
```

### 4.2 落盘位置与方式

- **位置**：`resolveUserPaths(env).dataDir + '/rss-sources.json'`（`data-dir.mjs` 的 `dataDir` = `~/.assetvault/data`）。
- **方式**：镜像 `platform-settings.mjs` 的**原子写**——先写 `*.tmp` 再 `rename`，避免半截文件。
- 订阅源是**用户数据**，不进版本库、不进 `src/`。

---

## 5. 服务端设计

### 5.1 新增文件（镜像 uiverse 双文件 + collect 调度）

| 文件 | 角色 | 复用/对齐 |
|------|------|-----------|
| `server/rss-state.mjs` | **纯解析层**（离线可测）：`parseRssXml(xml,{kind})`、`rssItemToModel(item,source)`、`dedupeItems(prevGuids,items)`、`normalizeFeedMeta(xml,url)` | 仿 `uiverse-state.mjs` |
| `server/rss.mjs` | **网络+逻辑层**：`fetchRssSource(source)`（条件 GET+解析+去重）、`add/list/remove/updateRssSource`（持久化）、`aggregateFeed({limit,offset})`（跨源聚合，返回 FEEDS 契约）、`pollAllSources()` | 仿 `uiverse.mjs` |
| `server/rss-scheduler.mjs` | **轮询调度**：`createRssScheduler({sources,fetcher,intervalMs,onNewItems,onWarn,setTimer})`，60s 心跳、串行、按 `lastPolledAt+pollIntervalMin` 判到期、`running` 防并发、`status()` | **镜像 `collect-scheduler.mjs`** |

### 5.2 关键纯函数：`rssItemToModel`（RSS item → AV `model` 卡片）

```js
{
  id: item.guid || item.link,
  title: item.title,
  summary: item.contentSnippet || item.content || item.summary, // 纯文本摘要
  link: item.link,
  author: item.creator || item.author || source.title,
  pubDate: item.isoDate || item.pubDate,
  thumbnail:
    source.kind==='podcast' ? (item.itunes?.image || item.enclosure?.url)  // 播客封面
                            : (item.itunes?.image || media:thumbnail || null),
  kind: source.kind,
  enclosure: source.kind==='podcast'
    ? {url:item.enclosure?.url, type:item.enclosure?.type, length:item.enclosure?.length}
    : null,
  sourceId: source.id,
  sourceTitle: source.title,
  guid: item.guid || item.link,
  unread: true
}
```

### 5.3 `aggregateFeed` —— 喂给网格的 FEEDS 契约

跨所有 `enabled` 源，取各自最新条目 → 按 `pubDate` 降序 → 分页返回 `{models, next, total}`，**与 Sketchfab/Uiverse 等现有 feed 同契约**，网格渲染零改。

### 5.4 端点（`server/library.mjs`，**保留 `x-sfx-local` 守卫**）

> ⚠️ 与 A 方向相反：A 要去掉守卫（对外给阅读器），B 的端点是 **AV 自己的 UI 接口**，**必须保留守卫**（防局域网越权读写订阅）。

| 方法+路径 | 作用 | 守卫 |
|-----------|------|------|
| `GET /api/rss/sources` | 列出订阅源（含 `lastError`/`lastPolledAt`/`itemCount`） | ✅ 留 |
| `POST /api/rss/sources` | 新增：`{url, kind, pollIntervalMin?}`；先探活+解析校验（非 RSS 则拒），自动取 `title` | ✅ 留 |
| `PATCH /api/rss/sources/:id` | 改：开关 `enabled` / 调 `pollIntervalMin` / 改 `title` | ✅ 留 |
| `DELETE /api/rss/sources/:id` | 删除源 | ✅ 留 |
| `GET /api/rss/feed?limit=&offset=` | 聚合条目（FEEDS 契约）喂网格 | ✅ 留 |
| `POST /api/rss/poll` | 手动立即轮询（刷新按钮） | ✅ 留 |
| `GET/POST /api/rss/opml` | （可选阶段）导出/导入 OPML，一键迁移现有阅读器订阅 | ✅ 留 |

### 5.5 能力位（`server/capabilities.mjs`）

```js
SERVER_VERSION = '3.16.3';            // 升版本（启动器据此换旧进程）
SERVER_CAPABILITIES.rssReader = true; // 新增；OPML 可选 rssOpml:true
```

> 铁律：漏加能力位 → 旧进程被判「已最新」不重启 → 新路由 404。必须同步加。

---

## 6. 前端设计

### 6.1 注册表（`src/library/platforms.js`）

- `FEEDS` 加 `'rss'`；`FEED_LABELS`/`FEED_ENDPOINTS` 加 `rss:'RSS 订阅'` / `rss:'/api/rss/feed'`。**前端零 if/else**，与 Uiverse 同套路。

### 6.2 请求流（`src/library/app.js`）

- `readRequest` 加 `mode==='rss'` → `GET /api/rss/feed`。
- 动作分发表加：`add-rss-source` / `remove-rss-source` / `toggle-rss-source` / `poll-rss` / `mark-rss-read`。

### 6.3 新增 UI

- **订阅管理面板**（模态/侧栏）：输入 RSS URL + 选类型（播客/资讯）+ 间隔；源列表显示「开关 / 上次更新 / 错误 / 条目数」；「导入 OPML」按钮（可选）。
- **卡片渲染**（复用网格，`kind` 决定样式）：
  - 播客：`itunes:image` 封面 + 标题 + **内嵌 `<audio controls src=enclosure.url>` 在线播放器** + 时长；
  - 资讯：缩略图 + 标题 + 摘要片段 + 「打开原文」外链；
  - 二者通用：源徽标 + 相对时间 + 「标记已读」。
- **未读角标**：调度器发现新条目 → 累加未读数 → 显示在「RSS 订阅」标签/按钮上。

### 6.4 样式（`src/library/app.css`）

新增 `.rss-source-panel` / `.rss-card` / `.rss-audio` / `.rss-unread-badge` 等。

### 6.5 音频播放可行性

`<audio>` 标签播放跨域媒体**无需 CORS**（仅脚本化分析才需要），故播客卡片内嵌播放器可行；个别主机防盗链导致加载失败时优雅降级为「打开/下载」外链。

---

## 7. 「实时更新」说清楚

RSS 是**拉模型**：调度器按每源 `pollIntervalMin`（默认 15，可 5–60）轮询，`guid` 去重发现新条目。

- **准实时/分钟级**，不是秒级推送。
- 真·秒级需 WebSub（PubSubHubbub），绝大多数源（尤其中文站/RSSHub）不支持 → 本期不做，留作增强。
- 条件 GET（`etag`）降低上游压力；尊重 `429/Retry-After`。

---

## 8. 文件改动清单（B 首期）

**新增**
| 文件 | 说明 |
|------|------|
| `server/rss-state.mjs` | 纯解析层 |
| `server/rss.mjs` | 网络+CRUD+聚合 |
| `server/rss-scheduler.mjs` | 轮询调度（镜像 collect-scheduler） |
| `test/library-rss-state.test.js` | 解析/归一化/去重单测 |
| `test/library-rss-scheduler.test.js` | 调度到期/串行/status 单测（若有 collect 测试可仿） |

**修改**
| 文件 | 改动 |
|------|------|
| `server/library.mjs` | 加 6 个 RSS 端点（保留守卫）+ 启动时 `rssScheduler.start()` |
| `server/capabilities.mjs` | `SERVER_VERSION` +1、`rssReader:true` |
| `package.json` | 加 `rss-parser`（MIT） |
| `src/library/platforms.js` | `FEEDS`/`FEED_LABELS`/`FEED_ENDPOINTS` 加 `rss` |
| `src/library/app.js` | `readRequest` 加 `rss` 分支 + 动作分发表 |
| `src/library/index.html` | 订阅管理面板 markup |
| `src/library/app.css` | RSS 相关样式 |
| `docs/CHANGELOG.md` / `docs/CODEMAP.md` / `docs/platforms.md` | 补 RSS 条目 |

---

## 9. 复用映射

| 新需求 | 直接复用 AV 既有 | 复用方式 |
|--------|------------------|----------|
| 解析层+单测 | `uiverse-state.mjs` + `test/library-uiverse-state.test.js` | 同构新建 `rss-state` |
| 网络层 | `uiverse.mjs` | 同构新建 `rss` |
| 调度 | `collect-scheduler.mjs` | 镜像 `createRssScheduler` |
| 落盘 | `platform-settings.mjs` 原子写 + `data-dir.mjs` `dataDir` | 订阅源存 `dataDir/rss-sources.json` |
| 网格渲染 | 既有 `models→卡片` | `aggregateFeed` 返回同契约，零改 |
| 注册表 | `platforms.js` 的 `FEEDS` | 加 `rss` 条目，无 if/else |
| 进程同步 | `capabilities.mjs` + `serverIsCurrent` | 必加能力位，否则 404 |

---

## 10. 风险

- **外部源不稳定 / 格式漂移**：`rss-parser` 覆盖 RSS 2.0 + Atom；非标准源解析失败 → 记 `lastError` 展示，不影响其他源。
- **防盗链**：音频/缩略图偶发加载失败 → 降级为外链。
- **轮询负载**：多源/短间隔 → 串行（`running` 防并发）+ 错峰 + `etag` 条件 GET。
- **「实时」预期管理**：分钟级，非秒级（文档/UI 文案写清楚）。
- **付费墙/登录内容**：RSS 协议天花板，本期无解、明确划界。

---

## 11. 实施阶段（B 首期）

1. **地基**：`rss-parser` 依赖 + `capabilities` 能力位/版本 + `rss-sources.json` 持久化 + `rss-state.mjs`（解析/归一化/去重）+ 单测。
2. **逻辑**：`rss.mjs`（探活校验/CRUD/聚合）+ 单测。
3. **调度+接口**：`rss-scheduler.mjs`（镜像 collect）+ `library.mjs` 端点（留守卫）+ 启动挂载。
4. **前端**：`FEEDS` 条目 + `readRequest` 分支 + 订阅管理面板 + 卡片渲染（播客 `<audio>`）+ `app.css`。
5. **收尾**：构建、冒烟、回归；OPML 导入（可选）；文档同步。

---

## 12. 待主人确认（B 范围）

1. **播客播放**：卡片内嵌 `<audio>` **在线播放**，还是只给「打开/下载」外链？（影响卡片复杂度与防盗链处理）
2. **OPML**：要不要支持**导入你现有阅读器的 OPML** 一键迁订阅？（阶段 5 可选）
3. **通知**：新条目只显示**网格未读角标**，还是要**桌面弹窗通知**？（若 AV 已有通知机制则复用）
4. **默认间隔**：每源默认 **15 分钟**轮询 OK 吗？（可单源设 5–60）
5. **微博**：确认**本期不做**，留作 RSSHub 桥接后续扩展？（文档已划界）
