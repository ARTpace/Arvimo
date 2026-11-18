import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {planImageAlbums,groupImageVariants,albumFolderView,albumImageKey,albumPreviewItems} from '../src/library/image-albums.js';

test('文件夹排序包含外层目录自身的新增时间，内部旧图集不拖后顺序',()=>{
 const rel='图片/纹理贴图/风格化Alphas';
 const rows=[{rel:rel+'/木头Wood',addedAt:100,mtime:50,folderAddedAt:{[rel]:900}},{rel:rel+'/Rocks',addedAt:200,mtime:80,folderAddedAt:{[rel]:900}},{rel:'图片/纹理贴图/旧素材/子图集',addedAt:500}];
 const folders=albumFolderView(rows).folders.sort((a,b)=>b.addedAt-a.addedAt);
 assert.equal(folders[0].name,'风格化Alphas');assert.equal(folders[0].addedAt,900);
 assert.equal(folders[0].mtime,80);
});

test('纹理分类不生成文件夹，含本层图片的真实目录只需点击一次',()=>{
 const base='图片/纹理贴图/岩石裂缝笔刷 Alpha Brushes';
 const rows=[{rel:base,albumParent:base,title:'本层图片'},{rel:base+'/裂纹'}];
 const root=albumFolderView(rows);
 assert.deepEqual(root.folders.map(f=>f.name),['岩石裂缝笔刷 Alpha Brushes']);
 assert.deepEqual(albumFolderView(rows,base),{folders:[],albums:rows});
});
import {createLocalFiles} from '../src/library/local-files.js';
import {createDropImporter} from '../server/drop-import.mjs';
import {scanLibraryPackages} from '../server/local-assets.mjs';
import {prepareAlbumBoard} from '../src/library/album-board-import.js';
import {loadLibrary,saveLibrary} from '../src/library/library-state.js';
const items=paths=>paths.map(rel=>({rel}));
test('嵌套图片目录各自成集，父层散图独立，PBR和模型不被合成普通图集',()=>{
 const rows=items(['贴花/a.png','贴花/裂纹/a.psd','贴花/污渍/a.png','贴花/污渍/b.png','贴花/PBR/wood_albedo.png','贴花/PBR/wood_normal.png','贴花/模型/tree.glb','贴花/模型/preview.png']);
 const plan=planImageAlbums(rows);
 assert.equal(plan.get('贴花/a.png'),'贴花/本层图片');
 assert.equal(plan.get('贴花/裂纹/a.psd'),'贴花/裂纹');
 assert.equal(plan.get('贴花/污渍/b.png'),'贴花/污渍');
 assert.equal(plan.has('贴花/PBR/wood_albedo.png'),false);
 assert.equal(plan.has('贴花/模型/preview.png'),false);
});
test('同名多格式一个条目，不同子目录不串组，优先轻量预览版本',()=>{
 const rows=['a.psd','a.png','b/a.png','b/a.tiff'].map(rel=>({rel,name:rel.split('/').pop()}));
 const groups=groupImageVariants(rows);
 assert.equal(groups.length,2);assert.equal(groups[0].rel,'a.png');
 assert.deepEqual(groups[0].variants.map(row=>row.rel),['a.png','a.psd']);
 assert.equal(albumImageKey({root:'J:/素材',rel:'贴花'},rows[0]),albumImageKey({root:'j:\\素材',rel:'贴花'},rows[1]));
});
test('搜索图集内文件名与单图标签，展开匹配图片，版本合并不影响真实文件路径',()=>{
 const local=createLocalFiles({$:()=>null,albumTags:(_pkg,item)=>item.rel==='rune.png'?['魔法']:[]});
 const pkg={root:'J:/素材',rel:'贴花/符号',category:'images',entries:[{name:'rune.psd',rel:'rune.psd'},{name:'rune.png',rel:'rune.png'},{name:'crack.png',rel:'crack.png'}]};
 assert.equal(local.matchesPackage(pkg,{query:'魔法'}),true);
 const hits=local.searchPackageImages(pkg,'魔法');
 assert.equal(hits.length,1);assert.equal(hits[0].rel,'贴花/符号/rune.png');
 assert.equal(local.searchPackageImages(pkg,'crack')[0].name,'crack.png');
});
test('画板整套与单图复用链接导入，批量一次提交；失败终止且不移动原文件',async()=>{
 const calls=[];
 const fetchImpl=async(route,options)=>{
  const data=JSON.parse(options.body);calls.push({route,data});
  return {ok:true,json:async()=>route.endsWith('import-file')?{asset:{uid:data.rel,name:data.rel}}:{ok:true}};
 };
 const pkg={root:'J:/素材',rel:'贴花/裂纹'},items=[{rel:'a.png'},{rel:'b.psd'}];
 const assets=await prepareAlbumBoard(pkg,items,{fetchImpl});
 assert.equal(assets.length,2);assert.equal(calls.length,3);
 assert.ok(calls.slice(0,2).every(call=>call.data.mode==='linked'&&call.data.batch===calls[0].data.batch));
 assert.equal(calls[0].data.rel,'贴花/裂纹/a.png');assert.equal(calls[2].data.action,'flush');
 calls.length=0;await prepareAlbumBoard(pkg,[items[1]],{fetchImpl});assert.equal(calls.length,2);
 const failed=[];
 await assert.rejects(prepareAlbumBoard(pkg,items,{fetchImpl:async(route,options)=>{
  failed.push(JSON.parse(options.body));return {ok:!route.endsWith('import-file'),json:async()=>({error:'源文件离线'})};
 }}),/源文件离线/);
 assert.equal(failed.at(-1).action,'abort');
});
test('单图标签与图集成员整理设置重开保留，不修改图片元数据',()=>{
 const storage={data:null,getItem(){return this.data;},setItem(_key,value){this.data=value;}};
 const state=loadLibrary(storage),key=albumImageKey({root:'J:/素材',rel:'裂纹'},{rel:'a.png'});
 state.options.albumImageTags={[key]:['裂纹','墙面']};state.options.albumMemberUids=['a'.repeat(32)];
 saveLibrary(storage,state);const reopened=loadLibrary(storage);
 assert.deepEqual(reopened.options.albumImageTags[key],['裂纹','墙面']);assert.deepEqual(reopened.options.albumMemberUids,state.options.albumMemberUids);
});
test('父目录入口逐层浏览，图集保留原对象和来源',()=>{
 const rows=['贴花/裂纹','贴花/符号/魔法','贴花/符号/科幻'].map(rel=>({rel,category:'images'}));
 const root=albumFolderView(rows);assert.equal(root.folders[0].name,'贴花');
 const next=albumFolderView(rows,'贴花');assert.equal(next.albums[0],rows[0]);assert.equal(next.folders[0].name,'符号');
 assert.deepEqual(albumFolderView(rows,'贴花/符号').albums,rows.slice(1));
});
test('真实落盘：同名子文件夹不混合，父层散图独立；扫描一目录一图集',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arvimo-albums-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const importer=createDropImporter({archiveRoot:dir,importRoots:{add(){}},localImporter:{flushBatch:async()=>({ok:true}),abortBatch:async()=>({ok:true})}});
 const rels=['贴花/A/符号/a.png','贴花/B/符号/a.psd','贴花/root.png'];
 const plan=planImageAlbums(items(rels));
 for(const rel of rels)await importer.save({name:rel,album:plan.get(rel),batch:'test',stream:Readable.from(Buffer.from('bytes'))});
 const result=await importer.flush('test');assert.equal(result.albums.length,3);
 const scan=await scanLibraryPackages({roots:[dir]});
 assert.equal(scan.packages.length,3);assert.equal(scan.files.length,0);
 assert.equal(new Set(scan.packages.map(pkg=>pkg.uid)).size,3);
 assert.ok(scan.packages.some(pkg=>pkg.rel.endsWith('/贴花/本层图片')));
 assert.ok(scan.packages.every(pkg=>pkg.fileCount===1));
});
test('系统缩略图缓存不打散图集，超过200张的图片清单完整保留，材质仍是材质卡',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arvimo-album-scan-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(path.join(dir,'符文'));await fs.mkdir(path.join(dir,'材质'));
 await Promise.all(Array.from({length:205},(_,i)=>fs.writeFile(path.join(dir,'符文',`rune-${i}.png`),'x')));
 await fs.writeFile(path.join(dir,'符文','Thumbs.db'),'cache');
 await fs.writeFile(path.join(dir,'材质','wood_albedo.png'),'x');await fs.writeFile(path.join(dir,'材质','wood_normal.png'),'x');
 const result=await scanLibraryPackages({roots:[dir]});
 assert.equal(result.files.length,0);
 const album=result.packages.find(pkg=>pkg.rel==='符文');
 assert.equal(album.entries.length,205);assert.equal(album.fileCount,205);assert.equal(album.truncatedEntries,false);
 assert.equal(result.packages.find(pkg=>pkg.rel==='材质').category,'material');
});

