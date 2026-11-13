import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {routeLink} from '../src/library/platforms.js';
import {describeRequest} from '../src/library/discovery-view.js';

// 两条都是「用户看得见但说不清为什么不对」的问题：一个删字后界面不动，一个粘作者页
// 不知道拿到的是什么。结构断言 + 路由行为断言一起钉住。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const app=read('src/library/app.js');
const feed=read('src/library/discovery-feed.js');
const view=read('src/library/discovery-view.js');
const catalog=read('server/catalog.mjs');
// 断言代码里「某个名字不再出现」之前必须先把注释剥掉：解释这个坑的那句话本身就写着那个名字，
// 直接匹配源码会假红（反过来，注释里写了本该删掉的符号也会让「已删除」类断言假绿）。
const codeOnly=source=>source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:])\/\/[^\n]*/g,'$1');

test('搜索词被清空后要重新检索，不能停在旧结果上',()=>{
 // 根因：搜索框只监听 submit（回车），删字这个动作界面完全不知道 →
 // 结果区还挂着上一次的卡片，切平台也只是把旧结果原样搬过去。
 assert.ok(app.includes("addEventListener('input',clearSearchIfEmptied)"),
  '搜索框必须监听 input，否则删字没有任何反应');
 assert.ok(app.includes('function clearSearchIfEmptied'),'要有专门的清空处理');
 assert.ok(/\$\('#asset-query'\)\.value\.trim\(\)/.test(app),
  '要以搜索框当前是否为空作为判据');
 // 正在打字、只删掉几个字时不该反复发请求：框里还有字就直接返回。
 assert.ok(app.includes("if($('#asset-query').value.trim())return"),'框里还有字就不打断检索');
 // 2026-10-16：只靠 hadQuery（一次性内存标志）会漏掉「刷新页面后 feeds 从本地存储恢复」这条路 ——
 // 那时框里回填了上次的关键词、结果区也还是那次检索，但 hadQuery 是 false，删空搜索框毫无反应。
 // 判据必须是「结果区自己还挂着一次有内容的检索吗」。
 assert.ok(app.includes('function searchStillActive'),'要用「结果区是否仍是检索态」判定');
 assert.ok(/\$\('#asset-query'\)\.value\.trim\(\)\)return;\s*\/\/[^\n]*\n\s*if\(!searchStillActive\(\)&&!hadQuery\)return/.test(app),
  '框已空 + 结果区已回浏览态时才什么都不做');
 assert.ok(app.includes('return Object.values(state.feeds).some('),
  '清空判据必须覆盖隐藏平台和在途请求');
 assert.ok(app.includes('let hadQuery=false')&&app.includes('hadQuery=true'),
  'hadQuery 保留为补充判据（首次打开页面框本来就是空的，不能当成一次删除）');
 assert.ok(feed.includes('markQueryActive'),'发起检索时要记下「框里有内容」');
 assert.ok(app.includes('markQueryActive:'),'要把该能力从 app.js 传进 discovery-feed');
 // 清空后回到「浏览热门」而不是空界面：那才是删掉关键词后该看到的状态。
 assert.ok(app.includes("state.source='search'"),'清空后要切回搜索来源，不能留在 link 来源');
 // 真实根因（2026-10-16 实测）：这一步原来写成 searchHistoryUI()?.close()，而 searchHistoryUI
 // 只是传给 discovery-feed 的属性键，app.js 作用域里根本没有这个名字 → 每次删空都抛
 // ReferenceError，后面的 restartSearch(0) 永远执行不到，界面一直停在旧结果上。
 // 当时的断言只比字符串，所以一直假绿；这里把「调用的是 app.js 里真实存在的对象」也钉住。
 assert.ok(app.includes('searchHistory?.close();'),'清空时要收起最近检索浮层（用 app.js 里的真实变量）');
 // 断言前必须去注释：解释这个坑的那句话里就写着 searchHistoryUI()，不去掉注释会假红。
 assert.equal(/\bsearchHistoryUI\(/.test(codeOnly(app)),false,'app.js 里不能直接调用 searchHistoryUI()');
});

