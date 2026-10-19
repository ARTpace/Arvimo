# AssetVault 自定义安装器

`index.html` 同时用于浏览器设计预览与 Windows 安装器。原生版本隐藏演示按钮，通过 Wry IPC 调用 Rust，由 NSIS 完成提权安装和卸载注册。

- `npm run build`：构建 Tauri / NSIS 引擎，再生成自定义安装包，最后清理旧版本。
- `npm run build:installer-ui`：使用已有 NSIS 引擎重新构建界面安装包。
- 分发文件：`dist/AssetVault_<版本>_x64-setup.exe`。`src-tauri/target/release/bundle/nsis/` 下为原始引擎，供打包使用。
- `npm run test:installer-ui`：Rust 路径校验测试。
- `python scripts/test-installer-ui.py --native`：前端桥接测试和真实 EXE 启动测试，不执行安装。

安装中使用不确定进度动画；完成状态取决于 NSIS 退出码和主程序文件存在性。界面不可在安装中关闭，失败后可重试。主程序以普通用户权限启动。缺少 WebView2 或窗口初始化失败时回退至标准 NSIS 向导。

没有自动执行全程安装测试，以免覆盖本机现有安装和卸载注册信息；分发前建议在干净的 Windows 虚拟机验证全新安装、覆盖升级与卸载。未经代码签名，Windows 可能显示未知发布者。
