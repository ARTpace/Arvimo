import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLazyPreview} from '../src/library/lazy-preview.js';
import {DownloadManager} from '../server/downloads.mjs';
import {createLibraryServer} from '../server/library.mjs';
import {SERVER_CAPABILITIES,serverIsCurrent} from '../server/capabilities.mjs';

test('lazy preview module is served as same-origin JavaScript and old servers require upgrading',async()=>{
 const server=createLibraryServer({staticRoot:fileURLToPath(new URL('../src/library/',import.meta.url))});
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/gltf-preview.js`);
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);
  assert.match(await response.text(),/export function createGltfPreview/);
  assert.equal(serverIsCurrent({...SERVER_CAPABILITIES,lazyPreview:false}),false);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('3D module loads once on demand; closing or switching cancels pending previews',async()=>{
 let imports=0,release;const calls=[];
 const module={createGltfPreview:()=>({load:id=>{calls.push(id);return id;},close:()=>calls.push('close'),polyforkLive:()=>true})};
 const preview=createLazyPreview({loadModule:()=>{imports++;return new Promise(resolve=>{release=resolve;});}});
 assert.equal(imports,0);assert.equal(preview.polyforkLive(),false);
 const old=preview.load('old');preview.close();release(module);
 assert.equal(await old,false);assert.deepEqual(calls,[]);
 const a=preview.load('a'),b=preview.load('b');
 assert.equal(await a,false);assert.equal(await b,'b');
 assert.equal(imports,1);assert.deepEqual(calls,['b']);assert.equal(preview.polyforkLive(),true);
 preview.close();assert.deepEqual(calls,['b','close']);
});

test('failed 3D imports can retry and report an error without an unhandled rejection',async()=>{
 let tries=0;const errors=[];
 const preview=createLazyPreview({loadModule:async()=>{
  if(++tries===1)throw Error('offline');
  return {createGltfPreview:()=>({load:()=>true})};
 },onError:error=>errors.push(error.message)});
 assert.equal(await preview.load('x'),false);assert.deepEqual(errors,['offline']);
 assert.equal(await preview.load('x'),true);assert.equal(tries,2);
});

test('asynchronous download snapshots preserve file/directory status and detect deletion immediately',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-snapshot-'));
 try{
  const file=path.join(dir,'asset.zip');await fs.writeFile(file,'fixture');
  const manager=Object.assign(Object.create(DownloadManager.prototype),{
   jobs:[{id:'file',filePath:file},{id:'directory',filePath:dir},{id:'missing',filePath:path.join(dir,'gone')},{id:'queued'}],
   folderStatus:()=>({ok:true}),browser:()=>false,blender:()=>false,
  });
  assert.deepEqual(await manager.snapshotAsync(),manager.snapshot());
  await fs.unlink(file);
  assert.deepEqual((await manager.snapshotAsync()).jobs.map(j=>j.fileExists),[false,true,false,false]);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('masonry measures only changed/new cards, then invalidates all heights when width changes',()=>{
 const source=readFileSync(new URL('../src/library/masonry.js',import.meta.url),'utf8').replaceAll('export function','function');
 let frame,mutate,reads=0,writes=0,styleReads=0;const listeners={};
 const style=()=>{const values=new Map();return {getPropertyValue:key=>{styleReads++;return values.get(key)||'';},setProperty:(key,value)=>{writes++;values.set(key,value);}};};
 const root={children:[],clientWidth:800,style:style(),matches:selector=>selector.includes('model-grid'),querySelectorAll:()=>[],addEventListener:(name,fn)=>listeners[name]=fn,closest:()=>root};
 const card=height=>({height,style:style(),closest(){return this;},getBoundingClientRect(){reads++;return {height:this.height};}});
 root.children=Array.from({length:1000},(_,i)=>card(200+i%5*50));
 const context={window:{innerWidth:1000,addEventListener(){}},document:{},
  // 不要把 el.style 交给 getComputedStyle：那会把 CSS 变量读取计进 styleReads，
  // 而这条用例只统计卡片 rect 的读取次数。
  getComputedStyle:()=>({getPropertyValue:()=>''}),requestAnimationFrame:fn=>{frame=fn;return 1;},
  MutationObserver:class{constructor(fn){mutate=fn;}observe(){}},ResizeObserver:class{observe(){}},root};
 vm.runInNewContext(source+';observeMasonry(root);',context);
 // masonry.js 在列宽变化时会先读一次首卡强制 reflow，每次 resized 多 1 次 rect 读取。
 const reflowReads=1;
 frame();assert.equal(reads,1000+reflowReads);
 const initialWrites=writes;frame();assert.equal(reads,1000+reflowReads);assert.equal(writes,initialWrites);
 const initialStyleReads=styleReads;
 listeners.load({target:root.children[1]});frame();
 assert.equal(styleReads,initialStyleReads,'unchanged image dimensions must skip coordinate processing');
 assert.equal(reads,1001+reflowReads);
 root.children[1].height=280;listeners.load({target:root.children[1]});frame();assert.equal(reads,1002+reflowReads);
 root.children.push(card(150));mutate([{type:'childList',target:root}]);frame();assert.equal(reads,1003+reflowReads);
 // 改宽度会再触发一次 resized：全量重测之外又多一次 reflow 探针。
 root.clientWidth=1100;frame();assert.equal(reads,2004+reflowReads*2);
 const first=root.children[0],second=root.children[1];
 root.children[0]=second;root.children[1]=first;
 mutate([{type:'childList',target:root}]);frame();
 assert.equal(second.style.getPropertyValue('--masonry-left'),'0px','reordering still updates positions');
});

test('3D frames coalesce, settle after damping, and wake after visibility or edits',()=>{
 const source=readFileSync(new URL('../src/library/gltf-preview.js',import.meta.url),'utf8');
 const loop=source.slice(source.indexOf(' function requestRender(){'),source.indexOf(' function ensureRenderer(){'));
 const listener=source.split('\n').find(line=>line.startsWith("document.addEventListener('visibilitychange'"));
 let visibility,renders=0,nextId=0,context;const frames=new Map();let changes=0;
 // loop 的 eval 切片不含模块顶层的 `let mixer=null`，补上才能让 `mixer&&playing` 短路。
 context={frame:0,disposed:false,renderer:{},mixer:null,viewW:10,viewH:10,document:{hidden:true,addEventListener:(_name,fn)=>visibility=fn},
  requestAnimationFrame:fn=>{frames.set(++nextId,fn);return nextId;},resize(){},
  stop(){frames.delete(context.frame);context.frame=0;},
  controls:{update(){if(changes-->0)context.requestRender();}},renderFrame:()=>renders++};
 const tick=()=>{const batch=[...frames.values()];frames.clear();for(const fn of batch)fn();};
 vm.runInNewContext(loop+'\n'+listener+'\nloop();',context);
 assert.equal(context.frame,0);assert.equal(renders,0);
 context.document.hidden=false;visibility();context.requestRender();assert.equal(frames.size,1);
 changes=2;tick();tick();tick();assert.equal(renders,3);assert.equal(frames.size,0);
 context.requestRender();context.document.hidden=true;visibility();tick();assert.equal(renders,3);
 context.document.hidden=false;visibility();tick();assert.equal(renders,4);
 context.disposed=true;context.requestRender();assert.equal(frames.size,0);
 assert.match(source,/controls\.addEventListener\('change',requestRender\)/);
 assert.match(source,/lightRig\.rotation\.x=[^\n]+\n\s*requestRender\(\)/);
});

test('closed preview shrinks idle buffers; an active preview keeps them and restores size on reopen',()=>{
 const source=readFileSync(new URL('../src/library/gltf-preview.js',import.meta.url),'utf8');
 const release=source.slice(source.indexOf(' function releaseIdleResources(){'),source.indexOf(' function close(){'));
 const resize=source.slice(source.indexOf(' function resize(){'),source.indexOf('const onResize='));
 let cleared=0,draws=0;const sizes=[];
 const context={disposed:true,viewW:800,viewH:600,previewCache:{clearMemory:()=>cleared++},pfBuffers:new Map([['model',1]]),
  renderer:{setSize:(...args)=>sizes.push(args),setScissorTest:()=>{},setViewport:()=>{}},camera:{updateProjectionMatrix(){}},canvas:{},
  canvasSize:()=>({w:800,h:600}),requestRender:()=>draws++};
 vm.runInNewContext(release+resize,context);
 context.releaseIdleResources();assert.deepEqual(sizes,[[1,1,false]]);assert.equal(cleared,1);assert.equal(context.pfBuffers.size,0);
 context.resize();assert.equal(sizes.length,1,'closed observers must not reallocate buffers');
 context.disposed=false;context.resize();assert.deepEqual(sizes[1],[800,600,false]);assert.equal(draws,1);
 context.releaseIdleResources();assert.equal(sizes.length,2);assert.equal(cleared,1);
});

test('task updates preserve existing action, checkbox and log nodes',()=>{
 const source=readFileSync(new URL('../src/library/download-ui.js',import.meta.url),'utf8');
 const patch=source.slice(source.indexOf(' function patchNode('),source.indexOf(' function renderList('));
 class Node{
  constructor(name,text=''){this.nodeName=name;this.nodeType=name==='#text'?3:1;this.nodeValue=text;this.childNodes=[];this.attrs=new Map();}
  get attributes(){return [...this.attrs].map(([name,value])=>({name,value}));}
  hasAttribute(key){return this.attrs.has(key);}getAttribute(key){return this.attrs.get(key)??null;}
  setAttribute(key,value){this.attrs.set(key,value);}removeAttribute(key){this.attrs.delete(key);}
  append(node){this.childNodes.push(node);node.parent=this;}
  isEqualNode(next){return this.nodeName===next.nodeName&&this.nodeValue===next.nodeValue&&JSON.stringify(this.attributes)===JSON.stringify(next.attributes)&&this.childNodes.length===next.childNodes.length&&this.childNodes.every((node,i)=>node.isEqualNode(next.childNodes[i]));}
  remove(){this.parent.childNodes.splice(this.parent.childNodes.indexOf(this),1);}
  replaceWith(next){const i=this.parent.childNodes.indexOf(this);this.parent.childNodes[i]=next;next.parent=this.parent;}
 }
 const tree=text=>{const node=new Node('ARTICLE');for(const name of ['INPUT','BUTTON','PRE']){const child=new Node(name);if(name==='PRE')child.append(new Node('#text',text));node.append(child);}return node;};
 const node=tree('old'),[checkbox,button,log]=node.childNodes,next=tree('new');
 next.childNodes[0].setAttribute('checked','');next.childNodes[0].checked=true;
 vm.runInNewContext(patch+';patchNode(node,next);',{node,next});
 assert.equal(node.childNodes[0],checkbox);assert.equal(checkbox.checked,true);
 assert.equal(node.childNodes[1],button);assert.equal(node.childNodes[2],log);assert.equal(log.childNodes[0].nodeValue,'new');
});
