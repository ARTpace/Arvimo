// 资产包识别：一个下载资产必须只出一张卡，包内的贴图/模型不能再各自成卡。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scanLibraryPackages,assetCategory} from '../server/local-assets.mjs';

function sandbox(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assetvault-pack-'));
 const write=(rel,data='x')=>{const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
 return {root,write,done:()=>fs.rmSync(root,{recursive:true,force:true})};
}

/** 最小 ZIP：全部 stored（不压缩），够读出中央目录和 info.json 即可。 */
function storedZip(files){
 const chunks=[];const central=[];let offset=0;
 for(const [name,data] of Object.entries(files)){
  const nameBuf=Buffer.from(name,'utf8'),body=Buffer.from(data);
  const crc=(()=>{let c=0xffffffff;for(const b of body){c^=b;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;}return (c^0xffffffff)>>>0;})();
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(nameBuf.length,26);
  chunks.push(local,nameBuf,body);
  const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50,0);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(body.length,20);entry.writeUInt32LE(body.length,24);entry.writeUInt16LE(nameBuf.length,28);entry.writeUInt32LE(offset,42);
  central.push(entry,nameBuf);
  offset+=30+nameBuf.length+body.length;
 }
 const cd=Buffer.concat(central),head=Buffer.concat(chunks);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(head.length,16);
 return Buffer.concat([head,cd,end]);
}

test('a folder with info.json becomes one package and hides its textures',async()=>{
 const box=sandbox();
 try{
  box.write('道具/Chair-aaaaaaaa/info.json',JSON.stringify({uid:'a'.repeat(32),title:'Chair',author:'Rob',kind:'model',format:'fbx',license:'CC0'}));
  box.write('道具/Chair-aaaaaaaa/Chair.fbx','mesh');
  box.write('道具/Chair-aaaaaaaa/textures/color.jpg','img');
  box.write('道具/Chair-aaaaaaaa/Chair.unpacked/dup.jpg','dup');
  const {packages,files}=await scanLibraryPackages({roots:[box.root]});
  assert.equal(packages.length,1);
  assert.equal(files.length,0,'包内文件不再单独成卡');
  const pkg=packages[0];
  assert.equal(pkg.category,'model');
  assert.equal(pkg.title,'Chair');
  assert.equal(pkg.entry,'Chair.fbx');
  assert.match(pkg.cover,/textures\/color\.jpg$/);
  assert.equal(pkg.fileCount,2,'.unpacked 不进统计，避免同一内容算两遍');
  assert.ok(pkg.entries.length===2);
 }finally{box.done();}
});

test('loose material files outside any package still show up individually',async()=>{
 const box=sandbox();
 try{
  box.write('我的素材/wood.png','img');
  const {packages,files}=await scanLibraryPackages({roots:[box.root]});
  assert.equal(packages.length,0);
  assert.deepEqual(files.map(file=>file.rel),['我的素材/wood.png']);
 }finally{box.done();}
});

test('material and hdri packages are categorised for the type filter',async()=>{
 const box=sandbox();
 try{
  box.write('m/info.json',JSON.stringify({uid:'b'.repeat(32),title:'Fabric',kind:'material',resolution:'2K'}));
  box.write('m/textures/Color.jpg','img');
  box.write('h/info.json',JSON.stringify({uid:'c'.repeat(32),title:'Sky',kind:'hdri',format:'HDR'}));
  box.write('h/sky.hdr','hdr');
  box.write('i/info.json',JSON.stringify({uid:'d'.repeat(32),title:'Renders',kind:'images',images:[{file:'images/01.png'}]}));
  box.write('i/images/01.png','img');
  const {packages}=await scanLibraryPackages({roots:[box.root]});
  const byTitle=Object.fromEntries(packages.map(pkg=>[pkg.title,pkg.category]));
  assert.deepEqual(byTitle,{Fabric:'material',Sky:'skybox',Renders:'images'});
  assert.equal(assetCategory({kind:'pack'}),'model','资源包按模型归类');
 }finally{box.done();}
});

