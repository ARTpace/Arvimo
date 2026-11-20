import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVideoSearch,videoResult,videoSearchUrl,searchVideo} from '../server/video-search.mjs';
import {resolveShortVideo} from '../server/short-videos.mjs';
import {pictureSiteSearchable,platformsForMode} from '../src/library/platforms.js';
import {createLibraryServer} from '../server/library.mjs';

const platforms=['douyin','kuaishou','bilibili','weibo'];
const id='7706103790805707697';
test('video search is declared on each platform and receives keywords rather than URL validation',async()=>{
 for(const platform of platforms){
  assert.ok(pictureSiteSearchable(platform));assert.ok(platformsForMode('video').some(p=>p.id===platform));
  const query='模型 & Blender 中文';let called=false;
  const result=await resolveShortVideo(platform,query,{search:async(p,q)=>{called=true;assert.equal(p,platform);assert.equal(q,query);return {items:[]};}});assert.ok(called);assert.deepEqual(result.items,[]);
  assert.ok(videoSearchUrl(platform,query).includes(encodeURIComponent(query)));
 }
});
test('source APIs normalize to lazy result cards without confusing artwork links and media files',()=>{
 const examples={
  douyin:{data:[{aweme_info:{aweme_id:id,desc:'作品',video:{cover:{url_list:['https://p3.douyinpic.com/a.jpg']}},author:{nickname:'作者'}}}]},
  kuaishou:{data:{visionSearchPhoto:{feeds:[{photo:{id:'3xexample',caption:'作品',coverUrl:'https://a.yximgs.com/a.jpg'},author:{name:'作者'}}]}}},
  bilibili:{data:{result:[{bvid:'BV1example',title:'<em class="keyword">作品</em>',pic:'//i0.hdslb.com/a.jpg',author:'作者'}]}},
  weibo:{data:{cards:[{mblog:{text:'作品',user:{screen_name:'作者'},page_info:{type:'video',object_id:'1034:12345',page_pic:{url:'https://a.sinaimg.cn/a.jpg'}}}}]}},
 };
 for(const platform of platforms){const results=parseVideoSearch(platform,examples[platform]);assert.equal(results.length,1,platform);assert.equal(results[0].title,'作品');assert.equal(results[0].author,'作者');assert.equal(results[0].type,'video');assert.equal(results[0].url,'');assert.match(results[0].pageUrl,/https:/);}
 const bad=videoResult('bilibili',{pageUrl:'https://bilibili.com.evil.test/video/BVexample',title:'bad'});assert.equal(bad,null);
 assert.equal(videoResult('douyin',{pageUrl:'http://127.0.0.1/video/'+id}),null);
});
test('Bilibili public search results return immediately without starting a browser',async()=>{
 const result=await searchVideo('bilibili','Blender',{read:async url=>{assert.equal(new URL(url).searchParams.get('keyword'),'Blender');return {status:200,body:Buffer.from(JSON.stringify({data:{result:[{bvid:'BV1example',title:'Blender'}]}}))};},watch:()=>{throw Error('browser should not run');}});
 assert.equal(result.search,true);assert.equal(result.items.length,1);assert.equal(result.source,'Blender');
});
test('browser fallback reads normal signed page responses and removes listeners',async()=>{
 const listeners=new Map(),requests=[];
 const page={on:(event,handler)=>{listeners.set(event,handler);return ()=>listeners.delete(event);},send:async(method,args)=>{
  requests.push({method,args});
  if(method==='Page.navigate'){listeners.get('Network.responseReceived')({requestId:'r1',response:{status:200,url:'https://www.douyin.com/aweme/v1/web/general/search/single/'}});listeners.get('Network.loadingFinished')({requestId:'r1',encodedDataLength:500});return {};}
  if(method==='Network.getResponseBody')return {body:JSON.stringify({data:[{aweme_info:{aweme_id:id,desc:'作品',video:{}}}]})};
  if(method==='Runtime.evaluate')return {result:{value:{cards:[],body:''}}};
 }};
 const result=await searchVideo('douyin','Blender',{watch:handler=>handler(page),waitMs:1000});assert.equal(result.items[0].title,'作品');assert.equal(listeners.size,0);assert.ok(requests.some(r=>r.method==='Page.navigate'));
});
test('browser DOM fallback validates and deduplicates source links',async()=>{
 const card={pageUrl:'https://www.kuaishou.com/short-video/3xexample?tracking=1',title:'Blender'};
 const page={on:()=>()=>{},send:async method=>method==='Runtime.evaluate'?{result:{value:{cards:[card,card,{pageUrl:'https://evil.test/short-video/3xexample'}]}}}:{}};
 const result=await searchVideo('kuaishou','Blender',{watch:handler=>handler(page),waitMs:100});assert.equal(result.items.length,1);assert.equal(result.items[0].pageUrl,'https://www.kuaishou.com/short-video/3xexample');
});
test('login walls fail clearly rather than returning an empty successful search',async()=>{
 let removed=0;const page={on:()=>()=>removed++,send:async method=>method==='Runtime.evaluate'?{result:{value:{cards:[],body:'请登录后完成验证码'}}}:{}};
 await assert.rejects(searchVideo('douyin','Blender',{watch:handler=>handler(page),waitMs:5}),/搜索需要登录或验证/);assert.equal(removed,2);
});
test('the existing resolve HTTP route exposes keyword search and individual download links',async()=>{
 const server=createLibraryServer({collect:false,pictureCollect:async(platform,{url})=>resolveShortVideo(platform,url,{search:async()=>({title:'搜索',search:true,items:[{type:'video',url:'',pageUrl:'https://www.bilibili.com/video/BV1example',title:'作品'}]})})});
 try{await new Promise(r=>server.listen(0,'127.0.0.1',r));const r=await fetch(`http://127.0.0.1:${server.address().port}/api/picture-site/resolve?`+new URLSearchParams({platform:'bilibili',url:'Blender'}),{headers:{'X-SFX-Local':'1'}});assert.equal(r.status,200);const body=await r.json();assert.equal(body.items[0].pageUrl,'https://www.bilibili.com/video/BV1example');assert.equal(body.items[0].url,'');}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
