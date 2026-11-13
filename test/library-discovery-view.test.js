import test from 'node:test';
import assert from 'node:assert/strict';
import {interleave,combine,statusText,subtitleText,pageInfoNote,loadMoreLabel,describeRequest,feedErrorMessage,SOURCE_LABELS} from '../src/library/discovery-view.js';

const feed=({rows=[],busy=false,error=false,status='',next=null,pending=[],pages=1,warnings=[],request=null}={})=>({rows,busy,error,status,next,pending,pages,warnings,request,controller:{abort:()=>{}}});

test('interleave alternates platforms instead of concatenating them',()=>{
 assert.deepEqual(interleave([['s1','s2','s3'],['a1','a2']]),['s1','a1','s2','a2','s3']);
 assert.deepEqual(interleave([['only']]),['only']);
 assert.deepEqual(interleave([[],[]]),[]);
});

test('a single source is passed through untouched so cursor state survives',()=>{
 const source=feed({rows:['m'],next:'https://api/cursor',request:{q:'robot'},controller:{abort(){}}});
 const merged=combine({sources:['search'],feeds:{search:source}});
 assert.equal(merged.request,source.request,'单源必须保留 request，分页要靠它');
 assert.equal(merged.next,'https://api/cursor');
 assert.deepEqual(merged.sources,['search']);
});

test('several sources merge into one projection: any busy, all failed, max page, union warnings',()=>{
 const merged=combine({sources:['search','art'],feeds:{
  search:feed({rows:['s1','s2'],busy:true,error:false,pages:2,pending:['p1'],warnings:['w1','w2']}),
  art:feed({rows:['a1'],busy:false,error:true,pages:1,pending:[],warnings:['w2','w3']}),
 }});
 assert.deepEqual(merged.rows,['s1','a1','s2'],'两个平台的结果必须交错，否则一个平台会沉底');
 assert.equal(merged.busy,true,'只要有一个源在跑，界面就该显示进行中');
 assert.equal(merged.error,false,'只有一个源失败不算整体失败');
 assert.equal(merged.pages,2,'页码取最靠前的那个源');
 assert.deepEqual(merged.pending,['p1']);
 assert.deepEqual(merged.warnings,['w1','w2','w3'],'提示要合并去重，不能只报第一个平台的');
 assert.deepEqual(merged.sources,['search','art']);
});

test('every source failing is what turns the status line red',()=>{
 const merged=combine({sources:['search','art'],feeds:{search:feed({error:true}),art:feed({error:true})}});
 assert.equal(merged.error,true);
});

test('aborting a multi-source view aborts each source it represents',()=>{
 const aborted=[];
 const view=combine({sources:['search','art'],feeds:{
  search:{...feed(),controller:{abort:()=>aborted.push('search')}},
  art:{...feed(),controller:{abort:()=>aborted.push('art')}},
 }});
 view.controller.abort();
 assert.deepEqual(aborted,['search','art'],'停止检索必须真的停掉每个平台，不能只停第一个');
});

test('图站平台上的空结果流要说清「能搜」还是「只能粘链接」',()=>{
 // 小红书这类站 search:true —— 只说「按链接解析」会让用户以为它搜不了关键词（展示区过去就是这么写的）。
 assert.match(statusText({sources:[],feeds:{},platform:'xiaohongshu'}),/输入关键词/,'可搜的图站必须先说搜索');
 assert.ok(!statusText({sources:[],feeds:{},platform:'xiaohongshu'}).includes('按链接解析'));
 // Pixiv 不做关键词检索：只能说粘链接，不能给一个搜不动的预期。
 assert.match(statusText({sources:[],feeds:{},platform:'pixiv'}),/按链接解析/);
 assert.ok(!statusText({sources:[],feeds:{},platform:'pixiv'}).includes('输入关键词'));
});

test('the status line names each platform when more than one is answering',()=>{
 assert.equal(statusText({sources:['search'],feeds:{search:feed({status:'已加载 3 个模型'})}}),'已加载 3 个模型');
 assert.equal(statusText({sources:['search'],feeds:{search:feed()}}).includes('关键词直接搜索'),true,'单源空闲时要有默认引导');
 const both=statusText({sources:['search','art'],feeds:{search:feed({busy:true}),art:feed({status:'已加载 4 个'})}});
 assert.ok(both.includes(`${SOURCE_LABELS.search}：检索中`),'正在检索的源要标出来');
 assert.ok(both.includes(`${SOURCE_LABELS.art}：已加载 4 个`),'空闲的源要报自己的结果');
});

test('the subtitle reports per-platform counts so a global search never looks single-sourced',()=>{
 const text=subtitleText({source:'search',platform:'all',feeds:{search:feed({rows:[1,2],request:{q:'robot'}}),art:feed({rows:[3],request:{q:'robot'}}),web:feed()},count:3,pages:1,request:null,categories:[]});
 assert.ok(text.includes('Sketchfab 2 个')&&text.includes('ArtStation 1 个'),`实际：${text}`);
 assert.ok(!text.includes('链接解析'),'没用过的链接流不该出现在统计里');
});

