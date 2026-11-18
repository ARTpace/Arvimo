# 卡片 UI 样式入口

| 类型 | 样式文件 | 渲染与交互 |
| --- | --- | --- |
| 普通资产卡 / 共用基础 | `asset-card.css` | `../card-view.js`、`../local-files.js` |
| 图集 | `album-card.css` | `../local-files.js`、`../album-card-layout.js` |
| 图集文件夹 | `album-folder-card.css` | `../local-files.js` 的 `folderCard` / `folderMedia` |
| 画板 | `board-card.css` | `../board-deck.js` |

## 修改方式

直接修改对应 CSS 文件中的规则；需要新增覆盖样式时，优先写在文件最末尾 `@section custom` 与 `@endsection` 之间。它们在基础样式之后生效，不必修改 `app.css`。

普通卡的 `.model-card`、`.card-media` 等是图集和文件夹复用的基础。只想调整普通资产时，可使用 `.model-card:not(.pkg-collection):not(.album-folder-card)`，避免影响另外两类。

保留 `@section` / `@endsection` 注释。历史规则有较多覆盖关系，`app.css` 中的 `@card-style` 占位符负责保持原始级联顺序；构建会将各段原样合并，而不是让浏览器单独请求这些文件。注明 `@media` / `@supports` 的历史段落继承占位符外层条件；在 `custom` 段新增响应式样式时，请写完整的 `@media` 块。

全局主题变量、页面布局和预览面板仍在 `../app.css`，瀑布流的列数、跨列及排布计算仍由 `../masonry.js` 负责。本次仅拆样式，没有拆动业务逻辑。

## 查看效果

在 `H:/AI-Tools/Arvimo/apps/assetvault` 执行：

```powershell
node scripts/build-library.mjs
```

构建会更新 `dist/library/app.css` 并同步桌面前端；刷新应用查看。不要直接编辑 `dist` 或 `sketchfab-exporter-tauri/src/app.css`，它们会被构建覆盖。
