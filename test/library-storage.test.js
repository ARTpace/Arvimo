import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {createPersistentStorage} from '../src/library/persistent-storage.js';
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
  await fs.writeFile(path.join(dir,'library-state.json'),'invalid');
  await assert.rejects(second.load(),/保留原文件/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
