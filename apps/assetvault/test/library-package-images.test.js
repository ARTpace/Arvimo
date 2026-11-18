import test from 'node:test';
import assert from 'node:assert/strict';
import {packageImages,packageImageUrl} from '../src/library/local-files.js';
test('图集统一接纳原生图片与可转码 PSD、TGA、TIFF、RAW，不混入模型与环境文件',()=>{
 const exts=['png','jpg','jpeg','jfif','gif','webp','avif','svg','bmp','ico','psd','tga','tif','tiff','dng','raw','heic','heif','dds'];
 const entries=[...exts,'glb','mp4','hdr','exr','json'].map(ext=>({name:`picture-${ext}.${ext.toUpperCase()}`,rel:`picture-${ext}.${ext.toUpperCase()}`}));
 assert.deepEqual(packageImages({entries}).map(item=>item.name.split('.').pop().toLowerCase()),exts);
 assert.deepEqual(packageImages({}),[]);
 for(const ext of ['psd','tga','tif','tiff','heic','dds'])assert.match(packageImageUrl({root:'J:/资产',rel:'图集'},`a.${ext}`,128),/^\/api\/local\/thumb\?/);
});

test('远程收藏卡不下载也能成图集：条目来自 remoteImages，缩略图走 /api/image 代理',()=>{
 const pkg={remote:true,entries:[],remoteImages:[
  {url:'https://img/1.jpg',thumb:'https://img/1_fw480.jpg',title:'第一张'},
  {url:'https://img/2.jpg',title:'第二张'},
 ]};
 const imgs=packageImages(pkg);
 assert.equal(imgs.length,2);
 assert.equal(imgs[0].name,'第一张');
 assert.equal(imgs[1].name,'第二张');
 // 拼贴/缩略图取稳定缩放档，走远程代理而不是不存在的本地 /api/local/thumb。
 const thumb=packageImageUrl(pkg,'0',256);
 assert.match(thumb,/^\/api\/image\?url=/);
 assert.match(decodeURIComponent(thumb),/1_fw480\.jpg/);
 // 没有缩放档的那张回退原图。
 assert.match(decodeURIComponent(packageImageUrl(pkg,'1',256)),/img\/2\.jpg/);
 // 普通包不受影响。
 assert.deepEqual(packageImages({remote:true,entries:[{name:'a.png',rel:'a.png'}]}).map(i=>i.name),['a.png']);
});
