# 项目目录规范

## 放置规则

| 位置 | 内容与边界 |
| --- | --- |
| 根目录 | README、LICENSE、package.json / lock、Git 配置、Windows 启停与安装入口；不新增日志和开发说明 |
| src/library/、src/userscript/ | 工作台与油猴脚本源文件；模块关系见 CODEMAP.md |
| server/ | 后端与 Blender 桥接源码 |
| test/ | Node 单元 / 集成测试与被测试使用的夹具 |
| scripts/ | 构建、下载依赖、启动维护与跨进程验证脚本；沿用现有路径，不为分类批量改入口 |
| sketchfab-exporter-tauri/ | 桌面工程及其专属脚本、配置与发布产物；不与根项目合并 |
| docs/、docs/release-notes/ | 功能 / 维护文档与逐版发布说明；文档用相对链接，源码路径相对仓库根目录 |
| assets/、design/ | 正式素材与独立设计原型；未被构建引用的设计稿不等于无用文件 |
| patches/、vendor/ | 上游补丁与第三方代码 / 可选运行依赖，不随意删除 |
| dist/ | 自动生成的前端产物，不手改 |
| artifacts/ | 截图、验证报告、归档日志；本轮历史日志放 artifacts/logs/ |
| scratch/ | 本地草稿与临时诊断，不提交；新临时文件不放根目录或 scripts/ |
| %APPDATA%/AssetVault/ | 工程外的配置、缓存、下载资产与历史数据归档；不随构建清理 |
| 示例/ | 本地参考资料，不按缓存直接删除 |
| node_modules/ | 本地依赖，由锁文件安装恢复；运行期间不清理 |

根目录启动脚本保留原位：现有快捷方式、脚本间调用及用户双击操作依赖这些路径。LICENSE 与包管理文件也保持根目录惯例。空的 tools/ 暂留，不把空目录视为需要递归清理的理由。

## 2026-10-31 已完成

- CODEMAP.md、CHANGELOG.md、THIRD_PARTY.md 从根目录移入 docs/，更新 README 链接与文档路径说明；已有代码地图内容完整保留。
- 根目录 _server_test.log、build-installer-run.log 移入 artifacts/logs/，未删除。
- 新增 docs/README.md 作为文档入口，不改业务代码、启动器与构建路径。
- 修改前建立 backup/clean-20261031-structure 分支，指向当时 HEAD；该分支不包含未提交改动。三个迁移文档的原始工作区版本另复制至 artifacts/cleanup-20261031/，包含代码地图已有的未提交修改。

## 待确认删除清单

本轮没有删除源码、依赖或数据。以下两个文件被现有 .gitignore 的 scripts/tmp-*.mjs 忽略；目录枚举发现后，搜索项目源码、配置与脚本未发现引用，也不在 package.json 入口中。文件内容为历史浏览器诊断副本，使用固定相对导入，没有发现自动加载该命名的入口。它们仍可能被用户手动运行，因此保留至确认。

| 文件 | 大小 | 建议 |
| --- | --- | --- |
| scripts/tmp-diag-browser.mjs | 58,133 字节 | 历史临时诊断副本，可在确认不再手动使用后删除 |
| scripts/tmp-diag3-browser.mjs | 59,739 字节 | 同上 |

未安装新的死代码分析工具，未把“搜索不到静态引用”视为业务模块可删的充分依据。assets/ 原始图片、design/ 原型、vendor/ 依赖及用户资产均不进入删除清单。
