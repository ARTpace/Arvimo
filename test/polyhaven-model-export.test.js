import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Poly Haven 模型导出「明明下了文件却报没有模型文件」：错在两个地方都把「有没有贴图」
// /「后缀名够不够全」当成了「有没有模型」。这两个都是静默走错分支、最后才在无关的
// 校验环节炸出来的 bug，只能靠结构断言钉住判据。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const polyhaven=read('server/polyhaven.mjs');
const folder=read('server/folder-archive.mjs');

test('Poly Haven 模型不能因为「有贴图」而被降级成材质任务',()=>{
 // 真实清单：models 与 textures 共用同一套 map 命名，模型资产的顶层同样挂着
 // Diffuse / Rough / nor_gl / arm 等贴图项。拿贴图存在与否判断「是不是材质」，
 // 会把每个正常模型都误判成材质 → 导出目录里没有 .fbx → 校验时报
 // 「导出目录里没有 Poly Haven 的模型文件」，错误信息完全指不到真因。
 assert.ok(polyhaven.includes('const MODEL_FORMATS='),
  '降级判据必须先看这个资产有没有模型格式');
 assert.ok(polyhaven.includes('const hasModelFormat=MODEL_FORMATS.some'),
  '要有 hasModelFormat 这种「有没有模型」的判断');
 assert.ok(!/!files\?\.fbx&&pickPolyhavenTextureFiles\(/.test(polyhaven),
  '不能再用「没有 fbx 但有贴图」当降级条件——它把每个模型都误判成材质');
 // 真正的纯材质图仍然要能降级，否则那条降级路径会被彻底删掉。
 assert.ok(polyhaven.includes('if(!hasModelFormat&&pickPolyhavenTextureFiles('),
  '一个模型格式都不提供的资产仍应转去材质导出');
 // 降级本身必须保留，但要降级到「真带模型文件」的格式：Poly Haven 的 fbx 条目**总是存在**
 // （里面常常只有贴图），按「键是否存在」判断会让降级永不触发，选出只有贴图的格式。
 assert.ok(polyhaven.includes('const formatHasModel=key=>'),
  '降级判据要是「这个格式的包里有没有模型文件」，不是「files[format] 这个键在不在」');
 assert.ok(polyhaven.includes('if(!formatHasModel(format))')&&polyhaven.includes('MODEL_FORMATS.find(key=>formatHasModel(key))'),
  '降级要在候选格式里逐个找一个真带模型文件的');
 assert.ok(!/if\(format==='fbx'&&!files\?\.fbx&&files\?\.gltf\)format='gltf'/.test(polyhaven),
  '不能再用「fbx 键不存在才降级」——该键总存在，降级永远不触发');
});

test('Poly Haven 校验要认 .bin —— glTF 包里几何数据就是它',()=>{
 // BarberShopChair_01 的 glTF 清单：BarberShopChair_01.bin + textures/*.jpg，
 // 并没有单独的 .gltf 文件。只认 fbx/gltf/glb 会让每个 glTF 导出都在校验环节被误判失败。
 assert.ok(folder.includes('fbx|gltf|glb|bin|blend|usdc|usd'),
  '模型文件后缀白名单必须包含 .bin');
 assert.ok(folder.includes("info.platform === 'polyhaven'"),
  'polyhaven 分支仍要走自己的模型文件判定');
});

test('纯材质 / HDRI 分支的校验逻辑没有被这次改动带偏',()=>{
 // 三条分支各有各的判据，别让 polyhaven 的改动顺手改了别的。
 for(const kind of ["info.kind === 'material'","info.kind === 'hdri' || info.kind === 'pack'"]){
  assert.ok(folder.includes(kind),`${kind} 分支应仍存在`);
 }
 assert.ok(folder.includes('导出目录里没有材质贴图'),'材质分支的报错文案保持原样');
 assert.ok(folder.includes('缺少有效 GLB'),'非 Poly Haven 的 GLB 校验保持原样');
});