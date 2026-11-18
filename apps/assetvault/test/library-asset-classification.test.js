import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {classifyAsset,materialSets} from '../src/library/asset-classification.js';
import {inspectAssetFormat,effectiveMime,sniffAssetExtensionFromBuffer} from '../server/image-sniff.mjs';
import {assetCategory} from '../server/local-assets.mjs';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {repairAssetTypes} from '../server/asset-type-repair.mjs';
import {importLibrary,normalizeSnapshot,PORTABLE_FORMAT,PORTABLE_VERSION} from '../server/library-portable.mjs';
import {localTypeFacets} from '../src/library/local-type-tree.js';

test('主模型优先于贴图附件，未知不强行归模型',()=>{
 const entries=[{name:'chair.fbx'},{name:'chair_basecolor.png'},{name:'chair_normal.png'},{name:'readme.pdf'}];
 assert.equal(classifyAsset({entries}).kind,'models');
 assert.equal(assetCategory({kind:'model',textures:['color.png']},'',entries),'model');
 assert.equal(classifyAsset({filePath:'stuff.zip'}).kind,'unknown');
 assert.equal(classifyAsset({}).needsReview,true);
 assert.equal(classifyAsset({entries:[{name:'index.html'},{name:'style.css'}]}).kind,'documents');
 assert.equal(materialSets(['wood_basecolor.png','wood_normal.png']),true);
 assert.equal(materialSets(['wood_basecolor.png','rock_normal.png']),false);
});
test('文件头冲突按内容处理，无法确认不谎称验证成功',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'arvimo-format-'));
 try{
  const file=path.join(dir,'wrong.fbx');
  writeFileSync(file,Buffer.from([137,80,78,71,13,10,26,10]));
  const check=inspectAssetFormat(file);
  assert.equal(check.detected,'png');assert.equal(check.conflict,true);
  assert.equal(effectiveMime(file),'image/png');
  assert.equal(classifyAsset({assetType:'model',formatCheck:check}).kind,'images');
  assert.equal(classifyAsset({assetType:'model',formatCheck:check,typeOverride:'textures'}).kind,'textures');
  writeFileSync(path.join(dir,'mesh.obj'),'v 0 0 0');
  assert.equal(inspectAssetFormat(path.join(dir,'mesh.obj')).evidence,'extension');
  assert.equal(sniffAssetExtensionFromBuffer(Buffer.from('%PDF-1.7')),'pdf');
  const office=path.join(dir,'report.docx');writeFileSync(office,Buffer.from('PK\x03\x04'));
  assert.equal(inspectAssetFormat(office).effective,'docx');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('用户类别优先并可随快照保留，待分类在侧栏独立列出',()=>{
 const asset={uid:'a'.repeat(32),platform:'sketchfab',assetType:'model',typeOverride:'images'};
 const snapshot=normalizeSnapshot({format:PORTABLE_FORMAT,version:PORTABLE_VERSION,assets:[asset]});
 assert.equal(snapshot.assets[0].typeOverride,'images');
 assert.equal(classifyAsset(snapshot.assets[0]).kind,'images');
 const groups=localTypeFacets({models:[{}]});
 assert.equal(groups.find(group=>group.id==='unknown').count,1);
});

test('分类纠正单条落库，重开和格式修复不覆盖用户选择',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'arvimo-type-save-'));
 let storage=createLibraryStorage(dir);
 try{
  const file=path.join(dir,'asset');writeFileSync(file,Buffer.from([137,80,78,71,13,10,26,10]));
  const uid='b'.repeat(32);
  await importLibrary({storage,mode:'merge',payload:{format:PORTABLE_FORMAT,version:PORTABLE_VERSION,assets:[{uid,platform:'local',assetType:'other',filePath:file,ext:''}]}});
  const result=await storage.mutateAssets([{op:'asset:patch',uid,patch:{typeOverride:'textures'}}]);
  assert.equal(result.applied,1);
  await repairAssetTypes({storage});
  await storage.close();storage=createLibraryStorage(dir);
  const rows=await storage.withDb(conn=>conn.all('SELECT payload,kind FROM assets WHERE uid = ?',[uid]));
  const model=JSON.parse(rows[0].payload);
  assert.equal(model.typeOverride,'textures');assert.equal(rows[0].kind,'textures');
  assert.equal(classifyAsset(model).kind,'textures');
 }finally{await storage.close();rmSync(dir,{recursive:true,force:true});}
});

test('PNG天空盒用途优先于图片文件头，普通宽屏和用户纠正不误判',()=>{
 const model={platform:'local',assetType:'image',filePath:'J:/资产库/HDR/卡通/Anubis1.png',formatCheck:{detected:'png',width:4096,height:2048}};
 assert.equal(classifyAsset(model).kind,'hdris');
 assert.equal(classifyAsset({...model,typeOverride:'images'}).kind,'images');
 assert.equal(classifyAsset({...model,filePath:'J:/壁纸/wide.png'}).kind,'images');
 assert.equal(classifyAsset({...model,formatCheck:{detected:'png',width:2048,height:2048}}).kind,'images');
 assert.equal(classifyAsset({...model,assetType:'model'}).kind,'images');
});
