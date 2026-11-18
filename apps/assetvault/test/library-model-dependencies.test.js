import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {modelResourceRel} from '../src/library/model-resource-path.js';
import {thumbSourceStat} from '../server/model-dependencies.mjs';

test('GLB JSON 块外部依赖变化失效，内嵌 BIN 不当外部路径，损坏块拒绝',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'av-glb-deps-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const model=path.join(root,'scene.glb');
 const raw=Buffer.from(JSON.stringify({asset:{version:'2.0'},buffers:[{byteLength:4},{uri:'mesh.bin'}],images:[{uri:'texture.png'}]}));
 const json=Buffer.alloc(Math.ceil(raw.length/4)*4,0x20);raw.copy(json);
 const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+json.length+12,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const bin=Buffer.alloc(12);bin.writeUInt32LE(4,0);bin.writeUInt32LE(0x004e4942,4);
 await fs.writeFile(model,Buffer.concat([header,json,bin]));
 const first=await thumbSourceStat(model,{root});assert.ok(first.dependencyVersion);
 await fs.writeFile(path.join(root,'texture.png'),'image');const second=await thumbSourceStat(model,{root});assert.notEqual(first.dependencyVersion,second.dependencyVersion);
 await fs.writeFile(path.join(root,'mesh.bin'),'mesh');const third=await thumbSourceStat(model,{root});assert.notEqual(second.dependencyVersion,third.dependencyVersion);
 assert.equal(first.mtimeNs,third.mtimeNs);
 header.writeUInt32LE(json.length+1000,12);await fs.writeFile(model,Buffer.concat([header,json,bin]));await assert.rejects(thumbSourceStat(model,{root}),/截断/);
 header.writeUInt32LE(json.length,12);header.writeUInt32LE(0,16);await fs.writeFile(model,Buffer.concat([header,json,bin]));await assert.rejects(thumbSourceStat(model,{root}),/无效/);
});

test('glTF 相对 URI 保留子目录和编码名称，允许根内上级，拒绝越界/网络/设备路径',()=>{
 assert.equal(modelResourceRel('models/scene.gltf','textures/a%20b.png'),'models/textures/a b.png');
 assert.equal(modelResourceRel('models/scene.gltf','../shared/a.png?version=1'),'shared/a.png');
 assert.equal(modelResourceRel('scene.gltf','a.png'),'a.png');
 for(const uri of ['../../a.png','/a.png','C:/a.png','https://example.com/a.png','%2e%2e/%2e%2e/a.png','%00.png','%xx'])assert.throws(()=>modelResourceRel('models/scene.gltf',uri));
});

test('glTF 缓存仅复用 URI 解析，贴图/bin/缺失变化每次核验，不改模型也会换依赖版本',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'av-deps-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const model=path.join(root,'model.gltf');await fs.mkdir(path.join(root,'textures'));
 await fs.writeFile(model,JSON.stringify({asset:{version:'2.0'},buffers:[{uri:'mesh.bin'}],images:[{uri:'textures/a.png'},{uri:'data:image/png;base64,AA=='}]}));
 const first=await thumbSourceStat(model,{root});await fs.writeFile(path.join(root,'mesh.bin'),'mesh');
 const second=await thumbSourceStat(model,{root});assert.notEqual(first.dependencyVersion,second.dependencyVersion);
 await fs.writeFile(path.join(root,'textures/a.png'),'texture');const third=await thumbSourceStat(model,{root});assert.notEqual(second.dependencyVersion,third.dependencyVersion);
 await fs.appendFile(path.join(root,'mesh.bin'),'changed');const fourth=await thumbSourceStat(model,{root});assert.notEqual(third.dependencyVersion,fourth.dependencyVersion);
 assert.equal(first.mtimeNs,fourth.mtimeNs);assert.equal(fourth.dependencyVersion,(await thumbSourceStat(model,{root})).dependencyVersion);
 await fs.unlink(path.join(root,'textures/a.png'));assert.notEqual(fourth.dependencyVersion,(await thumbSourceStat(model,{root})).dependencyVersion);
});

test('外部引用越界、链接和超限不会生成可采信版本',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'av-deps-invalid-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const model=path.join(root,'model.gltf');
 await fs.writeFile(model,JSON.stringify({images:[{uri:'../outside.png'}]}));await assert.rejects(thumbSourceStat(model,{root}),/越过/);
 await fs.mkdir(path.join(root,'target'));await fs.writeFile(path.join(root,'target','image.png'),'image');
 await fs.symlink(path.join(root,'target'),path.join(root,'link'),process.platform==='win32'?'junction':'dir');
 await fs.writeFile(model,JSON.stringify({images:[{uri:'link/image.png'}]}));await assert.rejects(thumbSourceStat(model,{root}),/链接/);
 await fs.writeFile(model,JSON.stringify({images:Array.from({length:129},(_,i)=>({uri:`${i}.png`}))}));await assert.rejects(thumbSourceStat(model,{root}),/128/);
});
