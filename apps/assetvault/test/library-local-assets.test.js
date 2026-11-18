// 资产包识别：一个下载资产必须只出一张卡，包内的贴图/模型不能再各自成卡。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scanLibraryPackages,assetCategory,catalogUidsForRemovedPaths} from '../server/local-assets.mjs';

function sandbox(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assetvault-pack-'));
 const write=(rel,data='x')=>{const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
 return {root,write,done:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('TIF、TIFF、TGA 图集也能选出封面',async()=>{
 const box=sandbox();
 try{
  for(const ext of ['tif','tiff','tga']){
   box.write(`图集-${ext}/alpha_01.${ext}`);box.write(`图集-${ext}/alpha_02.${ext}`);
  }
  const {packages}=await scanLibraryPackages({roots:[box.root]});
  assert.equal(packages.length,3);
  for(const pkg of packages)assert.ok(pkg.cover?.endsWith('.'+pkg.rel.split('-').pop()));
 }finally{box.done();}
});

test('复制的旧图片按磁盘新增时间排序，不改写原始修改时间',async()=>{
 const box=sandbox();
 try{
  box.write('图集/a.psd');box.write('图集/b.psd');box.write('single.png');
  const old=new Date('2019-12-08T00:00:00Z');
  for(const rel of ['图集/a.psd','图集/b.psd','single.png'])fs.utimesSync(path.join(box.root,rel),old,old);
  const {packages,files}=await scanLibraryPackages({roots:[box.root]});
  for(const item of [...packages,...files]){
   assert.equal(item.mtime,old.getTime());
   assert.ok(item.addedAt>old.getTime());
  }
 }finally{box.done();}
});

test('手动复制的 PSD 目录保留本层图片和命名子图集，混合文件不吞并',async()=>{
 const box=sandbox();
 try{
  const base='图片/纹理贴图/岩石裂缝笔刷 Alpha Brushes';
  box.write(`${base}/Crack_01_Alpha.psd`);
  box.write(`${base}/Crack_02_Alpha.psd`);
  box.write(`${base}/裂纹/Alpha_01_Clean.psd`);
  box.write(`${base}/裂纹/Alpha_02_Clean.psd`);
  box.write('混合/a.png');box.write('混合/b.png');box.write('混合/模型/item.fbx');
  const packageCache=new Map();
  const {packages,files}=await scanLibraryPackages({roots:[box.root],packageCache});
  const album=packages.find(item=>item.rel===base);
  assert.ok(album);assert.equal(album.category,'images');assert.equal(album.fileCount,2);
  assert.equal(album.albumParent,base);assert.equal(album.title,'本层图片');
  assert.equal(packages.find(item=>item.rel===base+'/裂纹').fileCount,2);
  assert.equal(files.some(item=>item.rel.startsWith(base+'/')),false);
  assert.equal(packages.find(item=>item.rel==='混合').fileCount,2);
  assert.ok(files.some(item=>item.rel==='混合/模型/item.fbx'));
  const next=await scanLibraryPackages({roots:[box.root],packageCache,changedPaths:[]});
  assert.ok(next.packages.some(item=>item.rel===base+'/裂纹'));
 }finally{box.done();}
});

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
  assert.equal(assetCategory({kind:'pack'}),'pack','资源包单独归类，不再落进模型');
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

// 2026-11-16 用户反馈：资产库里总有几张卡「没法生成缩略图」。实机 50 个包里有 13 个没有封面，
// 全是「包里一张图都没有」的：纯 3D 包、纯 HDRI 包、以及只落了一个 pack.zip 的包。
// 这些包里的主文件本身就能现算一张图（3D 离屏渲染 / HDR tonemap / 视频抓帧），只是旧逻辑没去推。
test('只有 3D 主文件的包也给出封面：用主文件现渲一帧',async()=>{
 const box=sandbox();
 try{
  box.write('模型/Mule-1234/info.json',JSON.stringify({uid:'a'.repeat(32),title:'Mule',kind:'model',format:'GLB'}));
  box.write('模型/Mule-1234/model.glb','glTF');
  const {packages}=await scanLibraryPackages({roots:[box.root]});
  const [pkg]=packages;
  assert.equal(pkg.cover,null,'包内确实没有现成图片');
  assert.deepEqual(pkg.derivedCover,{rel:'model.glb',source:'thumb',container:''},'3D 主文件走 /api/local/thumb 现算');
 }finally{box.done();}
});

test('只有环境贴图的 HDRI 包用 .hdr 当封面，不会挑到贴图目录深处的通道图',async()=>{
 const box=sandbox();
 try{
  box.write('环境/sky-1234/info.json',JSON.stringify({uid:'b'.repeat(32),title:'Sky',kind:'hdri'}));
  box.write('环境/sky-1234/environment.hdr','hdr');
  const {packages}=await scanLibraryPackages({roots:[box.root]});
  assert.deepEqual(packages[0].derivedCover,{rel:'environment.hdr',source:'thumb',container:''});

  // 贴图目录里还躺着法线 / 金属度 EXR 时必须选层级最浅的那个环境图，否则卡面是一片灰。
  box.write('装甲/Chair-5678/info.json',JSON.stringify({uid:'c'.repeat(32),title:'Chair',kind:'model'}));
  box.write('装甲/Chair-5678/Chair.fbx','mesh');
  box.write('装甲/Chair-5678/textures/metallic_4k.exr','exr');
  const again=await scanLibraryPackages({roots:[box.root]});
  const chair=again.packages.find(item=>item.title==='Chair');
  assert.equal(chair.derivedCover.rel,'Chair.fbx','模型优先于贴图通道图');
 }finally{box.done();}
});

test('压缩包里只有 info.json 之外的图片时，从 zip 里取封面（标成 archive + 容器）',async()=>{
 const box=sandbox();
 try{
  fs.writeFileSync(path.join(box.root,'Apple-1234abcd.zip'),storedZip({
   'info.json':JSON.stringify({uid:'d'.repeat(32),title:'Apple',kind:'model'}),
   'Apple_2K_Color.jpg':'img',
   'Apple_2K_Normal.jpg':'img',
  }));
  const {packages}=await scanLibraryPackages({roots:[box.root]});
  const [pkg]=packages;
  assert.equal(pkg.cover,null,'zip 内的路径不是文件系统路径，不能塞进 cover');
  assert.equal(pkg.derivedCover.source,'archive');
  assert.equal(pkg.derivedCover.container,'','zip 包自身就是容器，前端用 pkg.rel 打开它');
  assert.match(pkg.derivedCover.rel,/Apple_2K_Color\.jpg$/,'同层级里 prioritize 底色图，不是法线图');
 }finally{box.done();}
});

test('只落到一个 pack.zip 的文件夹包，也能从压缩包里取到封面',async()=>{
 const box=sandbox();
 try{
  fs.mkdirSync(path.join(box.root,'trowel-pack'),{recursive:true});
  fs.writeFileSync(path.join(box.root,'trowel-pack','info.json'),JSON.stringify({uid:'e'.repeat(32),title:'Trowel',kind:'pack'}));
  fs.writeFileSync(path.join(box.root,'trowel-pack','pack.zip'),storedZip({
   'Trowel/textures/Trowel_Base_color.png':'img',
   'Trowel/textures/Trowel_normal.png':'img',
  }));
  const {packages}=await scanLibraryPackages({roots:[box.root]});
  const [pkg]=packages;
  assert.equal(pkg.type,'folder');
  assert.equal(pkg.cover,null);
  assert.equal(pkg.derivedCover.source,'archive');
  assert.equal(pkg.derivedCover.container,'pack.zip','解包失败只剩压缩包时，容器要指到那个 zip');
  assert.match(pkg.derivedCover.rel,/Base_color\.png$/);
 }finally{box.done();}
});


for(const layout of ['flat','textures']){
 test(`PBR folder (${layout}) becomes one material card with five maps`,async()=>{
  const box=sandbox();
  try{
   const prefix=layout==='flat'?'Wood/': 'Wood/textures/';
   const maps=['basecolor','normal','roughness','metallic','ao'];
   for(const channel of maps)box.write(`${prefix}wood_${channel}.png`,'png');
   const {packages,files}=await scanLibraryPackages({roots:[box.root]});
   assert.equal(packages.length,1);
   assert.equal(files.length,0,'PBR maps must not become separate image cards');
   const [pkg]=packages;
   assert.equal(pkg.category,'material');
   assert.equal(pkg.classification.kind,'textures');
   assert.equal(pkg.fileCount,5);
   assert.equal(pkg.entries.length,5);
   assert.equal(pkg.cover,`${layout==='flat'?'':'textures/'}wood_basecolor.png`);
  }finally{box.done();}
 });
}

const panoramaPNG=(width=4096,height=2048)=>{
 const head=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(head);head.write('IHDR',12);head.writeUInt32BE(width,16);head.writeUInt32BE(height,20);return head;
};
test('HDR目录的2:1 PNG全景图独立成天空盒卡片，保留真实PNG格式',async()=>{
 const box=sandbox();
 try{
  box.write('HDR/卡通/HDR/守望先锋HDR/Anubis1.png',panoramaPNG());
  box.write('HDR/卡通/HDR/守望先锋HDR/BUSAN1.png',panoramaPNG(8192,4096));
  const {files,packages}=await scanLibraryPackages({roots:[box.root]});
  assert.equal(packages.length,0);assert.equal(files.length,2);
  assert.ok(files.every(file=>file.kind==='env'&&file.ext==='png'));
  assert.equal(files[0].formatCheck.width>0,true);
 }finally{box.done();}
});
test('2:1普通图片没有环境线索不误判，HDR目录普通图片也不误判',async()=>{
 const box=sandbox();
 try{
  box.write('壁纸/wide.png',panoramaPNG());
  box.write('HDR/cover.png',panoramaPNG(1024,1024));
  const {files}=await scanLibraryPackages({roots:[box.root]});
  assert.equal(files.length,2);assert.ok(files.every(file=>file.kind==='image'));
 }finally{box.done();}
});

test('分类目录（分组/子类型）本身不是资产包，里面的单张图要单独出卡',async()=>{
 const box=sandbox();
 try{
  // 资产根下的「图片/其他图片」是摆放位置，不是素材包：以前 ≥2 张图会被吞成一张包卡。
  box.write('图片/其他图片/ref-a.png');
  box.write('图片/其他图片/ref-b.png');
  // 对照组：普通目录里的同套素材仍然是「一个图片素材包」。
  box.write('我自己整理的素材/aa.png');
  box.write('我自己整理的素材/bb.png');
  const {packages,files}=await scanLibraryPackages({roots:[box.root]});
  const rels=files.map(f=>f.rel).sort();
  assert.deepEqual(rels,['图片/其他图片/ref-a.png','图片/其他图片/ref-b.png']);
  assert.deepEqual(packages.map(p=>p.rel),['我自己整理的素材']);
 }finally{box.done();}
});


test('path deletion removes catalog cards and descendants without matching sibling names',()=>{
 const root=path.resolve('test-assets'),deleted=path.join(root,'models');
 const rows=[
  {uid:'folder-child',payload:JSON.stringify({filePath:path.join(deleted,'H_22.FBX')})},
  {uid:'loose',payload:JSON.stringify({localRoot:root,localRel:'loose.fbx'})},
  {uid:'sibling',payload:JSON.stringify({filePath:path.join(root,'models-other','keep.fbx')})},
  {uid:'online',payload:JSON.stringify({url:'https://example.com/model'})}
 ];
 assert.deepEqual(catalogUidsForRemovedPaths(rows,[deleted]),['folder-child']);
 assert.deepEqual(catalogUidsForRemovedPaths(rows,[path.join(root,'loose.fbx')]),['loose']);
 assert.deepEqual(catalogUidsForRemovedPaths(rows,[]),[]);
});
