import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryStorage,restoreLibraryCovers,stateFileFor} from '../server/library-storage.mjs';
import {mergeModels,collectModels} from '../src/library/library-state.js';
import {createPersistentStorage} from '../src/library/persistent-storage.js';

test('recovered exports regain cached covers without replacing existing covers or adding assets',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-covers-'));
 try{
  const uid='a'.repeat(32),thumbnail='https://example.com/cover.jpg';
  await fs.writeFile(path.join(dir,'b'.repeat(64)),JSON.stringify({models:[{uid,thumbnail},{uid:'c'.repeat(32),url:'https://polyhaven.com/a/chair',thumbnail}]}));
  const values={'sfx-library-v2':JSON.stringify({models:[{uid,name:'Original',tags:['custom']}],favorites:[uid]})};
  const result=await restoreLibraryCovers(values,[{uid,thumbnail:null}],dir);
  const state=JSON.parse(result.values['sfx-library-v2']);
  assert.equal(state.models.length,1);assert.equal(state.models[0].thumbnail,thumbnail);
  assert.deepEqual(state.models[0].tags,['custom']);assert.deepEqual(state.favorites,[uid]);
  assert.equal(result.recovered[0].thumbnail,thumbnail);
  const imageResult=await restoreLibraryCovers({},[{uid:'d'.repeat(32),kind:'images',url:'https://polyhaven.com/a/chair/'}],dir);
  assert.equal(imageResult.recovered[0].thumbnail,thumbnail);
  const existing={uid,thumbnail};
  assert.equal(mergeModels([existing],[{uid,thumbnail:null}])[0].thumbnail,thumbnail);
  assert.equal(collectModels([existing],[{uid,thumbnail:''}]).models[0].thumbnail,thumbnail);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('frontend restores downloads and favorites across different page storage origins',async()=>{
 const values={};
 const uid='b'.repeat(32);
 const request=async(_url,options)=>{
  if(options.method==='POST'){Object.assign(values,JSON.parse(options.body));return {ok:true};}
  return {ok:true,json:async()=>({values:{...values},recovered:[{uid,name:'Recovered'}]})};
 };
 const local=new Map();const cache={getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,value)};
 const first=await createPersistentStorage(cache,request);
 assert.equal(JSON.parse(first.getItem('sfx-library-v2')).models[0].uid,uid);
 const saved={models:[],favorites:[uid],aiTags:{[uid]:['robot','机器人']}};
 first.setItem('sfx-library-v2',JSON.stringify(saved));
 await new Promise(resolve=>setImmediate(resolve));
 const second=await createPersistentStorage({getItem:()=>null,setItem(){}},request);
 assert.deepEqual(JSON.parse(second.getItem('sfx-library-v2')),saved);
});
test('pending saves merge keys and keep the latest value without concurrent writes',async()=>{
 const posts=[];let release;
 const request=async(_url,options)=>{
  if(options.method!=='POST')return {ok:true,json:async()=>({values:{'sfx-library-v2':'{}'}})};
  posts.push(JSON.parse(options.body));
  if(posts.length===1)await new Promise(resolve=>{release=resolve;});
  return {ok:true};
 };
 const storage=await createPersistentStorage({getItem:()=>null,setItem(){}},request);
 storage.setItem('sfx-library-v2','first');storage.setItem('sfx-library-ui','ui');
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(posts,[{'sfx-library-v2':'first','sfx-library-ui':'ui'}]);
 storage.setItem('sfx-library-v2','obsolete');storage.setItem('sfx-library-v2','latest');
 storage.setItem('sfx-discovery-v1','discovery');
 assert.equal(posts.length,1);assert.equal(storage.getItem('sfx-library-v2'),'latest');
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(posts[1],{'sfx-library-v2':'latest','sfx-discovery-v1':'discovery'});
});

test('library persists across server instances, recovers existing downloads and preserves removals',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-storage-'));
 try{
  const downloads={snapshot:()=>({jobs:[{uid:'a'.repeat(32),state:'saved',fileExists:true,name:'Saved'},{state:'saved',fileExists:false},{state:'failed',fileExists:true}]})};
  const first=createLibraryStorage(dir,downloads);
  assert.equal((await first.load()).recovered.length,1);
  const saved=JSON.stringify({models:[],favorites:['a'.repeat(32)],aiTags:{['a'.repeat(32)]:['robot','机器人']}});
  await Promise.all([first.save({'sfx-library-v2':saved}),first.save({'sfx-library-ui':'{}'})]);
  const second=createLibraryStorage(dir,downloads);
  assert.equal((await second.load()).values['sfx-library-v2'],saved);
  assert.equal((await second.load()).values['sfx-library-ui'],'{}');
  assert.throws(()=>first.save({'../../outside':'bad'}));
  await fs.writeFile(stateFileFor(dir,'sfx-library-v2'),'invalid');
  await assert.rejects(second.load(),/保留原文件/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
