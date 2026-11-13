# 清理记录

## 2026-10-31：历史工程数据迁出

- 授权：用户要求缓存、资产进入用户目录并确认继续迁移。
- 原位置：工程根目录 downloads/、.assetvault/、data/。
- 新位置：`%APPDATA%/AssetVault/downloads/project-19cb8285dd0e/` 与 `%APPDATA%/AssetVault/legacy-imports/project-19cb8285dd0e/`。
- 迁移 10,406 个文件、约 6.078 GiB，复制并逐文件校验 SHA-256 后才移除工程原件；不是丢弃缓存或删除用户资产。
- 旧配置完整归档，当前元数据有迁移前备份；合并后接口读回 49 条模型、2 条收藏。原工程三个目录均已不存在。
- 相关 8 项测试通过，后台已重启，用户目录路径与接口读取验证通过。

## 2026-10-31：编译残留

- 授权：用户确认按建议清理调试产物与安装器临时副本，保留 release 编译缓存。
- 执行：`npm run clean:build -- --apply`。
- 删除：`sketchfab-exporter-tauri/src-tauri/target/debug/`、`sketchfab-exporter-tauri/src-tauri/target/installer-ui/`。
- 原因：可重新生成的调试编译产物与已打包的安装器临时副本，文件大小合计约 6.380 GiB。
- 验证：脚本成功退出；两个目录已不存在，release/deps、release/build 与正式安装包 / 签名 / 更新清单保留。
- 恢复：未移入回收站，可重新编译生成；用户资产与应用状态未清理。
