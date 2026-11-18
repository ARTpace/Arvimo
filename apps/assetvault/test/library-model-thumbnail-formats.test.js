import test from 'node:test';
import assert from 'node:assert/strict';
import {FORMATS,hasModelThumbnail} from '../src/library/format-registry.js';
import {isModelName} from '../server/thumb-cache.mjs';
import {packageCoverOf,createLocalFiles} from '../src/library/local-files.js';
import {parseHTML} from 'linkedom';

test('本地模型复用标准封面卡片，详情收进信息面板，保留文件预览键和收藏',()=>{
 const local=createLocalFiles({$:()=>null,esc:String,icon:()=>'',favorites:()=>new Set()});
 for(const ext of ['FBX','obj','glb','blend']){
  const file={root:'J:/assets',rel:`pack/a.${ext}`,name:`a.${ext}`,kind:'model',ext,bytes:1024,mtime:100};
  const {document}=parseHTML(local.card(file)),card=document.querySelector('article');
  assert.ok(card.classList.contains('model-card'));assert.ok(!card.classList.contains('local-file-card'));
  assert.equal(card.dataset.file,`J:/assets|pack/a.${ext}`);
  assert.ok(card.querySelector('.card-media img.thumbnail.model-thumb'));
  assert.ok(card.querySelector('[data-card-facts]'));assert.ok(card.querySelector('.favorite'));
  assert.equal(card.querySelector('.card-title').textContent,`a.${ext}`);
  assert.equal(card.querySelector('.local-file-badge'),null);
 }
});

test('注册模型格式的卡片封面能力与服务端缓存一致，含 Blender 工程',()=>{
 const models=Object.values(FORMATS).filter(format=>format.kind==='model'||format.ext==='blend');
 assert.ok(models.length>=12);
 for(const format of models){
  const name=`model.${format.ext.toUpperCase()}`;
  assert.equal(hasModelThumbnail(name),true,name);
  assert.equal(isModelName(name),true,name);
  assert.equal(packageCoverOf({root:'J:/assets',rel:'pack',derivedCover:{rel:name,source:'thumb'}}).modelCover,true,name);
 }
 for(const ext of ['mtl','sbsar','png','zip','max','ma'])assert.equal(hasModelThumbnail(`file.${ext}`),false,ext);
});

test('本地图片视频和无封面的音频字体文档共用卡片外观，预览仍按文件定位',()=>{
 const local=createLocalFiles({$:()=>null,esc:String,icon:()=>'',favorites:()=>new Set()});
 for(const [ext,kind,cover] of [['png','image',true],['psd','image',true],['svg','image',true],['hdr','env',true],['mp4','video',true],['mp3','audio',false],['ttf','font',false],['pdf','document',false]]){
  const {document}=parseHTML(local.card({root:'J:/assets',rel:`a.${ext}`,name:`a.${ext}`,kind,ext}));
  const card=document.querySelector('article');
  assert.ok(card.classList.contains('model-card'),ext);
  assert.equal(card.dataset.file,`J:/assets|a.${ext}`);
  assert.equal(!!card.querySelector('img.thumbnail'),cover,ext);
  assert.equal(card.querySelector('.local-file-badge'),null,ext);
  assert.ok(card.querySelector('[data-card-facts]'),ext);
  if(ext==='svg')assert.match(card.querySelector('img').getAttribute('src'),/^\/api\/local\/file\?/);
 }
});
