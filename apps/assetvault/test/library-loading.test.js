import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {scanLibraryPackages} from '../server/local-assets.mjs';
import {createPersistentStorage} from '../src/library/persistent-storage.js';
import {createLibraryStorage} from '../server/library-storage.mjs';

const read=file=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8');

test('host index persists across storage instances; old servers only use browser cache',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-index-'));
 try{
  const host=createLibraryStorage(root);
  const index=JSON.stringify({version:1,files:[],packages:[{rel:'saved'}]});
  await host.save({'sfx-local-index-v1':index});
  const loaded=await createLibraryStorage(root).load();
  assert.equal(loaded.values['sfx-local-index-v1'],index);assert.equal(loaded.scanIndex,true);
  let writes=0;const local=new Map();
  const storage=await createPersistentStorage({getItem:key=>local.get(key),setItem:(key,value)=>local.set(key,value)},async(_url,options)=>{
   if(options.method==='POST'){writes++;return {ok:true};}
   return {ok:true,json:async()=>({values:{'sfx-library-v2':'{"models":[]}'}})};
  });
  storage.setItem('sfx-local-index-v1',index);await Promise.resolve();
  assert.equal(writes,0);assert.equal(local.get('sfx-local-index-v1'),index);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('local index displays immediately, requests coalesce, and failed refresh keeps assets',async()=>{
 const source=read('src/library/local-files.js');
 let finish,requests=0,saved;
 const index={version:1,files:[],packages:[{root:'root',rel:'old'}]};
 const context={storage:{getItem:()=>JSON.stringify(index),setItem:(_key,value)=>saved=JSON.parse(value)},
  // 切片只取 scan/索引部分，rebuildSequences 的定义留在切片外；本用例不验序列索引，给空实现。
  rebuildSequences(){},
  fetch:()=>{requests++;return new Promise(resolve=>finish=resolve);}};
 vm.runInNewContext(source.slice(source.indexOf(' let files=[];'),source.indexOf(' const keyOf='))+
  source.slice(source.indexOf(' function scan('),source.indexOf(' /** 搜索词与类型筛选'))+
  ';this.snapshot=()=>({files,packages,loading});',context);
 assert.equal(context.snapshot().packages[0].rel,'old');
 const one=context.scan(),two=context.scan();assert.equal(one,two);assert.equal(requests,1);
 finish({ok:false,status:500,json:async()=>({error:'offline'})});
 await assert.rejects(one,/offline/);assert.equal(context.snapshot().packages[0].rel,'old');
 const three=context.scan();finish({ok:true,json:async()=>({files:[],packages:[{rel:'new'}]})});
 await three;assert.equal(context.snapshot().packages[0].rel,'new');assert.equal(saved.packages[0].rel,'new');
});

test('unchanged packages reuse their index; nested edits, deletion and full scans stay correct',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-incremental-'));
 const packageCache=new Map();
 try{
  for(const name of ['a','b']){
   await fs.mkdir(path.join(root,name));
   await fs.writeFile(path.join(root,name,'info.json'),JSON.stringify({title:name,kind:'model'}));
   await fs.writeFile(path.join(root,name,'model.glb'),'abc');
  }
  const before=await scanLibraryPackages({roots:[root],packageCache});
  const oldB=before.packages.find(pkg=>pkg.rel==='b');
  const changed=path.join(root,'a','model.glb');await fs.writeFile(changed,'abcdef');
  const after=await scanLibraryPackages({roots:[root],packageCache,changedPaths:[changed]});
  assert.equal(after.packages.find(pkg=>pkg.rel==='b').entries,oldB.entries);
  assert.equal(after.packages.find(pkg=>pkg.rel==='a').entries.find(file=>file.name==='model.glb').bytes,6);
  await fs.rm(path.join(root,'b'),{recursive:true});
  const deleted=await scanLibraryPackages({roots:[root],packageCache,changedPaths:[path.join(root,'b')]});
  assert.equal(deleted.packages.length,1);assert.equal(packageCache.size,1);
  const full=await scanLibraryPackages({roots:[root],packageCache});
  assert.notEqual(full.packages[0],deleted.packages[0]);
  await fs.mkdir(path.join(root,'c'));
  for(const name of ['a','c'])await fs.writeFile(path.join(root,name,'info.json'),JSON.stringify({uid:'a'.repeat(32),title:name,kind:'model'}));
  await fs.writeFile(path.join(root,'c','model.glb'),'abc');
  await scanLibraryPackages({roots:[root],packageCache});
  const duplicate=await scanLibraryPackages({roots:[root],packageCache,changedPaths:[]});
  assert.equal(duplicate.packages.length,1);assert.equal(duplicate.packages[0].copies,2);
  assert.equal(packageCache.get(path.join(root,'a')).rel,'a');assert.equal(packageCache.get(path.join(root,'c')).rel,'c');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

function scanHarness({supported=true}={}){
 const source=read('server/scan-cache.mjs').replace(/^import .*;\r?\n/gm,'')
  .replaceAll('export function','function').replaceAll('export async function','async function')
  .replaceAll('export const','const');
 let now=1000,changed,closed=0;
 const context={process:{env:{}},Date:{now:()=>now},path,
  setTimeout:()=>({unref(){}}),
  fsp:{stat:async()=>({mtimeMs:1,size:1}),readdir:async()=>['asset']},
  watch:(_root,_options,callback)=>{if(!supported)throw Error('unsupported');changed=callback;return {on(){},close(){closed++;}};}};
 vm.runInNewContext(source,context);
 return {context,change:name=>changed('change',name),advance:ms=>now+=ms,closed:()=>closed};
}

test('watched scans coalesce, invalidate on nested changes, and support manual/full fallback',async()=>{
 const h=scanHarness(),calls=[];
 const options={roots:['root'],compute:async input=>{calls.push(input);return {count:calls.length};}};
 const [one,two]=await Promise.all([h.context.cachedScan('root',options),h.context.cachedScan('root',options)]);
 assert.equal(calls.length,1);assert.equal(one,two);
 h.advance(16000);await h.context.cachedScan('root',options);assert.equal(calls.length,1);
 h.change('asset/model.glb');await h.context.cachedScan('root',options);
 assert.equal(calls.length,2);assert.equal(calls[1].changedPaths[0],path.resolve('root','asset/model.glb'));
 await h.context.cachedScan('root',{...options,force:true});assert.equal(calls[2].changedPaths,null);
 h.advance(300001);await h.context.cachedScan('root',options);assert.equal(calls[3].changedPaths,null);
 h.context.invalidateScanCache();assert.equal(h.closed(),1);
 const fallback=scanHarness({supported:false});let count=0;
 const opts={roots:['root'],compute:async()=>++count};
 await fallback.context.cachedScan('root',opts);fallback.advance(16000);await fallback.context.cachedScan('root',opts);
 assert.equal(count,2);
});

test('file events during a scan prevent publishing stale cache state',async()=>{
 const h=scanHarness();let release,calls=0;
 const options={roots:['root'],compute:async()=>{calls++;if(calls===1)await new Promise(resolve=>release=resolve);return calls;}};
 const first=h.context.cachedScan('root',options);
 for(let i=0;i<8;i++)await Promise.resolve();
 h.change('asset/new.png');release();await first;
 await h.context.cachedScan('root',options);assert.equal(calls,2);
});

test('UI readiness does not await online categories, disk scanning or fonts',async()=>{
 const source=read('src/library/app.js');
 const start=source.indexOf(' // Online categories,');
 const end=source.indexOf(" fetch('/api/health')",start);
 let ready=false;
 const pending=new Promise(()=>{}),node={setAttribute(){}};
 const context={Promise,waitForInitialCategories:()=>pending,artFilters:pending,
  filterTrees:{refresh(){}},mergedFilters:null,renderPlatform(){},renderGrid(){},fillIcons(){},$:()=>node,
  requestAnimationFrame:fn=>{fn();return 1;},syncStickyOffset(){},document:{documentElement:{dataset:{}}},
  window:{dispatchEvent:()=>ready=true},Event:class{}};
 await vm.runInNewContext(`(async()=>{${source.slice(start,end)}})()`,context);
 assert.equal(ready,true);
});
