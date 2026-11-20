import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscoveryFeed,cancelPictureRequests,rememberPictureSnapshot,restorePictureSnapshot,resetDiscoveryFeeds} from '../src/library/discovery-feed.js';
import {mergePicturePage,PICTURE_FIRST_PAGE} from '../src/library/picture-page.js';
const response=data=>({ok:true,json:async()=>data});
function harness(){
 const state={route:'discover',platform:'wallhaven',source:'search',selected:new Set(),history:[],feeds:{}};
 const input={value:''};let renders=0,statusUpdates=0;
 const feed=createDiscoveryFeed({$:()=>input,state,toast:()=>{},persist:()=>{},renderGrid:()=>renders++,refreshPictureStatus:()=>statusUpdates++,mergeModels:()=>{},describeArt:()=>'',activeModes:()=>[],showsFeed:()=>false,searchHistoryUI:()=>({refresh(){}}),routeTo:name=>state.route=name,adoptPlatform:id=>state.platform=id});
 return {state,feed,renders:()=>renders,statusUpdates:()=>statusUpdates};
}

test('关注续页按用户ID去重并保留下一页状态',()=>{
 const ps={mode:'boards',boards:[{id:'one',url:'one'}],limit:24};
 const fresh=mergePicturePage(ps,{boards:[{id:'one',url:'one?new-token'},{id:'two',url:'two'}],truncated:true,personalPaging:1},84);
 assert.equal(fresh.length,1);assert.equal(ps.boards.length,2);assert.equal(ps.limit,84);assert.equal(ps.truncated,true);
});

test('赞过续页出现新点赞时按新前缀更新，不能把最新点赞追加到最后',()=>{
 const ps={platform:'xiaohongshu',items:[{key:'old',url:'old.jpg'},{key:'older',url:'older.jpg'}]};
 mergePicturePage(ps,{items:[{key:'new',url:'new.jpg'},...ps.items],order:'liked-desc',truncated:false},84);
 assert.deepEqual(ps.items.map(item=>item.key),['new','old','older']);
});

test('旧的20人个人列表缓存先展示后重新请求，不再被当成已加载完',async t=>{
 const {state,feed}=harness();const url='https://www.xiaohongshu.com/user/following?paging-regression=1';
 rememberPictureSnapshot({platform:'xiaohongshu',url,mode:'boards',boards:[{id:'old',url:'old'}],items:[],limit:24,truncated:false});
 let calls=0;
 t.mock.method(globalThis,'fetch',async request=>{calls++;assert.match(request,/refresh=1/);return response({mode:'boards',boards:[{id:'new',url:'new'}],items:[],truncated:true,personalPaging:1});});
 await feed.openPictureAuthor(url,'xiaohongshu');
 assert.equal(calls,1);assert.equal(state.pictureSite.personalPaging,1);assert.equal(state.pictureSite.boards[0].id,'new');
 await feed.openPictureAuthor(url,'xiaohongshu');assert.equal(calls,1);
});
test('new picture queries abort old fetches and stale results cannot replace the active view',async t=>{
 const {state,feed}=harness();const requests=[];
 t.mock.method(globalThis,'fetch',(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})));
 const old=feed.openPictureUrl('https://wallhaven.cc/search?q=old','wallhaven');
 const current=feed.openPictureUrl('https://wallhaven.cc/search?q=new','wallhaven');
 assert.equal(requests[0].options.signal.aborted,true);assert.ok(requests[1].url.includes(`limit=${PICTURE_FIRST_PAGE}`));
 requests[1].resolve(response({items:[{url:'new.jpg'}],truncated:true}));await current;
 requests[0].resolve(response({items:[{url:'old.jpg'}]}));await old;
 assert.equal(state.pictureSite.items[0].url,'new.jpg');assert.equal(state.pictureSite.busy,false);
});
test('resetting navigation aborts first/next requests without an error or retry',async t=>{
 const {state,feed}=harness();let calls=0;
 t.mock.method(globalThis,'fetch',(url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
 const pending=feed.openPictureUrl('https://wallhaven.cc/search?q=cancel','wallhaven');
 const more=new AbortController();state.pictureSite.moreController=more;
 resetDiscoveryFeeds(state);await pending;
 assert.equal(more.signal.aborted,true);assert.equal(state.pictureSite,null);assert.equal(calls,1);
});
test('warm picture snapshots retain appended items and limit without another request',async t=>{
 const {state,feed}=harness();const ps={platform:'wallhaven',url:'https://wallhaven.cc/search?q=cached',items:[{url:'one.jpg'},{url:'two.jpg'}],boards:[],limit:84,truncated:true,scrollTop:500};
 rememberPictureSnapshot(ps);let requests=0;t.mock.method(globalThis,'fetch',async()=>{requests++;throw Error('must use cache');});
 await feed.openPictureAuthor(ps.url,'wallhaven');
 assert.equal(requests,0);assert.equal(state.pictureSite.items.length,2);assert.equal(state.pictureSite.limit,84);assert.equal(state.pictureSite.scrollTop,500);assert.equal(restorePictureSnapshot('wallhaven').limit,84);
});
test('a temporary empty continuation preserves more state and retries the same limit',()=>{
 const ps={items:[{url:'a'}],limit:24,truncated:true};
 assert.deepEqual(mergePicturePage(ps,{items:[{url:'a'}],truncated:true,total:0},84),[]);
 assert.equal(ps.truncated,true);assert.equal(ps.limit,24);
 const fresh=mergePicturePage(ps,{items:[{url:'a'},{url:'b'},{url:'b'}],truncated:true},84);
 assert.equal(fresh.length,1);assert.equal(ps.limit,84);assert.equal(ps.items.length,2);
 mergePicturePage(ps,{items:ps.items,truncated:false,total:2},144);assert.equal(ps.truncated,false);assert.equal(ps.total,2);
});

test('refreshing a browsed picture window retains its extent and persisted scroll',async t=>{
 for(const changed of [false,true]){
  const {state,feed}=harness();const url=`https://wallhaven.cc/search?q=refresh-${changed}`;
  const items=Array.from({length:84},(_,i)=>({url:`https://img.test/${i}.jpg`}));
  rememberPictureSnapshot({platform:'wallhaven',url,items,limit:84,truncated:true,scrollTop:900});
  let requestedLimit;
  const updated=changed?[...items.slice(0,-1),{url:'https://img.test/new.jpg'}]:items;
  t.mock.method(globalThis,'fetch',async request=>{requestedLimit=Number(new URL(request,'https://local.test').searchParams.get('limit'));return response({items:updated,truncated:true});});
  await feed.openPictureUrl(url,'wallhaven');
  assert.equal(requestedLimit,84);assert.equal(state.pictureSite.items.length,84);assert.equal(state.pictureSite.limit,84);
  assert.equal(state.pictureSite.scrollTop,900);assert.equal(restorePictureSnapshot('wallhaven').scrollTop,900);
  assert.equal(state.pictureSite.items.at(-1).url,updated.at(-1).url);
 }
});

test('visiting and saving an expired snapshot cannot extend its response freshness',async t=>{
 const {state,feed}=harness();const url='https://wallhaven.cc/search?q=expired';
 const fetchedAt=Date.now()-11*60*1000;
 rememberPictureSnapshot({platform:'wallhaven',url,items:[{url:'old.jpg'}],limit:24,fetchedAt});
 state.pictureSite=restorePictureSnapshot('wallhaven');cancelPictureRequests(state);
 assert.equal(restorePictureSnapshot('wallhaven').fetchedAt,fetchedAt);
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return response({items:[{url:'fresh.jpg'}],truncated:false});});
 await feed.openPictureHome('wallhaven');
 assert.equal(calls,1);assert.equal(state.pictureSite.items[0].url,'fresh.jpg');
 assert.ok(state.pictureSite.fetchedAt>fetchedAt);
});

