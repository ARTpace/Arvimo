// Picture-download UI tests.
//
// The grid offers this in three places (card button, selection bar, preview dialog) and all three
// must mean the same thing. These tests pin that shared decision set — which assets get a button,
// which options a picture job asks for, and what the user is told when nothing can be queued.
import test from 'node:test';import assert from 'node:assert/strict';
import {createImageDownloader,hasImages,IMAGE_KIND} from '../src/library/image-download.js';

const icon=name=>`<i>${name}</i>`;
const say=()=>{};
const model=(extra={})=>({uid:'c'.repeat(32),name:'Model',platform:'sketchfab',thumbnail:'https://media.sketchfab.com/x.jpg',...extra});
/** Records every enqueue instead of talking to the queue. */
function fakeQueue(){
  const calls=[];
  return {
    calls,
    enqueue:async(...args)=>{calls.push(args);return {added:[{id:'new'}],duplicates:[]};},
  };
}
function harness({models=new Map(),queue=fakeQueue()}={}){
  const toasts=[];
  const findModel=uid=>models.get(uid)||null;
  let refreshed=0;
  const downloader=createImageDownloader({icon,toast:m=>toasts.push(m),downloads:()=>queue,findModel,refresh:()=>{refreshed++;}});
  return {downloader,toasts,queue:queue||null,calls:queue?.calls||[],refreshed:()=>refreshed};
}

test('only assets whose pictures actually exist get a button',()=>{
  assert.equal(hasImages(model()),true);
  // ArtStation artworks always carry uploads, even when the cover failed to load.
  assert.equal(hasImages(model({platform:'artstation',thumbnail:null})),true);
  assert.equal(hasImages(model({thumbnail:null})),false);
  assert.equal(hasImages({}),false);
  assert.equal(hasImages(null),false);
});
test('the button names the asset, says what it downloads, and stays accessible',()=>{
  const {downloader}=harness();
  const html=downloader.button(model({uid:'d'.repeat(32)}));
  assert.match(html,/data-action="download-images"/);
  assert.match(html,/data-uid="d{32}"/);
  assert.match(html,/aria-label="[^"]+"/);
  assert.match(html,/<i>image<\/i>/);
  assert.equal(downloader.button(model({thumbnail:null})),'');
});
test('the tooltip tells the truth about the size each platform can serve',()=>{
  const {downloader}=harness();
  assert.match(downloader.button(model()),/1920px/);
  assert.match(downloader.button(model({platform:'artstation'})),/作者上传的原图/);
});
test('one click queues one picture job with picture options — never a model export',async()=>{
  const target=model({uid:'e'.repeat(32)});
  const {downloader,calls,toasts}=harness({models:new Map([[target.uid,target]])});
  await downloader.requestImages([target.uid]);
  assert.equal(calls.length,1);
  const [models,options,force,folder,kind]=calls[0];
  assert.equal(kind,IMAGE_KIND);
  assert.deepEqual(options,{output:'folder',imageRendition:'max'});
  assert.equal(models[0].uid,target.uid);
  assert.match(toasts.at(-1),/已加入 1 个图片下载任务/);
});
test('selections that hold nothing downloadable are reported instead of silently ignored',async()=>{
  const noCover=model({uid:'f'.repeat(32),thumbnail:null});
  const {downloader,calls,toasts}=harness({models:new Map([[noCover.uid,noCover]])});
  await downloader.requestImages([noCover.uid,'missing-uid']);
  assert.equal(calls.length,0);
  assert.match(toasts.at(-1),/没有可下载图片的资产/);
});
test('a disconnected backend says so, and a queue error reaches the user as its own message',async()=>{
  const target=model({uid:'1'.repeat(32)});
  const broken=harness({models:new Map([[target.uid,target]]),queue:{enqueue:async()=>{throw Error('任务记录已满');}}});
  await broken.downloader.requestImages([target.uid]);
  assert.match(broken.toasts.at(-1),/任务记录已满/);

  const offline=harness({models:new Map([[target.uid,target]]),queue:null});
  await offline.downloader.requestImages([target.uid]);
  assert.match(offline.toasts.at(-1),/后台服务未连接/);
});
test('batches are capped before talking to the queue, and skipped assets are counted in the toast',async()=>{
  const ids=Array.from({length:51},(_,i)=>String(i).padStart(32,'a'));
  const models=new Map(ids.map(id=>[id,model({uid:id})]));
  const {downloader,calls,toasts}=harness({models});
  await downloader.requestImages(ids);
  assert.equal(calls.length,0);
  assert.match(toasts.at(-1),/每批最多下载 50 个/);
});
test('duplicates are surfaced rather than silently dropped',async()=>{
  const target=model({uid:'2'.repeat(32)});
  const queue={enqueue:async()=>({added:[],duplicates:[{uid:target.uid}]})};
  const {downloader,toasts}=harness({models:new Map([[target.uid,target]]),queue});
  await downloader.requestImages([target.uid]);
  assert.match(toasts.at(-1),/已在队列或已下载/);
});
