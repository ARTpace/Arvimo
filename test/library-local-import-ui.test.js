import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalImport} from '../src/library/local-import.js';

class Node {
 constructor(){this.listeners={};this.textContent='';this.innerHTML='';this.disabled=false;this.children=[];}
 addEventListener(type,fn){this.listeners[type]=fn;}
 appendChild(node){this.children.push(node);node.parent=this;}
 remove(){this.parent.children=this.parent.children.filter(node=>node!==this);}
 querySelectorAll(){return this.buttons||[];}
 setAttribute(){}
}

function importHarness(t, {online=true, visitor=false, files=[{rel:'nested/<img>.png',name:'<img>.png'}]}={}) {
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
 const rootButton=new Node();$('#local-import-roots').buttons=[rootButton];
 const previous=globalThis.document;globalThis.document={createElement:()=>new Node()};
 t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 const calls=[];let changed=0, changedData, reloaded=0;let reply={ok:true,status:'imported',mode:'linked',asset:{name:'<img>.png'}};
 let failure=false, pending=null;
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  calls.push({url,options});
  const ok=data=>({ok:true,json:async()=>data});
  if(url==='/api/library/import-roots')return ok({roots:['H:/Assets'],entries:[{path:'H:/Assets',online}]});
  if(url==='/api/library/scan')return ok({packages:[]});
  if(url==='/api/library/browse-folder')return ok({files,truncated:true});
  assert.equal(url,'/api/library/import-file');
  if(pending)await pending;
  if(typeof reply==='function')return reply(JSON.parse(options.body));
  if(failure)return {ok:false,status:409,json:async()=>({error:'原文件变化'})};
  return ok(reply);
 });
 const ui=createLocalImport({$,esc:x=>x,visitor,reload:()=>{reloaded++;},onChanged:async data=>{changed++;changedData=data;}});ui.setup();
 const click=()=>$('#local-import-roots').listeners.click({target:{closest:selector=>selector==='[data-import-file]'?{dataset:{importFile:'0'}}:null}});
 return {$,ui,calls,rootButton,click,get changed(){return changed;},get changedData(){return changedData;},get reloaded(){return reloaded;},setReply:value=>{reply=value;},setFailure:value=>{failure=value;},setPending:value=>{pending=value;}};
}

test('在线根选相对文件导入：默认链接/跳过，同名不覆盖、安全DOM、刷新资产',async t=>{
 const h=importHarness(t);await h.ui.refresh();
 assert.match(h.$('#local-import-roots').innerHTML,/data-import-file/);
 await h.click();
 const panel=h.$('#local-import-roots').children[0];const [file,mode,duplicate,confirm,cancel]=panel.children;
 assert.equal(file.children[0].textContent,'nested/<img>.png');assert.equal(file.children[0].innerHTML,'');
 assert.equal(mode.value,'linked');assert.equal(duplicate.value,'skip');assert.equal(h.rootButton.disabled,true);
 assert.match(h.$('#local-import-status').textContent,/不完整/);
 await h.click();assert.equal(h.$('#local-import-roots').children.length,1,'busy prevents another picker');
 await confirm.listeners.click();
 const request=h.calls.find(call=>call.url==='/api/library/import-file').options;
 assert.equal(request.headers['x-sfx-local'],'1');
 assert.deepEqual(JSON.parse(request.body),{folder:'H:/Assets',rel:'nested/<img>.png',mode:'linked',duplicate:'skip',nameConflict:'keep-both'});
 assert.equal(h.changed,1);assert.equal(h.changedData.status,'imported');assert.equal(h.changedData.asset.name,'<img>.png');assert.match(h.$('#local-import-status').textContent,/链接入库（未复制）/);
 assert.equal(h.$('#local-import-status').innerHTML,'');assert.equal(h.rootButton.disabled,false);
 assert.equal(h.$('#local-import-roots').children.length,1);
 const notice=h.$('#local-import-roots').children[0];assert.match(notice.children[0].textContent,/刷新资产库后显示新资产/);
 assert.equal(h.reloaded,0,'不自动刷新丢失草稿');notice.children[1].listeners.click();assert.equal(h.reloaded,1);
});

