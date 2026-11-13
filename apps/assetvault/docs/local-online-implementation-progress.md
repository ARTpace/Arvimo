# 本地＋在线资产库实施记录

更新日期：2026-11-12。对应[开发路线图](local-online-asset-library-roadmap.md)。本记录只描述本轮实际改动，不把历史脏修改计为新增成果。

## 当前边界

- 已进入 M0 安全与恢复、M1 现有功能纠偏；M2～M4 尚未宣告完成。
- 保留已有工作，不迁移真实库，不上传本地内容，不删除真实原件；不新增依赖。
- 测试使用临时数据、虚构凭据及本地模拟服务。静态检查、隔离测试、真实网络、宿主和视觉验收分别记录。

## 已完成的独立验证

### AV-SEC-01 / AV-SEC-02：LAN 身份与授权

- 共享密码只授予只读访问，展示名、同 IP、`X-SFX-Member` 不再作为 LAN 身份认证依据。
- 主机使用独立审批 ID，把当前会话绑定到成员；列表不公开会话 Cookie。成员角色和禁用状态即时重查，撤销、退出、重登、服务重启不继承批准。
- 总分发器先授权再解析正文或调用业务接口。非安全方法默认要求写权限，只有明确的 POST 查询例外放行；宿主设置、执行、物理删除等仅主机可用。
- 验证：`node --test test/library-lan-authorization.test.js test/library-collab-api.test.js`，13/13 通过；包含 44 类 POST、DELETE、伪造身份、拒绝正文解析、磁盘及 SQLite 字节未变、任务无副作用，以及允许的编辑与查询。
- 会话审批 UI 已接线：只按可信 me.local 展示主机审批，显式选择启用成员并核实，支持撤销；403 清空隐藏，外部名称使用 textContent。假 DOM 事件专项 `node --test test/library-team-settings.test.js` 最终 15/15 通过，未做浏览器视觉验收。
- 兼容影响：过去靠同名提升角色的 LAN 用户需由主机重新批准；共享 HTTP 本身未增加 TLS。
- 已知历史检查：旧 `library-lan-sharing` 测试有两条端口变化提示断言失败，未改成通过，也未归入本次身份修复。

### AV-DATA-01：备份恢复

- 目标备份先复制到不参与清理的临时区并校验；恢复前安全副本成功后才替换现库，不让保留策略提前删除输入。
- 同一 storage 的备份、恢复、清理串行执行；中途安装失败移回原 DB、WAL/SHM、状态目录和旧快照。回滚也失败时保留文件并报告恢复路径。
- v3 备份记录文件 SHA-256 清单，检查 JSON 与 SQLite；旧 v2 仍可读取但没有摘要保证。普通复制错误不再被吞掉。
- 验证：`node --test test/library-backup.test.js`，12/12 通过；覆盖 keep=1、满额最老备份、安全副本回退、损坏与缺失、复制与安装失败、跨实例串行及同秒命名。
- 范围：同进程同 storage 互斥，不是跨进程锁或崩溃原子提交；备份仍不包含素材原件。

### AV-SEC-03 / AV-SEC-04：HTTP 代理安全