test('文件夹以内部最新图集时间参与最近入库排序',()=>{
 const rows=[{rel:'旧目录/图集',mtime:10},{rel:'新目录/一',mtime:20},{rel:'新目录/二',mtime:30}];
 const folders=albumFolderView(rows).folders.sort((a,b)=>b.mtime-a.mtime);
 assert.equal(folders[0].name,'新目录');assert.equal(folders[0].mtime,30);assert.equal(folders[1].mtime,10);
});

test('存储分类不生成多余入口，贴花点击一次直接看到自己的图集',()=>{
 const rows=['图片/其他图片/贴花/符号','图片/其他图片/贴花/路牌','图片/其他图片/光效'].map(rel=>({rel,category:'images'}));
 const root=albumFolderView(rows);assert.deepEqual(root.folders.map(f=>f.name),['贴花']);assert.equal(root.albums[0],rows[2]);
 const target=root.folders[0];assert.equal(target.rel,'图片/其他图片/贴花');
 const inside=albumFolderView(rows,target.rel);assert.deepEqual(inside.albums,rows.slice(0,2));assert.equal(inside.folders.length,0);
});

test('画板从图集取多张封面，支持PSD与多格式合并且保留文件版本',()=>{
 const pkg={root:'J:/素材',rel:'符文',mtime:42,entries:[{name:'a.psd',rel:'a.psd'},{name:'a.png',rel:'a.png'},{name:'b.psd',rel:'b.psd'},{name:'c.tga',rel:'c.tga'}]};
 const previews=albumPreviewItems(pkg,3);assert.equal(previews.length,3);assert.equal(previews[0].name,'a.png');
 assert.match(previews[1].thumbnail,/b.psd/);assert.match(previews[1].thumbnail,/&v=42$/);assert.equal(pkg.entries.length,4);
});
