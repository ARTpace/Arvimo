import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// 内置 3D 预览要复刻八猴（Marmoset）的操作：左键旋转、右键缩放、中键平移、双击重置相机、
// Shift+左键旋转灯光。OrbitControls 的默认映射和八猴正好相反（RIGHT=PAN、MIDDLE=DOLLY），
// 且它管不了灯光和双击 —— 这两个点必须显式代码兜住，否则「和八猴一样」只是嘴上说。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const preview=read('src/library/gltf-preview.js');
const html=read('src/library/index.html');
const css=read('src/library/app.css');

test('鼠标映射对齐八猴：左键旋转、右键缩放、中键平移',()=>{
 assert.ok(preview.includes('controls.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.DOLLY}'),
  '必须显式映射三键——OrbitControls 默认 RIGHT 是 PAN、MIDDLE 是 DOLLY，和八猴正好相反');
 assert.ok(!/拖动旋转 · 滚轮缩放/.test(preview)&&!/拖动旋转 · 滚轮缩放/.test(html),
  '文案还写着「拖动旋转 · 滚轮缩放」，和新手势矛盾');
});

test('Shift+左键旋转灯光，且不会同时转相机',()=>{
 assert.ok(preview.includes('if(!event.shiftKey||event.button!==0||!controls||!lightRig)return;'),
  '只拦 Shift+左键，其他组合放行给 OrbitControls');
 assert.ok(preview.includes('controls.enabled=false;')&&preview.includes('controls.enabled=true;'),
  '拖灯光期间必须摘掉 OrbitControls——八猴的 Shift+左键是 PAN，不摘的话灯和相机一起动');
 assert.ok(preview.includes('lightRig.position.copy(controls.target);'),
  '灯光 rig 要绕视线中心转，不是绕世界原点');
 assert.ok(/lightRig\.rotation\.y=lightDrag\.yaw\+/.test(preview),'横向拖动改 yaw');
 assert.ok(/Math\.max\(-0\.5,Math\.min\(1\.1,/.test(preview),'俯仰要限幅，灯不能钻到地面以下');
 assert.ok(preview.includes("canvas.addEventListener('pointercancel',endLightDrag);"),
  '指针取消（触屏被打断）必须收尾，否则 controls 一直 disabled，相机直接瘫掉');
});

test('双击重置相机回到取景机位',()=>{
 assert.ok(preview.includes("canvas.addEventListener('dblclick',()=>resetCamera());"),'双击要绑重置');
 assert.ok(preview.includes('function resetCamera(){'),'要有 resetCamera 实现');
 assert.ok(preview.includes('function rememberHome(){'),'各分支取景后要记 homeShot');
 // 六个取景分支：Poly Haven models/textures/hdris + FreeStylized 模型/环境舞台 + Polyfork 参数化。
 // Polyfork 那处是 `if(!keepCamera)rememberHome()`：重建几何时保留当前机位，不覆盖 homeShot。
 assert.equal((preview.match(/rememberHome\(\)/g)||[]).length,6,
  '六个取景分支都要调 rememberHome，漏一个那种资产双击重置就没反应');
});

test('灯光 rig 与预览器 UI 到位',()=>{
 assert.ok(preview.includes('lightRig=new THREE.Group();scene.add(lightRig);'),'方向光要挂进 rig 才能整体旋转');
 assert.ok(preview.includes('lightRig.add(key)')&&preview.includes('lightRig.add(fill)'),'key/fill 进 rig，rim 留 scene');
 assert.ok(html.includes('id="viewer-help-btn"'),'操作提示要收进右上角「?」按钮，不再常驻占画面');
 assert.ok(html.includes('id="viewer-help"'),'「?」点击后要弹出操作说明面板');
 assert.ok(!html.includes('viewer-helps'),'常驻手势条已按需求移除，提示统一进「?」弹层');
 assert.ok(preview.includes('setChannelAvailable(true,model)')&&preview.includes('setChannelAvailable(true,object)'),
  '两条模型加载路径（Poly Haven glTF / FreeStylized 包）都要声明通道可用');
});

test('通道预览：五通道拆分 + 点击进单独预览',()=>{
 assert.ok(['normals','albedo','reflectivity','gloss','topology'].every(c=>preview.includes(`'${c}'`)),
  '五个通道一个不能少（对齐 mviewer 的 Normals/Albedo/Reflectivity/Gloss/Topology）');
 assert.ok(preview.includes('renderer.setScissorTest(true)')&&preview.includes('renderer.setScissor('),
  '拆分视图靠 scissor 分区域渲染同一场景，不是五份场景');
 assert.ok(preview.includes('setViewport(x,0,width,h)'),'每条通道要各自设 viewport，否则全画在一条里');
 // 压扁 bug 的根因：每条通道只有 1/5 宽，相机 aspect 若还是整块画布的，模型横向被压扁 5 倍。
 assert.ok(preview.includes('camera.aspect=aspect;camera.updateProjectionMatrix();'),
  '每条通道必须用自己的宽高比重算投影矩阵，否则模型被横向压扁（实测椅子直接被拍扁）');
 assert.ok(/channelRadius\/Math\.sin\(halfFov\)\/Math\.min\(1,aspect\)/.test(preview),
  '窄画幅横向 FOV 变小，距离要按包围球重算，否则模型被左右裁掉');
 assert.ok(preview.includes('const zoom=(dir.length()||1)/(fitFull||1);'),
  '拆分态要保留用户缩放级别，否则滚轮缩放失灵');
 assert.ok(preview.includes('camera.position.copy(logical);'),
  '渲染完要还原逻辑机位——controls 每帧按 camera.position 算轨道，不还原轨道会漂');
 assert.ok(preview.includes('if(moved>5)return;'),
  '点画布切通道必须用 pointerdown/up 距离区分拖动与点击，直接听 click 会在每次拖动收尾误切');
 assert.ok(preview.includes("setChannelMode(channelMode===CHANNELS[n-1]?'all':CHANNELS[n-1])"),
  '数字键 1-5 单通道，再按一次回拆分（与 mviewer 一致）');
 assert.ok(preview.includes("if(event.key==='0'){setChannelMode('all');return;}"),'0 进五通道拆分');
 assert.ok(html.includes('id="viewer-channel-labels"')&&html.includes('id="viewer-stats"'),
  '通道标签条与 Triangles/Vertices 统计都要有（照 mviewer）');
 assert.ok(css.includes('.viewer-channel-labels')&&css.includes('pointer-events:none'),
  '通道覆盖层必须 click-through，否则画布转不动');
});

test('平台自己的 iframe 预览器不显示内置预览器 UI',()=>{
 // Sketchfab / ArtStation / ambientCG 走 iframe，各有各的操作方式；
 // 内置预览器的「?」/通道按钮和手势 caption 只属于本地 three 预览。
 assert.ok(/\.viewer-tools\s*,\s*\.viewer-caption\s*\{[^}]*display:none/.test(css),
  '工具条与 caption 默认收起，不能常驻');
 assert.ok(/\.viewer-wrap:has\(#viewer-canvas:not\(\[hidden\]\)\)\s*\.viewer-tools\s*\{[^}]*display:flex/.test(css),
  '只有画布亮出（本地 three 预览）时才显示工具条');
 assert.ok(/\.viewer-wrap:has\(#viewer-canvas:not\(\[hidden\]\)\)\s*\.viewer-caption\s*\{[^}]*display:flex/.test(css),
  'caption 同理——iframe 预览下显示本地手势文案会误导');
});
test('通道覆盖材质可还原，且 gloss 用粗糙度反色',()=>{
 assert.ok(preview.includes('function restoreMaterials(){'),'切完通道必须还原原材质');
 assert.ok(preview.includes('originalMaterials.get(node)'),'原材质要先存再覆盖');
 assert.ok(preview.includes('function invertTexture(tex)'),'gloss 通道 = 粗糙度贴图反色');
 assert.ok(/255-data\[i\]/.test(preview),'反色要走 canvas 逐像素取反');
 assert.ok(preview.includes('new THREE.MeshNormalMaterial()'),'Normals 用法线材质');
 assert.ok(preview.includes('metalness:1,roughness:0.1'),'Reflectivity 用铬球（全金属 + 低粗糙）');
 assert.ok(preview.includes('wireframe:true'),'Topology 用线框');
 assert.ok(preview.includes('function disposeChannelResources(){'),'关预览必须释放通道覆盖材质与反色贴图');
 assert.ok(preview.includes('disposeChannelResources();setChannelMode'),'close/fail 都要收通道态');
});

// 「宽度一变模型就变形」的根因：渲染 buffer 停在旧尺寸。window 的 resize 只覆盖窗口尺寸变了，
// 覆盖不到弹窗布局变了（dialog 高度被 90vh 夹住、宽度是 min(1480px,96vw)、回流改画布尺寸），
// 那些时刻一个 resize 事件都不发 —— 必须自己盯住画布容器。
test('画布尺寸跟着显示尺寸同步，不只靠 window resize',()=>{
 assert.ok(preview.includes("new ResizeObserver(()=>resize())"),'要盯住画布容器的尺寸变化');
 assert.ok(/sizeObserver\.observe\(canvas\.parentElement\|\|canvas\)/.test(preview),'观察的是容器，画布 hidden 时它是 0');
 assert.ok(preview.includes('observeStage();'),'建好与复用渲染器两条路径都要挂上观察');
 assert.ok(/if\(w===viewW&&h===viewH\)return;/.test(preview),'尺寸没变要早退（它现在会被每帧兜底调到）');
 assert.ok(/function loop\(\)\{[\s\S]*?resize\(\);[\s\S]*?controls\.update\(\)/.test(preview),'交互请求的帧在绘制前同步尺寸，空闲时不再为兜底持续绘制');
 assert.ok(preview.includes('let viewW=0,viewH=0,sizeObserver=null;'),'记着上次同步过的尺寸');
});
