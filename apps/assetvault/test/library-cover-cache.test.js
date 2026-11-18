import test from 'node:test';
import assert from 'node:assert/strict';
import {localIndexSnapshot} from '../src/library/image-albums.js';
import {bindCardImageResidency} from '../src/library/card-image-residency.js';
test('大图集启动索引只缓存封面清单，原始数据及总数保持完整',()=>{
 const pkg={entries:Array.from({length:5000},(_,i)=>({rel:`${i}.png`,name:`${i}.png`,extra:'x'.repeat(100)})),fileCount:5000};
 const snapshot=localIndexSnapshot({files:[],packages:[pkg],truncated:false});
 assert.equal(snapshot.packages[0].entries.length,9);assert.equal(snapshot.packages[0].previewImageCount,5000);
 assert.equal(snapshot.packages[0].previewOnly,true);assert.equal(pkg.entries.length,5000);assert.ok(JSON.stringify(snapshot).length<4000);
});
test('搜索暂存卡片保留已加载图片，普通移除仍释放图片',()=>{
 let sync;class Mutations{constructor(fn){sync=fn;}observe(){}disconnect(){}}
 let attached=true,cached=true,src='cover';const img={closest:()=>cached?{}:null,removeAttribute:()=>{src=null;}};
 const grid={contains:()=>attached,querySelectorAll:()=>attached?[img]:[]};
 bindCardImageResidency(grid,{Mutations});attached=false;sync();assert.equal(src,'cover');
 attached=true;sync();attached=false;cached=false;sync();assert.equal(src,null);
});


test('同名模型和展示图使用各自封面，图片不能复用模型预览',async()=>{
 const {localImageThumbnail}=await import('../src/library/card-view.js');
 const image={platform:'polyhaven',assetType:'images',localRoot:'J:/assets',localRel:'图片/ArmChair_01/images/top.png',thumbnail:'/api/local/thumb?root=J&rel=models/ArmChair_01/preview.png'};
 const src=localImageThumbnail(image),params=new URL(src,'http://local').searchParams;
 assert.equal(params.get('rel'),image.localRel);
 assert.equal(localImageThumbnail({...image,assetType:'models',localRel:'models/ArmChair_01.fbx'}),'');
 assert.equal(localImageThumbnail({platform:'local',assetType:'images',thumbnail:'https://example.com/image.png'}),'');
 const fallback=localImageThumbnail({assetType:'images',previewUrl:'/api/local/file?root=J&rel=images%2Ftop.png'});
 assert.equal(new URL(fallback,'http://local').searchParams.get('rel'),'images/top.png');
});