- 逐跳重新验证目标；跨 origin 删除调用方凭据及未知自定义头，按目标重新选 Cookie；HTTP 不发送 Secure Cookie；禁止 HTTPS 降级到 HTTP。
- 代理 TLS 默认严格验证，证书错误不降级重试。旧 `SFX_PROXY_VERIFY=0` 不再关闭验证；显式 PEM 可通过 `SFX_PROXY_CA_FILE` 配置。
- 验证：`node --check server/public-http.mjs`；`node --test test/library-proxy-security.test.js test/library-proxy-tunnel.test.js test/library-proxy-bypass.test.js`，17/17 通过。
- 覆盖本地 HTTP/HTTPS/CONNECT、多跳、同源／跨域、Cookie 路径与 Secure、禁用 Cookie、非法目标、证书不可信／错域／过期和可信 CA。
- curl 回退已改为单跳，无 `-L`，首参 `-q` 禁用 curlrc、限制协议、明确代理选择、透传 CA、严格处理非零退出；fake spawn 专项 `node --test test/library-curl-impersonate-security.test.js` 4/4 通过。没有真实 curl 或外网。
- 公共 HTTP 文件出现外部并发 browserPrint 改动，尚未统一 curl 3xx 的 followRedirect。14:02 只读核对发现 mustBrowserPrint 新分支自行递归 openPublic，保留 extraHeaders 且绕过降级检查；因此此前“全部 curl 跳转安全停止”的描述已不适用于当前并发版本。常规 403 回退仍安全返回 3xx。等待确认写入方，不覆盖其工作；原 17/17 仅对应当时版本，不能证明最新并发分支安全。

### AV-META-01：导出时间与同步内容 hash

- 默认时钟、函数时钟和数值时钟导出数值时间；WebDAV 内容 hash 排除导出时间，避免时间变化触发空上传。
- 验证：`node --test test/library-portable.test.js test/library-webdav-sync.test.js`，当时 8/8 通过；假 WebDAV 无真实上传，验证无内容变化 noop 和真实标注变更上传。
- DATA-02 合并后的集成回归：`node --test --test-concurrency=1 test/library-portable.test.js test/library-webdav-sync.test.js`，15/15 通过。
- 兼容影响：旧保存 hash 可能在升级后触发一次元数据上传；不表示同步协议、原件传输或并发合并已修好。

### AV-SEARCH-01：最新标注与向量失效

- 构建、状态与检索共用最新用户 note 列和定序去重标签；备注清空不会回退到旧 payload。
- 按 64 个 UID 分页读取 payload、tags 和 hash；构建只保留当前批次。pending 排除无法构建的空文本；无效响应不计作成功，网络等待期间编辑或删除不提交旧文本。
- 旧向量可留库，但文本 hash 失效后不参与搜索或相似推荐，直到重建。检索余弦仍保留全部有效向量，不宣称大规模 ANN。
- 验证：`node --test test/library-vector-index.test.js`，最终 9/9 通过；真实 mutateTags 修改和清空、用户／AI 标签增删、未重建旧结果排除、145 条分页、模型切换、坏响应与等待期间修改。
- status 为精确 hash 统计仍需分页遍历全库；不是 O(1)。没有真实 AI 网络请求。

### AV-DATA-02：整库替换与原子回滚

- merge / replace 共用写队列、单连接 BEGIN IMMEDIATE 事务；批次、用户种子或合集失败全部回滚。
- replace 清理 active / trash、合集关系与智能规则、标签与向量等派生，清除旧同 UID 标注种子；保留主机配置、成员、词表定义、审计与磁盘原件。
- 同事务写 DB 权威视图和版本戳；空替换重启及后续保存不再复活旧文件目录。父子合集可逆序恢复。
- 事务导入专项 14/14；直接受影响的四份 storage 回归 24/24；上述 portable + WebDAV 集成当时 15/15。临时库覆盖零变更拒绝、失败全表回滚、队列串行、空库重启与 save。
- 后续补齐 UTF-8 字节校验，直接复用 asset-ops 的 512 KiB 上限，避免中文字符数未超限而字节数越界。新增 ASCII／Unicode 精确上限、超一字节拒绝及 merge／replace 零排队零写入；导入专项最终 16/16 通过。

### 前端产物

- 执行 `node scripts/build-library.mjs` 成功，同步桌面前端；确认构建产物含审批 API 和 DOM 标记，两份 app.js SHA-256 相同：`500ca67fd74c879bc43bb0cb8187efc0610bf7c109f35e6857e023de17c1f4c2`。
- 首次按原始中文检索产物未命中，原因是 esbuild Unicode 转义；解码后文案存在。未因此重复构建。
- 产物包含构建时的现有工作区内容，不把其他会话修改归为本轮成果。没有重启服务或打包安装程序。

