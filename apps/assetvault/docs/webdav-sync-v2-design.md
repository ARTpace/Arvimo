# WebDAV 同步 v2 提交契约（设计，未启用）

日期：2026-11-12。对应 AV-SYNC-01。当前 `library.json` 加 `library.meta.json` 无条件双 PUT 仍是 v1，本文不代表已实现或允许上传原件。

## 目标与兼容边界

把导入与同步彻底分离：导入保留本机已存在标注是合理策略，但同步必须传播编辑、清空、删除与恢复。不能把 importLibrary 的 merge 复用为 v2 冲突策略。

v2 使用独立命名空间 `assetvault-v2/`。旧客户端仍访问 v1，v2 不与其共写。切换需显式确认，先备份本地与远端 v1 元数据；旧格式不能静默升级、双写或推断已完整同步。

## 远端提交模型

- 原件与快照对象为不可变内容寻址对象，摘要 SHA-256，记录字节数和 schemaVersion；写完校验再引用。
- 单一 `head.json` 为提交点，含 generation、commitId、parentCommit、snapshotHash 和协议版本。真实设备 ID 只作审计，不能作为认证。
- 读取 head 必须同时得到准确原始 ETag；不能去除引号、拼接弱 ETag 或以更新时间替代条件令牌。
- 首次创建 head 用 `If-None-Match: *`；后续用 `If-Match: <原始 ETag>`。412 不是网络重试，必须重读新基线重新计算。
- 不支持可靠条件写的服务只能提供明确的单写者备份模式，不能宣称双向并发安全，也不能静默退回无条件 PUT。
- 不可变对象先上传，最后条件提交 head；失败保留未引用对象，稍后按安全保留期回收。提交前不得清理旧 head 可达对象。

## 本地基线与并发

每个远端配置保存最后确认的 commitId、三方合并基线、远端 ETag 和上传进度。基线只在远端条件提交或下载应用事务成功后更新，不能上传前先标成功。

三方差异分别比较 base→local 与 base→remote。资产状态、人工 note/rating/favorite、用户标签、合集成员分别建版本，不用一条资产 updatedAt 替代所有域。时间戳不用于裁定胜负。

- 仅一端变化：采纳该变化，包括空字符串、0、false、空集合。
- 两端变成相同值：自动收敛。
- 两端同字段不同值：保留双方并创建冲突记录，等待用户决策，不静默 last-write-wins。
- 集合字段按带操作身份的 add/remove 合并；不能单纯求并集导致删除无法传播。
- 删除写 tombstone；删除对编辑、恢复对删除都显式冲突。墓碑需满足所有已知有效设备确认与保留期，不能简单按天数清空。

网络等待期间本地版本变化时，应用前重新校验本地基线。远端提交成功但本地断电的情况，以 commitId 和对象 hash 幂等恢复，不再次产生新版本。

## 原件与隐私

默认只同步明确支持的元数据。原件同步必须用户单独选择范围，展示总字节和目标；不上传主机配置、Cookie、密码、本机绝对路径或外盘拓扑。linked 原件不能因记录同步而被隐式上传或转 managed。

传输采用流式临时文件、可取消、续传能力探测、最终内容摘要校验与原子安装。未知依赖不能伪造支持 Range。下载目录需边界验证，远端提供的路径不是可信本机路径。

## 实现前置与切片

先完成 M2 身份和可恢复生命周期契约；再实现纯三方 planner 与冲突模型，使用临时快照验证。随后扩展 WebDAV 客户端准确 ETag、条件请求及响应体超时，再做不可变对象和 head 提交。v2 引擎、显式切换 UI、元数据试点完成后，才评估原件流传输。

## 放行测试矩阵

双客户端同基线同时提交只能一方成功；412 后无覆盖丢失；条件写不支持时明确拒绝双向；对象已上传但 head 未提交不可见；head 成功本地断电能恢复；网络等待本地编辑不被覆盖；备注清空、取消收藏、标签移除、合集移出可传播；删除与编辑冲突可恢复；远端损坏 hash 拒绝；旧 v1 客户端不覆盖 v2；取消和断网不产生假成功；超大原件不全量 Buffer 入内存。

## 已实现但未接线的 planner

