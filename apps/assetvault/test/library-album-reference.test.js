import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareAlbumReference,legacyAlbumMembers} from '../src/library/album-board-import.js';
import {createLocalFiles} from '../src/library/local-files.js';
import {createCardView} from '../src/library/card-view.js';
test('整套图集只创建一条稳定引用，重复拖放不生成新身份，也不逐张导入',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected fetch');});
 const previous=globalThis.localStorage;globalThis.localStorage={getItem:()=>null};t.after(()=>{if(previous===undefined)delete globalThis.localStorage;else globalThis.localStorage=previous;});
 const calls=[],pkg={root:'J:/素材',rel:'贴花/符文',title:'符文',category:'images',type:'folder',fileCount:40,entries:Array.from({length:40},(_,n)=>({name:`${n}.png`,rel:`${n}.png`}))};
 const fetchImpl=async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return {ok:true,json:async()=>({applied:1})};};
 const asset=await prepareAlbumReference(pkg,{fetchImpl});const repeat=await prepareAlbumReference(pkg,{fetchImpl});
 assert.equal(asset.uid,repeat.uid);assert.match(asset.uid,/^[a-f0-9]{32}$/);assert.equal(calls.length,2);
 assert.ok(calls.every(([url,body])=>url==='/api/library/assets/mutate'&&body.ops.length===1));
 assert.equal(asset.albumPackage.fileCount,40);assert.equal(asset.albumPackage.entries.length,9);assert.equal(asset.filePath,undefined);
 const lf=createLocalFiles({$:()=>null,esc:String,icon:()=>'',favorites:()=>new Set()});
 const html=lf.referenceCard(asset);assert.match(html,/data-package="J:\/素材\|贴花\/符文"/);assert.match(html,new RegExp(`data-uid="${asset.uid}"`));
 let seen;const view=createCardView({albumCard:model=>{seen=model;return 'album';}});assert.equal(view.card(asset),'album');assert.equal(seen,asset);
});
test('图集引用写入失败会报错，不把未保存引用加入画板',async()=>{
 await assert.rejects(prepareAlbumReference({root:'R',rel:'A'},{fetchImpl:async()=>({ok:false,json:async()=>({error:'只读'})})}),/只读/);
});

test('恢复旧图集只替换本图集自动创建的成员，不动手动加入或其他目录图片',()=>{
 const pkg={root:'R',rel:'符文'},models=[{uid:'auto',sourceRoot:'R',sourceRel:'符文/a.png'},{uid:'manual',sourceRoot:'R',sourceRel:'符文/b.png'},{uid:'other',sourceRoot:'R',sourceRel:'符文其他/a.png'}];
 assert.deepEqual(legacyAlbumMembers(pkg,models,['auto','other']),['auto']);
});