test('a single platform keeps its own wording and category label',()=>{
 const categories=[['characters-creatures','角色与生物']];
 const art=subtitleText({source:'search',platform:'artstation',feeds:{},count:12,pages:3,request:{q:'props'},categories});
 assert.ok(art.includes('12 个 Marmoset 作品')&&art.includes('第 3 页'),`实际：${art}`);
 const sketchfab=subtitleText({source:'search',platform:'sketchfab',feeds:{},count:24,pages:1,request:{q:'',category:'characters-creatures'},categories});
 assert.ok(sketchfab.includes('24 个公开模型')&&sketchfab.includes('角色与生物'),`实际：${sketchfab}`);
});

test('a link parse says so instead of pretending to be a platform search',()=>{
 assert.ok(subtitleText({source:'link',platform:'sketchfab',feeds:{},count:5,pages:1,request:{url:'https://x'},categories:[]}).includes('从这个链接解析出 5 个资产'));
 // 副标题必须写明「不自动下载」：粘贴链接只出卡片，下载是主人点卡片上的键才发生的。
 assert.ok(subtitleText({source:'link',platform:'sketchfab',feeds:{},count:5,pages:1,request:{url:'https://x'},categories:[]}).includes('不会自动下载'));
 assert.ok(subtitleText({source:'link',platform:'all',feeds:{},count:0,pages:0,request:null,categories:[]}).includes('正在解析'));
});

test('pager wording follows what is actually being paged',()=>{
 assert.equal(loadMoreLabel({source:'link',platform:'all'}),'解析下一页');
 assert.equal(loadMoreLabel({source:'search',platform:'artstation'}),'加载更多 Marmoset 作品');
 assert.equal(loadMoreLabel({source:'search',platform:'all'}),'加载更多（两个平台）');
 assert.equal(loadMoreLabel({source:'search',platform:'sketchfab'}),'加载更多资产');
 assert.equal(pageInfoNote({source:'link',platform:'sketchfab'}),'链接解析结果');
 assert.ok(pageInfoNote({source:'search',platform:'all'}).includes('两个平台合计'));
});

test('标题的那句话跟着「谁在回答」走，链接解析结果不冒充任何平台',()=>{
 const feeds={search:feed({rows:['s'],request:{q:'robot'}}),art:feed({rows:['a'],request:{q:'hero'}})};
 const describeArt=request=>'ArtStation 描述 '+(request?.q||'无关键词');
 const base={source:'search',platform:'all',feeds,categories:[],describeArt};
 assert.equal(describeRequest({...base,source:'link'}),'链接解析结果','链接解析结果不属于任何平台流');
 assert.equal(describeRequest({...base,platform:'artstation'}),'ArtStation 描述 hero','ArtStation 用自己那套描述器');
 assert.equal(describeRequest(base),'“robot” 的跨平台结果');
 assert.equal(describeRequest({...base,feeds:{search:feed(),art:feed()}}),'最新精选','没搜过时给的是平台的「最新精选」流，不再是固定的热门榜');
 assert.equal(describeRequest({...base,platform:'sketchfab'}),'“robot” 的搜索结果');
 assert.equal(describeRequest({...base,platform:'sketchfab',feeds:{search:feed()}}),'发现好模型');
 assert.equal(describeRequest({...base,platform:'sketchfab',feeds:{search:feed({request:{category:'characters-creatures'}})},categories:[['characters-creatures','角色与生物']]}),'角色与生物资产');
 assert.equal(describeRequest({...base,platform:'sketchfab',feeds:{search:feed({request:{staffpicked:true}})}}),'精选资产');
 assert.equal(describeRequest({...base,platform:'sketchfab',feeds:{search:feed({request:{category:'unknown'}})}}),'分类资产','分类标签尚未加载时不显示 undefined');
});

test('一次失败的检索要把用户送到下一步，而不是复述服务端内部文案',()=>{
 // 后台服务是旧版本时，前端会打到一个服务端还不认识的接口，回的就是这句 404 原文。
 // 照抄给用户等于把内部实现漏出去，而且没有出路——他不知道该去做什么。
 const stale=feedErrorMessage({mode:'polyhaven',status:404,error:'不存在的页面或接口'});
 assert.equal(stale.includes('不存在的页面或接口'),false,'不能把服务端内部文案照抄给用户');
 assert.match(stale,/Poly Haven/,'要说清是哪个来源没被支持');
 assert.match(stale,/重新打开 AssetVault/,'要给出可照做的下一步');
 // 其它失败照旧透出服务端给的原因；没有原因时兜底带上状态码，不能显示空白。
 assert.equal(feedErrorMessage({mode:'search',status:500,error:'上游超时'}),'上游超时');
 assert.equal(feedErrorMessage({mode:'search',status:502}),'检索失败 HTTP 502');
 assert.equal(feedErrorMessage({mode:'art',status:503,error:''}),'检索失败 HTTP 503');
});