[mergeSyncRecord](../server/sync-three-way.mjs) 接收完整 base/local/remote JSON 记录，返回 record 与 conflicts。逐顶层字段三方比较；缺失与 null、空串、0、false、空数组分别处理。数组整体比较，不做并集。双方不同则保留 base 值并携带双方 presence 快照；deleted:true 与另一端编辑升级记录级冲突，保留整条 base。

输入严格校验 JSON，拒绝危险原型键、访问器、非有限数、特殊对象、稀疏数组和循环引用；输出不保留输入引用。专项 `node --test test/library-sync-three-way.test.js` 8/8 通过。

## 已实现但未接线的 WebDAV 原语

[客户端](../server/webdav-client.mjs) 保留旧 etag 字段，另暴露准确 rawEtag；putConditional 只接受原始强带引号 If-Match 或 If-None-Match:*，拒绝弱／裸／列表／CRLF 条件。412 为 WEBDAV_CONFLICT，无无条件降级重试。HEAD、PROPFIND、GET 的响应体消费受同一 deadline 约束，超时取消流；所有请求拒绝重定向，用户需填写最终地址。

后续已新增 getWithMetadata，同一次 GET 返回 buffer 与 rawEtag，404 返回 null，不用 HEAD 与 GET 拼接版本；默认实际流式读取上限 8 MiB，可配置 1～8 MiB，超限 cancel／abort，忽略不可信 Content-Length，不支持有界 reader 的非空响应失败关闭。旧 get 返回值及默认无上限行为不变。客户端专项与原 v1 同步专项最新合跑 16/16 通过，随后空200支持分支对应单项 1/1 通过，全部 fake fetch／临时库，无真实凭据或外网。这只是读取及提交原语，不证明远端实际可靠执行 CAS；v2 切换仍需服务能力验证。

## 已实现但未接线的快照对象

[快照 codec](../server/sync-snapshot-object.mjs) 固定 schemaVersion:1 封装，确定性对象键顺序、数组保序；对完整 UTF-8 编码计算 SHA-256 和字节数，上限 8 MiB。解码验证 hash、实际长度、UTF-8、版本与严格 JSON，不接受 getter、toJSON 函数或 Proxy。专项 7/7 通过，含精确多字节边界与损坏拒绝；没有磁盘、网络或远端对象发布。

该限制只针对元数据封装，不能拿来承载原件，也不宣称编码过程是流式或任意大输入有界。

## 已实现但未接线的 head 计划

[head 计划器](../server/sync-head-plan.mjs) 严格验证旧 head schema 与提交 ID，首次仅生成 create-only 条件，更新必须绑定准确强 ETag 并递增 generation；缺失令牌、弱令牌、溢出或复用旧 commitId 均拒绝。输出只有 head 与 condition，不执行 PUT，也不验证远端 CAS 能力，不分配设备版本。

## 合同集成验证

[双客户端合同测试](../test/library-sync-v2-contract.test.js) 将上述真实模块连接至内存 fake WebDAV，严格执行条件写。最新 4/4 通过：同基线两提交恰一成功、412 无无条件重试；失败对象未获 head 引用；重读后独立编辑与显式清空合并再提交；同字段冲突停止提交；损坏对象拒绝读取。

head 与不可变对象读取均已改用有界 getWithMetadata，head 与 ETag 绑定同一次响应，fake 全程拒绝 HEAD。对象缺失显式失败；无 Content-Length 的 8 MiB + 1 字节对象被 WEBDAV_TOO_LARGE 拒绝，两种失败都不产生 PUT 或改变 head。新增竞态验证：捕获旧响应后远端推进 head，旧计划恰一次 412 且不覆盖；重新获取新版配对令牌后正确合并并提交。

边界：测试编排而非生产引擎，生产 v2 尚未接线。head 未声明对象 bytes，测试用实际下载长度及 head hash 校验，不代表远端声明长度检查。未验证真实服务器 CAS 或本地持久基线、掉电恢复。

现状限制：planner、codec、head 计划与条件写原语尚未组成 v2 引擎；没有版本分配、head CAS 提交、集合操作日志、自动迁移或真实双端测试。调用方仍必须处理所有冲突，不能直接提交返回的 record。当前 v1 同步不能据此标为完成。
