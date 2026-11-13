import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// 2026-10-16 两处版面调整：
// ① 发现资产页只有卡片区滚动，搜索栏 / 结果标题行钉住（顶部那条状态栏当天晚些按用户要求撤掉）；
// ② 下载管理去掉四张统计卡、独立队列行与底部大段说明，目录与队列操作并成一行工具条，
//    各状态计数并进筛选页签——把版面留给任务列表本身。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const css=read('src/library/app.css');
const html=read('src/library/index.html');
const view=read('src/library/library-view.js');
const ui=read('src/library/download-ui.js');

test('the search bar and result heading stay pinned; only the card area scrolls',()=>{
 // 2026-10-16 用户要求撤掉顶部那条状态栏（面包屑 + 连接点 + 头像），钉住基准随之归零。
 assert.equal(/class="topbar"/.test(html),false,'顶部状态栏要撤掉');
 assert.equal(/\.topbar\{/.test(css),false,'顶栏样式一并不留');
 assert.ok(/\.search-sticky\{[^}]*position:sticky;top:37px/.test(css),'搜索栏要钉住（自然位置 = 内容区上边距）');
 assert.ok(/\.library-heading\{[^}]*position:sticky/.test(css),'结果标题行（含视图切换与加载数量）要钉住');
 assert.ok(css.includes('--sticky-search'),'标题行的 top 要避开搜索面板');
 assert.ok(view.includes('function syncStickyOffset')&&view.includes("setProperty('--sticky-search'"),'每次渲染量一次面板高度写进 CSS 变量');
 // sticky 钉不出父容器边界：搜索面板原先裹在 #discovery-panel 里，那层只有面板高，
 // 钉到尽头就跟着滚走了。
 assert.equal(html.includes('id="discovery-panel"'),false,'去掉只包住面板的那层 section');
 assert.equal(/id="search-panel"/.test(html),true,'搜索面板本身要保留');
 // 面板自己 overflow:hidden（裁渐变装饰）且 ::before 已被占用，钉子与遮罩只能在外层。
 // 模式图标轨也挂在同一层、排在面板之前，所以中间允许恰好一个 nav，别的一律不许夹。
 assert.match(html,/class="search-sticky">(?:\s*<nav[^>]*><\/nav>)?\s*<section class="search-panel"/,'搜索面板要包进 .search-sticky');
 assert.ok(/\.search-sticky::before\{[^}]*position:absolute/.test(css),
  '面板上方那条缝要盖住，否则滚动中的卡片从缝里透过去');
 assert.ok(css.includes('.search-sticky:has(#search-panel[hidden]){display:none}'),'非发现页整块收起');
 // 元素撤了，脚本就不能再往它们里面写：健康检查只做「首次自动检索」，连不上改用状态行 + 提示条。
 const app=read('src/library/app.js');
 assert.equal(/#page-crumb|#connection/.test(app),false,'脚本里不能再引用已撤掉的顶栏元素');
});

// 滚动时「往上跳 + 上下挤在一起」的根因：间距靠 margin，而 sticky 钉住时 margin 会被吃掉。
// 修法是让钉住位置等于元素在文档流里的自然位置（顶栏撤掉后就是 .content 的上边距），间距改成 padding。
// 基准写 0 是错的：一滚面板就贴到视口顶，那段上边距凭空消失 —— 用户看到的就是「一滚就变紧凑」。
test('pinned offset equals the natural position; spacing rides on padding',()=>{
 assert.match(css,/\.search-sticky\{position:sticky;top:37px;/,'桌面钉住基准 = .content 的 37px 上边距');
 assert.match(css,/\.library-heading\{position:sticky;top:calc\(37px \+ var\(--sticky-search,0px\)\)/,
  '标题行钉在「同一基准 + 搜索面板高」处');
 assert.ok(/\.library-heading\{[^}]*padding:25px 0 28px/.test(css),'标题行的上下间距都内化成 padding，钉住时才不会被吃掉、也不会被卡片透过去');
 assert.equal(/\.library-heading\{[^}]*margin-top:25px/.test(css),false,'不能再靠 margin-top 撑间距');
 // 间距若留在 margin 上，钉住时那段是透明的 —— 卡片滚到那里看着就是「紧贴标题行」。
 // 所以下方的 28px 也必须走 padding，由 .library-heading 自己的背景盖住。
 assert.equal(/\.library-heading\{[^}]*margin-bottom:\d/.test(css),false,'下方间距同样不能留在 margin 上');
 assert.ok(/\.search-sticky\{[^}]*padding:22px 34px 0/.test(css),'面板原来那段上间距改由 wrapper 的 padding 承担，滚动前后一致');
 assert.ok(view.includes("querySelector('.search-sticky')"),'变量量的是外层高度（含上间距），标题行才对得上');
 assert.ok(css.includes('@media(max-width:1150px){.search-sticky{top:30px}')&&
  css.includes('@media(max-width:780px){.search-sticky{top:25px}'),
  '两个窄屏断点各按自己的 .content 上边距（30 / 25）钉住，滚动前后不再挪位');
});

// 卡片从搜索栏前后透出来：钉住的容器自己必须是「不透明」的 —— 只靠 ::before 盖上方
// 那 40px 不够，padding-top 那 22px 和左右各 34px 都还是透明的。
test('the pinned search block is opaque and its mask spans the full main width',()=>{
 assert.ok(/\.search-sticky\{[^}]*background:#0d1117/.test(css),'钉住容器自己要有底色，不然卡片从 padding 区透出来');
 assert.ok(/\.search-sticky\{[^}]*margin-inline:-34px/.test(css),'底色要向左右扩到内容区边缘，盖住 content 的左右内边距');
 assert.ok(/\.search-sticky::before\{[^}]*left:-9999px/.test(css),'上方那条缝的遮罩要横向铺满（超出的部分由 main 裁掉）');
 assert.ok(/main\{[^}]*overflow-x:clip/.test(css),
  'main 用 overflow-x:clip 裁掉外扩的遮罩：clip 不创建滚动容器，sticky 不受影响');
 // 扫描状态行原先在 .search-sticky 外面，所以跟着卡片一起滚。
 const scanAt=html.indexOf('id="scan-status"');
 const stickyStart=html.indexOf('class="search-sticky"');
 const stickyEnd=html.indexOf('migration-note');
 assert.ok(scanAt>stickyStart&&scanAt<stickyEnd,'扫描状态行要放进 .search-sticky 里，跟搜索栏一起钉住');
 assert.ok(view.includes('new ResizeObserver'),'搜索区高度还会被筛选行搬移 / 状态行文案改动，用 RO 兜住偏移量');
});

// 2026-11-10 命令条的作用域：它只服务资产库本地资产，发现页一律收起。
// 过去 `#local-toolbar.hidden=online` 写在 renderGrid() 中段，而图站视图在函数开头就 return 了 ——
// 那一屏会带着上一屏的可见状态留在发现页。修法：外壳归属挪到任何早退之前，HTML 默认也收起。
test('本地命令条只在资产库出现，发现页（含图站视图）一律收起',()=>{
 assert.match(html,/id="local-toolbar"[^>]*\shidden(\s|>)/,'HTML 默认收起，首帧 / 任何早退路径都不会漏出命令条');
 const head=view.slice(view.indexOf('function renderGrid(){'),view.indexOf('if(state.pictureSite'));
 assert.ok(head.includes("$('#local-toolbar').hidden=online"),
  '命令条的可见性必须在图站早退分支之前就定下来');
 assert.ok(head.includes("heading.hidden=!online"),
  '标题行（含视图切换键）同样先定归属，图站视图不该继承资产库的隐藏状态');
 const after=view.slice(view.indexOf('if(state.pictureSite'));
 assert.equal(after.includes("$('#local-toolbar').hidden=online"),false,'旧的中段赋值要删掉，避免两处各写一遍');
});

test('the download center is slimmed down and the task list owns the page',()=>{
 // 删掉的三块
 assert.equal(html.includes('download-stats'),false,'四张统计卡移除');
 assert.equal(html.includes('queue-note'),false,'独立队列说明行移除');
 assert.equal(html.includes('download-footnote'),false,'底部大段说明移除');
 assert.equal(css.includes('.download-stats{'),false,'统计卡样式一并清理');
 assert.equal(css.includes('.queue-controls{'),false,'队列行样式一并清理');
 // 合并出来的一行工具条
 assert.ok(html.includes('class="download-bar"'),'保存目录与队列操作并成一行工具条');
 assert.ok(css.includes('.download-bar-actions'),'工具条右侧动作区有样式');
 assert.equal(css.includes('.download-bar{'),true,'工具条本体有样式');
 // 计数进页签、说明收进 title
 assert.ok(ui.includes("count.className='tab-count'"),'各状态计数并进筛选页签');
 assert.ok(ui.includes('pause.title='),'队列说明收进暂停键的 title，不占版面');
});

// 2026-10-16 ③ 预览弹窗随视口伸缩，并把版面让给 3D 展示区。
// 根因回顾：弹窗只有 max-height 没有确定高度，实际高度被 .preview-layout 的 min-height:620px
// 钉死 —— 高分屏上 3D 区就只有 620px 高，全屏反而显小；同时 iframe 硬编码 height:465px，
// 容器越宽越扁，和平台预览器的内容比例（约 3:2）对不上就左右留大片白。
test('预览弹窗随视口伸缩，3D 区宽高比恒定',()=>{
 const css=read('src/library/app.css');
 assert.match(css,/\.preview-dialog\{--pv-h:min\(90vh,1040px\)[^}]*height:var\(--pv-h\)/,
  '弹窗高度吃满视口（留上限防超大屏拉空侧栏），全屏时 3D 区跟着变大而非钉死在 620px');
 assert.match(css,/\.preview-dialog\{[^}]*width:min\(96vw,calc\(\(var\(--pv-h\) - 88px\) \* 1\.5 \+ 240px\)\)/,
  '宽度由高度按 3D 区 3:2 反推再加侧栏，预览器内容不再被压扁 / 左右留白');
 // dialog 关闭态靠 UA 样式的 display:none，作者样式必须用 [open] 限定才盖不掉它
 assert.match(css,/\.preview-dialog\[open\]\{display:grid;grid-template-rows:auto minmax\(0,1fr\)\}/,
  '弹窗改 grid 让内容区撑满剩余高度；[open] 限定避免弹窗关不掉');
 assert.match(css,/\.preview-layout\{display:grid;grid-template-columns:minmax\(0,1fr\) 240px;min-height:0/,
  '旧的 min-height:620px 钉死高度必须去掉');
 assert.equal(css.includes('.viewer-wrap iframe{width:100%;height:465px'),false,
  'iframe 硬编码高度会让画面随容器变宽而压扁');
 assert.match(css,/\.viewer-wrap iframe\{width:100%;[^}]*flex:1;min-height:0\}/,
  'iframe 交给 flex 撑满剩余空间');
 assert.match(css,/\.preview-layout\{grid-template-columns:1fr;grid-template-rows:minmax\(0,1fr\) minmax\(0,1fr\)\}/,
  '窄屏单列时两行均分高度，不再靠 330px 硬高度');
 assert.equal(css.includes('height:330px'),false,'330px 硬高度已清干净');
});
