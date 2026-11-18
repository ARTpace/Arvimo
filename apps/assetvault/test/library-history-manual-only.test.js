import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';
// 最近检索的三条规矩（2026-10-16 用户提的三件事，各自钉一条）：
//
//  1. 只有「手动在搜索框里敲了关键词并提交」才写记录。分类 / 排序 / 复选变更、历史回放、
//     页面初始化都会重发检索，如果把它们的请求也记下来，浮层里就会塞满一堆没有关键词的空条目。
//  2. 浮层是一行铺多个的胶囊，不是每条占一行的列表。
//  3. 平台下拉与浮层都贴在搜索卡片下沿的同一处，同时打开必然互相压住 —— 打开一个必须收起另一个。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createDiscoveryFeed} from '../src/library/discovery-feed.js';

const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
/** 断言看代码，不看注释：解释这些坑的注释里会出现同样的字样，先剥掉再匹配。 */
const code=src=>src.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const at=(src,needle,label)=>{const i=src.indexOf(needle);assert.notEqual(i,-1,`源码里找不到：${label||needle}`);return i;};

const newFeed=()=>({rows:[],request:null,next:null,pending:[],pages:0,busy:false,token:0,controller:null,status:'',error:false,aborted:false,warnings:[],visited:new Set()});

/** 跟 library-discovery-link.test.js 同一个套路：discovery-feed 只通过 ctx 跟外界打交道，桩就够了。 */
function harness({q='chair'}={}){
 const state={route:'discover',platform:'sketchfab',source:'search',selected:new Set(),history:[],feeds:{search:newFeed(),art:newFeed(),web:newFeed(),polyhaven:newFeed(),ambientcg:newFeed()}};
 const feed=createDiscoveryFeed({
  $:()=>({value:'chair'}),
  toast:()=>{},
  state,
  persist:()=>{},
  renderGrid:()=>{},
  mergeModels:(current,incoming)=>[...current,...(incoming||[])],
  describeArt:()=>'',
  activeModes:()=>['search'],
  showsFeed:mode=>mode==='search',
  searchHistoryUI:()=>({refresh(){},close(){}}),
  resolveArtworkLink:()=>Promise.resolve(null),
  routeTo:()=>{},
  readRequest:()=>({q}),
  clearSearchTimer:()=>{},
  feedError:({error})=>error||'failed',
  markQueryActive:()=>{},
 });
 globalThis.fetch=async()=>({ok:true,json:async()=>({models:[],next:null,pending:[],warnings:[]})});
 return {state,feed};
}

test('a filter change (no record flag) leaves 最近检索 untouched',async()=>{
 const {state,feed}=harness();
 await feed.startSearch();
 assert.deepEqual(state.history,[],'分类 / 排序变更重发的检索不该写进历史');
});

test('a submitted keyword is remembered',async()=>{
 const {state,feed}=harness();
 await feed.startSearch({record:true});
 assert.equal(state.history.length,1);
 assert.equal(state.history[0].kind,'search');
 assert.equal(state.history[0].params.q,'chair');
 assert.equal(state.history[0].platform,'sketchfab');
});

test('submitting an empty box (browse popular) is not remembered either',async()=>{
 const {state,feed}=harness({q:''});
 await feed.startSearch({record:true});
 assert.deepEqual(state.history,[],'浏览热门没有关键词可回放，记下来只会占住一个名额');
});

test('requestFeed defaults record to false, so no caller forgets the flag and starts recording',()=>{
 const feed=code(read('src/library/discovery-feed.js'));
 assert.ok(/async function requestFeed\(mode,request,\{[^}]*record=false[^}]*\}=\{\}\)/.test(feed),
  'requestFeed 的 record 必须默认 false：漏传参数的入口不该悄悄开始记历史');
 assert.ok(/if\(!more&&mode==='search'&&record&&String\((?:originalRequest|request)\.q\|\|''\)\.trim\(\)\)\{?remember\(/.test(feed),
  '关键词那一路要 record 为真、且确实带关键词才记录');
 assert.ok(/function startSearch\(\{record=false\}=\{\}\)/.test(feed),'startSearch 同样默认不记录');
 assert.ok(/requestFeed\(mode,readRequest\(mode\),\{record\}\)/.test(feed),'startSearch 要把 record 透传下去');
});

