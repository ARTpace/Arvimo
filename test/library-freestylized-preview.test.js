// FreeStylized 的 3D 预览：资源包里是 FBX / PNG 组 / 全景图，前端拿不到直链，
// 只能服务端解包。这组断言钉住「从 ZIP 里挑对了哪些条目」—— 挑错等于预览空白或渲染成黑块。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {zipEntries} from '../server/zip-writer.mjs';
import {zipIndex,zipRead,pickPreviewEntries} from '../server/freestylized-preview.mjs';

const zipOf=names=>zipEntries(names.map(n=>({name:n,data:Buffer.alloc(n.length%97+8,7)})));

test('模型包挑 lod0 的 FBX，贴图按体积从小到大取',()=>{
 const buf=zipOf([
  'Trowel_01_M101/source/trowel_01_lod1.fbx',
  'Trowel_01_M101/source/trowel_01_lod0.fbx',
  'Trowel_01_M101/textures/Trowel_01_Base_color.png',
  'Trowel_01_M101/textures/Trowel_01_Roughness.png',
  'Trowel_01_M101/License.txt',
 ]);
 const picked=pickPreviewEntries(zipIndex(buf),'models');
 assert.equal(picked.kind,'fbx');
 const model=picked.items.find(i=>i.role==='model');
 assert.match(model.entry.name,/lod0\.fbx$/,`lod0 优先，实际挑了 ${model.entry.name}`);
 const textures=picked.items.filter(i=>i.role==='texture').map(i=>i.entry.name);
 assert.equal(textures.length,2,'两张 PNG 都该拿，License.txt 不该拿');
 assert.ok(!textures.some(n=>/license/i.test(n)));
});

test('有 glTF 时不挑 FBX，且 kind 标记为 model',()=>{
 const buf=zipOf(['Kit/Models/box.gltf','Kit/Models/box.bin','Kit/Models/box.fbx','Kit/tex/a.png']);
 const picked=pickPreviewEntries(zipIndex(buf),'models');
 assert.equal(picked.kind,'model');
 assert.match(picked.items.find(i=>i.role==='model').entry.name,/\.gltf$/);
});

test('材质包按文件名认槽位，法线取 OpenGL 约定那张',()=>{
 const buf=zipOf([
  'wooden_wall_03_2k/wooden_wall_03_basecolor_2k.png',
  'wooden_wall_03_2k/wooden_wall_03_normal_dx_2k.png',
  'wooden_wall_03_2k/wooden_wall_03_normal_gl_2k.png',
  'wooden_wall_03_2k/wooden_wall_03_roughness_2k.png',
  'wooden_wall_03_2k/wooden_wall_03_metallic_2k.png',
  'wooden_wall_03_2k/wooden_wall_03_ambientocclusion_2k.png',
 ]);
 const picked=pickPreviewEntries(zipIndex(buf),'textures');
 assert.equal(picked.kind,'texture');
 const roles=Object.fromEntries(picked.items.map(i=>[i.role,i.entry.name]));
 assert.match(roles.base,/basecolor/);
 assert.match(roles.nor,/normal_gl/,'three 用 OpenGL 法线约定，DX 那张会凹凸反向');
 assert.match(roles.rough,/roughness/);
 assert.match(roles.metal,/metallic/);
 assert.match(roles.ao,/ambientocclusion/);
});

test('天空盒优先 HDR，没有就退回最大那张全景图',()=>{
 const hdr=pickPreviewEntries(zipIndex(zipOf(['sky/pano_4k.hdr','sky/preview.jpg'])),'skybox');
 assert.equal(hdr.kind,'hdri');
 assert.match(hdr.items[0].entry.name,/\.hdr$/);
 // 全景图按体积挑最大的一张（等距柱状全景通常比缩略图大）。
 const two=zipEntries([{name:'sky/pano_small.jpg',data:Buffer.alloc(64,1)},{name:'sky/pano_big.jpg',data:Buffer.alloc(4096,1)}]);
 const jpg=pickPreviewEntries(zipIndex(two),'skybox');
 assert.equal(jpg.kind,'equirect');
 assert.match(jpg.items[0].entry.name,/big/);
});

test('资源包 / Alpha / 智能材质没有可预览内容',()=>{
 for(const type of ['packs','alphas','smart']){
  assert.equal(pickPreviewEntries(zipIndex(zipOf(['pack/a.png','pack/b.fbx'])),type),null,`${type} 不该返回可预览项`);
 }
});

test('解出来的条目与写进去的字节一致',()=>{
 const payload=Buffer.from('FBX-binary-payload-0123456789');
 const buf=zipEntries([{name:'a/source/model.fbx',data:payload}]);
 const entries=zipIndex(buf);
 assert.equal(entries.length,1);
 assert.deepEqual(zipRead(buf,entries[0]),payload);
});

test('前端与路由都已接上 FreeStylized 预览',()=>{
 const preview=fs.readFileSync(path.resolve('src/library/gltf-preview.js'),'utf8');
 const view=fs.readFileSync(path.resolve('src/library/library-view.js'),'utf8');
 const server=fs.readFileSync(path.resolve('server/library.mjs'),'utf8');
 assert.match(preview,/loadFreestylized/,'预览渲染器要暴露 FreeStylized 入口');
 assert.match(preview,/FBXLoader/,'模型包里只有 FBX，没有 FBXLoader 就渲染不出来');
 assert.match(view,/platform==='freestylized'/,`卡片点击要分流到 3D 预览`);
 assert.match(server,/\/api\/freestylized\/preview-file/,`解出来的条目要给前端一个取文件的端点`);
});
