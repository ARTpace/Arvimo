import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {parseXhsNote,parseXhsApiItems,xhsVideoSources} from '../server/xhs-state.mjs';

const id='a'.repeat(24);
const main='https://sns-video-bd.xhscdn.com/202611201234/aabb/stream.mp4?sign=a%2Fb&key=1';
const backup='https://sns-video-qc.xhscdn.com/202611201234/aabb/backup.mp4?sign=keep';
const note=video=>({note:{noteDetailMap:{[id]:{note:{noteId:id,type:'video',title:'video',imageList:[{url:'https://sns-img-qc.xhscdn.com/cover.jpg'}],video}}}}});
const video={media:{stream:{h265:[{masterUrl:'https://sns-video-bd.xhscdn.com/hevc.mp4',avgBitrate:9000}],h264:[{masterUrl:main,backupUrls:[backup,main],avgBitrate:1000}]}},consumer:{originVideoKey:'original.mp4'}};

test('blob播放器从实际MP4响应补齐视频，错误笔记页面不能挂入视频',async()=>{
 const source=readFileSync(new URL('../server/xhs-browser.mjs',import.meta.url),'utf8');
 for(const matches of [true,false]){
  const {document}=parseHTML('<html><body><h1 id="detail-title">视频标题</h1><video src="blob:current"></video></body></html>');
  for(const node of document.querySelectorAll('*'))node.getClientRects=()=>[{}];
  let listener;
  const page={on:(_,fn)=>{listener=fn;return ()=>{};},send:async(command,args)=>{
   if(command==='Page.navigate'){listener({response:{url:main,status:206,mimeType:'video/mp4'}});return {};}
   if(command==='Runtime.evaluate')return {result:{value:vm.runInNewContext(args.expression,{document,window:{__INITIAL_STATE__:note({})},location:{pathname:'/explore/'+(matches?id:'b'.repeat(24))}})}};
   return {};
  }};
  const context=vm.createContext({parseXhsNote,watchPage:fn=>fn(page),Date,setTimeout,console});
  vm.runInContext(source.replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'')+';this.capture=xhsBrowserCapture;',context);
  const result=await context.capture({url:'https://www.xiaohongshu.com/explore/'+id,kind:'note',noteId:id});
  assert.equal(result.note.videoUrl,matches?main:'');
 }
});

test('视频保留签名路径，H264优先于更高码率H265，并保留去重备用源',()=>{
 const result=parseXhsNote(note(video),id);
 assert.equal(result.videoUrl,main);assert.equal(result.videoAlternates[0],backup);
 assert.deepEqual(xhsVideoSources(video),[main,backup,'https://sns-video-bd.xhscdn.com/hevc.mp4','https://sns-video-bd.xhscdn.com/original.mp4']);
});

test('只有H265或原始视频key时仍能解析视频，API列表保留视频类型',()=>{
 assert.equal(parseXhsNote(note({media:{stream:{h265:[{masterUrl:main}]}}}),id).videoUrl,main);
 assert.equal(parseXhsNote(note({consumer:{originVideoKey:'origin.mp4'}}),id).videoUrl,'https://sns-video-bd.xhscdn.com/origin.mp4');
 assert.equal(parseXhsApiItems({data:{notes:[{id,type:'video',cover:{url_default:'https://sns-img-qc.xhscdn.com/cover.jpg'}}]}})[0].type,'video');
});

test('浏览器状态序列化保留编码、备用源、码率与原始key，未就绪视频继续等待',()=>{
 const source=readFileSync(new URL('../server/xhs-browser.mjs',import.meta.url),'utf8');
 const read=source.match(/const readState = function[\s\S]*?\n\};/)[0];
 const context=vm.createContext({window:{__INITIAL_STATE__:note(video)}});
 vm.runInContext(read+';this.read=readState;',context);
 const result=JSON.parse(context.read('note',id));
 assert.equal(parseXhsNote(result.payload,id).videoUrl,main);
 assert.equal(result.payload.note.noteDetailMap[id].note.video.media.stream.h264[0].backupUrls[0],backup);
 assert.equal(result.payload.note.noteDetailMap[id].note.video.consumer.originVideoKey,'original.mp4');
 context.window.__INITIAL_STATE__=note({});
 assert.equal(JSON.parse(context.read('note',id)).ok,false);
});

test('视频笔记优先返回视频，即使预览只请求一项也不能只给封面',()=>{
 const source=readFileSync(new URL('../server/picture-sites.mjs',import.meta.url),'utf8');
 const fn=source.match(/function xhsNoteResult\([\s\S]*?\n\}/)[0];
 const context=vm.createContext({XHS_ORIGIN:'https://www.xiaohongshu.com'});
 vm.runInContext(fn+';this.result=xhsNoteResult;',context);
 const result=context.result(parseXhsNote(note(video),id),'https://www.xiaohongshu.com/explore/'+id,1);
 assert.equal(result.items.length,1);assert.equal(result.items[0].type,'video');assert.equal(result.items[0].url,main);
 assert.equal(result.items[0].alternates[0],backup);
});

test('远程视频预览完整透传备用源，主源失败后切换并在耗尽时停止',()=>{
 const source=readFileSync(new URL('../src/library/local-files.js',import.meta.url),'utf8');
 const open=source.match(/ function openImageGallery\([\s\S]*?\n \}/)[0];
 let pkg,items;
 const context=vm.createContext({openGallery:(options,entries)=>{pkg=options;items=entries;}});
 vm.runInContext(open+';this.open=openImageGallery;',context);
 context.open({title:'video',images:[{type:'video',url:main,alternates:[backup,main]}]});
 const urls=pkg.videoUrls('0');assert.equal(urls.length,2);
 assert.equal(new URL(urls[0],'http://localhost').searchParams.get('url'),main);
 const error={hidden:true},player={hidden:false,src:'',getAttribute(){return this.src;},load(){},play:()=>Promise.resolve()};
 const stage={querySelector:selector=>selector==='.local-gallery-video'?player:selector==='.local-gallery-error'?error:null};
 const render=source.match(/function showGalleryImage\([\s\S]*?\n\}/)[0];
 const runtime=vm.createContext({galleryImages:items,galleryIndex:0,galleryPkg:pkg,isVideoItem:item=>item.type==='video',
  $:selector=>selector==='#file-preview-stage'?stage:null,preloadGallery(){},galleryZoom:null});
 vm.runInContext(render+';this.show=showGalleryImage;',runtime);
 runtime.show(0);assert.equal(player.src,urls[0]);
 player.onerror();assert.equal(player.src,urls[1]);
 player.onerror();assert.equal(error.hidden,false);assert.match(error.textContent,/视频暂时无法播放/);
 runtime.galleryImages=[];player.src='new-video';player.onerror();assert.equal(player.src,'new-video');
});