test('托管保留原件/显式保留重复：取消等待在途完成，仅停止后续，不回滚',async t=>{
 const h=importHarness(t,{files:[{rel:'one.png'},{rel:'two.png'}]});await h.ui.refresh();await h.click();
 const [file,mode,duplicate,confirm,cancel,note]=h.$('#local-import-roots').children[0].children;
 file.selectedOptions=file.children;mode.value='managed';duplicate.value='keep-both';
 assert.match(mode.children[1].textContent,/复制入库，保留原件/);
 let release;h.setPending(new Promise(resolve=>{release=resolve;}));
 const pending=confirm.listeners.click();assert.equal(cancel.disabled,false);assert.equal(file.disabled,true);
 assert.equal(mode.disabled,true);assert.equal(duplicate.disabled,true);assert.equal(confirm.disabled,true);
 cancel.listeners.click();await confirm.listeners.click();
 assert.match(note.textContent,/当前提交仍在等待结果/);assert.equal(h.rootButton.disabled,true);assert.equal(h.changed,0);
 assert.equal(h.calls.filter(call=>call.url==='/api/library/import-file').length,1);
 assert.equal(h.calls.at(-1).options.signal,undefined,'POST不abort');
 release();await pending;
 assert.equal(h.calls.filter(call=>call.url==='/api/library/import-file').length,1);
 assert.equal(h.changed,1);assert.equal(h.changedData.cancelled,true);assert.equal(h.changedData.stats.completed,1);
 assert.match(h.$('#local-import-status').textContent,/完成 1\/2/);assert.match(h.$('#local-import-status').textContent,/复制入库（原件保留）/);
 assert.equal(h.rootButton.disabled,false);
 const payload=JSON.parse(h.calls.filter(call=>call.url==='/api/library/import-file').at(-1).options.body);
 assert.equal(payload.duplicate,'keep-both');assert.equal(payload.mode,'managed');
});

test('选择可取消，离线根和访客不可导入，重复跳过不是新增成功',async t=>{
 const h=importHarness(t);await h.ui.refresh();await h.click();
 h.$('#local-import-roots').children[0].children[4].listeners.click();
 assert.equal(h.$('#local-import-roots').children.length,0);assert.equal(h.changed,0);
 assert.equal(h.calls.some(call=>call.url==='/api/library/import-file'),false);
 await h.click();h.setReply({ok:true,status:'skipped',mode:'linked',reason:'same-linked-path'});
 await h.$('#local-import-roots').children[0].children[3].listeners.click();
 assert.match(h.$('#local-import-status').textContent,/已跳过.*不重复创建/);
 const offline=importHarness(t,{online:false});await offline.ui.refresh();await offline.click();
 assert.ok(!offline.$('#local-import-roots').innerHTML.includes('data-import-file'));assert.equal(offline.$('#local-import-roots').children.length,0);
 const visitor=importHarness(t,{visitor:true});await visitor.ui.refresh();await visitor.click();
 assert.equal(visitor.calls.some(call=>call.url==='/api/library/import-file'),false);assert.equal(visitor.$('#local-import-roots').children.length,0);
});

test('无文件不提交，内容重复skip提示显式保留两份',async t=>{
 const empty=importHarness(t,{files:[]});await empty.ui.refresh();await empty.click();
 assert.equal(empty.$('#local-import-roots').children[0].children[3].disabled,true);
 const h=importHarness(t);await h.ui.refresh();await h.click();
 h.setReply({ok:true,status:'skipped',mode:'linked',reason:'exact-duplicate'});
 await h.$('#local-import-roots').children[0].children[3].listeners.click();
 assert.match(h.$('#local-import-status').textContent,/跳过同内容重复.*保留两份/);assert.equal(h.changed,1);
});

test('多选串行：失败继续、启动冻结参数、仅批末通知，空选择不提交',async t=>{
 const h=importHarness(t,{files:[{rel:'first.png'},{rel:'bad<img>.png'},{rel:'last.png'}]});await h.ui.refresh();await h.click();
 const [file,mode,duplicate,confirm]=h.$('#local-import-roots').children[0].children;
 assert.equal(file.multiple,true);file.selectedOptions=[];await confirm.listeners.click();
 assert.equal(h.calls.some(call=>call.url==='/api/library/import-file'),false);
 file.selectedOptions=file.children;mode.value='managed';duplicate.value='keep-both';
 let release;h.setPending(new Promise(resolve=>{release=resolve;}));
 h.setReply(({rel})=>{if(rel.startsWith('bad'))throw Error('响应丢失<img>');return {ok:true,json:async()=>({ok:true,status:rel==='first.png'?'imported':'skipped',reason:'exact-duplicate'})};});
 const pending=confirm.listeners.click();assert.equal(h.calls.filter(call=>call.url==='/api/library/import-file').length,1);
 assert.equal(h.changed,0);mode.value='linked';duplicate.value='skip';file.selectedOptions=[];
 release();await pending;
 const posts=h.calls.filter(call=>call.url==='/api/library/import-file').map(call=>JSON.parse(call.options.body));
 assert.deepEqual(posts.map(row=>row.rel),['first.png','bad<img>.png','last.png']);
 assert.ok(posts.every(row=>row.mode==='managed'&&row.duplicate==='keep-both'));
 assert.equal(h.changed,1);assert.deepEqual(h.changedData.stats,{total:3,completed:3,imported:1,skipped:1,failed:1});
 const status=h.$('#local-import-status');assert.match(status.textContent,/完成 3\/3/);assert.match(status.textContent,/bad<img>.png：响应丢失<img>/);
 assert.match(status.textContent,/可能已入库/);assert.match(status.textContent,/不会自动重试/);assert.equal(status.innerHTML,'');assert.equal(h.reloaded,0);
});

