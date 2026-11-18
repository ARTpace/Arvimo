import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// 这三条修的都是「点了没反应 / 点了变黑」这类看不出原因的问题，只能靠结构断言钉住做法。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const app=read('src/library/app.js');
const feed=read('src/library/discovery-feed.js');
const view=read('src/library/library-view.js');
const preview=read('src/library/gltf-preview.js');
const html=read('src/library/index.html');
const main=read('sketchfab-exporter-tauri/src-tauri/src/main.rs');

test('预览弹窗重新打开时，迟到的 close 事件不能把新预览作废',()=>{
 // 根因：<dialog> 的 close 事件是排队异步派发的，而 preview() 是
 // close() → showModal() → load() 同步走完。新 load 先占了 loadToken，
 // 那个迟到的 close 再跑一遍 close() 就会藏掉 canvas 并作废 token —— 之后每个模型都黑屏。
 assert.ok(/addEventListener\('close'[\s\S]{0,200}preview-dialog'\)\.open\)return;/.test(app),
  'close 监听必须先判断弹窗是否已重新打开，已打开就跳过这一轮收尾');
 assert.ok(view.includes('gltfPreview.load(m.assetId,phType)'),
  'Poly Haven 仍然走本地渲染');
 assert.ok(view.includes('dlg.close()'),
  '连点下一个资产时先关掉旧弹窗，避免 showModal 抛 InvalidStateError');
 // 顺带守住尺寸：<dialog> 关着时 canvas 是 display:none，clientWidth 恒为 0，
 // 直接拿它算渲染器尺寸会让复用渲染器的那次 resize 落空、画布与画面错位成黑屏。
 assert.ok(preview.includes('canvas.parentElement?.clientWidth'),
  '画布尺寸必须有父容器兜底，不能只读 hidden 状态下恒为 0 的 clientWidth');
 assert.ok(preview.includes('canvas.clear()')||preview.includes('renderer.clear()'),
  '换资产时先清一次帧缓冲，别把上一帧留在画布上');
 // ensureRenderer 的定义在 prepareStage 之前，所以不能拿全文下标比大小 ——
 // 要在 prepareStage 这个函数体内部找「亮画布」与「建渲染器」的先后。
 const stage=preview.slice(preview.indexOf('function prepareStage'),preview.indexOf('function clearRoot'));
 assert.ok(stage.includes('canvas.hidden=false')&&stage.includes('ensureRenderer()')
  &&stage.indexOf('canvas.hidden=false')<stage.indexOf('ensureRenderer()'),
  '必须先亮出画布再建/复用渲染器，否则它量到的是 0 宽高');
});

// 这一条曾被上面那个「画布显隐顺序」修复**掩盖**好几个月：旧 prepareStage 在画布还 hidden
// 时就 return false，loadModel 提前 return，压根走不到这行；顺序修好后流程往下走才炸出来。
// 症状是 revokeBlobs 抛「blobs is not iterable」，整个预览黑屏。
test('inlineResources 就地 push blob，调用方不能把返回值赋给 blobs',()=>{
 // toBlob / toLocalBlobUrl 都是 registry.push(...) 就地登记，返回的是自己那个 url，不是数组。
 assert.ok(preview.includes('registry.push(created)'),'toBlob 通过 registry 就地 push');
 // 断言要先剥注释：修复说明里就写着那个错误写法，朴素匹配会把自己判成不合格。
 const code=preview.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
 assert.ok(!/\w+\s*=\s*await inlineResources\(/.test(code),
  'inlineResources 不返回值，赋值给 blobs 会把它变成 undefined，下一次 revokeBlobs 直接崩');
 assert.ok(code.includes('await inlineResources(gltf,indexByBasename(files),baseDir,blobs)'),
  '调用处要传 blobs 进去并 await');
 // 兜底：即便将来又被谁弄成非数组，回收也不能抛 —— 抛了就是黑屏且无提示。
 assert.ok(/function revokeBlobs\(\)\{if\(Array\.isArray\(blobs\)\)/.test(code),
  'revokeBlobs 必须先判 Array.isArray 再遍历');
});

test('预览资源跨预览复用缓存，且必须有容量上限',()=>{
 const code=preview.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
 assert.ok(code.includes('createPreviewCache(fetchLocal)'), '预览使用有容量限制的持久缓存');
 assert.ok(code.includes('await previewCache.get(url)'), '先读热缓存/磁盘，再访问网络');
 assert.ok(code.includes('URL.createObjectURL(blob)'), '每次预览创建独立 URL，关闭后可安全回收');
 // 文件清单同样不该每次重取（三条预览路径都要先问一遍 /files/{id}）。
 assert.ok(code.includes('async function fetchList(assetId,type)'),'文件清单要有缓存入口');
 // 只数调用形态（=await fetchList(…,'type')），别把函数定义那一行也算进来。
 const lists=(code.match(/=\s*await fetchList\(assetId,'\w+'\)/g)||[]).length;
 assert.equal(lists,3,'models / textures / hdris 三条路径都要走 fetchList');
 // 直取清单的写法只允许存在于 fetchList 自己体内（那是缓存未命中时的真请求）。
 const outside=code.replace(/async function fetchList\(assetId,type\)\{[\s\S]*?\n\}/,'');
 assert.ok(!/fetchLocal\(`\$\{FILE_API\}/.test(outside),'fetchList 之外不能再有直取清单的写法');
 // 并行：一个 1K 模型有 1 个 .bin + 5~7 张贴图，串行等于把 RTT 叠起来。
 const inline=code.slice(code.indexOf('async function inlineResources'),code.indexOf('export function createGltfPreview'));
 assert.ok(inline.includes('await Promise.all(jobs)'),'贴图与 .bin 必须并行抓取');
 assert.ok(!/for\(const b of gltf\.buffers\)[\s\S]{0,160}await toBlobURL/.test(inline),
  '不能在循环里逐个 await，那正是串行的来源');
 // 加载反馈：有缓存后重复预览近乎瞬时，但首次仍要下载，纯黑画面没有等待感。
 // 2026-11 起改成整块加载过渡层：#state 是唯一状态源，MutationObserver 驱动
 // #viewer-loading 显隐与文案，不再靠 hint.classList.toggle('busy')。
 assert.ok(code.includes('function bindLoadingOverlay()'),'要有加载过渡层的绑定入口');
 assert.ok(code.includes("document.getElementById('viewer-loading')"),'过渡层容器要接上');
 assert.ok(code.includes('new MutationObserver(sync).observe(stateEl'),'由 #state 变化驱动，不改各处 setHint');
 assert.ok(assembleLibraryStyles().includes('@keyframes viewer-spin'),'app.css 要有关联的动画');
});

test('安装版里所有外链都交给系统默认浏览器',()=>{
 const helper=read('src/library/open-url.js');
 assert.ok(helper.includes("invoke('open_external'"),'桌面版必须走 Tauri 命令让系统接管');
 assert.ok(helper.includes('window.open'),'浏览器里直接跑时要有回退，不能只在桌面可用');
 assert.ok(main.includes('fn open_external(url: String)')&&main.includes('open_external,'),
  'Rust 侧必须实现并注册 open_external');
 assert.ok(main.includes('rundll32')||main.includes('xdg-open'),
  '打开链接要走系统 ShellExecute，不能拿 cmd /c start 去拼 URL');
 // 只放行 http/https：这是给用户主动点的链接用的，不该让界面拿着任意协议去调系统。
 assert.match(main,/starts_with\("http:\/\/"\)/,
  'open_external 必须校验协议，否则界面可以拿 file:// 去调系统');
 assert.ok(/a\[target="_blank"\]/.test(app),
  '详情面板里所有 target=_blank 的官方页面链接都要被全局接走，否则装成应用后点了没反应');
 for(const f of ['src/library/artstation-ui.js','src/library/library-view.js','src/library/setup-wizard.js']){
  assert.ok(read(f).includes("from './open-url.js'"),`${f} 应改用 openExternal`);
  assert.ok(!/window\.open\(/.test(read(f)),`${f} 里不该再有裸 window.open`);
 }
});

test('资源列表滚动到底自动加载，且每批条数可调',()=>{
 assert.ok(html.includes('id="page-size"'),'分页行要有「每次加载多少条」的下拉');
 assert.ok(app.includes('IntersectionObserver'),'自动加载用观察分页行，而不是自己算滚动位置');
 assert.ok(app.includes("autoLoad.observe($('#pagination'))"),'观察对象必须是分页行：它 hidden 时不产生交点，没有下一页就自然停');
 // 分页行在加载完成前会再次进入视口（新增上千像素内容），没有这个闸门会连发。
 assert.ok(app.includes('autoLoadBusy'),'必须有 in-flight 闸门，否则滚动加载会连发');
 assert.ok(/f\.rows\.length>=1000\|\|\!\(f\.next\|\|f\.pending\.length\)/.test(app),
  '自动加载前要复述「还有下一页且没到上限」的判断，不能无条件翻页');
 // 下拉调的是「一轮翻几页」而不是改平台接口的每页大小（那是各平台写死的 24/48），
 // 所以滚动与按钮两条入口必须共用同一个 batchPages，否则两者节奏会不一致。
 assert.match(feed,/const batchPages=Math\.max\(1,Math\.ceil\(/,
  'discovery-feed 要按目标条数算出这一轮翻几页');
 assert.ok(feed.includes('const pageLimit=all?')&&feed.includes(':batchPages;'),
  '普通翻页与「继续检索至上限」都要用 batchPages，只是上限来源不同');
 // 选择要能留下来：pageSize 属于界面节奏，不塞进会被设置面板整份覆盖的 options。
 assert.ok(app.includes('state.pageSize=')&&app.includes('pageSize:state.pageSize'),
  '每批条数要跟 discovery 快照一起持久化');
 assert.ok(read('src/library/library-state.js').includes('pageSize:Number(data.pageSize)'),
  'loadDiscovery 必须把 pageSize 读回来，否则刷新后回到默认值');
 assert.ok(app.includes("pageSizeSelect.onchange"),'下拉必须有 change 处理');
});