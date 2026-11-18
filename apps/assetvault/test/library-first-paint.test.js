import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

// 首帧与切页时的「闪一下」有两个独立成因，这里各钉一条：
//
// ① 侧边栏折叠态是挂在 <html> 上的 class，必须**早于第一次绘制**就挂好。原来靠 <head> 里的
//    内联 <script>，但页面 CSP 是 script-src 'self'，内联脚本被直接拒绝执行（控制台只有一条
//    Refused to execute inline script），于是每次刷新都是「先画成展开、再收起」。
// ② 瀑布流卡片的坐标是 CSS 变量给的，默认 0px。整块重建 innerHTML 之后如果等下一帧再量，
//    中间那一帧所有卡片叠在左上角、网格高度还是 0，切页 / 切瀑布流 / 切内容模式就是这一下闪。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const html=read('src/library/index.html');
const boot=read('src/library/sidebar-boot.js');
const collapse=read('src/library/sidebar-collapse.js');
const view=read('src/library/library-view.js');
const server=read('server/library.mjs');
const build=read('scripts/build-library.mjs');

test('按需图片解码模块同时有构建产物和服务端入口',()=>{
 assert.ok(server.includes("'/image-decoders.js'"));
 assert.ok(build.includes("'image-decoders.js'"));
});
// masonry.js 从 gallery-view.js 取「横版跨两列」的判定（比例从哪来、跨几列是同一份知识，
// 不在排版引擎里再抄一份）。这里把两个模块拼成一段脚本跑：vm 不认 import 语句，
// 所以先把 import 行去掉、把 export 改成普通声明。
const stripModule=s=>s.replaceAll('export function','function').replaceAll('export const','const');
const gallerySource=stripModule(read('src/library/gallery-view.js'));
const masonrySource=gallerySource+'\n'+stripModule(read('src/library/masonry.js')).replace(/^import\s.*$/gm,'');

