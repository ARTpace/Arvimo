import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {albumPreviewItems} from '../src/library/image-albums.js';

test('已知画板立即进入，不等待重复读取完整画板列表',async()=>{
 const source=readFileSync(new URL('../src/library/advanced-query.js',import.meta.url),'utf8');
 const calls=[];
 const ctx={collections:[],activeBoard:null,activeCollection:'',sort:{value:'recent'},
  refreshCollections:async()=>{throw Error('不应重复请求列表');},renderCollections:()=>{},
  broadcastBoard:()=>calls.push('enter'),apply:async()=>calls.push('query')};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('  async function openCollection('),source.indexOf('  function clearCollection(')),ctx);
 await ctx.openCollection('A',{force:true,refresh:true,board:{id:'A',name:'参考',smart:false}});
 assert.deepEqual(calls,['enter','query']);
 assert.equal(ctx.activeCollection,'A');
});
test('连续点击画板始终强制进入，并刷新列表以识别新画板',async()=>{
 const source=readFileSync(new URL('../src/library/board-hub.js',import.meta.url),'utf8'),calls=[];
 const context={gotoLibrary:()=>calls.push('route'),store:{setActive:id=>calls.push(id)},controls:{applyCollection:async(id,options)=>calls.push([id,options.force,options.refresh])}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  const openBoard ='),source.indexOf('  const openAll ='))+'\nglobalThis.openBoard=openBoard;',context);
 await context.openBoard('new');await context.openBoard('new');assert.deepEqual(calls,['route','new',['new',true,true],'route','new',['new',true,true]]);
});
test('画板预览每个图集仅取一张封面，第二个图集不会被第一套的图片挤掉',()=>{
 const source=readFileSync(new URL('../server/library-api.mjs',import.meta.url),'utf8');
 const row=id=>({uid:id,thumbnail:'',model:{albumPackage:{root:'R',rel:id,entries:Array.from({length:6},(_,n)=>({name:`${n}.png`,rel:`${n}.png`}))}}});
 const context={uids:['first','second'],byUid:new Map([['first',row('first')],['second',row('second')]]),limit:6,albumPreviewItems,pick:row=>({uid:row.uid,thumbnail:row.thumbnail})};
 vm.createContext(context);const start=source.indexOf('          const items = uids.slice(0, limit + 1)');
 vm.runInContext(source.slice(start,source.indexOf('          previews[id] =',start))+'\nglobalThis.items=items;',context);
 assert.deepEqual(Array.from(context.items,item=>item.uid),['first','second']);assert.match(context.items[0].thumbnail,/first/);assert.match(context.items[1].thumbnail,/second/);
});
