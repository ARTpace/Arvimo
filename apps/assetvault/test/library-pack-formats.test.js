import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// 资源包模型与环境贴图的格式覆盖面。参考 Serpent 的格式注册表补了 OBJ / STL / PLY / 3MF 与 EXR 全景：
// 这三件事任何一件退回去，用户看到的就又是「这个格式没法预览」。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const preview=read('src/library/gltf-preview.js');
const server=read('server/library.mjs');
const picker=read('server/freestylized-preview.mjs');

/** 截一段函数体，避免拿整文件做宽松匹配（别处的名字会误命中）。 */
function section(source,startMarker,endMarker){
 const start=source.indexOf(startMarker);
 assert.ok(start>=0,`源码里找不到 ${startMarker}`);
 const end=source.indexOf(endMarker,start+startMarker.length);
 return source.slice(start,end<0?undefined:end);
}

test('vendor 里真的存在这些 loader 文件',()=>{
 for(const name of ['OBJLoader','STLLoader','PLYLoader','3MFLoader','EXRLoader','RGBELoader','FBXLoader','GLTFLoader']){
  assert.ok(fs.existsSync(path.join(root,'vendor/three/loaders',`${name}.js`)),`vendor/three/loaders 缺 ${name}.js`);
 }
});

test('模型预览按扩展名分派到对应 loader',()=>{
 const table=section(preview,'async function parseModelBuffer','/** 全景环境贴图');
 for(const [ext,loader] of [['obj','OBJLoader'],['stl','STLLoader'],['ply','PLYLoader'],['3mf','ThreeMFLoader'],['fbx','FBXLoader'],['glb','GLTFLoader']]){
  assert.match(table,new RegExp(`\\.${ext}\\$`),`parseModelBuffer 里缺少 .${ext} 的扩展名判定`);
  assert.ok(table.includes(loader),`parseModelBuffer 里缺少 ${loader} 分支`);
 }
 // 格式判断只能有一处：资源包预览与本地文件预览都得走这张表，各写一份必然走偏。
 assert.match(section(preview,'async function showPackModel','async function showPackEnvironment'),/parseModelBuffer\(/,'showPackModel 必须复用 parseModelBuffer，不能自带格式表');
 assert.match(section(preview,'async function loadLocalModel','async function loadLocalEnvironment'),/parseModelBuffer\(/,'loadLocalModel 必须复用 parseModelBuffer，不能自带格式表');
 // STL / PLY 没有材质与 UV：必须自己包一层 Mesh + 标准材质，否则渲染出来是默认灰。
 assert.match(preview,/function meshFromGeometry/,'缺 meshFromGeometry，STL/PLY 会渲染成默认材质');
 assert.match(preview,/function upgradePackMaterials/,'OBJ 的 Phong 材质要升成 Standard，否则光照和其它资产不一致');
});

test('EXR 全景要真的能渲染，不许再抛「暂不支持」',()=>{
 assert.ok(preview.includes('EXRLoader'),'环境贴图缺 EXRLoader');
 assert.ok(!preview.includes('暂不支持在线预览'),'EXR 天空盒必须真渲染，不能退回报错');
 // 环境贴图的扩展名判断同样只留一处。
 const env=section(preview,'async function loadEnvironmentTexture','function meshFromGeometry');
 assert.match(env,/\\.exr\$/i,'loadEnvironmentTexture 缺 .exr 分支');
 assert.match(env,/EXRLoader/,'loadEnvironmentTexture 里 .exr 要走 EXRLoader');
 assert.match(section(preview,'async function showPackEnvironment','async function loadFreestylized'),/loadEnvironmentTexture\(/,'showPackEnvironment 必须复用 loadEnvironmentTexture');
 assert.match(section(preview,'async function loadLocalEnvironment','async function loadHdri'),/loadEnvironmentTexture\(/,'loadLocalEnvironment 必须复用 loadEnvironmentTexture');
 // Poly Haven HDRI 只有 exr 时也要能预览
 const hdri=section(preview,'async function loadHdri','/** PBR 贴图预览');
 assert.match(hdri,/\\.exr\$/i,'Poly Haven HDRI 只有 exr 时也要能预览');
});

test('后端预览 MIME 覆盖新格式',async()=>{
 // PREVIEW_MIMES 现在从格式注册表派生（不再有逐扩展名字面量），所以断言真值而不是源码字符串：
 // 既检查注册表里每种格式的 MIME，也检查服务端确实从 FORMATS 派生而不是另抄一份表。
 const {FORMATS, formatMime} = await import('../src/library/format-registry.js');
 for(const ext of ['obj','stl','ply','3mf','fbx','exr']){
  assert.ok(FORMATS[ext]?.mime,`格式注册表缺 .${ext}`);
  assert.equal(formatMime(`a.${ext}`),FORMATS[ext].mime,`.${ext} 的 MIME 不一致`);
 }
 assert.match(server,/PREVIEW_MIMES\s*=\s*Object\.fromEntries\(Object\.values\(FORMATS\)/,'服务端预览 MIME 必须从格式注册表派生');
});

test('包内挑选规则能挑出 OBJ / STL / PLY / 3MF',()=>{
 assert.match(picker,/\\.\(obj\|stl\|ply\|3mf\)\$/i,'pickPreviewEntries 的模型兜底没接上新格式');
});
