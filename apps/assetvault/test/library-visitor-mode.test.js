import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isLanVisitor} from '../src/library/visitor-mode.js';
import {createSettingsPanel} from '../src/library/settings-panel.js';
import {createClientDirectory} from '../src/library/client-directory.js';
import {createBrowserDelivery} from '../src/library/browser-delivery.js';
import {createTaskCard} from '../src/library/download-card.js';

test('LAN settings are hidden and opening the settings panel is a no-op',t=>{
 for(const host of ['localhost','127.0.0.1','[::1]'])assert.equal(isLanVisitor(host),false);
 assert.equal(isLanVisitor('192.168.1.10'),true);
 const previous=Object.getOwnPropertyDescriptor(globalThis,'location');
 Object.defineProperty(globalThis,'location',{configurable:true,value:{hostname:'192.168.1.10'}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'location',previous);else delete globalThis.location;});
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,inert:false});return nodes.get(id);};
 const panel=createSettingsPanel({$,loadAI:()=>assert.fail('must not load host settings')});panel.open('sharing');
 for(const node of nodes.values()){assert.equal(node.hidden,true);assert.equal(node.inert,true);}
});

test('LAN downloads override a saved opt-out and remain enabled',async()=>{
 let saved=JSON.stringify({enabled:false,pending:[]}),received=[];
 const delivery=createBrowserDelivery({forceEnabled:true,storage:{getItem:()=>saved,setItem:(key,value)=>{saved=value;}},download:id=>received.push(id)});
 assert.equal(delivery.enabled,true);delivery.setEnabled(false);assert.equal(delivery.enabled,true);
 delivery.track(['mine']);await delivery.accept([{id:'mine',state:'saved',fileExists:true}]);assert.deepEqual(received,['mine']);
});

test('plain HTTP offers browser downloads and never requests a host folder',async()=>{
 const directory=createClientDirectory({secure:false,picker:()=>assert.fail('insecure directory picker must not run'),store:()=>assert.fail('must not load a handle for HTTP')});
 assert.equal(directory.supported,false);await directory.restore();assert.equal(await directory.save(new Blob(['asset']),'asset.zip'),false);
 await assert.rejects(directory.choose(),/浏览器下载设置/);
});

test('a client directory is remembered and receives subsequent assets with safe names',async()=>{
 let remembered,permission='granted';const files=new Map();
 const directory={name:'我的资产',queryPermission:async()=>permission,getFileHandle:async(name,{create=false}={})=>{
  if(!create&&!files.has(name))throw Object.assign(Error('missing'),{name:'NotFoundError'});
  return {createWritable:async()=>new WritableStream({write(chunk){files.set(name,Buffer.from(chunk));}})};
 }};
 const options={secure:true,picker:async()=>directory,store:async value=>value?(remembered=value):remembered};
 const first=createClientDirectory(options);assert.equal(await first.choose(),'我的资产');
 const next=createClientDirectory(options);await next.restore();assert.equal(next.name,'我的资产');
 assert.equal(await next.save(new Blob(['zip-content']),'a/b.zip'),true);assert.equal(files.get('a_b.zip').toString(),'zip-content');
 await next.save(new Blob(['second']),'a/b.zip');assert.equal(files.size,2,'existing files must not be overwritten');
 permission='prompt';await assert.rejects(next.save(new Blob(['other']),'c.zip'),/重新授权/);
});

test('visitor task cards do not offer host folders or display their save paths',()=>{
 const render=createTaskCard({visitor:true,esc:value=>String(value??''),icon:()=>''});
 const html=render({id:'one',uid:'uid',state:'saved',fileExists:true,name:'asset',filePath:'C:/host/private',downloadDir:'C:/host/private',logs:[],verification:{entries:1},createdAt:Date.now()},{selected:false});
 assert.ok(!html.includes('data-dm-action="reveal"'));
 assert.ok(!html.includes('title="C:/host/private"'));
 assert.ok(html.includes('自动取回到此电脑'));
});
