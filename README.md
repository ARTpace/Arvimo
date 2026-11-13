# Studio Monorepo

AssetVault 与 Artflow 的统一工作仓。仓库就地由原 AssetVault 仓改造而来，Git 历史完整保留。

## 目录结构

```
studio/
├── apps/
│   ├── assetvault/        # AssetVault（原 AssetVault 仓，含 3D 预览库、Sketchfab 导出器、Tauri 桌面端）
│   └── artflow/           # Artflow（Electron + React 无限画布宿主，经 git subtree 并入）
├── packages/              # 跨应用共享包（L1 headless 内核 / L0 契约），待建
├── docs/                  # 仓级文档与架构决策
└── .gitignore             # 仅通用规则；应用专属规则见各 apps/<name>/.gitignore
```

## 应用速查

| 应用 | 技术栈 | 构建 | 入口 |
| --- | --- | --- | --- |
| assetvault | 纯 JS（命令式 DOM）+ esbuild 单文件打包 | `npm run build:library` | `apps/assetvault/src/library/` |
| artflow | Electron + React 19 + TS + Vite + Tailwind | `npm run build` / `npm run dev` | `apps/artflow/src/` |

## 合仓后的路径基准变更

原 AssetVault 仓根下的所有相对路径，其基准已从仓库根下移到 `apps/assetvault/`：

- 原 `H:\AI-Tools\AssetVault\<x>` → 现 `H:\AI-Tools\studio\apps\assetvault\<x>`
- 原 `H:\AI-Tools\artflow\<x>` → 现 `H:\AI-Tools\studio\apps\artflow\<x>`
- 原仓库根 `.gitignore` 的路径规则已拆分：通用规则上提至仓库根，路径相关规则下放至 `apps/assetvault/.gitignore`
- 已修正的硬编码绝对路径：`apps/assetvault/.workbuddy/skills/assetvault-self-check/SKILL.md`、`apps/assetvault/docs/ai-bridge.md`

## 大件隔离

合仓前将可再生大件移至同步范围外的 `H:\_preMerge_archive\`（同盘移动，可随时取回）：

| 隔离项 | 原位置 | 体积 |
| --- | --- | --- |
| Rust 构建缓存 | `apps/assetvault/sketchfab-exporter-tauri/src-tauri/target` | 5.9 GB |
| 草稿与探查脚本 | `apps/assetvault/scratch` | 3.8 GB |
| 文件系统诊断输出 | `apps/assetvault/tmp-fs-diag-out` | 664 MB |
| 依赖目录 | `apps/assetvault/node_modules`、`apps/artflow/node_modules` | 2.0 GB |
| 构建产物 | `apps/artflow/dist` | 4 MB |
| 原 artflow 独立仓（含 .git 全量留档） | `H:\_preMerge_archive\artflow-orig` | — |

## 开发前必读

迁移后各应用依赖需重装：

```powershell
cd H:\AI-Tools\studio\apps\assetvault ; npm install
cd H:\AI-Tools\studio\apps\artflow    ; npm install
```

## 回滚方式

两个仓的合仓前状态已打 tag `pre-merge-backup-20261113` 并推送远端：

```powershell
git -C H:\AI-Tools\studio checkout pre-merge-backup-20261113
```
