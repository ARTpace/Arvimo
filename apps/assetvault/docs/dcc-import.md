# 一键导入其他软件

Blender 保持原来的导入方式。Maya、3ds Max、Houdini、Cinema 4D 在设置中安装接收脚本、重启对应软件一次，之后导出按钮调用软件原生 FBX/OBJ 导入器，收到场景导入结果后才报告成功。无需指定软件可执行文件路径。

接收脚本只处理一次性导入任务，不同步场景、不执行任意远程代码。任务文件存放在当前用户数据目录，软件主线程执行导入。多个同类软件实例同时连接时拒绝发送，避免导入错误窗口。超时后不自动重试，以免产生重复对象。

模型优先使用 FBX，缺少 FBX 时使用 OBJ；仅 GLB 的下载需重新选择 GLB + FBX。使用原生导入器保留文件自带材质与贴图引用，不承诺将任意 PBR 文件转换为所有第三方渲染器材质。独立材质/HDRI 仍沿用 Blender 功能。

设置自动检测 Windows 用户配置：Documents/maya/年份（2022 起，Python 3）、Documents/houdini版本、AppData/Local 或 Roaming/Autodesk/3dsMax/版本/语言、AppData/Roaming/Maxon/Cinema 4D 配置目录。没有配置目录时先启动软件。Maya userSetup.py、Houdini 123.py/456.py 第一次修改前备份为 .assetvault-backup，后续安装仅更新 AssetVault 标记区块；Max 和 C4D 使用独立启动脚本，不改已有插件。

## 参考与复用范围

- https://github.com/mohsenicreative/MaxBridge-Assistant ：参考 pymxs 代替 MaxPlus、PySide2/PySide6 的新版 Max 适配。未搬用仓库中 original/ 下的 Quixel 代码。
- https://github.com/yunananya/Megascans-LiveLink-for-Cinema-4D ：参考 AddGeometry 中 MergeDocument 原生合并路线、MessageData 主线程执行方式；这里只调用原生 API，没有打包上游插件或材质库。
- https://github.com/bdvoid/Quixel_H21 ：参考任务队列与导入结果确认思路；未复制其未明确许可的源码。
- AssetVault 自身的 blender-import.mjs：直接复用持久 ZIP 解包与文件筛选，避免导入后删除素材导致贴图丢失。

未引入这些项目的整套运行时或网络协议，也不依赖 Quixel Bridge。各软件 API 和版本差异仍需在目标软件验证。C4D 当前使用本机开发插件 ID 1000001，若与其他开发插件冲突可通过 ASSETVAULT_C4D_PLUGIN_ID 指定独立 ID；正式分发前必须申请 Maxon Plugin ID。
