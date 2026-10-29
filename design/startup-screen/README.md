# AssetVault 启动界面外观包

- `standalone.html`：单文件版，CSS、动画 JS、Logo 均已内嵌。可直接双击打开，或将整个文件发给其他工具优化。
- `index.html`：拆分版页面结构。
- `style.css`：当前启动页的完整原始样式，包含响应式、浮动、进度条条纹、粒子、Logo 弹跳和完成动画。
- `animation.js`：独立演示脚本，模拟加载进度并循环播放；点击 Logo 保留弹跳互动。
- `logo.png`：当前应用使用的新 Logo。

无需安装依赖、启动服务或联网。页面不含真实后台检测、软件安装、资产扫描和跳转逻辑，不修改正式工具。

交给其他工具的说明：

> 请优化这份 AssetVault 启动界面的外观和动画，保留元素 ID（card、mascot、hero、runner、fill、msg、pct、tip、ver）以及加载、完成两种状态。请返回完整 HTML，Logo 保持内嵌，方便回填正式项目。

修改拆分版时，将整个文件夹一起发送；修改单文件版只需发送 standalone.html。演示时长可在 animation.js 的 settings 中调整。
