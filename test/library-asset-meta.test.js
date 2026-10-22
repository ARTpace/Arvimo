// 资产元信息 info.json：登记写一次事实，AI 只补 ai 段，已有文件绝不改写。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readMeta,deriveUid,registerPackage,patchAi,writeMeta,META_SCHEMA} from '../server/asset-meta.mjs';
import {scanLibraryPackages} from '../server/local-assets.mjs';

function sandbox(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assetvault-meta-'));
 const write=(rel,data='x')=>{const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
 return {root,write,done:()=>fs.rmSync(root,{recursive:true,force:true})};
}

/** 直接问扫描器要一个真实的包条目，别自己手搓 describe 的输出形状。 */
async function packOf(root,rel){
 const {packages}=await scanLibraryPackages({roots:[root]});
 const pkg=packages.find(item=>item.rel===rel);
 assert.ok(pkg,`扫描没找到包 ${rel}`);
 return pkg;
}

test('info.json：登记写出 schema v1 的完整事实字段',async()=>{
 const box=sandbox();
 try{
  box.write('日式纹饰/a.png','alpha-a');
  box.write('日式纹饰/b.png','alpha-b');
  const pkg=await packOf(box.root,'日式纹饰');
  const result=await registerPackage(path.join(box.root,'日式纹饰'),pkg);
  assert.equal(result.skipped,false);
  const meta=readMetaSync(path.join(box.root,'日式纹饰'));
  assert.equal(meta.schemaVersion,META_SCHEMA);
  assert.equal(meta.uid,result.uid);
  assert.match(meta.uid,/^local-[a-f0-9]{32}$/);
  assert.equal(meta.title,'日式纹饰');
  assert.equal(meta.kind,'images');
  assert.equal(meta.source,'local-import');
  assert.equal(meta.package.fileCount,2);
  assert.equal(meta.package.images,2);
  assert.equal(meta.package.cover,'a.png');
  assert.deepEqual(meta.movedFrom,[]);
 }finally{box.done();}
});

test('info.json：同一份内容派生出同一个 uid，内容一变 uid 就变',async()=>{
 const box=sandbox();
 try{
  for(const dir of ['one','two']){box.write(`${dir}/a.png`,'same-bytes');box.write(`${dir}/b.png`,'same-bytes-2');}
  box.write('three/a.png','other-bytes');
  box.write('three/b.png','other-bytes-2');
  const uidOne=await deriveUid(path.join(box.root,'one'),await packOf(box.root,'one'));
  const uidTwo=await deriveUid(path.join(box.root,'two'),await packOf(box.root,'two'));
  const uidThree=await deriveUid(path.join(box.root,'three'),await packOf(box.root,'three'));
  assert.equal(uidOne,uidTwo);
  assert.notEqual(uidOne,uidThree);
 }finally{box.done();}
});

test('info.json：已经有可解析的 info.json 时，登记不改写一个字节',async()=>{
 const box=sandbox();
 try{
  box.write('pack/a.png','alpha');
  const original=JSON.stringify({uid:'abcdef0123456789abcdef0123456789',title:'平台原始标题',kind:'images'},null,2);
  box.write('pack/info.json',original);
  const pkg=await packOf(box.root,'pack');
  const result=await registerPackage(path.join(box.root,'pack'),pkg);
  assert.equal(result.skipped,true);
  assert.equal(fs.readFileSync(path.join(box.root,'pack','info.json'),'utf8'),original);
 }finally{box.done();}
});

test('info.json：坏掉的 info.json 能被重新登记成合法文件（原文件先备份意识留给用户）',async()=>{
 const box=sandbox();
 try{
  box.write('pack/a.png','alpha');
  box.write('pack/b.png','alpha2');
  box.write('pack/info.json','{"uid": "half');   // 半截写入的典型形态
  const pkg=await packOf(box.root,'pack');
  assert.equal(pkg.hasMeta,false,'解析不了的 info.json 不算已登记');
  const result=await registerPackage(path.join(box.root,'pack'),pkg);
  assert.equal(result.skipped,false);
  assert.match(readMetaSync(path.join(box.root,'pack')).uid,/^local-/);
  assert.equal(fs.existsSync(path.join(box.root,'pack','info.json.tmp')),false);
 }finally{box.done();}
});

test('info.json：AI 只补 ai 段，事实字段原样保留',async()=>{
 const box=sandbox();
 try{
  box.write('pack/a.png','alpha');
  box.write('pack/b.png','alpha2');
  const pkg=await packOf(box.root,'pack');
  const {uid}=await registerPackage(path.join(box.root,'pack'),pkg);
  await patchAi(path.join(box.root,'pack'),{tags:[{value:'日式纹饰',group:'题材'}]});
  const meta=readMetaSync(path.join(box.root,'pack'));
  assert.equal(meta.uid,uid);
  assert.equal(meta.title,'pack');
  assert.equal(meta.ai.tags[0].value,'日式纹饰');
 }finally{box.done();}
});

test('info.json：没登记就写 AI 标签会明确报错，不会凭空造一个包',async()=>{
 const box=sandbox();
 try{
  box.write('pack/a.png','alpha');
  box.write('pack/b.png','alpha2');
  await assert.rejects(()=>patchAi(path.join(box.root,'pack'),{tags:[]}),/先登记/);
  assert.equal(fs.existsSync(path.join(box.root,'pack','info.json')),false);
 }finally{box.done();}
});

test('info.json：原子写校验拦得住非法内容',async()=>{
 const box=sandbox();
 try{
  fs.mkdirSync(path.join(box.root,'pack'),{recursive:true});
  const broken={};
  broken.self=broken;               // JSON.stringify 会抛循环引用
  await assert.rejects(()=>writeMeta(path.join(box.root,'pack'),broken));
  assert.equal(fs.existsSync(path.join(box.root,'pack','info.json')),false);
  assert.equal(fs.existsSync(path.join(box.root,'pack','info.json.tmp')),false);
 }finally{box.done();}
});

function readMetaSync(dir){
 return JSON.parse(fs.readFileSync(path.join(dir,'info.json'),'utf8'));
}

test('info.json：登记后的包再扫描，uid / 标题 / 分类都从文件里读回来',async()=>{
 const box=sandbox();
 try{
  box.write('res/日式纹饰/PNG/a.png','alpha-a');
  box.write('res/日式纹饰/PNG/b.png','alpha-b');
  const before=await packOf(box.root,'res/日式纹饰');
  assert.equal(before.uid,'');
  await registerPackage(path.join(box.root,'res','日式纹饰'),before);
  const after=await packOf(box.root,'res/日式纹饰');
  assert.match(after.uid,/^local-/);
  assert.equal(after.hasMeta,true);
  assert.equal(after.category,'images');
 }finally{box.done();}
});
