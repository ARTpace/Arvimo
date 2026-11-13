import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {filterLocalAssets,localFileState,localAssetKind,localAssetCategories} from '../src/library/local-filters.js';

test('local categories combine metadata and tags independently of discovery filters',()=>{
 const models=[{uid:'a',category:'道具',categories:[{name:'武器'}],tags:['金属','道具'],userTags:['游戏']},{uid:'b',tags:['木材']}];
 assert.deepEqual(localAssetCategories(models[0]),['武器','道具','金属','游戏']);
 assert.deepEqual(filterLocalAssets(models,{category:'武器'},null),[models[0]]);
 assert.deepEqual(filterLocalAssets(models,{category:'木材',search:'不存在'},null),[]);
 assert.deepEqual(filterLocalAssets(models,{},null),models);
});

test('file status uses any available saved version before reporting missing',()=>{
 const jobs=[{id:'4k',uid:'a',state:'saved',fileExists:false,options:{resolution:'4K'}},{id:'8k',uid:'a',state:'saved',fileExists:true,options:{resolution:'8K'}}];
 assert.equal(localFileState(jobs,'a'),'downloaded');
 assert.equal(localFileState(jobs.slice(0,1),'a'),'missing');
 assert.equal(localFileState([{id:'old',uid:'a',state:'sent'}],'a'),'untracked');
 assert.equal(localFileState([{id:'pending',uid:'a',state:'running'}],'a'),'untracked');
});

test('mixed asset types map to the matching local category',()=>{
 for(const [model,kind] of [
  [{platform:'ambientcg'},'textures'],[{platform:'kenney'},'packs'],
  [{platform:'polyhaven',assetType:'hdris'},'hdris'],
  [{platform:'freestylized',assetType:'skybox'},'hdris'],
  [{platform:'freestylized',assetType:'smart'},'textures'],
  [{platform:'freestylized',assetType:'alphas'},'images'],
  [{platform:'artstation',hasMarmoset:false},'images'],
  [{platform:'artstation',hasMarmoset:true},'models'],
  [{platform:'sketchfab'},'models'],
 ])assert.equal(localAssetKind(model),kind);
});

test('type, status and normalized search compose without mutating the library',()=>{
 const models=[{uid:'a',platform:'ambientcg',name:'Wood',author:'Alice',tags:['Oak']},{uid:'b',platform:'sketchfab',name:'Chair'}];
 const jobs=[{id:'a4k',uid:'a',state:'saved',fileExists:true}];
 assert.deepEqual(filterLocalAssets(models,{kind:'textures',status:'downloaded',search:' OAK '},jobs),[models[0]]);
 assert.deepEqual(filterLocalAssets(models,{search:' ALICE '},jobs),[models[0]]);
 assert.deepEqual(filterLocalAssets(models,{status:'untracked'},jobs),[models[1]]);
 assert.deepEqual(filterLocalAssets(models,{status:'downloaded'},null),[]);
 assert.equal(filterLocalAssets(models,{},null).length,2);
 assert.equal(models.length,2);
});

test('startup restores page size after loading the discovery snapshot',()=>{
 const source=fs.readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8');
 const start=source.indexOf('state.pageSize=');
 const declaration=source.indexOf('const savedDiscovery=');
 const end=Math.max(source.indexOf(';',start),source.indexOf(';',declaration))+1;
 const snippet=source.slice(Math.min(start,declaration),end);
 for(const snapshot of [null,{pageSize:96},{pageSize:7}]){
  const context={state:{},storage:{},loadDiscovery:()=>snapshot};
  vm.runInNewContext(snippet,context);
  assert.equal(context.state.pageSize,snapshot?.pageSize===96?96:48);
 }
});