test('全失败仍逐件完成、最多20失败明细，不触发刷新回调且不自动重试',async t=>{
 const h=importHarness(t,{files:Array.from({length:22},(_,i)=>({rel:`bad-${i}.png`}))});await h.ui.refresh();await h.click();
 const [file,,,confirm]=h.$('#local-import-roots').children[0].children;file.selectedOptions=file.children;
 h.setFailure(true);await confirm.listeners.click();
 assert.equal(h.calls.filter(call=>call.url==='/api/library/import-file').length,22);assert.equal(h.changed,0);
 const status=h.$('#local-import-status').textContent;assert.match(status,/完成 22\/22/);assert.match(status,/失败\/待核实）22/);
 assert.match(status,/bad-19.png：原文件变化/);assert.ok(!status.includes('bad-20.png'));assert.match(status,/前 20/);
 assert.equal(h.rootButton.disabled,false);assert.equal(h.$('#local-import-roots').children.length,1,'显式刷新入口保留');
 assert.match(h.$('#local-import-roots').children[0].children[0].textContent,/尚无已确认的成功结果/);
});

test('根列表重复检查报告安全文本、最多50问题、busy与取消恢复',async t=>{
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
 const button=new Node();$('#local-import-roots').buttons=[button];
 const previous=globalThis.document;globalThis.document={createElement:()=>new Node()};
 t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 let request,mode='report',calls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='/api/library/import-roots')return {ok:true,json:async()=>({roots:['H:/Assets'],entries:[{path:'H:/Assets',online:true}]})};
  if(url==='/api/library/scan')return {ok:true,json:async()=>({packages:[]})};
  if(url==='/api/library/browse-folder')return {ok:true,json:async()=>({files:[]})};
  assert.equal(url,'/api/library/import-preflight');calls++;request=options;
  if(mode==='cancel')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('cancel'),{name:'AbortError'}))));
  return {ok:true,json:async()=>({stats:{total:60,'exact-duplicate':60},truncated:false,scanned:{folders:3,skipped:2},results:Array.from({length:60},(_,i)=>({status:'exact-duplicate',path:`<img onerror=bad>${i}`}))})};
 });
 const ui=createLocalImport({$,esc:x=>x,visitor:false});ui.setup();await ui.refresh();
 assert.match($('#local-import-roots').innerHTML,/data-import-check/);
 const click=()=>$('#local-import-roots').listeners.click({target:{closest:selector=>selector==='[data-import-check]'?{dataset:{importCheck:'0'}}:null}});
 click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(request.headers['x-sfx-local'],'1');assert.deepEqual(JSON.parse(request.body),{folder:'H:/Assets'});
 const report=$('#local-import-status').textContent;
 assert.match(report,/未与全库比较/);assert.match(report,/4000 个文件、8 层/);assert.match(report,/跳过项 2/);assert.match(report,/结果不完整/);assert.match(report,/前 50/);assert.match(report,/<img onerror=bad>49/);assert.ok(!report.includes('<img onerror=bad>50'));
 assert.equal($('#local-import-status').innerHTML,'','report does not use innerHTML');assert.equal(button.disabled,false);
 mode='cancel';click();assert.equal(button.disabled,true);click();assert.equal(calls,2,'busy prevents duplicate request');
 const cancel=$('#local-import-roots').children[0];cancel.listeners.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(request.signal.aborted,true);assert.match($('#local-import-status').textContent,/已取消/);assert.equal(button.disabled,false);assert.equal($('#local-import-roots').children.length,0);
});