## 第二轮完成的隔离切片

- API 整库 replace：先确认和校验快照，安全备份缺失或失败返回 503，不再仅告警后继续覆盖；不排队导入、不广播，merge 保持不依赖备份。新增临时真实 SQLite 专项 9/9，Lead 合并 LAN 授权与协作回归 22/22 通过。未实际覆盖真实库。
- M2 [只读导入预检](../server/local-import-preflight.mjs)：显式绝对文件列表，串行 256 KiB 流式 SHA-256，区分同内容、同名异内容、读失败与读中变化；拒绝符号链接和非 regular 文件，可取消并释放句柄。Lead 审阅后修正真实 NUL 检查并拒绝稀疏参数数组，参数失败零 IO。专项最终 6 通过、0 失败、1 跳过（Windows symlink 创建 EPERM）；大文件、真实取消、读中追加检测通过。未接 API/UI 或真实导入，摘要不作为资产身份或自动删除授权。
- M3 [纯三方 planner](../server/sync-three-way.mjs)：保留字段缺失与显式清空、双方冲突及删除对编辑的记录冲突；严格 JSON 校验、输出不引用输入。专项 8/8 通过。未启用，不接当前 v1，不包含 CAS／网络／版本引擎，不能宣称同步已可用。

## 第三轮完成的增量

- WebDAV 客户端已新增原始带引号 rawEtag 与 putConditional：只接受唯一强 If-Match 或 If-None-Match:*，412 返回 WEBDAV_CONFLICT，绝不无条件重试。deadline 覆盖 headers 和 body，超时取消流并清理 timer／lock；禁止重定向，避免认证跨域或 HTTPS 降级。新专项与原 v1 同步专项合跑 8/8 通过，含挂起响应体、fetch 挂起、成功后无遗留 timer、原始 ETag 与输入拒绝。保留旧 etag 归一化与 v1 接口，但自动跟随重定向有意停止，需填写最终网盘地址。仅 fake fetch／临时库，不启用 v2，不连接真实网盘。
- API JSON 分块读取已修复：按原始 Buffer.length 计数、StringDecoder 流式解码，跨分片中文与 emoji 不再静默损坏；保持超限排空和原有授权。新 API 黑盒专项与导入安全专项合跑 13/13 通过，覆盖 1 字节分片导入、实际 2 MiB 精确边界、超限全部消费后 413 且零写入、invalid／empty 兼容行为。仅临时库，无真实数据操作。

## 第四轮完成的增量

- 新增未接线的 [快照 codec](../server/sync-snapshot-object.mjs)：严格 JSON、确定性 UTF-8 编码与 SHA-256，完整封装 8 MiB 上限，解码校验长度、摘要、UTF-8 和版本。专项 7/7 通过，含多字节精确边界与恶意 getter／Proxy 零执行。
- 新增未接线的 [head 提交计划](../server/sync-head-plan.mjs)：严格 schema、原样强 ETag、首次 create-only、generation 溢出与旧 commitId 复用拒绝。专项最终 8/8；首次合法 ETag 测试样本误含空格失败，修正样本后通过，未放宽实现。
- Lead 阅读当前模块与测试边界；四个新增文件状态已核对。两者只处理内存，不调用网络、不启用真实同步、不迁移数据；codec 不是原件流传输，也不保证任意大输入内存有界，head 计划不执行实际 CAS。
- 公共 HTTP 并发文件继续停写，等待人工确认归属，不以其他模块进展掩盖其未修复分支。

## 第五轮完成的增量

