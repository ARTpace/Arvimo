import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createSubstanceBridge} from '../server/substance-engine.mjs';

test('open loads an sbsar, hides output size, and renders the base color the engine writes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sre-'));
 const sbsar=path.join(dir,'Clay.sbsar');
 await fs.writeFile(sbsar,'not-a-real-archive');
 await fs.writeFile(path.join(dir,'substance_remote_engine.exe'),'');
 const seen=[];
 const bridge=createSubstanceBridge({
  dirs:[dir],
  spawnImpl:()=>({on(){},kill(){}}),
  exchange:async(_port,msg)=>{
   seen.push(msg.operation);
   if(msg.operation===25){
    await fs.writeFile(path.join(msg.data.render.path,'mat_basecolor.png'),Buffer.from([1,2,3]));
    return {code:0};
   }
   if(msg.operation===20)return {code:0,data:{substance:{uuid:'abc',graphs:[{index:0,inputs:[{id:3,identifier:'wear',label:'Wear',type:'float',value:0.4,min:0,max:1},{id:4,identifier:'$outputsize',label:'Size',type:'int2',value:[8,8]}],outputs:[{identifier:'basecolor'}]}]}}};
   return {code:0};
  },
 });
 try{
  const opened=await bridge.open(sbsar);
  assert.equal(opened.uuid,'abc');
  assert.deepEqual(opened.inputs.map(input=>input.identifier),['wear']);
  assert.equal(opened.images.basecolor,'mat_basecolor.png');
  const image=await bridge.readImage(opened.images.basecolor);
  assert.equal(image.data.length,3);
  assert.deepEqual(seen.filter(op=>op===20||op===25).length>=2,true);
 }finally{await bridge.stop();await fs.rm(dir,{recursive:true,force:true});}
});
