# M2 稳定本地资产身份：兼容切片设计

状态：设计及未接线的纯函数预检已实现，尚未实施真实迁移或宣称 M2 完成。日期：2026-11-12。

## 已核实的断点

在线平台通常使用 32 位十六进制 UID，下载任务继承该 UID。已登记的本地包另有 `local-` 前缀的固定 UID；当前收藏不接受该格式，退回 `root|rel` 派生键，因此目录搬迁或包改名会改变收藏身份。未登记散件只有路径身份，不能凭相同文件名认定同一资产。

本地包固定 UID 的生成包含主文件前 1 MiB 等摘要输入，不是完整内容哈希。Eagle 的导入 UID 又包含来源库绝对路径，来源库搬家再导入可能产生新 ID。现有根目录重新定位只改变扫描配置，不迁移收藏与标注关联。

定位：[本地收藏键](../src/library/local-files.js#L330-L335)、[收藏目标注册](../src/library/favorite-targets.js)、[本地包元信息](../server/asset-meta.mjs)、[根目录重新定位](../server/import-roots.mjs#L65-L83)、[Eagle 身份](../server/import-eagle.mjs#L33-L34)。

## 推荐的第一切片

先实现“已登记本地包稳定收藏身份兼容桥”，不立即把全库重键为 UUID，不修改下载 UID 协议。

- 32hex 包直接沿用 UID；固定 `local-` UID 映射到有命名空间的 32hex 收藏键，不包含路径。
- 无 UID 的未登记文件仍保留旧路径键；扫描不擅自写入 info 文件。
- 只有扫描时能够确定关联的旧收藏键才生成迁移预览。旧路径无法确定时保留孤项，不猜测、不删除。
- 保留旧键 alias，迁移幂等、可回退；多个包声称同一固定 UID 时显式冲突，不自动合并，也不隐藏重复卡。
- 先明确定义序列化与旧客户端兼容，才接入真实读写。收藏、备注、标签、合集不是同一个域，不能只修心形按钮就宣称身份统一。

## 之后的数据模型切片

引入 FileLocation 侧表，建议字段：`asset_uid`、`location_id`、`root_id`、`rel`、`mode`、`availability`、`fingerprint_version`。现有 32hex 和 local UID 保留为 legacy alias。

根目录注册表需持久 root_id；relink 只换 locator，不换 root_id。用户外部目录默认 linked，只有确实由应用复制或下载托管的记录才是 managed，不能仅凭路径前缀推断。

SourceRecord 按平台与来源 ID 关联。内容哈希用于关联同内容，不直接决定合并逻辑资产，更不触发物理去重或删除。

## 首切片放行条件

登记包根移动、包改名后收藏和标注保持；旧路径收藏迁移可预览、幂等、可回退；重复 UID 可见且不丢卡；未登记散件不被写入元信息；在线收藏到下载重扫仍保持原 UID。

还需覆盖跨重启、序列化、旧客户端、合集、人工／AI 标签、回收态、向量、导出导入和快照。所有迁移先在临时夹具验证，真实库只做明确授权后的预检和备份。

## 已实现的纯函数契约

[local-asset-identity.js](../src/library/local-asset-identity.js) 提供版本 1 的 `packageFavoriteIdentity`、`legacyPackageFavoriteUid` 和 `preflightLocalFavoriteMigration`。输入是当前包快照和收藏列表，输出身份、alias、迁移建议、冲突、未知关联与建议收藏列表；只读计算，不包含提交操作。

32hex 保持原值；有效 local- UID 通过 `assetvault-local-favorite-v1` 命名空间映射收藏键；旧路径键逐字保留既有散列算法。重复固定 UID、目标键碰撞和旧键歧义均阻断相关迁移，输入包不会消失。未知旧路径不能恢复关联，继续保留为未解析项。

专项 `node --test test/library-local-asset-identity.test.js`：7/7 通过。当前散列是兼容性收藏键，不是密码学摘要或全局唯一证明。尚未接入卡片、收藏写入、数据库、导出和真实迁移，因此现有用户的搬迁关联问题尚未修复。

## 当前未决项

迁移映射保存于哪个权威域、旧客户端如何读写 alias、同 UID 多位置的冲突策略、孤项保留与显式修复交互，必须在实现前明确。此前保持现状，不自动迁移用户数据。