- 新增 [合同集成测试](../test/library-sync-v2-contract.test.js)，真实 planner／codec／head／client 配合 fake WebDAV 严格 CAS，2/2 通过：同基线双提交恰一成功、412 无无条件重试，重读合并传播清空，同字段冲突不提交，损坏对象拒绝。无生产引擎或真实网络；stat/get 的 head 与 ETag 读取竞态未覆盖，正式引擎必须绑定同次响应。当前 head 不含对象 bytes，测试以实际长度和 head hash 校验。
- 条件写尾换行假设经真实字符与 Node 运行时检查未复现：LF／CRLF 均已拒绝，合法 opaque 令牌可用。因此未改生产客户端，只新增拒绝控制字符及合法 opaque 回归；客户端加原 v1 同步专项最终 10/10 通过。没有把失败假设记为已修复漏洞。

## 第六轮完成的增量

- WebDAV 客户端已新增 getWithMetadata，同次 GET 返回 buffer 与 rawEtag，不预发 HEAD，不捏造缺失令牌；旧 get 仍返回 Buffer。client 与旧 v1 sync 专项合跑 13/13，覆盖逐请求换版本、缺失／弱／quoted 令牌、404／403、响应体超时取消与拒绝跳转。全部 fake fetch／临时库。
- 合同测试已改用该原语并全程禁止 HEAD，最新单项 3/3 通过。新增 fake 竞态：捕获旧响应后远端推进版本，旧计划恰一次 412，不覆盖新 head；重读新内容／令牌配对后合并并正确 CAS。Lead 阅读新用例和当前 client 接口。未启用生产引擎或连接真实网盘；head 尚不包含远端声明 bytes，真实服务器能力与持久基线仍未验收。

## 第七轮完成的增量

- getWithMetadata 已增加按实际流式字节计数的 8 MiB 默认上限，支持 1～8 MiB 整数配置；超限取消流并 abort，不信任 Content-Length，也不先完整读取再判断。不支持 reader 的非空 fake 响应失败关闭；标准 null body 空200可返回空 Buffer。旧 v1 get/list 无新上限。
- client 与旧 v1 sync 一次合跑 16/16；随后追加空200分支后只复测对应单项 1/1，通过。覆盖 Unicode／8 MiB 精确边界、+1 字节、伪造 Content-Length、无 reader、非法 limit 零 fetch、超限 cancel／abort及旧 get 兼容。Lead 阅读实际计数和边界分支。未执行真实网盘或原件传输。

## 第八轮完成的增量

- v2 合同的不可变对象读取已从旧 get 改为有界 getWithMetadata；head 与对象均执行实际字节上限。对象缺失显式报错，不误当空库；8 MiB + 1 字节且无 Content-Length 的恶意对象被真实 client 拒绝为 WEBDAV_TOO_LARGE。
- 合同测试单次 4/4 通过，原三例保留；新例验证缺失／超限均无 PUT，head 内容及 ETag 不变，超限仅发生 head／对象两次 GET。Lead 阅读读取及失败断言。仍仅内存 fake，未接生产 v2 或真实网盘。

## 进行中与后续

- M0 curl 跳转的统一校验接线待并发写入方协调；新 browserPrint 直走分支存在未修复的跨域头继承／降级检查缺口，暂不宣告 M0 整体完成。
- M2 [稳定身份兼容切片设计](local-asset-identity-design.md)已形成。新增纯函数 [身份与迁移预检](../src/library/local-asset-identity.js)，32hex 沿用、local- 映射稳定收藏键，重复身份／键碰撞阻断迁移，未知旧收藏保留。专项 `node --test test/library-local-asset-identity.test.js` 7/7 通过；未接 UI、存储或真实迁移，搬迁关联尚未修复。先明确 alias 权威域、旧客户端与重复 UID 契约。
- M3 [v2 提交契约设计](webdav-sync-v2-design.md)已新增，约束独立协议空间、不可变对象、ETag 条件提交、三方冲突及显式原件授权；未启用。当前同步仍只有元数据快照，不承诺原件、删除传播、三方合并或双端并发安全。

## 尚未验证

真实 LAN 多设备攻击、浏览器交互与视觉、真实用户数据恢复、真实代理与外部站点、真实 WebDAV 并发、Tauri 宿主。当前没有重启用户正在运行的服务。