test('only the search box submit turns recording on — filters, tags and replay never do',()=>{
 const app=code(read('src/library/app.js'));
 const hits=app.match(/startSearch\(\{record:true\}\)/g)||[];
 // 只有两个入口：搜索框回车提交，以及点浮层里的推荐词（后者等同用户在框里敲了那个词）。
 // 其余入口（分类/排序/复选、标签点选、重置筛选、浏览全部、历史回放）一律走默认的不记录。
 assert.equal(hits.length,2,`只允许「搜索框提交」与「推荐词」两处开启记录，实际 ${hits.length} 处`);
 assert.ok(/\$\('#asset-search-form'\)\.addEventListener\('submit'[\s\S]{0,120}startSearch\(\{record:true\}\)/.test(app),
  '开启记录的一处必须是搜索表单的 submit');
 assert.ok(/function pickTerm\(term\)\{[\s\S]{0,200}startSearch\(\{record:true\}\)/.test(app),
  '另一处必须是浮层推荐词的统一入口：它等同用户自己输入关键词');
 // 标签点选、重置筛选、浏览全部这几处都会改动搜索条件，它们只能走默认（不记录）的那条路。
 // 只断言「入口存在 + 调用不带参数」，不锁死整行源码 —— 之前整行比对在旁边加个分支就假红。
 for(const [pattern,label] of [
  [/const tag=e\.target\.closest\('\[data-tag\]'\)[\s\S]{0,240}?startSearch\(\);/, '标签点选'],
  [/\$\('#reset-search-filters'\)\.onclick[\s\S]{0,160}?startSearch\(\);/, '重置筛选'],
  [/\$\('#empty-explore'\)\.onclick[\s\S]{0,180}?startSearch\(\);/, '浏览全部'],
 ])assert.ok(pattern.test(app),`${label} 应保持不带 record`);
});

test('history entries without a keyword are dropped when the store is loaded',()=>{
 const state=code(read('src/library/library-state.js'));
 assert.ok(/h\.params\.q\.trim\(\)!==''/.test(state),
  '关键词为空的检索记录（浏览热门的副产物）不该被加载回历史');
});

test('the history popover lists compact chips and drops keyword-less entries when rendering',()=>{
 const ui=code(read('src/library/search-history.js'));
 assert.ok(ui.includes("input.closest('.global-search')"),
  '锚点要落在输入框那一段，否则点平台下拉会被当成点在搜索框里，浮层不关');
 assert.ok(/entry\.kind!=='search'\|\|String\(entry\.params\?\.q\|\|''\)\.trim\(\)!==''/.test(ui),
  '渲染前再兜一层：没有关键词的记录不显示');
 assert.equal(ui.includes('<small>'),false,'胶囊里只有词，平台 / 分类压进 title 提示，不再占一整行');
 assert.ok(/document\.addEventListener\('picker:open',\(\)=>close\(\)\)/.test(ui),'平台下拉弹开时收起浮层');
});

test('the platform picker announces itself so the popover can get out of the way',()=>{
 const picker=code(read('src/library/picker.js'));
 assert.ok(/document\.dispatchEvent\(new CustomEvent\('picker:open'(?:,\{detail:\{id\}\})?\)\)/.test(picker),
  'picker 打开时要广播 picker:open');
});

test('the two popovers are layered and laid out so they cannot cover each other',()=>{
 const css=assembleLibraryStyles();
 const grab=sel=>{const i=at(css,sel+'{');return css.slice(i,css.indexOf('}',i));};
 assert.ok(/flex-wrap:wrap/.test(grab('.history-list')),'历史列表要横向铺开、装不下才换行');
 assert.ok(/border-radius:99px/.test(grab('.history-item')),'历史记录是胶囊样式');
 assert.equal(/(?:^|[^-])width:100%/.test(grab('.history-item')),false,'胶囊不能再独占整行');
 const menu=grab('.picker-menu');
 const popStart=at(css,'.history-pop{');
 const pop=css.slice(popStart,css.indexOf('}',popStart));
 const zOf=text=>Number((text.match(/z-index:(\d+)/)||[])[1]||0);
 assert.ok(zOf(menu)>zOf(pop),
  '平台菜单要压在历史浮层之上：万一两者同时开着，也是菜单可点');
});
