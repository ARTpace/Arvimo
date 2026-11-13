# GitHub 发布与在线更新

发布仓库：https://github.com/ARTpace/AssetVault

1. 同步根目录 `package.json`、桌面工程 `src-tauri/Cargo.toml` 和 `tauri.conf.json` 的版本号。
2. 执行桌面工程 `build-installer.cmd`。更新签名私钥默认读取当前用户目录 `.codex/assetvault-signing/updater.key`，也支持环境变量 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。私钥不得提交。务必离线备份，丢失后旧客户端无法信任新密钥。
3. 确认测试通过，先提交并推送源码，然后创建 Release。安装包统一产出在桌面工程 `dist/` 根目录：仅一个 `*-setup.exe`、其 `.sig` 和更新清单 `latest.json`。以下使用占位版本 `X.Y.Z`，发布时替换为实际版本：

```powershell
gh release create vX.Y.Z --repo ARTpace/AssetVault --title "AssetVault X.Y.Z" --notes-file docs/release-notes/vX.Y.Z.md --draft
gh release upload vX.Y.Z sketchfab-exporter-tauri/dist/AssetVault_X.Y.Z_x64-setup.exe sketchfab-exporter-tauri/dist/AssetVault_X.Y.Z_x64-setup.exe.sig sketchfab-exporter-tauri/dist/latest.json --repo ARTpace/AssetVault
gh release edit vX.Y.Z --draft=false --repo ARTpace/AssetVault
```

首次安装与在线更新共用 `*-setup.exe`。手动启动显示自定义界面；Tauri 更新参数 `/UPDATE` 让同一文件直接执行内嵌 NSIS 引擎，并保留安装模式、重启和应用参数。构建脚本对最终包装器签名，`latest.json` 指向该文件；签名后不得修改。侧栏显示桌面真实版本，检测到更新后显示醒目标识与独立更新弹窗，无需打开设置。确认更新后下载、验证签名、安装并重启；自动检查可提前在后台下载，但不会自动安装。

应用启动 15 秒后、之后每 6 小时检查更新；可在设置关闭自动检查。检查失败不弹窗打断工作，可手动重试。存在下载/导出任务时暂不允许重启更新。

当前不包含旧版到新版的完整虚拟机安装验收；发布前应验证升级、UAC 取消、非 ASCII 路径和卸载。0.1.6 及以前没有更新能力，需先手动安装 0.1.7。
