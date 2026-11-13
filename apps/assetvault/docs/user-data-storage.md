# 用户数据目录

运行数据与工具工程分离，Windows 默认使用 `%APPDATA%\AssetVault\`：

| 子目录 | 用途 |
| --- | --- |
| data/ | 配置、任务、收藏、资产库记录、缓存、浏览器配置及启停日志 / PID |
| downloads/ | 下载资产，可在设置中改到用户指定目录 |
| browsers/ | 安装后下载的浏览器运行依赖 |
| legacy-imports/project-*/ | 本次从旧工程迁入的历史配置、缓存、浏览器数据及迁移前元数据备份 |
| downloads/project-*/ | 旧工程完整资产树，独立存放以避免同名文件覆盖 |

直接 `node server/library.mjs`、`npm run library`、Windows 后台启动器共用 `server/data-dir.mjs` 的路径解析；cookie 仓库也使用同一数据目录。安装版已有对应的用户目录逻辑。`SFX_DATA_DIR` 与 `SFX_DOWNLOAD_DIR` 的显式绝对路径仍优先；无效相对路径报错，避免悄悄写回工程。

旧 `%APPDATA%\com.assetvault.desktop` 若是同一目录的联接，使用新名称；若新旧为两个独立目录，沿用桌面端的保守策略，不自动合并。用户手动指定的外部资产目录（例如 J 盘）不移动。

## 历史工程迁移

```sh
npm run migrate:data                 # 只预览
npm run migrate:data -- --apply      # 服务完全退出后执行
```

只处理工程根目录固定的 downloads/、.assetvault/、data/。拒绝源目录联接，不向已有同名文件强制写入。先复制所有文件并逐个校验 SHA-256，备份用户现有 library-state.json / tasks.json，再补充旧库独有模型与收藏；冲突优先当前元数据、配置与回收站决定。旧任务只补充已结束的记录，不恢复旧的待下载任务。迁移时修改导入记录中指向旧 downloads/ 的绝对路径。

完整校验后移除原工程副本，原始历史记录仍完整保留在 legacy-imports/，不覆盖当前 AI、登录或平台配置。迁移是位置调整，不是腾空整台电脑的磁盘空间，也没有跨目录去重。迁移报告保存为归档目录中的 migration-report.json。

修改路径逻辑后需要重启后台；已经安装的桌面程序需重新打包才能获得新后端代码。构建缓存清理仅处理 target/，不会删除上述用户目录。

## 本机迁移结果（2026-10-31）

已迁移 10,406 个文件、约 6.078 GiB：748 个资产文件进入 downloads/project-19cb8285dd0e/，其余旧缓存和配置进入 legacy-imports/project-19cb8285dd0e/。每个文件复制后及移除原件前均核对 SHA-256，工程 downloads/、.assetvault/、data/ 已不存在。

迁移前当前资产库 24 条模型、0 条收藏，合并后接口读回为 49 条模型、2 条收藏。任务接口 109 条（含启动扫描恢复的资产任务）。后台已恢复到 4179，能力接口 userDataPaths=true。原配置和迁移前元数据备份仍在归档目录，可按 migration-report.json 找到原始数据。迁移后的文件并未去重，电脑总占用不会因此减少。

相关 8 项测试通过；后台语法检查及接口读回验证通过。没有执行新的安装包编译，已有安装包未改动。
