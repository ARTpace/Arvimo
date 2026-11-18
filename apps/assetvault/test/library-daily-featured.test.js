import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {searchPage} from '../server/catalog.mjs';
import {artSearchParams} from '../server/artstation-search.mjs';
import {dailyTopics,TOPICS,TOPIC_COUNT} from '../src/library/search-options.js';
import {SERVER_CAPABILITIES,SERVER_VERSION} from '../server/capabilities.mjs';

const read=path=>readFileSync(path,'utf8');
const app=read('src/library/app.js');
const html=read('src/library/index.html');
const css=assembleLibraryStyles();

/** 抓一次 Sketchfab 搜索真正发出去的 URL。 */
async function sketchfabUrl(input){
  let seen;
  await searchPage(input,{json:async u=>(seen=new URL(u),{results:[]})});
  return seen;
}

// 浏览态 = 用户什么都没要求（没关键词、没分类、排序还停在默认、没勾任何筛选）。
// 这时界面该给一份跟着平台更新的「最新精选」，而不是永远不变的历史点赞榜 ——
// 用户 2026-10-16 反馈「每次打开都一样」，根因就是这里原来固定用 -likeCount。
test('Sketchfab browsing gives fresh staff picks, not a frozen all-time chart',async()=>{
  const url=await sketchfabUrl({});
  assert.equal(url.searchParams.get('staffpicked'),'true');
  assert.equal(url.searchParams.get('sort_by'),'-publishedAt');
  assert.equal(url.searchParams.has('downloadable'),false,'不额外收紧：可下载与精选兼顾不上，会让列表变空');
});

test('any real request from the user takes over from the browsing default',async()=>{
  for(const input of [{sort:'popular'},{category:'characters-creatures'},{downloadable:true},{animated:true},{q:'chair'}]){
    const url=await sketchfabUrl(input);
    assert.notEqual(url.searchParams.get('sort_by'),'-publishedAt',`${JSON.stringify(input)} 不该被当成浏览态去改写排序`);
  }
  // 自己勾了精选：仍然按他的排序来（没关键词时是热门），我们不再往上加「最新」。
  const own=await sketchfabUrl({staffpicked:true});
  assert.equal(own.searchParams.get('sort_by'),'-likeCount');
  // 用户自己点「最新发布」当然还是最新：这条要按他给的排序走，而非我们替他选的浏览态。
  assert.equal((await sketchfabUrl({sort:'newest'})).searchParams.get('sort_by'),'-publishedAt');
});

test('ArtStation browsing gives editor picks by newest',()=>{
  // 前端每次都会把控件现值一起送来 —— 这就是真实调用形状，必须仍然被认成浏览态。
  const live=artSearchParams({q:'',sort:'relevance',picked:false,assetType:'marmoset'});
  assert.equal(live.sort,'newest');
  assert.equal(live.picked,true);
  assert.equal(artSearchParams({}).picked,true);
  // 关键词、分类、非默认排序、勾了精选、非默认分面：任一条用户提过，就一律按他说的来。
  // （「相关度 + 不勾精选 + 默认分面」与「什么都没动」在值上无法区分，这就是浏览态本身 ——
  //   无关键词时「相关度」本来也没有意义，服务端过去同样会把它换成别的排序。）
  assert.deepEqual(artSearchParams({q:'chair'}),{q:'chair',sort:'relevance',category:'',picked:false,assetType:'marmoset'});
  for(const input of [{sort:'popular'},{picked:true},{category:'21'},{assetType:'pano'},{assetType:''}]){
    const params=artSearchParams(input);
    assert.equal(params.picked,input.picked===true,`${JSON.stringify(input)} 不该被注入精选`);
    assert.equal(params.sort,input.sort||'relevance',`${JSON.stringify(input)} 不该被改写排序`);
  }
});

test('daily topics: stable within a day, rotating across days, first one is today',()=>{
  const day=new Date(2026,9,16);
  const a=dailyTopics(day),again=dailyTopics(new Date(2026,9,16,23,59));
  assert.deepEqual(a,again,'同一天任何时刻都是同一组（刷新、切标签页都不该跳）');
  assert.equal(a.length,TOPIC_COUNT);
  assert.equal(a[0].today,true);
  assert.equal(a.slice(1).some(topic=>topic.today),false,'只有第一个是今日主题');
  assert.ok(a.every(topic=>TOPICS.includes(topic.en)),'推荐词必须来自词池');
  assert.equal(new Set(a.map(topic=>topic.en)).size,a.length,'一行里不能出现重复词');

  const tomorrow=dailyTopics(new Date(2026,9,17));
  assert.notDeepEqual(tomorrow.map(topic=>topic.en),a.map(topic=>topic.en),'跨天要换一批');
  assert.equal(tomorrow[0].en,a[1].en,'只推进一格：今天排第二的词就是明天的今日主题');
});

test('daily topics live in the grouped search popover, not a permanent strip',()=>{
 const groups=read('src/library/term-groups.js');
 const ui=read('src/library/search-history.js');
 assert.equal(html.includes('id="topic-strip"'),false,'常驻主题带已收进检索浮层');
 assert.ok(app.includes('function termSources'),'主题 / 相近词由 app.js 整理成一份数据');
 assert.ok(app.includes('dailyTopics()'),'今日主题仍取自每日词池');
 assert.ok(app.includes('sources:termSources'),'浮层通过 provider 拿词组，不自己算主题');
 assert.ok(app.includes('onTerm:pickTerm'),'点任一推荐词走统一检索入口');
 assert.ok(app.includes("startSearch({record:true})"),'点主题等同用户手输，要记进最近检索');
 assert.ok(app.includes('refreshTopicStrip();'),'改输入框 / 提交搜索时刷新浮层');
 for(const id of ['recent','links','daily','related'])assert.ok(groups.includes(`id:'${id}'`),`分组契约里要有 ${id}`);
 assert.ok(ui.includes('buildTermSections'),'渲染层按契约分区，不写 if-else 长龙');
 assert.ok(/\.term-chip\.today\{/.test(css),'今日主题要有高亮样式');
 assert.ok(/\.term-badge\{/.test(css),'首颗主题要带「今日」徽标');
});

test('capability bit and version bump so the launcher replaces the old process',()=>{
  assert.equal(SERVER_CAPABILITIES.browseFeaturedDaily,true);
  // 版本只升不降：写死具体版本会让每次加能力位（3.12.0 → 3.13.0）都误报。
  const [major,minor]=SERVER_VERSION.split('.').map(Number);
  assert.ok(major===3&&minor>=12,`SERVER_VERSION 必须 >= 3.12.0，实际 ${SERVER_VERSION}`);
  assert.equal(SERVER_CAPABILITIES.version,SERVER_VERSION,'能力位里的版本必须与 SERVER_VERSION 同源');
});
