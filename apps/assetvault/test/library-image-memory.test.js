import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createGalleryPreload} from '../src/library/gallery-preload.js';
import {cardThumbnail} from '../server/card-thumbnail.mjs';

test('连续浏览长图集只保留相邻两张，释放src且不加载视频',()=>{
 const alive=new Set();
 const cache=createGalleryPreload(()=>{const image={removeAttribute(){alive.delete(image);}};alive.add(image);return image;});
 const items=Array.from({length:200},(_,i)=>({url:`${i}`,type:i===10?'video':'image'}));
 for(let i=0;i<items.length;i++){
  cache.update(items,i,item=>item.url);
  assert.ok(alive.size<=2);
  assert.equal(cache.get(10),undefined);
 }
 cache.clear();assert.equal(alive.size,0);
});

test('卡片大图限制384像素，小图不放大，原始输入不改写',async()=>{
 const source=await sharp({create:{width:4096,height:2048,channels:3,background:'#6789ab'}}).png().toBuffer();
 const result=await cardThumbnail(source),metadata=await sharp(result.bytes).metadata();
 assert.equal(metadata.width,384);assert.equal(metadata.height,192);assert.equal(result.mime,'image/webp');
 assert.equal((await sharp(source).metadata()).width,4096);
 const small=await sharp({create:{width:32,height:16,channels:4,background:'#0000'}}).png().toBuffer();
 assert.equal((await sharp((await cardThumbnail(small)).bytes).metadata()).width,32);
});
