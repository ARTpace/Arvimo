# HTML 卡片设计副本

直接打开 index.html 查看四类卡片，也可以分别打开四个 HTML。所有 CSS、图形和演示脚本均内嵌，可离线打开和独立修改。

每份 HTML 内有 asset-card-styles、album-card-styles、album-folder-card-styles、board-card-styles 四个 style 区域。preview-shell 只控制演示页布局。

封面为内嵌 SVG 示例图，不使用或修改资产库数据。悬停、收藏高亮、宫格切换和角标拖动为设计演示；打开画板、编辑、删除等业务动作未接入。

这是 UI 设计副本，修改 HTML 不会自动改变应用。调整后可交回 HTML，再迁移到生产 CSS。重新运行 node scripts/export-card-preview.mjs 会覆盖这些设计副本，请先保留自己的修改。
