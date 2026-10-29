# AssetVault

本地 3D 资产工作台：统一搜索 8 个 3D 资产平台（Sketchfab、ArtStation、Poly Haven、ambientCG、Poly Pizza、Kenney、FreeStylized、Polyfork），后台下载并转成 GLB / FBX，统一收进本地模型库；另有 13 个图站可批量抓参考图。完整清单（名称 / 简介 / 官网 / 分类）见 [`docs/platforms.md`](docs/platforms.md)。
同时保留一个 **Tampermonkey 单文件脚本**（`dist/sketchfab-exporter.user.js`，只处理 Sketchfab）。

> 自 3.4.0 起品牌由 Sketchvault 改为 **AssetVault**。旧数据目录 `.sketchvault` 首次启动会自动迁移为 `.assetvault`。
> 仅用于你自有或已获明确授权的模型，请遵守模型许可证与站点条款（署名写入输出包 `info.json`）。

## 快速开始

Windows 双击 **`AssetVault.lnk`** 或 **`Start-Library-Silent.vbs`** → 服务后台运行 → 浏览器自动打开工作台 **http://127.0.0.1:4179**。
本机入口仅监听回环地址，端口冲突时自动回退。局域网分享使用独立固定端口（默认 4178），在设置中启用；分享端口冲突只暂停分享，不影响本机。手动更改分享端口后需重新分享链接。

首次使用需 Node.js 22+ 并 `npm install`；FBX 转换需已安装 Chrome / Edge。停止服务双击 `Stop-Library.cmd`。

## 启用 Blender 导入（AssetVault Bridge）

在打开 Blender **之前**双击 **`Install-Blender-Bridge.cmd`** 即可，无需重启 Blender。
也可在工作台「导出设置 → Blender 连接」里一键安装 / 更新。
手动兜底：把 `server/blender-bridge.py` 复制到 `%APPDATA%\Blender Foundation\Blender\<版本>\scripts\startup\`，重命名为 `assetvault_bridge_startup.py`，重启 Blender。

## 核心功能

- **统一搜索**：8 个 3D 资产平台 + 13 个图站，「全部平台」并行检索并交错合并结果；平台清单见 [`docs/platforms.md`](docs/platforms.md)。
- **一键下载队列**：各平台共用同一套队列，支持暂停 / 重试 / 取消 / ZIP·GLB 校验 / SHA-256。
- **导出选项**：GLB 或 FBX；ZIP 压缩包或直接输出文件夹（可直接拖进 Unity）；贴图尺寸可选。
- **本地模型库**：收藏、分类筛选、可旋转 3D 预览。
- **Blender 直送**：已下载到本地的资产一键导入当前场景。
- **高清图批量下载**：勾选资产即可批量导出各平台最大档图片。

## 油猴脚本（仅 Sketchfab）

1. 安装 Tampermonkey（Chrome / Edge）。
2. 打开 `dist/sketchfab-exporter.user.js`，按提示安装。
3. 在 Sketchfab 模型页点右下角 ⬇，勾选是否下载贴图后点「下载」。

## 开发

```sh
npm install
npm test                       # 补丁 + 本仓库回归 + 上游测试集
npm run build                  # 输出 dist/sketchfab-exporter.user.js
npm run build:library          # 构建独立工作台 dist/library/
npm run test:library           # 网页 / 服务器 / 安全回归
npm run test:artstation        # ArtStation Marmoset 搜索回归
npm run fetch:blender          # 下载便携版 Blender（FBX 导出可选）
```

上游源码固定在 `vendor/upstream-src/`，改动一律写成 `patches/*.mjs`，勿手改。

## 目录

- `src/userscript/` — 油猴脚本
- `src/library/`、`server/` — 独立工作台与本地服务
- `patches/` — 上游构建时补丁
- `dist/` — 构建产物（可直接安装）

## 版本记录

历史变更与修复见 [CHANGELOG.md](CHANGELOG.md)。

## License

GPL-3.0-only（上游 GPL-3.0，本仓库为衍生作品，见 `LICENSE`）。

平台模块：在「设置 → 平台模块」按需启用或关闭在线平台，默认全部启用。保存后页面自动刷新；关闭的平台不参与搜索、分类初始化、在线解析和新下载，已下载文件及已有任务保留。配置由主机统一保存，局域网访客刷新后同步，不能修改开关。
