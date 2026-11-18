import test from 'node:test';
import assert from 'node:assert/strict';
import {packageCoverOf} from '../src/library/local-files.js';

// 卡片封面只走这一个函数。它错了，用户看到的就是「一片空白的卡片」——
// 2026-11-16 反馈的「没法生成缩略图的资产」有一半是这里给出的 URL 后端不认。
const root = 'H:\\AI-Tools\\Arvimo\\downloads';

test('平台缩略图优先，走 /api/image 代理绕开各站防盗链', () => {
  const pkg = {root, rel: 'a-pack', thumb: 'https://cdn.example.com/x.jpg', cover: 'inside.png'};
  assert.equal(packageCoverOf(pkg).src, `/api/image?url=${encodeURIComponent(pkg.thumb)}`);
});

test('包内现成图片走缩略图缓存，rel 要拼上包目录', () => {
  const pkg = {root, rel: '模型/凳子', cover: 'textures/base.png'};
  const {src} = packageCoverOf(pkg);
  assert.equal(src, `/api/local/thumb?root=${encodeURIComponent(root)}&rel=${encodeURIComponent('模型/凳子/textures/base.png')}&w=384&v=0`);
});

test('SVG / ICO 直接给原文件：缩略图通道不接这两种格式，走 thumb 只会 415', () => {
  const svg = packageCoverOf({root, rel: 'icons', cover: 'logo.SVG'});
  assert.equal(svg.src, `/api/local/file?root=${encodeURIComponent(root)}&rel=${encodeURIComponent('icons/logo.SVG')}`);
});

test('兜底封面：3D 主文件挂 modelCover，交给离屏渲染器', () => {
  const {src, modelCover} = packageCoverOf({root, rel: '道具/trowel', derivedCover: {rel: 'model.glb', source: 'thumb', container: ''}});
  assert.equal(modelCover, true);
  assert.equal(src, `/api/local/thumb?root=${encodeURIComponent(root)}&rel=${encodeURIComponent('道具/trowel/model.glb')}&w=384&v=0`);
});

test('兜底封面：HDRI / 视频不挂 modelCover（后端已经能出图，不需要浏览器渲染）', () => {
  const {modelCover} = packageCoverOf({root, rel: '环境/sky', derivedCover: {rel: 'environment.hdr', source: 'thumb', container: ''}});
  assert.equal(modelCover, false);
});

test('压缩包里的图：包自身是 zip 时 rel 就是 zip，folder 包要把 container 拼进去', () => {
  const zipOnly = packageCoverOf({root, rel: 'Wizard_Cat-textures.zip', derivedCover: {rel: 'textures/cat.png', source: 'archive', container: ''}});
  assert.equal(zipOnly.src, `/api/local/archive/entry?root=${encodeURIComponent(root)}&rel=${encodeURIComponent('Wizard_Cat-textures.zip')}&entry=${encodeURIComponent('textures/cat.png')}&w=384`);
  const folderWithZip = packageCoverOf({root, rel: '材质/floor', derivedCover: {rel: 'pack/baseColor.png', source: 'archive', container: 'pack.zip'}});
  assert.equal(folderWithZip.src, `/api/local/archive/entry?root=${encodeURIComponent(root)}&rel=${encodeURIComponent('材质/floor/pack.zip')}&entry=${encodeURIComponent('pack/baseColor.png')}&w=384`);
});

test('三档都没有时才返回 null（卡片退回类型图标）', () => {
  assert.equal(packageCoverOf({root, rel: 'a-pack'}), null);
  assert.equal(packageCoverOf({root, rel: 'a-pack', derivedCover: null}), null);
});

test('文件更新时间进入缩略图URL，更新后自动绕过旧缓存',()=>{
 const pkg={root,rel:'图集',cover:'a.png',mtime:123};
 assert.match(packageCoverOf(pkg).src,/&v=123$/);assert.notEqual(packageCoverOf(pkg).src,packageCoverOf({...pkg,mtime:124}).src);
});
