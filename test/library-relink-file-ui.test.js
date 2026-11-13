import test from 'node:test';
import assert from 'node:assert/strict';
import {openRelinkFile} from '../src/library/relink-file.js';

class Node {
 constructor(){this.children=[];this.listeners={};this.textContent='';this.innerHTML='';this.value='';}
 appendChild(node){this.children.push(node);node.parent=this;}
 replaceChildren(){this.children=[];}
 addEventListener(type,fn){this.listeners[type]=fn;}
 setAttribute(){}
 showModal(){this.open=true;}
 close(){this.open=false;}
 remove(){this.parent.children=this.parent.children.filter(row=>row!==this);}
}
function harness(t,{roots=['H:/Online','H:/Offline'],entries=[{path:'H:/Online',online:true},{path:'H:/Offline',online:false}],files=[{rel:'nested/<img>.png'}],denied=false}={}) {
 const body=new Node(),previous=globalThis.document;globalThis.document={body,createElement:()=>new Node()};
 t.after(()=>{if(body.children[0])body.children[0].children[1].children[0].children[3].listeners.click();if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 const calls=[];let result={ok:true,status:'relinked',asset:{uid:'old',name:'same'}},fail=false,pending,changed=0,reloaded=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls.push({url,options});const ok=data=>({ok:true,json:async()=>data});
  if(url==='/api/library/import-roots')return denied?{ok:false,status:403,json:async()=>({error:'仅主机'})}:ok({roots,entries});
  if(url==='/api/library/browse-folder')return ok({files,truncated:true});
  assert.equal(url,'/api/library/relink-file');if(pending)await pending;if(fail)throw Error('响应丢失<img>');return ok(result);
 });
 const model={uid:'old',storageMode:'linked',name:'<img onerror=bad>'};
 const open=()=>openRelinkFile({model,onChanged:async data=>{changed++;assert.equal(data.asset.uid,'old');},reload:()=>{reloaded++;}});
 return {body,calls,open,model,get changed(){return changed;},get reloaded(){return reloaded;},setResult:r=>{result=r;},setFailure:()=>{fail=true;},setPending:p=>{pending=p;},get dialog(){return body.children[0];},get controls(){return body.children[0].children[1].children[0].children;},get status(){return body.children[0].children[1].children[2];}};
}

test('卡片model重定位：只选登记在线根和相对文件，保留UID，不自动刷新，安全文本',async t=>{
 const h=harness(t);await h.open();const [folder,file,apply,close,refresh]=h.controls;
 assert.equal(folder.children.length,1);assert.equal(folder.value,'H:/Online');assert.equal(file.value,'nested/<img>.png');
 assert.equal(file.children[0].innerHTML,'');assert.equal(h.dialog.children[0].textContent,'重新定位链接文件：<img onerror=bad>');assert.equal(h.dialog.children[0].innerHTML,'');
 assert.match(h.status.textContent,/列表不完整/);
 await h.open();assert.equal(h.body.children.length,1,'不重复打开');
 await apply.listeners.click();
 const post=h.calls.find(row=>row.url==='/api/library/relink-file');assert.equal(post.options.headers['x-sfx-local'],'1');
 assert.deepEqual(JSON.parse(post.options.body),{uid:'old',folder:'H:/Online',rel:'nested/<img>.png'});assert.equal(post.options.signal,undefined);
 assert.equal(h.changed,1);assert.equal(h.reloaded,0);assert.equal(refresh.hidden,false);assert.equal(apply.disabled,true);assert.match(h.status.textContent,/标注与合集保留/);
 refresh.listeners.click();assert.equal(h.reloaded,1);close.listeners.click();assert.equal(h.body.children.length,0);
});

test('提交冻结输入与关闭，重复点击无第二POST，等待结果后才可关闭',async t=>{
 const h=harness(t);await h.open();const [folder,file,apply,close]=h.controls;
 let release;h.setPending(new Promise(resolve=>{release=resolve;}));const pending=apply.listeners.click();
 assert.equal(folder.disabled,true);assert.equal(file.disabled,true);assert.equal(close.disabled,true);
 close.listeners.click();let prevented=false;h.dialog.listeners.cancel({preventDefault:()=>{prevented=true;}});assert.equal(prevented,true);assert.equal(h.body.children.length,1);
 await apply.listeners.click();assert.equal(h.calls.filter(row=>row.url.endsWith('/relink-file')).length,1);
 release();await pending;assert.equal(close.disabled,false);close.listeners.click();assert.equal(h.body.children.length,0);
});

test('内容或引用冲突不覆盖，网络失败提示先核实，无自动重试',async t=>{
 const h=harness(t);await h.open();let [,,apply,close]=h.controls;
 h.setResult({ok:false,error:'内容不匹配'});await apply.listeners.click();assert.match(h.status.textContent,/不可覆盖/);assert.equal(h.changed,0);assert.equal(apply.disabled,true);close.listeners.click();
 await h.open();[,,apply]=h.controls;h.setFailure();await apply.listeners.click();
 assert.match(h.status.textContent,/响应丢失<img>/);assert.match(h.status.textContent,/可能已保存/);assert.match(h.status.textContent,/勿直接重试/);assert.equal(h.status.innerHTML,'');assert.equal(h.changed,0);
 assert.equal(h.calls.filter(row=>row.url.endsWith('/relink-file')).length,2);
});

test('无在线根、空目录、403均不提交；非linked拒绝打开',async t=>{
 const h=harness(t,{entries:[]});await h.open();assert.match(h.status.textContent,/没有已登记的在线目录/);assert.equal(h.controls[2].disabled,true);h.controls[3].listeners.click();
 h.model.storageMode='managed';await h.open();assert.equal(h.body.children.length,0);
 const empty=harness(t,{files:[]});await empty.open();assert.match(empty.status.textContent,/没有可选文件/);await empty.controls[2].listeners.click();assert.equal(empty.calls.some(row=>row.url.endsWith('/relink-file')),false);empty.controls[3].listeners.click();
 const denied=harness(t,{denied:true});await denied.open();assert.match(denied.status.textContent,/仅主机/);assert.equal(denied.controls[2].disabled,true);
});
