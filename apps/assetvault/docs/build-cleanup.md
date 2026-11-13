# 构建残留与清理

## 2026-10-31 占用扫描

以下为本机文件大小总和（GiB，非 Git 仓库对象大小或磁盘分配空间）：

| 位置 | 大小 | 处理 |
| --- | --- | --- |
| sketchfab-exporter-tauri/src-tauri/target/ | 9.52 GiB | 编译中间文件为主要占用 |
| downloads/ | 3.83 GiB | 用户资产，保留 |
| .assetvault/ | 2.24 GiB | 网络 / 预览缓存、浏览器配置与任务状态，保留，不在构建时清理 |
| vendor/ | 1.21 GiB | 第三方代码与运行依赖，保留 |
| .git/ | 0.18 GiB | 版本历史，不清理 |

只读预览确认可清理的编译目录共 9.354 GiB：target/debug 6.350、target/installer-ui 0.031、target/release/build 1.016、target/release/deps 1.958、target/release/.fingerprint 0.001、target/release/incremental 不足 0.001。

用户确认采用普通清理后，已执行 `npm run clean:build -- --apply`，删除 target/debug 与 target/installer-ui，按文件大小总和释放约 6.380 GiB（四舍五入）。复核两个目录已不存在，release/deps 与 release/build 保留，当前安装包、签名和 latest.json 保留。未执行深度清理；已删除内容不在回收站，可通过重新编译生成。

## 命令

在项目根目录运行：

```sh
npm run clean:build                       # 只预览：调试产物和安装器临时副本
npm run clean:build -- --apply            # 执行上述清理，保留发布编译缓存
npm run clean:build -- --deep             # 只预览：另加发布依赖和构建中间文件
npm run clean:build -- --apply --deep     # 深度清理，下次 Rust 编译更慢
```

脚本只允许固定的 target 子目录，不接受自定义删除路径。删除前检查完整发布产物（当前版本安装包、签名文件与更新清单内容一致，安装包具有 MZ 文件头），拒绝目录链接 / junction。Windows 检测到 cargo、rustc、assetvault 或 assetvault-setup 运行时停止清理。正式安装包、更新清单、源码、用户资产及密钥不进入删除目标。签名一致性检查不替代密码学验签。

## 自动清理策略

桌面 npm run build 的发布流程在 Tauri 编译、自定义安装器、签名、发布清单准备和旧安装包清理全部成功后，自动删除 target/debug 和 target/installer-ui。保留 release/build 与 release/deps 等发布编译缓存，避免每次发布都全量重编译。

前面任一步失败，不进入新清理阶段，保留排错产物。清理遇到运行中的程序或文件锁时提示并跳过，不把已经成功的发布标记为失败。不在 finally 中无条件清理。

前端 build:library 和油猴 build 使用固定输出文件覆盖，不按版本重复堆积，当前 dist/ 约 0.01 GiB，不额外清空目录。仅构建自定义安装器的 build:installer-ui 和原始 tauri build 不执行完整发布后清理；需要时手动运行 clean:build。

## 验证

清理测试覆盖：默认不删除、发布元数据不一致时不删除、目录链接拒绝、普通清理保留发布依赖、深度清理仍保留安装包 / 资产 / 状态。发布资产准备回归测试一并通过。未执行 Rust 完整发布构建。
