# GitHub 发布与在线更新

发布仓库：https://github.com/ARTpace/AssetVault

1. 同步根目录 `package.json`、桌面工程 `src-tauri/Cargo.toml` 和 `tauri.conf.json` 的版本号。
2. 执行桌面工程 `build-installer.cmd`。更新签名私钥默认读取当前用户目录 `.codex/assetvault-signing/updater.key`，也支持环境变量 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。私钥不得提交。务必离线备份，丢失后旧客户端无法信任新密钥。
3. 确认测试通过，先提交并推送源码，然后创建 Release。安装包统一产出在桌面工程 `dist/` 根目录（最终安装器 `*-setup.exe`、更新载荷 `*-update.exe` + `.sig`、更新清单 `latest.json`）。以 0.1.7 为例：

```powershell
gh release create v0.1.7 --repo ARTpace/AssetVault --title "AssetVault 0.1.7" --notes "新增应用内更新和安装动效，修复 Blender 解包冲突。" --draft
gh release upload v0.1.7 sketchfab-exporter-tauri/dist/AssetVault_0.1.7_x64-setup.exe sketchfab-exporter-tauri/dist/AssetVault_0.1.7_x64-update.exe sketchfab-exporter-tauri/dist/latest.json --repo ARTpace/AssetVault
gh release edit v0.1.7 --draft=false --repo ARTpace/AssetVault
```

首次安装使用 `*-setup.exe`（自定义可爱界面）；`latest.json` 指向 `*-update.exe`（签名 NSIS 引擎）。更新时验证签名、显示下载进度、要求主动点击重启，并在安装前回收 Node 后台服务。请勿互换两个 EXE 或在签名后修改更新 EXE。

应用启动 15 秒后、之后每 6 小时检查更新；可在设置关闭自动检查。检查失败不弹窗打断工作，可手动重试。存在下载/导出任务时暂不允许重启更新。

当前不包含旧版到新版的完整虚拟机安装验收；发布前应验证升级、UAC 取消、非 ASCII 路径和卸载。0.1.6 及以前没有更新能力，需先手动安装 0.1.7。
