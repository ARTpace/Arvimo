# 搜索栏外观编辑包

双击 `index.html` 即可预览，不需要安装依赖或启动 AssetVault。也可以把这四个文件一起交给其他工具。

- `index.html`：搜索栏结构，保留原项目的主要 ID 和类名；图标为内嵌 SVG。
- `search-bar.css`：独立样式，含桌面和窄屏布局。
- `search-bar.js`：平台切换、主题填入、表单事件；不发送搜索请求或调用 AI。

这是根据当前实现整理的独立外观示例，不是完整业务组件。平台列表使用原生下拉框代替项目的自定义平台菜单；每日主题固定为截图内容。

## 给其他工具的修改要求

请优化这个搜索栏的外观，保留现有功能入口：平台选择、搜索输入、回车提示、搜索/解析按钮、AI 拆解按钮和主题推荐。保留主要 HTML ID，尽量只修改 CSS，不添加框架、依赖或后台接口。交付完整 HTML、CSS、JS 文件，并说明变更点。

## 对应原项目源码

- `src/library/index.html`：`#search-panel` / `#asset-search-form`。
- `src/library/app.css`：`.search-panel`、`.search-field`、`.platform-select`、`.global-search`、`.topic-strip`；同名样式有多次覆盖，后面的规则优先。
- `src/library/platforms.js`：平台选择的业务配置。

修改独立示例不会改变 AssetVault。拿到优化结果后，应将相关样式与结构合并回原项目，保留原来的搜索和 AI 业务事件。