test('a bare zip carrying info.json counts as one package',async()=>{
 const box=sandbox();
 try{
  fs.writeFileSync(path.join(box.root,'Study-1234abcd.zip'),storedZip({
   'info.json':JSON.stringify({uid:'e'.repeat(32),title:'Study',kind:'model',format:'glb'}),
   'scene.glb':'glTF',
   'textures/a.png':'img',
  }));
  const {packages,files}=await scanLibraryPackages({roots:[box.root]});
  assert.equal(files.length,0,'zip 不再作为零散文件出现');
  assert.equal(packages.length,1);
  assert.equal(packages[0].type,'zip');
  assert.equal(packages[0].title,'Study');
  assert.equal(packages[0].fileCount,2,'清单里不列 info.json 自身');
 }finally{box.done();}
});

test('the same uid on disk twice yields one card with a copy count',async()=>{
 const box=sandbox();
 try{
  const info=JSON.stringify({uid:'f'.repeat(32),title:'Shiba',kind:'model'});
  box.write('A/info.json',info);box.write('A/Shiba.glb','glb');
  box.write('B/info.json',info);box.write('B/Shiba.glb','glb');
  const {packages}=await scanLibraryPackages({roots:[box.root]});
  assert.equal(packages.length,1);
  assert.equal(packages[0].copies,2);
 }finally{box.done();}
});

// 用户自己整理/拷进资产库的素材包没有 info.json，但也必须「一个文件夹＝一张卡」：
// 70 张 alpha 若逐文件出卡，就是 70 张没有缩略图的行卡（2026-10-21 用户反馈）。
test('a plain folder of images becomes one image package with a cover and previewable entries',async()=>{
 const box=sandbox();
 try{
  for(const n of ['Ornament10','Ornament2','Ornament1'])box.write(`纹饰/JRO/${n}_out.png`,'png');
  const {packages,files}=await scanLibraryPackages({roots:[box.root]});
  assert.equal(files.length,0,'包内图片不该再单独出卡');
  assert.equal(packages.length,1);
  const [pkg]=packages;
  assert.equal(pkg.category,'images');
  assert.equal(pkg.title,'JRO');
  assert.equal(pkg.fileCount,3);
  // 自然序：Ornament2 要排在 Ornament10 前面，封面不能挑到 10 号。
  assert.equal(pkg.cover,'Ornament1_out.png');
  // 缩略图墙靠 entries[].rel 拼文件地址，只给 name 会让每张图都指向根目录。
  assert.deepEqual(pkg.entries.map(item=>item.rel),['Ornament1_out.png','Ornament2_out.png','Ornament10_out.png']);
 }finally{box.done();}
});

// 一堆模型摊在同一层是「模型合集」，不是单个资产：仍然逐个文件出卡。
test('a folder collecting many models stays loose instead of collapsing into one card',async()=>{
 const box=sandbox();
 try{
  for(const n of ['a','b','c'])box.write(`模型/SM_${n}.fbx`,'mesh');
  const {packages,files}=await scanLibraryPackages({roots:[box.root]});
  assert.equal(packages.length,0);
  assert.equal(files.length,3);
 }finally{box.done();}
});

// `Shapes/PNG/*.png` + `Shapes/SVG/*.svg` 是同一套素材的两种格式，合成一张卡。
test('format subfolders of the same asset merge into one package',async()=>{
 const box=sandbox();
 try{
  box.write('Shapes/PNG/a.png','png');
  box.write('Shapes/SVG/a.svg','svg');
  const {packages}=await scanLibraryPackages({roots:[box.root]});
  assert.equal(packages.length,1);
  assert.equal(packages[0].title,'Shapes');
  assert.equal(packages[0].fileCount,2);
 }finally{box.done();}
});