test('unchanged cards update paging metadata without a second refresh redraw; changed covers redraw',async t=>{
 const h=harness();const url='https://wallhaven.cc/search?q=metadata';let thumb='one.jpg',total=100;
 t.mock.method(globalThis,'fetch',async()=>response({items:[{url:'image.jpg',thumb}],truncated:true,total}));
 await h.feed.openPictureUrl(url,'wallhaven');
 const before=h.renders();total=120;
 await h.feed.openPictureUrl(url,'wallhaven');
 assert.equal(h.renders(),before+1);assert.equal(h.state.pictureSite.total,120);assert.ok(h.statusUpdates()>0);
 const stable=h.renders();thumb='two.jpg';
 await h.feed.openPictureUrl(url,'wallhaven');
 assert.equal(h.renders(),stable+2);assert.equal(h.state.pictureSite.items[0].thumb,'two.jpg');
});

test('continuation clears stale totals and carries a recoverable crawl warning',()=>{
 const ps={items:[{url:'a'}],total:300,limit:24};
 mergePicturePage(ps,{items:ps.items,truncated:true,total:0,warning:'upstream failed'},84);
 assert.equal(ps.total,0);assert.equal(ps.warning,'upstream failed');assert.equal(ps.limit,24);
 mergePicturePage(ps,{items:[{url:'a'},{url:'b'}],truncated:false,total:2},84);
 assert.equal(ps.warning,'');assert.equal(ps.total,2);
});

test('page exit flushes the latest scroll synchronously and clips large persisted windows safely',t=>{
 const previous={document:globalThis.document,localStorage:globalThis.localStorage,requestAnimationFrame:globalThis.requestAnimationFrame};
 t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
 let saved,restored;const scroller={scrollTop:1200,scrollTo:options=>restored=options.top};
 globalThis.document={getElementById:()=>scroller};
 globalThis.localStorage={setItem:(key,value)=>saved=JSON.parse(value)};
 globalThis.requestAnimationFrame=run=>run();
 const {state,feed}=harness();const url='https://wallhaven.cc/search?q=page-exit';
 state.pictureSite={platform:'wallhaven',url,items:[{url:'one.jpg'}],limit:24,truncated:true,scrollTop:600};
 feed.restorePictureScroll();assert.equal(restored,600);
 feed.savePictureSession();
 let entry=saved.find(item=>item.url===url);assert.equal(entry.data.scrollTop,1200);assert.equal(entry.data.items.length,1);assert.equal(entry.data.moreController,undefined);
 state.pictureSite.items=Array.from({length:300},(_,i)=>({url:`${i}.jpg`}));state.pictureSite.limit=324;
 feed.savePictureSession();entry=saved.find(item=>item.url===url);
 assert.equal(entry.data.items.length,240);assert.equal(entry.data.limit,240);assert.equal(entry.data.scrollTop,0);assert.equal(entry.data.truncated,true);
});

test('snapshots saved in the same millisecond restore the last visited result',t=>{
 t.mock.method(Date,'now',()=>2000000000000);
 for(const name of ['same-time-first','same-time-last'])rememberPictureSnapshot({platform:'wallhaven',url:name,items:[{url:name}]});
 assert.equal(restorePictureSnapshot('wallhaven').url,'same-time-last');
});