test('切标签页要保住各自的滚动位置，不能复位到顶部',()=>{
 // 根因：切走时那个标签页被 hidden 掉，页面瞬间变矮，浏览器把窗口滚动量夹到 0；
 // 切回来就从顶部开始了。所以要在隐藏之前读一次 scrollY，回来后再放回去。
 assert.ok(app.includes('const routeScroll=new Map()'),'要有一份「路由 → 滚动位置」的记录');
 assert.ok(/const leaving=state\.route;\s*\n\s*if\(leaving&&leaving!==name\)routeScroll\.set\(leaving,window\.scrollY\)/.test(app),
  '切换前要读一次当前滚动位置（读在 hidden 之前，否则读到的已经是夹住后的 0）');
 assert.ok(/if\(leaving&&leaving!==name\)restoreRouteScroll\(routeScroll\.get\(name\)\|\|0\)/.test(app),
  '切回来要把记录的位置放回去');
 assert.ok(/window\.scrollTo\(0,Math\.max\(0,top\)\)/.test(app),
  '桌面/WebView 里滚的是 window（main 只有 overflow-x:clip，不是滚动容器）');
 assert.ok(app.includes('requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo(0,Math.max(0,top))))'),
  '要等两帧再恢复：显隐与重绘要先落盘，否则页面高度还没稳定');
 // 首次进入（state.route 与目标同名）不恢复：每次刷新页面都被拉回顶部反而更差，
 // 这条由上面那条 leaving!==name 的门控保证。
});

test('粘贴 Sketchfab 作者页能列出该作者的全部模型',()=>{
 // 后端早就支持（/v3/models?user=xxx），这里守住「别被改坏」。
 assert.match(catalog,/models\?\$\{segments\[1\]==='likes'\?'liked_by':'user'\}=/,
  'scanPage 要按 user/liked_by 取作者模型');
 assert.match(catalog,/v3\/search\?type=users&q=/,
  '作者名要先经 users 接口换成真实用户名');
 // 前端要能把作者页和别的 Sketchfab 页面区分开，否则结果区只写「链接解析结果」。
 const author=routeLink('https://sketchfab.com/bozhena_bozhena');
 assert.equal(author.label,'Sketchfab 作者','裸作者页应识别为作者页');
 assert.equal(routeLink('https://sketchfab.com/bozhena_bozhena/models').label,'Sketchfab 作者',
  '作者模型页同样是作者页');
 // 这些不能被误判成作者名，否则会拿着 "models" / "search" 去查用户。
 for(const u of ['https://sketchfab.com/models/abc123','https://sketchfab.com/search',
                 'https://sketchfab.com/collections/xyz','https://sketchfab.com/settings']){
  assert.notEqual(routeLink(u).label,'Sketchfab 作者',`${u} 不该被当成作者页`);
 }
 // 结果区标题要说出这批结果到底是什么。
 assert.ok(feed.includes('f.origin=data.source'),'要记住服务端给的 source');
 assert.ok(app.includes("origin:''"),'新Feed 要声明 origin 字段，否则持久化恢复会丢');
 assert.ok(view.includes('feeds?.web?.origin'),'标题要用 origin 取代笼统的「链接解析结果」');
 assert.ok(feed.includes("f.origin=''"),'换一次链接时要清掉上一批的来源');
 assert.equal(
  describeRequest({source:'link',platform:'sketchfab',feeds:{web:{origin:'作者 · bozhena_bozhena'}},categories:[],describeArt:()=>''}),
  '作者 · bozhena_bozhena','标题应直接说出是哪个作者的模型');
 assert.equal(
  describeRequest({source:'link',platform:'sketchfab',feeds:{web:{}},categories:[],describeArt:()=>''}),
  '链接解析结果','没有 origin 时仍要退回原来的文案，不能显示空白');
});
