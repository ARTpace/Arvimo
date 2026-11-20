import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {parseCivitaiUrl,civitaiUid,civitaiFiles,pickCivitaiFile,civitaiSearch,civitaiResolve,runCivitaiJob} from '../server/civitai.mjs';
import {modelSnapshot,JOB_KINDS} from '../server/downloads.mjs';
import {verifyFolder} from '../server/folder-archive.mjs';
import {jobKindOf} from '../src/library/platforms.js';

const model={
 id:'123456',name:'木纹 LoRA',creator:{username:'tester'},license:{name:'Open Rail'},tags:['wood','style'],
 modelVersions:[{
  id:'654321',name:'v2',images:[{url:'https://image.civitai.com/cover.png'}],
  files:[
   {id:'f-preview',name:'preview.png',sizeKB:1,downloadUrl:'https://cdn.civitai.com/preview.png'},
   {id:'f-model',name:'wood_lora.safetensors',sizeKB:4,primary:false,sha256:'a'.repeat(64),downloadUrl:'https://cdn.civitai.com/wood_lora.safetensors'},
  ],
 }],
};
const modelJson=JSON.stringify(model);
const versionJson=JSON.stringify(model.modelVersions[0]);
const fakeRead=async url=>({body:Buffer.from(String(url).includes('/model-versions/')?versionJson:modelJson)});
const payload=Buffer.alloc(4096,7);
const fakeOpen=async()=>({status:200,headers:{'content-length':String(payload.length)},stream:Readable.from([payload])});

test('URL parsing accepts model pages and version links, refuses other hosts',()=>{
 assert.deepEqual(parseCivitaiUrl('https://civitai.com/models/123456'),{modelId:'123456',versionId:'',url:'https://civitai.com/models/123456'});
 assert.equal(parseCivitaiUrl('https://www.civitai.com/models/123456?modelVersionId=654321').versionId,'654321');
 assert.equal(parseCivitaiUrl('https://civitai.com/api/download/models/654321').versionId,'654321');
 assert.throws(()=>parseCivitaiUrl('https://example.com/models/1'),/只支持/);
 assert.match(civitaiUid('123456','654321'),/^[a-f0-9]{32}$/);
});

test('file selection prefers weights over previews and honours explicit fileId',()=>{
 const files=civitaiFiles(model.modelVersions[0]);
 assert.equal(files.length,2);
 assert.equal(pickCivitaiFile(model.modelVersions[0]).id,'f-model');
 assert.equal(pickCivitaiFile(model.modelVersions[0],'f-preview').id,'f-preview');
 assert.throws(()=>pickCivitaiFile(model.modelVersions[0],'missing'),/已不存在/);
});

test('search returns one card per version with model fields preserved',async()=>{
 const data=await civitaiSearch({q:'wood'},{read:async()=>({body:Buffer.from(JSON.stringify({items:[model],metadata:{}}))})});
 assert.equal(data.models.length,1);
 assert.equal(data.models[0].platform,'civitai');
 assert.equal(data.models[0].versionId,'654321');
 assert.equal(data.models[0].fileId,'f-model');
 assert.ok(data.models[0].tags.includes('wood'));
 const empty=await civitaiSearch({},{read:fakeRead});
 assert.deepEqual(empty.models,[]);
});

test('resolve accepts a pasted model page and exposes the file list',async()=>{
 const resolved=await civitaiResolve('https://civitai.com/models/123456',{read:fakeRead});
 assert.equal(resolved.modelId,'123456');
 assert.equal(resolved.versionId,'654321');
 assert.equal(resolved.files[1].name,'wood_lora.safetensors');
});

test('modelSnapshot exports the ids the runner needs, and jobKindOf routes to civitai',()=>{
 assert.ok(JOB_KINDS.has('civitai'));
 const card=civitaiUid('123456','654321')&&{
  uid:civitaiUid('123456','654321'),platform:'civitai',name:'木纹 LoRA',
  modelId:'123456',versionId:'654321',fileId:'f-model',url:'https://civitai.com/models/123456?modelVersionId=654321',
 };
 const snap=modelSnapshot(card,'civitai');
 assert.equal(snap.kind,'civitai');
 assert.equal(snap.modelId,'123456');
 assert.equal(snap.versionId,'654321');
 assert.equal(snap.fileId,'f-model');
 assert.equal(jobKindOf([card]),'civitai');
 assert.equal(jobKindOf([card,{platform:'sketchfab'}]),null);
});

test('runner writes the model and a verifiable info.json, then verifyFolder accepts it',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-civitai-'));
 try{
  const output=path.join(dir,'staged');
  const meta=await runCivitaiJob({
   uid:civitaiUid('123456','654321'),modelId:'123456',versionId:'654321',fileId:'f-model',
   url:'https://civitai.com/models/123456?modelVersionId=654321',name:'木纹 LoRA',author:'tester',tags:['wood'],output,
  },{read:fakeRead,open:fakeOpen});
  assert.match(meta.zipName,/木纹 LoRA/);
  const info=JSON.parse(await fs.readFile(path.join(output,'info.json'),'utf8'));
  assert.equal(info.platform,'civitai');
  assert.equal(info.files[0].file,'wood_lora.safetensors');
  assert.equal(info.files[0].bytes,payload.length);
  const verification=await verifyFolder(output,{uid:info.uid});
  assert.equal(verification.bytes>payload.length,true);
  assert.equal(verification.info.modelId,'123456');
  // A truncated payload must be rejected instead of being stored as a valid asset.
  await fs.writeFile(path.join(output,'wood_lora.safetensors'),Buffer.alloc(10,7));
  await assert.rejects(()=>verifyFolder(output,{uid:info.uid}),/不完整/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
