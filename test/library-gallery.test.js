import test from 'node:test';
import assert from 'node:assert/strict';
import {galleryAvailable,galleryActive,displayGridClass,coverRendition,aspectRatioStyle,GALLERY_RENDITION} from '../src/library/gallery-view.js';
import {PICTURE_SITES} from '../src/library/platforms.js';

// 画廊是 ArtStation 专属的看图视图，判据集中在一个模块里：
// 「按钮显不显示」和「网格生不生效」都从同一处推导，两者不可能各说各话。
test('gallery: all image platforms on the discovery page offer it',()=>{
 assert.equal(galleryAvailable({route:'discover',platform:'artstation'}),true);
 // Sketchfab 是 3D 模型，卡片上的面数/动画/许可是有用信息，极简掉是净损失。
 assert.equal(galleryAvailable({route:'discover',platform:'sketchfab'}),false);
 assert.equal(galleryAvailable({route:'discover',platform:'all'}),false);
 // 本地库与收藏里混着两个平台来源，画廊只画在线 A 站结果。
 for(const route of ['library','favorites','downloads'])assert.equal(galleryAvailable({route,platform:'artstation'}),false,route);
 assert.equal(galleryAvailable(),false);
});

test('all image platforms share mutually exclusive layout classes',()=>{
 for(const platform of ['artstation',...Object.keys(PICTURE_SITES)]){
  const state={route:'discover',platform};
  assert.equal(galleryAvailable(state),true,platform);
  assert.equal(displayGridClass(state),'model-grid');
  assert.equal(displayGridClass({...state,compact:true}),'model-grid compact');
  assert.equal(displayGridClass({...state,compact:true,gallery:true}),'model-grid gallery');
 }
 assert.equal(displayGridClass({route:'discover',platform:'sketchfab',gallery:true}),'model-grid');
});

test('gallery: the view renders only when it is offered and switched on',()=>{
 const art={route:'discover',platform:'artstation'};
 assert.equal(galleryActive({...art,gallery:true}),true);
 assert.equal(galleryActive({...art,gallery:false}),false);
 // 切平台会重置开关，这里再兜一层：条件不成立时绝不能残留瀑布流布局。
 assert.equal(galleryActive({route:'library',platform:'artstation',gallery:true}),false);
 assert.equal(galleryActive({route:'discover',platform:'all',gallery:true}),false);
 assert.equal(galleryActive({}),false);
});

test('gallery: covers ask for the lighter proportional rendition, others keep the default',()=>{
 assert.equal(coverRendition({platform:'artstation',gallery:true}),GALLERY_RENDITION);
 assert.equal(GALLERY_RENDITION,'small');
 // 非画廊交给图片代理用它自己的默认档（medium），画廊不改变网格的观感。
 assert.equal(coverRendition({platform:'artstation',gallery:false}),'');
 assert.equal(coverRendition({platform:'sketchfab',gallery:true}),'');
 assert.equal(coverRendition(),'');
});

test('gallery: a decoded size replaces the square placeholder, unknown sizes keep it',()=>{
 assert.equal(aspectRatioStyle(800,1808),'800 / 1808');
 assert.equal(aspectRatioStyle(800,450),'800 / 450');
 // 宽高拿不到时返回空串：卡片保持 CSS 里的 1:1 占位，而不是塌成零高度。
 for(const bad of [undefined,null,0,0,NaN,Infinity,'','x',-5])assert.equal(aspectRatioStyle(bad,bad),'',String(bad));
 assert.equal(aspectRatioStyle(800,0),'');
 assert.equal(aspectRatioStyle(0,800),'');
 assert.equal(aspectRatioStyle('800','600'),'800 / 600');
});
