import test from 'node:test';
import assert from 'node:assert/strict';
import {PLATFORMS,DEFAULT_PLATFORM,platformById,routeLink,LINK_ROUTES,FEEDS,FEED_LABELS,FEED_ENDPOINTS,ORIGIN_COPY,jobKindOf,isPictureSite,isUiSite} from '../src/library/platforms.js';

test('the feed registry is the single place a new result stream is declared',()=>{
 assert.equal(new Set(FEEDS).size,FEEDS.length,'结果流不能重复');
 for(const mode of FEEDS){
  assert.ok(FEED_LABELS[mode],`${mode} 缺少状态行用的名字`);
  assert.match(FEED_ENDPOINTS[mode],/^\/api\//,`${mode} 缺少接口地址`);
 }
});

test('every platform declares the feeds and copy the UI needs',()=>{
 const ids=PLATFORMS.map(platform=>platform.id);
 assert.equal(new Set(ids).size,ids.length,'平台 id 不能重复');
 assert.ok(ids.includes(DEFAULT_PLATFORM),'默认平台必须是注册表里的一个');
 for(const platform of PLATFORMS){
  assert.ok(platform.feeds.length>0,`${platform.id} 至少要有一个结果流`);
  for(const mode of platform.feeds)assert.ok(FEEDS.includes(mode),`${platform.id} 引用了未注册的结果流 ${mode}`);
  assert.equal(typeof platform.placeholder,'string');
  assert.ok(platform.suggestions.every(([q,label])=>q&&label),`${platform.id} 的推荐词必须成对`);
  if(platform.id!==DEFAULT_PLATFORM)assert.ok(ORIGIN_COPY[platform.id],`${platform.id} 缺少「还没检索时」的副标题措辞`);
 }
});

test('the all-platform entry is the only one that answers with more than one feed',()=>{
 const multi=PLATFORMS.filter(platform=>platform.feeds.length>1).map(platform=>platform.id);
 assert.deepEqual(multi,[DEFAULT_PLATFORM],'只有「全部平台」该同时驱动多个流');
 // 全部平台只有一棵统一树：两平台共用一套分类/排序/范围，所以这里只声明 #filters-merged；
 // 单平台仍然只声明自己那一组（切过去就能按平台自己的分类体系精细筛）。
 const all=platformById(DEFAULT_PLATFORM);
 assert.deepEqual(all.filters,['filters-merged'],'全平台的筛选要收成统一树这一棵');
 assert.match(all.note,/统一/,'说明行要讲清「统一分类同时作用于两个平台」');
 assert.match(all.note,/ArtStation/,'说明行要交代 A 站没有对应的分类本轮只检索 Sketchfab');
 for(const platform of PLATFORMS.filter(p=>p.id!==DEFAULT_PLATFORM)){
  // 没有筛选树的平台（目前是 Poly Haven）声明 null，页面会整行隐藏而不是去找一个不存在的节点。
  if(platform.filters===null)continue;
  assert.equal(platform.filters,`filters-${platform.id}`,`${platform.id} 只该声明自己的筛选行`);
 }
});

test('an unknown platform id falls back to the default instead of breaking the page',()=>{
 assert.equal(platformById('nope').id,DEFAULT_PLATFORM);
 assert.equal(platformById(undefined).id,DEFAULT_PLATFORM);
 assert.equal(platformById('artstation').id,'artstation');
});

test('a pasted ArtStation artwork link is recognised as an artwork, not as a page to scan',()=>{
 const route=routeLink('https://www.artstation.com/artwork/lEVE8J');
 assert.equal(route.platform,'artstation');
 assert.equal(route.label,'ArtStation 作品页');
});

test('a link that only looks like ArtStation is not treated as one',()=>{
 for(const url of ['https://artstation.com.evil.example/artwork/1','https://not-artstation.com/artwork/1','https://artstation.com/artworkish/1']){
  assert.equal(routeLink(url).platform,'web',`${url} 不该被判定成 ArtStation 作品页`);
 }
});

test('a Sketchfab link and any other page both reach the page reader, with the kind named',()=>{
 assert.equal(routeLink('https://sketchfab.com/3d-models/thing-abc123').platform,'web');
 assert.equal(routeLink('https://sketchfab.com/patrix').label,'Sketchfab 作者','裸作者页有专属分类，用户才知道拿到的是该作者的全部模型');
 assert.equal(routeLink('https://sketchfab.com/patrix/models').label,'Sketchfab 作者','作者模型页同样算作者页');
 assert.equal(routeLink('https://example.com/gallery').label,'普通网页');
});

test('bad input is refused with a reason instead of being sent to the server',()=>{
 assert.ok(routeLink('').error);
 assert.ok(routeLink('   ').error);
 assert.ok(routeLink('not a url').error);
 assert.ok(routeLink('ftp://example.com/x').error,'只支持 http(s)');
 assert.equal(routeLink('https://example.com/x').error,undefined);
});

test('every link rule names a platform the search already understands',()=>{
 for(const rule of LINK_ROUTES){
  // 图站 / 视频站的路由本来就在这张表里（PICTURE_LINK_ROUTES 展开进来），
  // 它们由 /api/picture-site/resolve 承接，不是「未知通道」。
  const known=['artstation','web','link'].includes(rule.platform)||isPictureSite(rule.platform)||isUiSite(rule.platform);
  assert.ok(known,`${rule.id} 指向了未知通道 ${rule.platform}`);
  assert.equal(typeof rule.test,'function');
 }
});

test('jobKindOf maps a model batch to one download kind, splitting mixed platforms',()=>{
 assert.equal(jobKindOf([{platform:'sketchfab'}]),'sketchfab');
 assert.equal(jobKindOf([{platform:'sketchfab'},{platform:'sketchfab'}]),'sketchfab');
 assert.equal(jobKindOf([{platform:'polyhaven',assetId:'X'}]),'polyhaven');
 assert.equal(jobKindOf([{platform:'artstation',artworkUrl:'https://www.artstation.com/artwork/abc'}]),'artstation');
 // 历史 Sketchfab 模型没有 platform 字段：缺省即 Sketchfab，不能误判成「混合平台」。
 assert.equal(jobKindOf([{uid:'abc'}]),'sketchfab');
 // 混合平台（不同源）必须拒绝，逼用户分批次 —— 否则 Poly Haven 的 md5 uid 会被后端当 Sketchfab 处理。
 assert.equal(jobKindOf([{platform:'sketchfab'},{platform:'polyhaven',assetId:'X'}]),null);
 assert.equal(jobKindOf([{platform:'artstation'},{platform:'polyhaven',assetId:'X'}]),null);
});
