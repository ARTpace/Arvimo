import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Poly Haven 的 3D 预览：以前点卡片是 window.open 跳官网，但按钮却写着「交互式 3D 预览」——
// 标签与行为不符。现在改成真渲染（本地 three.js 加载官方 1K glTF），这里守住三条容易回退的点。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const preview=read('src/library/gltf-preview.js');
const view=read('src/library/library-view.js');
const cards=read('src/library/card-view.js');
const html=read('src/library/index.html');

test('Poly Haven 预览不再跳官网，改成本地渲染',()=>{
 assert.ok(!/m\.platform==='polyhaven'\)\{if\(m\.url\)window\.open/.test(view),
  'polyhaven 分支里不该再有 window.open 直跳官网');
 assert.ok(preview.includes('inlineResources')&&preview.includes('gltf'),
  'gltf-preview.js 必须真的去加载 glTF');
 assert.ok(view.includes('gltfPreview.load('),'library-view 必须调用 gltfPreview.load');
 assert.ok(view.includes('gltfPreview.close()')===false,'释放逻辑放在弹窗 close 事件里，见下条');
 assert.ok(read('src/library/app.js').includes('gltfPreview.close()'),
  '关弹窗必须停渲染循环并释放 GPU 资源，否则 canvas 会一直每帧烧 GPU');
});

test('glTF 的外部引用必须改写成本地代理，不能留着相对路径',()=>{
 // glTF 里贴图写的是打包相对路径（textures/Armchair_01_diff_1k.jpg），CDN 上没有这个目录，
 //  直接加载必然 404 —— 表现是「模型白模 + 黑材质」，比明确失败更难查。
 assert.ok(preview.includes('indexByBasename'),'必须按 basename 到官方文件清单里映射真实 URL');
 assert.ok(preview.includes('/api/proxy'),'本机有系统代理，直连 Poly Haven 会被劫持成 ERR_ABORTED，必须走本地 /api/proxy');
 assert.ok(preview.includes("'x-sfx-local':'1'"),'/api/proxy 要带本地标识头');
 assert.ok(preview.includes('loader.parse('),'必须用 parse(gltf) 而不是 load(JSON.stringify(gltf))——后者会把 JSON 当 URL 请求，必然 404');
 assert.ok(!/loader\.load\(JSON\.stringify/.test(preview),'load(JSON.stringify(...)) 是404 的直接来源，不能回来');
 assert.ok(preview.includes('revokeObjectURL'),'blob 用完必须 revoke，否则连续看十几个模型内存一路涨');
});

test('Poly Haven 三类资产都走本地 3D 预览，贴图与 HDRI 不许退回「跳官网」',()=>{
 // 贴图/HDRI 现在也是真渲染（球体看高光法线、全景看环境），旧的 phNoMesh 旁路已删。
 assert.ok(!cards.includes('phNoMesh'),'phNoMesh 旁路必须删除——三类资产统一本地渲染');
 assert.ok(view.includes("m.assetType||'models'"),'library-view 按卡片 assetType 分发预览类型');
 assert.ok(preview.includes('loadTexture')&&preview.includes('loadHdri'),'gltf-preview 必须实现贴图与 HDRI 两条加载路径');
 assert.ok(preview.includes('RGBELoader'),'HDRI 需要 RGBELoader 解析 .hdr');
 assert.ok(fs.existsSync(path.join(root,'vendor/three/loaders/RGBELoader.js')),'vendor/three 缺少 RGBELoader.js');
 // 反证：服务端曾把 hdris 折成 models，卡片 assetType 永远是 models，HDRI 预览死活进不来。
 const polyhaven=read('server/polyhaven.mjs');
 assert.ok(/asset\.assetType==='textures'\|\|asset\.assetType==='hdris'/.test(polyhaven),
  '服务端 normalize 必须原样保留 hdris 类型，否则 HDRI 卡片永远走模型分支');
 assert.ok(preview.includes('resetEnvironment'),'看完 HDRI 再看模型必须复位 environment，否则模型被上一个 HDRI 染色');
});

test('预览容器与 three.js 依赖都到位',()=>{
 assert.ok(html.includes('id="viewer-canvas"'),'弹窗里要有 canvas 容器给本地渲染用');
 assert.ok(html.includes('id="viewer-caption"'),'底部说明要能按预览类型换文案');
 for(const f of ['three.module.js','loaders/GLTFLoader.js','controls/OrbitControls.js','environments/RoomEnvironment.js','utils/BufferGeometryUtils.js']){
  assert.ok(fs.existsSync(path.join(root,'vendor/three',f)),`vendor/three 缺少 ${f}`);
 }
 const build=read('scripts/build-library.mjs');
 assert.ok(build.includes('three-resolver'),'three.js 的裸导入（from \'three\'）需要 esbuild 插件解析');
 // 正则必须带 examples/jsm 这层且不能用 slice 取后缀（会拼出 GLTFLoader.js.js）
 assert.ok(/\^three\\\/examples\\\/jsm\\\/\(\.\+\?\)\\\.js\$/.test(build),'解析规则要精确匹配 three/examples/jsm/<path>.js');
});
