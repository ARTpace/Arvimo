import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {galleryAvailable,galleryActive,displayGridClass,coverRendition,aspectRatioStyle,GALLERY_RENDITION} from '../src/library/gallery-view.js';
import {PICTURE_SITES} from '../src/library/platforms.js';

// 画廊是 ArtStation 专属的看图视图，判据集中在一个模块里：
// 「按钮显不显示」和「网格生不生效」都从同一处推导，两者不可能各说各话。
test('gallery: every platform except the download page can use waterfall',()=>{
 for(const platform of ['artstation','sketchfab','all','uiverse',...Object.keys(PICTURE_SITES)]){
  assert.equal(galleryAvailable({route:'discover',platform}),true,platform);
 }
 for(const route of ['library','favorites'])assert.equal(galleryAvailable({route,platform:'sketchfab'}),true,route);
 assert.equal(galleryAvailable({route:'downloads',platform:'artstation'}),false);
});

test('all image platforms share mutually exclusive layout classes',()=>{
 for(const platform of ['artstation',...Object.keys(PICTURE_SITES)]){
  const state={route:'discover',platform};
  assert.equal(galleryAvailable(state),true,platform);
  assert.equal(displayGridClass(state),'model-grid');
  assert.equal(displayGridClass({...state,gallery:true}),'model-grid gallery');
  // 紧凑列表视图已移除：即使旧状态里残留 compact 字段，也不该再改变布局。
  assert.equal(displayGridClass({...state,compact:true}),'model-grid');
 }
 assert.equal(displayGridClass({route:'discover',platform:'sketchfab',gallery:true}),'model-grid gallery');
});

test('gallery: Uiverse cards do get the waterfall, and stay square inside it',()=>{
 // UI 元素的封面是一层绝对定位的 Shadow DOM，没有 <img> 撑高；
 // 瀑布流默认把 card-media 的 aspect-ratio 设成 auto，会让整张卡片塌成 0 高。
 // 所以瀑布流对 UI 卡片必须是「能用」+「封面锁 1:1」两条同时成立。
 const state={route:'discover',platform:'uiverse',gallery:true};
 assert.equal(galleryAvailable(state),true);
 assert.equal(galleryActive(state),true);
 assert.equal(displayGridClass(state),'model-grid gallery');
 const css=assembleLibraryStyles();
 assert.match(css,/\.gallery \.ui-element-card \.card-media\{aspect-ratio:1\}/,'瀑布流里 UI 卡片封面必须锁 1:1，否则高度塌成 0');
});

test('gallery: the view renders only when it is offered and switched on',()=>{
 const art={route:'discover',platform:'artstation'};
 assert.equal(galleryActive({...art,gallery:true}),true);
 assert.equal(galleryActive({...art,gallery:false}),false);
 // 切平台会重置开关，这里再兜一层：条件不成立时绝不能残留瀑布流布局。
 assert.equal(galleryActive({route:'library',platform:'artstation',gallery:true}),true);
 assert.equal(galleryActive({route:'discover',platform:'all',gallery:true}),true);
 assert.equal(galleryActive({route:'downloads',platform:'artstation',gallery:true}),false);
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
