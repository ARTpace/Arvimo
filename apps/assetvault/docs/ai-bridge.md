# AI 桥接：MCP server 与 CLI

给外部 AI 客户端（WorkBuddy、Claude Desktop、Cursor 等）驱动 AssetVault 的接入层。
状态：已实现，2026-11-04。源码：`server/ai-client.mjs`、`server/ai-mcp.mjs`、`scripts/assetvault-cli.mjs`。

## 为什么是 MCP，而不是纯 CLI

AssetVault 不是「一个命令」，是**有状态的长驻服务**：本地 HTTP 服务、进程锁、30 分钟量级的
下载/转换队列、任务落在数据目录。CLI 每次调用无状态，让模型用 CLI 驱动它就得靠「轮询 + 解析
输出」追进度；MCP server 本身常驻，天然维持连接、缓存搜索结果、把任务列表作为资源提供。

但这不等于要把 103 个 `/api` 路由 1:1 映射成工具。工具列表越长，上下文越贵、选错工具的概率越高。
所以这里只收敛出 **8 个语义化工具**，其余端点继续留在 HTTP 层给工作台 UI 用。

## 结构

```
工作台 UI ─┐
CLI       ─┼─> server/ai-client.mjs ─> 本地服务 127.0.0.1:4179 ─> 下载队列 / 模型库 / Blender 桥
MCP server ┘   （唯一入口，零第三方依赖）     端口读 <dataDir>/server-port.json
```

三条入口共用同一个客户端模块，所以「是 MCP 错了还是服务错了」可以直接用 CLI 对照复现。

## 配置 MCP 客户端

先生成配置片段：

```sh
npm run ai:config
```

把输出的 `mcpServers` 片段贴进客户端配置。路径是绝对路径，按实际仓库位置生成：

```json
{
  "mcpServers": {
    "assetvault": {
      "command": "node",
      "args": ["H:/AI-Tools/studio/apps/assetvault/server/ai-mcp.mjs"]
    }
  }
}
```

端口不用写死：服务启动时若 4179 被占用会自动回退，真实端口写在数据目录的 `server-port.json`，
MCP server 启动时读它，并用 `/api/health` 确认对面确实是 AssetVault。需要强制指定时设环境变量
`AV_BASE_URL`（如 `http://127.0.0.1:4180`）或 `AV_PORT`。

**服务没启动时不会自动拉起。** 服务是单实例带进程锁的，MCP server 偷偷 spawn 一份会让状态分裂；
工具会返回「请先双击 AssetVault.lnk 启动」而不是静默起进程。

## 工具清单

| 工具 | 作用 | 说明 |
| --- | --- | --- |
| `get_capabilities` | 服务是否就绪、版本、缺失能力位、导出目标 | 只回摘要，不回 45 个能力位原始字段 |
| `search_assets` | 八个平台统一在线搜索 | 返回紧凑条目 + `handle`，`next` 作为翻页 `cursor` |
| `get_asset` | 按 UID / URL 取详情 | 也支持 `ids` 批量 |
| `enqueue_download` | 加入后台下载队列 | **立即返回任务 ID**，必须 `authorized: true` |
| `get_jobs` | 队列摘要；传 `jobId` 得完整详情 | 含状态分布、路径、SHA-256、最近日志 |
| `manage_job` | cancel / retry / hold / resume / remove | `remove` 只删记录，不删磁盘文件 |
| `list_library` | 模型库 / 收藏 / 导出设置 | `scan: true` 同时索引磁盘素材包 |
| `send_to_blender` | 把已保存任务送进当前场景 | 桥接未装或 Blender 未开时明确报错 |

三个必须遵守的约束：

1. **授权闸门。** `enqueue_download` 不带 `authorized: true` 会被客户端本地拦下（服务端还会二次校验）。
   调用前必须由用户确认拥有该模型的下载与使用授权。**可下载不等于可以商用**，许可证随结果返回。
2. **长任务不阻塞。** 下载可能跑 30 分钟，工具只返回任务 ID，进度靠 `get_jobs` 轮询。任何工具都不
   同步等待任务完成——客户端工具调用会超时。
3. **handle 只在本次会话有效。** `search_assets` 的原始结果缓存在 MCP 进程里，`handle`（如 `s3:0`）
   是它的引用。进程重启后旧 handle 失效，会明确提示重新搜索。

## 资源

| URI | 内容 |
| --- | --- |
| `assetvault://search/{batchId}` | 某次搜索的完整原始模型列表（用于检查筛选或自定义下载参数） |
| `assetvault://job/{jobId}` | 某个任务的完整字段与日志 |

资源只在缓存里有数据时才出现（先调用过 `search_assets` / `get_jobs`）。缓存上限 12 条，先进先出。

## CLI

CLI 是人的脚本入口，也是 MCP 的排错工具。输出一律 JSON，方便管道：

```sh
npm run av -- status
npm run av -- search --q tree --platform polyhaven --limit 5 --pretty
npm run av -- jobs --state failed --limit 10
npm run av -- jobs --id <任务ID>
npm run av -- library --scan --limit 5
npm run av -- send-blender --id <任务ID>
npm run av -- mcp-config --pretty
```

入队必须显式确认授权，没有默认值：

```sh
npm run av -- enqueue --models '[{"uid":"...","name":"...","license":"CC0"}]' --kind sketchfab --authorized
```

环境变量：`AV_BASE_URL` / `AV_PORT` 指定服务地址，`SFX_DATA_DIR` 指定数据目录（用于读 `server-port.json`）。

## 测试

```sh
npm run test:ai
```

`test/ai-bridge.test.js` 用本地 mock 服务覆盖端口发现、本地请求标识、授权闸门、语义方法映射，
并真实拉起 MCP 子进程验证 stdio 握手、工具列表、handle 入队与资源读取。不联网、不碰用户数据。

> 注意：测试会显式把客户端锁定到 mock 地址。用户本机可能真的开着 AssetVault，不锁死的话断言失败
> 会变成往真实下载队列里塞测试任务（开发时踩过一次）。

## 明确不做

- 不把全部 `/api` 路由暴露成工具，也不做「万能 HTTP 工具」——那等于绕过所有参数校验。
- 不在 MCP 里另写一套搜索、下载、转换逻辑；全部复用现有路由与队列。
- 不代替用户确认授权，不提供 `authorized` 的默认值。
- 不做 MCP 的 HTTP/SSE 传输：本地场景 stdio 足够，少开一个监听端口就少一处攻击面。