test('折叠态在首帧就是对的：同源脚本阻塞解析，不靠内联脚本',()=>{
 // CSP 只放行 'self'：任何没有 src 的内联脚本都不会执行，等于这条早设 class 的逻辑不存在。
 const inline=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
 assert.equal(inline.length,0,'index.html 里不能再有内联 <script>（CSP script-src \'self\' 会拒绝执行）');
 const tag=html.match(/<script[^>]*src="\/sidebar-boot\.js"[^>]*><\/script>/);
 assert.ok(tag,'折叠态要由 /sidebar-boot.js 设置');
 // defer / async 都要等文档解析完才跑，那时侧栏已经画出来了，闪躲不掉。
 assert.equal(/\b(defer|async)\b/.test(tag[0]),false,'首帧脚本必须阻塞解析，不能 defer/async');
 assert.ok(html.indexOf('href="/app.css"')<html.indexOf('src="/sidebar-boot.js"'),'先让样式表发现 app.css，再阻塞取脚本，两者并行');
 assert.ok(html.indexOf('src="/sidebar-boot.js"')<html.indexOf('</head>'),'脚本留在 <head> 里，body 解析前就执行');
 // 两边必须是同一个 key，否则首帧读 A、交互写 B，刷新永远对不上。
 const key=/(KEY|getItem\(|setItem\()\s*'av:sidebar:collapsed'/;
 assert.match(boot,/getItem\('av:sidebar:collapsed'\)/);
 assert.match(collapse,/const KEY = 'av:sidebar:collapsed'|const KEY='av:sidebar:collapsed'/);
 assert.ok(key.test(boot),'boot 脚本与 sidebar-collapse.js 共用同一个 localStorage key');
 // 服务端只发白名单里的静态文件；构建要把它复制进 dist 与桌面工程，否则线上 404。
 assert.ok(server.includes("'/sidebar-boot.js'"),'服务端静态白名单要放行 /sidebar-boot.js');
 assert.ok(build.includes("'sidebar-boot.js'"),'构建要把它复制进 dist 和桌面工程');
});

// 一个够用的假网格：children 是卡片，clientWidth 可改，样式写进每张卡自己的 Map。
function makeGrid(width,timedResize=false){
 let timerId=0;const timers=new Map();
 let frame=0,resize,mutate;const records=[],listeners={};
 const style=()=>{const values=new Map();return {values,getPropertyValue:key=>values.get(key)||'',setProperty:(key,value)=>values.set(key,value)};};
 const root={children:[],clientWidth:width,style:style(),matches:selector=>selector.includes('model-grid'),
  querySelectorAll:()=>[],addEventListener:(name,fn)=>{listeners[name]=fn;},closest:()=>root};
 const card=height=>({height,classList:{contains:()=>false},style:style(),closest(){return this;},getBoundingClientRect(){return {height:this.height};}});
 const context={window:{innerWidth:1200,addEventListener(){},...(timedResize?{setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)}:{})},document:{},
  // masonry.js 读 --lib-gap-x/y 与 --lib-col-min 用 getComputedStyle；沙箱里给个回落，
  // 缺变量时 masonry 自己会走 12/14/190 默认值，不影响这里对坐标写入时机的断言。
  getComputedStyle:el=>el.style||{getPropertyValue:()=>''},
  requestAnimationFrame:fn=>{frame=fn;return 1;},MutationObserver:class{constructor(fn){mutate=fn;}observe(){}takeRecords(){return records.splice(0);}},
  cancelAnimationFrame:()=>{frame=0;},
  ResizeObserver:class{constructor(fn){resize=fn;}observe(){}},root};
 vm.runInNewContext(masonrySource+';this.__api=observeMasonry(root);',context);
 // frame() 只在真的排了帧时跑它；已经直接 layout 过（没有待跑帧）就什么也不做。
 return {root,card,timers,frame:()=>{const fn=frame;frame=0;if(typeof fn==='function')fn();},pending:()=>!!frame,queue:record=>records.push(record),deliver:()=>mutate(records.splice(0)),resize:width=>resize([{contentRect:{width}}]),api:context.__api,listeners};
}
const placed=card=>card.style.getPropertyValue('--masonry-left')!==''&&card.style.getPropertyValue('--masonry-top')!=='';

test('同步排版消费未派发的 DOM 变更，下一帧不再重复测量',()=>{
 const grid=makeGrid(800);let reads=0;
 const card=grid.card(200);card.getBoundingClientRect=()=>{reads++;return {height:200};};grid.root.children=[card];
 grid.queue({type:'attributes',target:grid.root});grid.api.flush();
 const before=reads;grid.deliver();assert.equal(grid.pending(),false);
 grid.frame();assert.equal(reads,before);
});

test('瀑布流尺寸连续跟随滑块，不等跨过列数阈值才变化',()=>{
 const grid=makeGrid(800);
 grid.root.children=[grid.card(300),grid.card(200)];
 grid.root.style.setProperty('--lib-col-min','150.25');
 grid.api.flush();
 assert.equal(grid.root.children[0].style.getPropertyValue('--masonry-width'),'150.25px');
 grid.root.style.setProperty('--lib-col-min','150.75');
 grid.api.flush();
 assert.equal(grid.root.children[0].style.getPropertyValue('--masonry-width'),'150.75px');
});

test('同步排版消费待执行帧，网格自身高度变化不再触发重排',()=>{
 const grid=makeGrid(800);
 grid.root.children=[grid.card(300),grid.card(200)];
 assert.equal(grid.pending(),true);
 grid.api.flush();
 assert.equal(grid.pending(),false,'flush cancels the already queued layout');
 grid.resize(800);grid.frame();
 grid.resize(800);
 assert.equal(grid.pending(),false,'height-only resize must not schedule layout');
 grid.root.clientWidth=600;grid.resize(600);
 assert.equal(grid.pending(),true,'width resize still schedules live layout');
 grid.frame();
 assert.ok(grid.root.children.every(placed));
 grid.resize(0);grid.frame();
 grid.resize(600);
 assert.equal(grid.pending(),true,'showing a hidden grid schedules layout again');
});

test('整块重建后在同一个任务里摆好位，不等下一帧',()=>{
 const grid=makeGrid(800);
 grid.root.children=[grid.card(300),grid.card(200)];
 grid.frame();
 assert.ok(grid.root.children.every(placed),'首屏照旧在 rAF 里落位');
 const height=grid.root.style.getPropertyValue('--masonry-height');
 // 换一批卡片（innerHTML 重建）：新节点没有任何坐标变量，宽度也回到 CSS 默认值。
 grid.root.children=[grid.card(320),grid.card(180),grid.card(260)];
 grid.api.flush();
 const cards=grid.root.children;
 assert.ok(cards.every(placed),'flush 之后当帧就要有坐标，否则重建那一帧卡片全叠在左上角');
 assert.ok(cards.every(card=>card.style.getPropertyValue('--masonry-width').endsWith('px')),'新卡片也要拿到列宽');
 assert.notEqual(grid.root.style.getPropertyValue('--masonry-height'),height,'网格高度同样当帧更新');
 // 摆完再走一次正常帧，不应再把坐标改坏。
 const before=cards.map(card=>card.style.getPropertyValue('--masonry-top'));
 grid.api.schedule();
 grid.frame();
 assert.deepEqual(cards.map(card=>card.style.getPropertyValue('--masonry-top')),before);
});

test('量不出宽度时什么都不写：切到下载页不能被压成 0 宽',()=>{
 const grid=makeGrid(800);
 grid.root.children=[grid.card(300),grid.card(200),grid.card(250)];
 grid.frame();
 const before=grid.root.children.map(card=>({...card.style.values}));
 const gridHeight=grid.root.style.getPropertyValue('--masonry-height');
 // 切到下载页：#library-view 变 display:none，网格的 clientWidth 归零。
 grid.root.clientWidth=0;
 grid.api.flush();
 grid.frame();
 const after=grid.root.children.map(card=>({...card.style.values}));
 assert.deepEqual(after,before,'宽度为 0 时不能改写坐标，否则卡片会被压成 0 宽堆到 (0,0)');
 assert.equal(grid.root.style.getPropertyValue('--masonry-height'),gridHeight,'网格高度也不能被清零，否则页面高度塌下去、滚动位置被夹掉');
 // 切回来：ResizeObserver 会再调一次 layout，这时才可以用真实宽度重排。
 grid.root.clientWidth=600;
 grid.api.flush();
 assert.equal(grid.root.children[0].style.getPropertyValue('--masonry-left'),'0px');
 assert.notEqual(grid.root.children[1].style.getPropertyValue('--masonry-left'),'0px','第二张要换列');
});

test('绘制层在瀑布流重建后主动 flush，而不是等下一帧',()=>{
 assert.match(view,/const masonry=observeMasonry\(\$\('#grid'\)\)/,'要留住 observeMasonry 的返回值');
 assert.ok(view.includes('masonry.flush()'),'写完后同一任务内摆位');
 assert.ok(/if\(gallery\)masonry\.flush\(\);/.test(view),'只有瀑布流需要抢帧；平铺网格是正常流');
});

test('连续窗口变宽只在停止后重排一次，期间图片加载不触发全量测量',()=>{
 const grid=makeGrid(800,true),card=grid.card(200);let reads=0;
 card.getBoundingClientRect=()=>{reads++;return {height:200};};grid.root.children=[card];
 grid.frame();grid.resize(800);grid.frame();const before=reads;
 for(let width=801;width<=900;width++){
  grid.root.clientWidth=width;grid.resize(width);
  grid.listeners.load({target:card});grid.frame();
 }
 assert.equal(reads,before,'拖动期间不反复恢复卡片自然布局');
 assert.equal(grid.timers.size,1,'所有宽度事件合并为一次尾部更新');
 const run=[...grid.timers.values()][0];grid.timers.clear();run();grid.frame();
 assert.ok(reads>before,'停止拖动后测量最终宽度');
 assert.equal(parseFloat(card.style.getPropertyValue('--masonry-width')),216,'采用最终 900px 的四列布局');
 grid.listeners.load({target:card});grid.frame();assert.ok(reads>before+1,'普通图片加载继续即时更新');
});
