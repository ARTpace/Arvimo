import {loadUsdPreview} from './usd-preview.js';
// Poly Haven 的本地 3D 预览。
//
// 官方页面能转视角，靠的是浏览器自己去 glTF CDN 取 1k 档模型自己渲染；他们**没有**可嵌入的
// iframe viewer。所以这里做等价的事：同一个 1k glTF，同一个 CDN，只是渲染器在我们这边。
//
// 有个坑必须处理：glTF 里贴图写的是打包时的相对路径（`textures/Armchair_01_diff_1k.jpg`），
// 而 CDN 上并没有这个目录，直接加载必然 404。官方是靠自己的文件清单把 basename 映射回真实 URL，
// 我们照同样的做法——先要清单，再按 basename 改写 GLTFLoader 要用的 URL。
import * as THREE from 'three';
import {createPreviewCache} from './preview-cache.js';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {RGBELoader} from 'three/examples/jsm/loaders/RGBELoader.js';
// FreeStylized 的模型包里只有 FBX（没有 glTF），所以除了 glTF 还得会读 FBX。
import {FBXLoader} from 'three/examples/jsm/loaders/FBXLoader.js';
// 资源包里的模型格式很杂：ambientCG 地形是 OBJ，打印/扫描类资产常见 STL / PLY / 3MF。
// 每个格式一个官方 loader，按扩展名分派（见 showPackModel 的格式表）。
import {OBJLoader} from 'three/examples/jsm/loaders/OBJLoader.js';
import {STLLoader} from 'three/examples/jsm/loaders/STLLoader.js';
// Polyfork 的生成器脚本 import 了 mergeGeometries：本地重建时把这一份注入给它，
// 免得为了跑生成器再让浏览器下载第二份 three。
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {PLYLoader} from 'three/examples/jsm/loaders/PLYLoader.js';
import {ThreeMFLoader} from 'three/examples/jsm/loaders/3MFLoader.js';
// 环境贴图除了 Radiance .hdr，还有 ambientCG / Poly Haven 出的 EXR 全景。
import {EXRLoader} from 'three/examples/jsm/loaders/EXRLoader.js';

const FILE_API='https://api.polyhaven.com/files';
const CDN='https://dl.polyhaven.org/file/ph-assets';
/** 本机有系统代理（127.0.0.1:2953），浏览器直连这两个域会被劫持成 ERR_ABORTED（实测过）。
 *  所以所有远程请求都改走本地服务的 /api/proxy：它已把 Poly Haven 列入白名单，且对非图片类型
 *  放行 application/octet-stream，glTF 与 .bin 都能原样穿过。
 *  /api/proxy 要求 x-sfx-local 头，但 GLTFLoader 自己发的贴图/缓冲请求带不了头 —— 与其改服务端的
 *  鉴权规则，不如我们自己把资源抓成 blob: URL 再交给 loader。blob 是同源的，不经服务端二次请求。 */
function proxied(url){return `/api/proxy?url=${encodeURIComponent(url)}`;}
const LOCAL_HEADER={'x-sfx-local':'1'};
async function fetchLocal(url){
  const res=await fetch(proxied(url),{headers:LOCAL_HEADER});
  if(!res.ok)throw new Error(`代理请求失败 HTTP ${res.status}`);
  return res;
}
/** glTF 的文件名首字母大小写常与 CDN 上的不一致（ArmChair_01_1k.gltf 里的贴图是 Armchair_01_*），
 *  所以索引统一按小写 basename 存，比对时也小写 —— 否则 CDN 是大小写敏感的，会静默 404。 */
function indexByBasename(node,index=new Map()){
 if(Array.isArray(node)){for(const item of node)indexByBasename(item,index);return index;}
 if(!node||typeof node!=='object')return index;
 if(typeof node.url==='string'&&node.url){const base=node.url.slice(node.url.lastIndexOf('/')+1).toLowerCase();if(base&&!index.has(base))index.set(base,node.url);}
 for(const value of Object.values(node))indexByBasename(value,index);
 return index;
}

// 磁盘保存原始压缩图片/几何资源，热缓存只保留 24 MB；重复预览不必重新下载。
const previewCache=createPreviewCache(fetchLocal);
async function toBlob(url,registry,kind='资源'){
 const blob=await previewCache.get(url);
 const created=URL.createObjectURL(blob);
 registry.push(created);
 return created;
}

/** 官方文件清单也缓存：三条预览路径每次都要先问一遍 `/files/{id}?type=..`，
 *  而清单是稳定的小 JSON（几十 KB），没必要每次跨网重取。
 *  缓存的是 parsed 对象直接复用 —— 调用方只读不改它（改写 URI 的是 inlineResources 作用在
 *  另一份 gltf 对象上），所以共享同一份是安全的。 */
const LIST_CACHE_MAX=64;
const listCache=new Map();
async function fetchList(assetId,type){
 const key=`${type}:${assetId}`;
 const hit=listCache.get(key);
 if(hit){listCache.delete(key);listCache.set(key,hit);return hit;}
 const res=await fetchLocal(`${FILE_API}/${encodeURIComponent(assetId)}?type=${type}`);
 const data=await res.json();
 listCache.set(key,data);
 while(listCache.size>LIST_CACHE_MAX)listCache.delete([...listCache.keys()][0]);
 return data;
}

/** 把 glTF 的外部引用全部换成本地 blob URL。
 *  清单里没有的按 glTF 所在目录兜底拼（`.bin` 就是这种，文件清单只列模型与贴图）。
 *  注意：blob 是通过 registry **就地 push** 的，本函数不返回值 —— 调用方不要写
 *  `blobs=await inlineResources(...)`，那会把 blobs 覆盖成 undefined，下一次 revokeBlobs 直接崩。 */
async function inlineResources(gltf,index,baseDir,registry){
  const toBlobURL=async(uri,kind)=>{
    const base=uri.slice(uri.lastIndexOf('/')+1).toLowerCase();
    const target=index.get(base)||`${baseDir}/${uri}`;
    try{
      return await toBlob(target,registry,kind);
    }catch(e){
      throw new Error(`${kind} ${uri} 取不到：${e.message}`);
    }
  };
  // 并行而不是逐个 await：一个 1K 模型通常 1 个 .bin + 5~7 张贴图，串行等于把
  // 「网络往返次数 × RTT」叠起来（本机代理 + 跨境 CDN，RTT 不小），这是预览慢的另一半原因。
  // Promise.all 一起发，墙钟时间从「求和」变成「取最慢的那一个」。
  const jobs=[];
  if(Array.isArray(gltf.buffers))for(const b of gltf.buffers){
    if(typeof b.uri==='string'&&b.uri&&!/^(data:|blob:)/i.test(b.uri))jobs.push(toBlobURL(b.uri,'几何数据').then(url=>{b.uri=url;}));
  }
  if(Array.isArray(gltf.images))for(const i of gltf.images){
    if(typeof i.uri==='string'&&i.uri&&!/^(data:|blob:)/i.test(i.uri))jobs.push(toBlobURL(i.uri,'贴图').then(url=>{i.uri=url;}));
  }
  await Promise.all(jobs);
}

export function createGltfPreview(){
 let renderer=null,scene=null,camera=null,controls=null,frame=0,disposed=false,ready=false;
 let loadToken=0,blobs=[],root=null,baseEnvironment=null,envTexture=null;
 let cacheIdleTimer;
 // 灯光 rig：Shift+左键拖动时转它（八猴的 rotate lights），绕视线中心旋转。
 let lightRig=null,homeShot=null,lightDrag=null,gesturesBound=false,uiBound=false;
 // 上一次真正同步过的画布尺寸：渲染 buffer 必须等于显示尺寸，否则画面被拉伸变形。
 let viewW=0,viewH=0,sizeObserver=null;
 // 通道预览（复刻 ArtStation mviewer）：'off' 关闭 / 'all' 五通道拆分 / 单通道名 = 单独预览。
 let channelMode='off',channelTarget=null,channelAvailable=false,pressInfo=null,channelRadius=1;
 // 显示模式（对齐 art-canvas 预览器）：material 原材质 / white 白模 / wire 线框。
 let displayMode='material';
 // 灯光与后加的场景设置要能改强度，所以三盏灯提到外面引用。
 let keyLight=null,fillLight=null,hemiLight=null;
 // 用户上传的自定义环境（PMREM 生成物，切走必须 dispose）与设置面板里的环境缩略球目标。
 let customEnvironment=null,environmentPreviewTarget=null,environmentRequest=0;
 // 视角标签与会话内的动画状态。
 let savedViews=[],assetKey='',mixer=null,animClipList=[],animAction=null,playing=true,animClock=null;
 // 资产类型决定工具条显隐；参数撤销栈按每次预览会话隔离。
 let assetKind='model',undoStack=[],lastCommitted=null;
 // 通道分条渲染用 scissor/viewport，一旦中途抛错会残留到下一次预览（画面只画在一条竖条里）。
 let scissorDirty=false;
 // 通道覆盖材质：原材质存 originalMaterials 供还原；albedo/gloss 与源材质一对一并按 uuid 缓存；
 // invertCache 缓存 gloss 用的「粗糙度反色」贴图（canvas 生成，关闭时必须 dispose）。
 let originalMaterials=new Map(),channelMaterials=null,albedoCache=new Map(),glossCache=new Map(),invertCache=new Map();
 const CHANNELS=['normals','albedo','reflectivity','gloss','topology'];
 const CHANNEL_LABELS={normals:'Normals',albedo:'Albedo',reflectivity:'Reflectivity',gloss:'Gloss',topology:'Topology'};
 const canvas=document.getElementById('viewer-canvas');

 /** blob 是同源的，但不会自动回收 —— 每次换资产或关弹窗都必须 revoke，否则显存/内存一路涨。
  * 兜底 Array.isArray：blobs 一旦被弄成非数组（历史上 inlineResources 没返回值、被赋值覆盖成
  * undefined），这里抛出的 TypeError 会让整个预览黑屏且毫无提示，宁可漏回收也不能让预览挂掉。 */
 function revokeBlobs(){if(Array.isArray(blobs))for(const url of blobs)URL.revokeObjectURL(url);blobs=[];}

 function stop(){
  cancelAnimationFrame(frame);frame=0;
  // 重要：这里故意不复用销毁 WebGL 上下文。关预览弹窗只是「隐藏」，下次打开会复用同一个
  // renderer（见 ensureRenderer 的复用分支）。若在此 dispose 渲染器并把 renderer 置空，
  // 下一次打开会在同一个 <canvas> 上新建 renderer —— 同一个 canvas 复用已被清过状态的上下文
  // 极不稳定，表现就是「第一次预览正常、第二次整片黑屏」。渲染器在应用生命周期内只建一次、长期复用。
 }

 // 状态文字统一写 #state —— 与 art-canvas viewer.html 的 #state 同一个元素、同一处位置。
 function setHint(text){
  const hint=document.getElementById('state');if(!hint)return;
  hint.textContent=text||'';
  hint.className=text&&/失败|不支持/.test(text)?'error':'';
 }
/* ── ANCHOR-DIFF 9：加载过渡层（与 art-canvas viewer.html 同构，可整段互相拷贝）──
 * #state 是唯一的加载状态源：有文字且不是错误 = 加载中，清空文字 = 加载完成。
 * 用 MutationObserver 统一驱动，不用改任何一处 setHint 调用点。 */
function bindLoadingOverlay(){
 const stateEl=document.getElementById('state'),layer=document.getElementById('viewer-loading');
 if(!stateEl||!layer||layer.dataset.bound)return;
 layer.dataset.bound='1';
 const text=document.getElementById('viewer-loading-text');
 let hideTimer=0,wantVisible=false;
 const sync=()=>{
  const value=stateEl.textContent.trim();
  const loading=!!value&&!/失败|不支持|错误|无法|丢失/.test(value)&&!stateEl.classList.contains('error');
  clearTimeout(hideTimer);
  // wantVisible 必须一起判断：缓存命中时加载比两帧还快，只判 hidden 会让
  // 迟到的淡入回调把已经收起的遮罩重新点亮，然后永久卡住。
  wantVisible=loading;
  if(loading){
   layer.hidden=false;
   if(text)text.textContent=value;
   requestAnimationFrame(()=>requestAnimationFrame(()=>{if(wantVisible&&!layer.hidden)layer.classList.add('on');}));
  }else{
   layer.classList.remove('on');
   hideTimer=setTimeout(()=>{if(!wantVisible)layer.hidden=true;},240);
  }
 };
 new MutationObserver(sync).observe(stateEl,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['class']});
 sync();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bindLoadingOverlay,{once:true});
else bindLoadingOverlay();
// 界面里已经没有底部 caption（art-canvas 那份也没有），保留空函数是为了不动各处调用点。
 function setCaption(){}
const DEFAULT_CAPTION='';

 function fail(message,detail){
  stop();
  stopAnimation();
  // 释放上一帧的 GPU 资源（灯光在 scene 上、不会被清），避免连续预览显存堆积。
  pfGround=null;
  if(root){for(const child of [...root.children]){root.remove(child);disposeObject(child);}}
  if(canvas)canvas.hidden=true;
  // 这里**不能**把 iframe 放出来：本地渲染（Poly Haven / FreeStylized / SimReady / SBSAR）
  // 走的是 canvas，iframe 的 src 早在 prepareStage 就被清掉了。一旦把它 hidden=false，
  // 一片 about:blank 的白底会盖在 canvas 和错误提示上面 —— 表现就是「预览一片白」，
  // 连失败原因都看不见（2026-11-12 用户反馈）。
  const iframe=document.getElementById('viewer');
  if(iframe){iframe.hidden=true;iframe.removeAttribute('src');}
  channelTarget=null;disposeChannelResources();setChannelMode('off');
  setCaption(DEFAULT_CAPTION);
  setHint(message);
  if(detail)console.warn('[Poly Haven 预览]',message,detail);
 }

 /** Controls 的 change 事件续上阻尼帧，静止后不再重复绘制。 */
 function requestRender(){
  if(!disposed&&renderer&&!document.hidden&&!frame)frame=requestAnimationFrame(loop);
 }
 function loop(){
  frame=0;
  if(disposed||!renderer)return;
  if(document.hidden)return;
  resize();
  controls.update();
  // 动画在播就每帧续一次 raf（静止后仍回到按需绘制，不空转烧 GPU）。
  if(mixer&&playing){
   mixer.update(Math.min(animClock?.getDelta?.()||0.016,0.1));
   requestRender();
  }
  renderFrame();
 }

 /** 弹窗打开时才建渲染器：<dialog>关闭时尺寸是 0，建了也白建。 */
 function ensureRenderer(){
  clearTimeout(cacheIdleTimer);
  // 复用渲染器（连着看多个资产）时也要保证循环是活的，并重新对齐画布尺寸
  // （窗口可能在上次预览后变过宽高，否则画布会被 CSS 拉伸、画面错位）。
  if(renderer){disposed=false;requestRender();observeStage();resize();return true;}
  if(!canvas)return false;
  const {w,h}=canvasSize();
  if(!w)return false;
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
  renderer.setSize(w,h||465,false);
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.05;
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  // PMREM 环境光：Poly Haven 的 PBR 材质里有金属/粗糙度，没有环境贴图会渲染成一片黑。
  const pmrem=new THREE.PMREMGenerator(renderer);
  baseEnvironment=pmrem.fromScene(new RoomEnvironment(),0.04).texture;
  pmrem.dispose();
  scene=new THREE.Scene();
  scene.background=new THREE.Color(0x0d1117);
  scene.environment=baseEnvironment;
  // 灯光挂在 scene 上（不是 root）：换资产时 clearRoot 只清 root 下的模型/地面，灯光始终留着，
  // 否则每次 clearRoot 都会把灯光一并 dispose，第二张往后就只剩环境光、发灰发暗。
  root=new THREE.Group();scene.add(root);
  // 方向光挂进 lightRig：Shift+左键拖动就是转这个 rig（八猴的 rotate lights），
  // 绕着视线中心 controls.target 转，明暗关系随手可调。半球光留 scene 不动。
  lightRig=new THREE.Group();scene.add(lightRig);
  keyLight=new THREE.DirectionalLight(0xffffff,1.7);keyLight.position.set(3,5,4);lightRig.add(keyLight);
  fillLight=new THREE.DirectionalLight(0xbcd0ff,0.7);fillLight.position.set(-4,2,-3);lightRig.add(fillLight);
  hemiLight=new THREE.HemisphereLight(0xdfe8ff,0x2b3440,1.1);scene.add(hemiLight);
  // w/h 来自上面 canvasSize()：画布此刻已经亮出（有真实高度），不要退回写死的 465。
  camera=new THREE.PerspectiveCamera(45,w/(h||465),0.01,2000);
  camera.position.set(1.6,1.2,1.9);
  controls=new OrbitControls(camera,canvas);
  controls.enableDamping=true;controls.dampingFactor=0.08;
  controls.addEventListener('change',requestRender);
  controls.minDistance=0.05;controls.maxDistance=60;
  // 八猴（Marmoset）那套鼠标映射：左键旋转、右键缩放、中键平移。滚轮缩放保持默认开启。
  // 注意 RIGHT 默认是 PAN、MIDDLE 默认是 DOLLY，不显式映射就是「和八猴反着来」。
  controls.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.DOLLY};
  bindViewerGestures();
  bindViewerUI();
  observeStage();
  // 关掉弹窗时 disposed 被置 true（让在途的那一帧退出）。它是「一次性」的开关，重开预览必须
  // 复位：否则新启动的 loop 第一行就 return，场景只在 load 末尾手动 render 那一帧，之后既不
  // 重绘也不跑 controls.update() —— 表现就是拖动、滚轮全部失灵（第二次打开起必现）。
  disposed=false;
  requestRender();
  return true;
 }

 /** 把渲染 buffer 对齐到画布当前显示尺寸。尺寸没变就直接返回——它现在会被每帧的兜底检查
  *  调到，早退是必要的，否则每帧重算投影矩阵纯属浪费。 */
 function resize(){
  if(disposed||!renderer||!camera||!canvas)return;
  const {w,h}=canvasSize();
  if(!w||!h)return;
  // 尺寸没变也要守住 aspect：通道分条渲染会把 camera.aspect 改成单条宽高比，恢复漏掉一次，
  // 之后的画面就永远挤在一条竖缝里。
  if(w===viewW&&h===viewH){if(Math.abs(camera.aspect-w/h)>1e-4){camera.aspect=w/h;camera.updateProjectionMatrix();requestRender();}return;}
  viewW=w;viewH=h;
  camera.aspect=w/h;camera.updateProjectionMatrix();
  renderer.setSize(w,h,false);
  renderer.setScissorTest(false);
  renderer.setViewport(0,0,w,h);
  requestRender();
 }
const onResize=()=>resize();
window.addEventListener('resize',onResize);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else requestRender();});
/** window 的 resize 只覆盖「窗口尺寸变了」，覆盖不到「弹窗布局变了」：<dialog> 的高度会被
 *  90vh 夹住、宽度是 min(1480px,96vw)，同一次预览里布局回流也会改画布尺寸（字体加载、
 *  筛选行搬位……），那些时刻一个 resize 事件都不会发。渲染 buffer 就停在旧尺寸上，
 *  画面被横向或纵向拉伸——这正是「宽度一变模型就变形」的来源。ResizeObserver 盯住
 *  画布容器，布局一改就补同步。 */
 function observeStage(){
  if(sizeObserver||!canvas||typeof ResizeObserver==='undefined')return;
  sizeObserver=new ResizeObserver(()=>resize());
  sizeObserver.observe(canvas.parentElement||canvas);
 }

 /** 八猴式手势（OrbitControls 默认映射与它相反，且管不了灯光和双击）：
  *  - Shift+左键拖动 = 旋转灯光：先摘掉 OrbitControls（否则左键会同时转相机），
  *    拖动时把 lightRig 的枢轴对齐到 controls.target，俯仰限制在合理区间。
  *  - 双击 = 重置相机：回到各分支取景时记下的 homeShot。
  *  灯光变化单独请求一帧，静止后不继续绘制。 */
 function bindViewerGestures(){
  if(!canvas||gesturesBound)return;
  gesturesBound=true;
  canvas.addEventListener('pointerdown',event=>{
   if(!event.shiftKey||event.button!==0||!controls||!lightRig)return;
   lightDrag={x:event.clientX,y:event.clientY,yaw:lightRig.rotation.y,pitch:lightRig.rotation.x};
   controls.enabled=false;
   lightRig.position.copy(controls.target);
   try{canvas.setPointerCapture(event.pointerId);}catch(_){}
   event.preventDefault();
  });
  canvas.addEventListener('pointermove',event=>{
   if(!lightDrag)return;
   lightRig.rotation.y=lightDrag.yaw+(event.clientX-lightDrag.x)*0.006;
   lightRig.rotation.x=Math.max(-0.5,Math.min(1.1,lightDrag.pitch+(event.clientY-lightDrag.y)*0.006));
   requestRender();
  });
  const endLightDrag=()=>{if(!lightDrag)return;lightDrag=null;if(controls)controls.enabled=true;};
  canvas.addEventListener('pointerup',endLightDrag);
  canvas.addEventListener('pointercancel',endLightDrag);
  canvas.addEventListener('dblclick',()=>resetCamera());
 }

 /** 预览器 UI：右上角「?」操作说明弹层 + 「通道」开关 + 点画布切通道 + 数字快捷键。
  *  点画布切通道必须挂在 canvas 自己身上（覆盖层 pointer-events:none），并且用
  *  pointerdown/up 的距离区分「点击」与「拖动旋转」—— 直接听 click 会在每次拖动
  *  收尾时误切通道。 */
 function bindViewerUI(){
  if(!canvas||uiBound)return;
  uiBound=true;
  const helpBtn=document.getElementById('viewer-help-btn');
  const helpPanel=document.getElementById('viewer-help');
  if(helpBtn&&helpPanel)helpBtn.addEventListener('click',()=>togglePanel('viewer-help','viewer-help-btn'));
  const helpClose=helpPanel?.querySelector('[data-close]');
  if(helpClose&&helpPanel)helpClose.addEventListener('click',()=>{helpPanel.hidden=true;helpBtn?.classList.remove('on');});
  const channelBtn=document.getElementById('viewer-channels-btn');
  if(channelBtn)channelBtn.addEventListener('click',()=>{
   if(!channelAvailable||!channelTarget)return;
   setChannelMode(channelMode==='off'?'all':'off');
  });
  // 画布点击：拆分态点某条 → 单独预览该通道；单独态再点 → 回拆分（同 mviewer）。
  canvas.addEventListener('pointerdown',event=>{pressInfo={x:event.clientX,y:event.clientY};});
  canvas.addEventListener('pointerup',event=>{
   if(!pressInfo||channelMode==='off'||!channelTarget){pressInfo=null;return;}
   const moved=Math.hypot(event.clientX-pressInfo.x,event.clientY-pressInfo.y);
   pressInfo=null;
   if(moved>5)return;
   const rect=canvas.getBoundingClientRect();
   const fx=rect.width?(event.clientX-rect.left)/rect.width:0;
   if(channelMode==='all'){
    const idx=Math.min(CHANNELS.length-1,Math.max(0,Math.floor(fx*CHANNELS.length)));
    setChannelMode(CHANNELS[idx]);
   }else setChannelMode('all');
  });
  // 数字快捷键与 mviewer 一致：1-5 单通道（再按一次回拆分），0 进拆分。
  window.addEventListener('keydown',event=>{
   const dialog=document.getElementById('preview-dialog');
   if(!dialog?.open||canvas.hidden)return;
   const tag=event.target?.tagName;
   // 文本框里让浏览器自己撤销输入；滑条 / 复选框 / 画布上的 Ctrl+Z 归预览器参数。
   const typing=tag==='TEXTAREA'||(tag==='INPUT'&&!['range','checkbox','file'].includes(event.target.type));
   if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='z'&&!event.shiftKey&&!typing){
    if(undoParams())event.preventDefault();
    return;
   }
   if(event.target&&/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))return;
   if(event.key==='Escape'){closeViewerPanels();return;}
   if(!channelAvailable||!channelTarget)return;
   if(event.key==='0'){setChannelMode('all');return;}
   const n=Number(event.key);
   if(n>=1&&n<=CHANNELS.length)setChannelMode(channelMode===CHANNELS[n-1]?'all':CHANNELS[n-1]);
  });

  // 显示模式三键
  for(const button of document.querySelectorAll('[data-display]')){
   button.addEventListener('click',()=>setDisplayMode(button.dataset.display));
  }
  // 面板开合
  const uvBtn=document.getElementById('viewer-uv-btn');
  if(uvBtn)uvBtn.addEventListener('click',()=>setUVOpen(document.getElementById('viewer-uv')?.hidden!==false));
  const uvClose=document.getElementById('viewer-uv-close');
  if(uvClose)uvClose.addEventListener('click',()=>setUVOpen(false));
  const texturesBtn=document.getElementById('viewer-textures-btn');
  if(texturesBtn)texturesBtn.addEventListener('click',()=>setTexturesOpen(document.getElementById('viewer-textures')?.hidden!==false));
  const fullBtn=document.getElementById('full');
  if(fullBtn)fullBtn.addEventListener('click',toggleFullscreen);

  // UV 通道切换
  const uvSelect=document.getElementById('viewer-uv-channel');
  if(uvSelect)uvSelect.addEventListener('change',drawUVLayout);
  // 视角保存
  const viewForm=document.getElementById('viewer-view-form');
  if(viewForm)viewForm.addEventListener('submit',event=>{
   event.preventDefault();
   const input=document.getElementById('viewer-view-name');
   saveCurrentView(input?.value);
   if(input)input.value='';
  });
  // 场景设置：光照/环境收进 lighting-btn 的下拉，id 与交互和 art-canvas 完全同一套。
  const settings=document.getElementById('viewer-settings');
  const closeLighting=()=>{
   const menu=document.getElementById('lighting-menu'),btn=document.getElementById('lighting-btn');
   if(menu)menu.hidden=true;
   if(btn)btn.setAttribute('aria-expanded','false');
  };
  const lightingBtn=document.getElementById('lighting-btn');
  if(lightingBtn)lightingBtn.addEventListener('click',()=>{
   const menu=document.getElementById('lighting-menu');
   if(!menu)return;
   const open=menu.hidden;
   closeLighting();
   menu.hidden=!open;
   lightingBtn.setAttribute('aria-expanded',String(open));
   if(open){updateEnvironmentSettings();scheduleEnvironmentPreview(true);renderSavedViews();}
  });
  if(settings)document.addEventListener('pointerdown',event=>{if(!settings.contains(event.target))closeLighting();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeLighting();});
  const strength=document.getElementById('lighting-strength');
  if(strength)strength.addEventListener('input',()=>{setLightStrength(strength.value);updateEnvironmentSettings();});
  for(const id of ['scene-lights','scene-world','environment-rotation','environment-opacity','environment-blur']){
   const input=document.getElementById(id);
   if(input)input.addEventListener('input',updateEnvironmentSettings);
  }
  const file=document.getElementById('environment-file');
  const upload=document.getElementById('environment-upload');
  if(upload&&file)upload.addEventListener('click',()=>file.click());
  // 缩略球本身就是「换环境」的按钮（art-canvas 同款交互）。
  const envPreview=document.getElementById('environment-preview');
  if(envPreview&&file)envPreview.addEventListener('click',()=>file.click());
  if(file)file.addEventListener('change',()=>{replaceEnvironment(file.files?.[0]);file.value='';});
  const reset=document.getElementById('environment-reset');
  if(reset)reset.addEventListener('click',resetCustomEnvironment);
  // 材质预设条
  bindMaterialBar();
  // 动画：选 clip / 播放暂停
  const clipSelect=document.getElementById('clip');
  if(clipSelect)clipSelect.addEventListener('change',()=>playAnimation(clipSelect.value));
  const playBtn=document.getElementById('play');
  if(playBtn)playBtn.addEventListener('click',()=>{
   playing=!playing;
   if(animAction)animAction.paused=!playing;
   syncPlayButton();requestRender();
  });
  // 参数撤销：滑条/复选框 change、按钮 click 后各记一帧；状态没变则不入栈。
  for(const rootId of ['lighting-menu','viewer-material','viewer-tools']){
   const root=document.getElementById(rootId);if(!root)continue;
   root.addEventListener('change',commitUndo);
   root.addEventListener('click',()=>setTimeout(commitUndo,0));
  }
  // 点面板外收面板（设置/视角这类浮层不该一直挡画布）
  for(const btn of document.querySelectorAll('[data-close-panel]'))btn.addEventListener('click',()=>closeFloatingPanels());
  document.addEventListener('pointerdown',event=>{
   const dialog=document.getElementById('preview-dialog');
   if(!dialog?.open)return;
   const tools=document.querySelector('.viewer-tools');
   if(tools&&tools.contains(event.target))return;
   for(const [panel] of PANEL_BUTTONS){
    const el=document.getElementById(panel);
    if(el&&!el.hidden&&!el.contains(event.target))closeFloatingPanels();
   }
  });
 }

 /** 各分支取景完成后记一次「到家机位」，双击重置就靠它 —— 包围盒是加载时算好的，
  *  这里只存快照，不做任何重算，避免 reset 时再量一次尺寸把 ground 圆也算进去。 */
 function rememberHome(){
  if(!camera||!controls)return;
  homeShot={position:camera.position.clone(),target:controls.target.clone(),
   near:camera.near,far:camera.far,minDistance:controls.minDistance,maxDistance:controls.maxDistance};
 }
 function resetCamera(){
  if(!homeShot||!camera||!controls)return;
  camera.position.copy(homeShot.position);
  controls.target.copy(homeShot.target);
  camera.near=homeShot.near;camera.far=homeShot.far;camera.updateProjectionMatrix();
  controls.minDistance=homeShot.minDistance;controls.maxDistance=homeShot.maxDistance;
  controls.update();
 }

 /** 通道预览整套状态机（复刻 ArtStation mviewer 的 Normals/Albedo/Reflectivity/Gloss/Topology）：
  *  - 'off'   正常渲染
  *  - 'all'   画布竖切成五条，每条一个通道（scissor 分区域渲染同一场景）
  *  - 单通道  该通道独占整块画布；再点一下画布回到 'all'
  *  点画布的行为由 bindViewerUI 里的 pointerdown/up 距离判定（>5px 算拖动，不切通道）。 */
 function setChannelMode(mode){
  channelMode=mode;
  // 进通道视图就把显示模式收回材质：两套覆盖材质不该同时生效（通道优先）。
  if(mode!=='off')displayMode='material';
  const btn=document.getElementById('viewer-channels-btn');
  if(btn)btn.classList.toggle('on',mode!=='off');
  const overlay=document.getElementById('viewer-channels');
  if(overlay)overlay.hidden=mode==='off'||!channelTarget;
  renderChannelLabels();
  syncDisplayButtons();
  renderFrame();
 }

 /** 通道是否可用：只有模型预览有通道可言；贴图/HDRI 是球和全景，进来先把按钮收起来。
  *  同时量一次包围球半径 —— 拆分视图每条通道是窄画幅，要靠它把相机推到能看全的距离。 */
 function setChannelAvailable(available,model){
  channelAvailable=!!available;
  channelTarget=model||null;
  if(channelTarget){
   const box=new THREE.Box3().setFromObject(channelTarget);
   const sphere=box.isEmpty()?null:box.getBoundingSphere(new THREE.Sphere());
   channelRadius=sphere&&sphere.radius>0?sphere.radius:1;
  }
  const btn=document.getElementById('viewer-channels-btn');
  if(btn)btn.hidden=!channelAvailable||assetKind!=='model';
  if(!channelAvailable)setChannelMode('off');
  // 白模/线框/UV/视角都只对有网格的预览有意义：没有目标就把按键灰掉。
  applyCapabilityBar();
  updateUVPreview();
  renderSavedViews();
  // 换资产时材质预设回到「模型」，并重刷材质条的可用状态。
  materialGeometry='model';
  disposeMaterialPreset();
  syncMaterialBar();
 }

 /** 拆分/单独预览的标签条与统计（mviewer 左下角的 Triangles/Vertices）。 */
 function renderChannelLabels(){
  const wrap=document.getElementById('viewer-channel-labels');
  const stats=document.getElementById('viewer-stats');
  const live=channelMode!=='off'&&!!channelTarget;
  if(wrap){
   const strips=live?(channelMode==='all'?CHANNELS:[channelMode]):[];
   wrap.innerHTML=strips.map(name=>`<span>${CHANNEL_LABELS[name]}</span>`).join('');
   wrap.dataset.mode=channelMode;
  }
  if(stats){
   stats.hidden=!live;
   if(live){
    let tris=0,verts=0;
    channelTarget.traverse(node=>{
     if(!node.isMesh||!node.geometry)return;
     const g=node.geometry;
     verts+=g.attributes.position?.count||0;
     tris+=g.index?g.index.count/3:(g.attributes.position?.count||0)/3;
    });
    stats.textContent=`Triangles: ${Math.round(tris).toLocaleString('en-US')}　Vertices: ${verts.toLocaleString('en-US')}`;
   }
  }
 }

 /** 每帧出口：正常渲染，或按通道 scissor 分条渲染。renderer.render 默认 autoClear，
  *  开着 scissor test 时clear 只清当前条区域 —— 这正是多视图官方示例的做法。
  *
  *  拆分态最关键的一点：每条通道只是整块画布的 1/5 宽，相机 aspect 若还是整块画布的，
  *  模型会被横向压扁 5 倍（实测椅子直接被拍扁）。所以每条通道：
  *   1. aspect 改成该条的 width/h；
  *   2. 距离按包围球重算（窄画幅横向 FOV 变小，不推远就会被左右裁掉）；
  *   3. 乘上用户的缩放系数（dUser/dFull），否则拆分态里滚轮缩放会失灵。
  *  渲染完把 aspect 和机位还原成「逻辑机位」—— controls 每帧都用这两个值算轨道。 */
 function renderFrame(){
  if(!renderer)return;
  if(scissorDirty)resetRenderState();
  if(channelMode==='off'||!channelTarget){
   // 白模 / 线框也是「覆盖材质」，和通道预览共用一套缓存与还原逻辑，只是不切条。
   const override=channelTarget&&displayMode!=='material';
   if(override)applyChannel(displayMode);
   renderer.render(scene,camera);
   if(override)restoreMaterials();
   return;
  }
  const {w,h}=canvasSize();
  if(!w||!h){renderer.render(scene,camera);return;}
  const strips=channelMode==='all'?CHANNELS:[channelMode];
  const solo=channelMode!=='all';
  const baseAspect=camera.aspect;
  const logical=camera.position.clone();
  const dir=logical.clone().sub(controls.target);
  const halfFov=camera.fov*Math.PI/360;
  const fitFull=channelRadius/Math.sin(halfFov)/Math.min(1,baseAspect);
  const zoom=(dir.length()||1)/(fitFull||1);
  renderer.setScissorTest(true);
  scissorDirty=true;
  try{
  for(let i=0;i<strips.length;i++){
   const x=solo?0:Math.round(w*i/strips.length);
   const width=solo?w:Math.round(w/strips.length);
   const aspect=width/h;
   camera.aspect=aspect;camera.updateProjectionMatrix();
   if(solo){
    camera.position.copy(logical);
   }else{
    const fit=channelRadius/Math.sin(halfFov)/Math.min(1,aspect);
    camera.position.copy(controls.target).addScaledVector(dir.normalize(),fit*zoom);
   }
   renderer.setViewport(x,0,width,h);
   renderer.setScissor(x,0,width,h);
   applyChannel(strips[i]);
   renderer.render(scene,camera);
  }
  }finally{
   // finally 是必须的：分条渲染里任何一次 applyChannel / render 抛错，上面那套
   // scissor + viewport + 窄 aspect 就会留在渲染器上，下一次预览（比如天空盒）只会
   // 画在那条竖缝里、其余全黑 —— 症状就是「预览只剩一条竖图」。
   scissorDirty=false;
   renderer.setScissorTest(false);
   renderer.setViewport(0,0,w,h);
   camera.aspect=baseAspect;camera.updateProjectionMatrix();
   camera.position.copy(logical);
   restoreMaterials();
  }
 }

 function applyChannel(name){
  if(!channelTarget)return;
  channelTarget.traverse(node=>{
   if(!node.isMesh)return;
   if(!originalMaterials.has(node))originalMaterials.set(node,node.material);
   const base=originalMaterials.get(node);
   // 多材质网格（FBX / glTF 里的 submesh 组）node.material 是数组：逐项换成覆盖材质。
   // 老写法直接把数组塞进 channelMaterial，src.uuid / src.map 全是 undefined，
   // 最终把「函数」当贴图传进材质，渲染时抛错 —— 而通道渲染是在 scissor 里跑的，
   // 抛错后 scissor 收不回来，之后所有预览都只剩一条竖条。
   if(Array.isArray(base))node.material=base.map(material=>channelMaterial(name,material)||material);
   else node.material=channelMaterial(name,base)||base;
  });
 }
 /** 渲染器状态自愈：分条渲染用的是 scissor + viewport + 单条宽高比，任何一处残留都会让
  *  后续预览挤在一条竖缝里、其余全黑。准备舞台时与发现残留时都走这里复位。 */
 function resetRenderState(){
  if(!renderer)return;
  const {w,h}=canvasSize();
  renderer.setScissorTest(false);
  if(w&&h)renderer.setViewport(0,0,w,h);
  if(w&&h&&camera){camera.aspect=w/h;camera.updateProjectionMatrix();}
  scissorDirty=false;
 }
 function restoreMaterials(){
  for(const [mesh,material] of originalMaterials)mesh.material=material;
  originalMaterials.clear();
 }

 /** 各通道的覆盖材质。albedo/gloss 与源材质一对一（要拿它的 map/color/roughnessMap），
  *  按源材质 uuid 缓存；normals/reflectivity/topology 与资产无关，全预览共用一份。 */
 function channelMaterial(name,src){
  if(!src)return null;
  if(name==='albedo'){
   if(!albedoCache.has(src.uuid))albedoCache.set(src.uuid,new THREE.MeshBasicMaterial({
    map:src.map||null,color:src.color?src.color.clone():new THREE.Color(0xb8bcc4)}));
   return albedoCache.get(src.uuid);
  }
  if(name==='gloss'){
   if(!glossCache.has(src.uuid)){
    // gloss = 粗糙度取反。有 roughnessMap 就 canvas 反色一份；没有的材质退化成统一高光
    // （gloss 通道本来就是看高光分布，不是看底色）。
    const inv=invertTexture(src.roughnessMap);
    glossCache.set(src.uuid,new THREE.MeshStandardMaterial({
     color:0x0b0e13,metalness:0,roughness:inv?1:0.05,roughnessMap:inv||null,envMapIntensity:1.4}));
   }
   return glossCache.get(src.uuid);
  }
  if(!channelMaterials)channelMaterials={
   normals:new THREE.MeshNormalMaterial(),
   reflectivity:new THREE.MeshStandardMaterial({color:0xffffff,metalness:1,roughness:0.1,envMapIntensity:1.3}),
   topology:new THREE.MeshBasicMaterial({color:0x9fe870,wireframe:true}),
   // 显示模式的两种覆盖材质（对齐 art-canvas 预览器）：白模看剪影，线框看布线。
   white:new THREE.MeshStandardMaterial({color:0xd8dde6,roughness:0.62,metalness:0.02}),
   wire:new THREE.MeshBasicMaterial({color:0x9fe870,wireframe:true}),
  };
  return channelMaterials[name];
 }

 /** 粗糙度贴图反色成 gloss 贴图。8 位贴图才能 canvas 反色；HDR/浮点贴图进 catch 后退化。 */
 function invertTexture(tex){
  if(!tex||!tex.image)return null;
  const cached=invertCache.get(tex);if(cached)return cached;
  try{
   const img=tex.image;
   const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
   const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
   const data=ctx.getImageData(0,0,c.width,c.height);
   for(let i=0;i<data.length;i+=4){const v=255-data[i];data[i]=v;data[i+1]=v;data[i+2]=v;}
   ctx.putImageData(data,0,0);
   const t=new THREE.CanvasTexture(c);
   t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.copy(tex.repeat);t.needsUpdate=true;
   invertCache.set(tex,t);
   return t;
  }catch(err){
   console.warn('[预览] 粗糙度贴图反色失败，gloss 通道退化为统一高光',err);
   return null;
  }
 }

 /** 关预览/换资产/失败时释放通道覆盖材质。注意 albedo/gloss 克隆与源贴图共享纹理，
  *  dispose 只放 three 侧的 program 状态，不会误伤源材质；CanvasTexture 是自己的，必须 dispose。 */
 function disposeChannelResources(){
  restoreMaterials();
  for(const material of albedoCache.values())material.dispose();
  for(const material of glossCache.values())material.dispose();
  albedoCache.clear();glossCache.clear();
  for(const tex of invertCache.values())tex.dispose();
  invertCache.clear();
  if(channelMaterials){for(const material of Object.values(channelMaterials))material.dispose();channelMaterials=null;}
 }

 async function load(assetId,type='models'){
  if(type==='textures'){setChannelAvailable(false);return loadTexture(assetId);}
  if(type==='hdris'){setChannelAvailable(false);return loadHdri(assetId);}
  return loadModel(assetId);
 }

 /** 画布宽高。直接读 clientWidth 在画布处于 hidden 时恒为 0（display:none 不参与布局），
  *  而 <dialog> 关闭时画布正是 hidden 的 —— 于是「关掉再开第二个模型」时那次 resize 读到的
  *  是 0，直接 return，渲染器尺寸与实际显示尺寸错位，画面就成了纯黑。兜底读父容器，
  *  .viewer-wrap 一直有真实宽度。 */
 function canvasSize(){
  return {
   w:canvas.clientWidth||canvas.parentElement?.clientWidth||0,
   h:canvas.clientHeight||canvas.parentElement?.clientHeight||0,
  };
 }

 /** 弹窗每次只显示一种预览；三条路径共用的舞台准备：隐藏 iframe、亮出 canvas。
  *  注意 <dialog> 打开前 canvas 尺寸是 0，所以必须先 showModal 再 load（调用方已保证）。
  *  关键：复用渲染器时（连着看多个资产）必须先清掉上一帧的模型/环境并立即重绘一帧空白 ——
  *  否则画布会停在「上一个资产」的最后一帧，表现就是「换资产但画面还是第一个」（第二次起必现）。
  *  顺序也很要紧：iframe/canvas 的显隐必须先翻好，再建或复用渲染器。反过来（先 ensureRenderer
  *  再亮画布）会让它量到 hidden 画布的 0 宽高，尺寸对不上，下一次预览就黑屏。 */
 function prepareStage(caption,hint){
  const iframe=document.getElementById('viewer');
  if(iframe){iframe.hidden=true;iframe.removeAttribute('src');}
  if(canvas)canvas.hidden=false;
  // 换资产先收通道态：root 马上要被清，channelTarget 会变成野指针。
  channelTarget=null;disposeChannelResources();setChannelMode('off');
  disposeMaterialPreset();materialGeometry='model';
  if(!ensureRenderer())return false;
  setCaption(caption);
  setHint(hint);
  resetEnvironment();
  clearRoot();
  // 先按新尺寸对齐一次（复用渲染器时上一轮可能停在别的窗口宽度上），再刷一帧空白。
  resize();
  // 换资产一律把渲染器状态与浮层收干净：上一轮如果开过通道/设置面板，残留会跟着新资产走。
  resetRenderState();
  closeViewerPanels();
  stopAnimation();
  syncDisplayButtons();
  if(renderer&&scene&&camera){renderer.clear();renderer.render(scene,camera);}
  return true;
 }
 function clearRoot(){
  for(const child of [...root.children]){root.remove(child);disposeObject(child);}
 }

 /** 把 environment / background 从 HDRI 全景复位成基础环境（贴图也要复位，模型会被 HDRI 染色）。
  *  HDRI 贴图本身是 GPU 资源，切走必须 dispose，否则每看一张就漏一张。 */
 function resetEnvironment(){
  if(!scene)return;
  if(envTexture){
    if(scene.environment===envTexture)scene.environment=baseEnvironment;
    if(scene.background===envTexture)scene.background=new THREE.Color(0x0d1117);
    envTexture.dispose();envTexture=null;
  }
 }

 async function loadModel(assetId){
  const token=++loadToken;
  beginAsset('ph:model:'+assetId);
  if(!prepareStage('左键旋转 · 右键缩放 · 中键平移 · 从 Poly Haven 官方 CDN 取 1K glTF 本地渲染','正在加载 Poly Haven 模型…'))return false;
  // HDRI 预览会把 environment/background 换成全景贴图；模型预览必须换回基础环境，
  // 否则上一个看过的 HDRI 还挂在场景上，模型的阴影和高光全是它的颜色。
  resetEnvironment();
  try{
    const files=await fetchList(assetId,'models');
    const gltfEntry=files?.gltf?.['1k']?.gltf;
    if(!gltfEntry?.url)throw new Error('该资产没有 1k glTF');
    const gltfUrl=gltfEntry.url;
    const baseDir=gltfUrl.slice(0,gltfUrl.lastIndexOf('/'));
    const gltfRes=await fetchLocal(gltfUrl);
    const gltf=await gltfRes.json();
    // 贴图与几何都转成 blob 后再解析：GLTFLoader 自己发的请求带不了 x-sfx-local 头。
    revokeBlobs();
    // 不要写 blobs=await inlineResources(...)：它不返回值（blob 是就地 push 进 blobs 的），
    // 赋值会把 blobs 覆盖成 undefined，下一次 revokeBlobs 就抛「blobs is not iterable」。
    await inlineResources(gltf,indexByBasename(files),baseDir,blobs);
    if(token!==loadToken)return false;
    // 每次开预览都从干净 root 开始，否则上一帧的模型会叠在这一个上面。
    // 只清 root，不碰 scene 本身 —— scene 里的灯光是复用的。
    clearRoot();
    setHint('');
    const loader=new GLTFLoader();
    // 必须用 parse 而不是 load(JSON.stringify(...))：load 把第一个参数当 URL 拿去请求，
    // 于是整份 glTF JSON 被拼成路径发出、必然 404。parse 才是「我已经拿到 JSON 了，直接解析」。
    // 场景对象要用回调给的 parsed.gltf —— 原始 gltf.scene 只是 JSON 里的下标字段，不是 Object3D。
    const parsed=await new Promise((resolve,reject)=>loader.parse(gltf,'',g=>resolve(g),err=>reject(new Error(err?.message||'glTF 解析失败'))));
    if(token!==loadToken)return false;
    const model=parsed?.scene;
    if(!model)throw new Error('glTF 里没有场景');
    root.add(model);
    setChannelAvailable(true,model);
    mountAnimations(model,parsed?.animations||[]);
    const box=new THREE.Box3().setFromObject(model);
    if(box.isEmpty())throw new Error('模型是空的');
    const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    // 相机按包围盒自动取景：Poly Haven 的资产尺度差几个数量级，写死距离不是忽远忽近就是穿模。
    const radius=Math.max(size.length()*0.5,0.05);
    camera.position.copy(center).add(new THREE.Vector3(radius*1.4,radius*1.1,radius*1.7));
    camera.near=radius*0.01;camera.far=radius*120;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    controls.target.copy(center);
    controls.minDistance=radius*0.15;controls.maxDistance=radius*14;
    controls.update();rememberHome();
    // 地面阴影接影，让模型不悬空。
    const ground=new THREE.Mesh(new THREE.CircleGeometry(radius*3,48),new THREE.ShadowMaterial({opacity:0.28}));
    ground.rotation.x=-Math.PI/2;ground.position.set(center.x,box.min.y,center.z);
    ground.receiveShadow=true;root.add(ground);
    renderer.shadowMap.enabled=true;
    model.traverse(node=>{if(node.isMesh){node.castShadow=true;node.receiveShadow=true;}});
    renderer.render(scene,camera);
    return true;
 }catch(err){
    if(token!==loadToken)return false;
    revokeBlobs();
    fail(`无法加载 Poly Haven 预览：${err.message}`,err);
    return false;
  }
 }

 /** PBR 贴图预览：官方没给贴图做 viewer，但同一份 1k JPG 自己就能渲染——
  *  球体看高光/法线/金属度，地面看平铺效果，比盯着一张平面 diff 图直观得多。
  *  ARM 打包图（R=AO G=Rough B=Metal）正好对应 three 的通道约定，一张顶三张。 */
 async function loadTexture(assetId){
  const token=++loadToken;
  beginAsset('ph:texture:'+assetId);
  if(!prepareStage('左键旋转 · 右键缩放 · 中键平移 · 从 Poly Haven 官方 CDN 取 1K 贴图本地渲染','正在加载 Poly Haven 材质…'))return false;
  resetEnvironment();
  try{
   const files=await fetchList(assetId,'textures');
   const pick=names=>{for(const n of names){const e=files?.[n]?.['1k']?.jpg||files?.[n]?.['1k']?.png;if(e?.url)return e.url;}return null;};
   const diffUrl=pick(['Diffuse','diff']);
   if(!diffUrl)throw new Error('该资产没有 Diffuse 贴图');
   const armUrl=pick(['arm','rough_ao']);
   const norUrl=pick(['nor_gl']);
   const dispUrl=pick(['disp','Displacement','height']);
   revokeBlobs();
   // 四张贴图一起发：串行 await 会把「往返次数 × RTT」累加起来（本机代理 + 跨境 CDN）。
   const [diffBlob,armBlob,norBlob,dispBlob]=await Promise.all([
    toBlob(diffUrl,blobs),
    armUrl?toBlob(armUrl,blobs):null,
    norUrl?toBlob(norUrl,blobs):null,
    dispUrl?toBlob(dispUrl,blobs):null,
   ]);
   if(token!==loadToken)return false;
   clearRoot();
   setHint('');
   const loader=new THREE.TextureLoader();
   const loadTex=(blobUrl,srgb)=>blobUrl?new Promise((res,rej)=>loader.load(blobUrl,t=>{
     if(srgb)t.colorSpace=THREE.SRGBColorSpace;
     t.wrapS=t.wrapT=THREE.RepeatWrapping;
     t.anisotropy=renderer.capabilities.getMaxAnisotropy();
     res(t);
   },undefined,rej)):null;
   // 解码也并行：逐个 await 会在网络之后又叠一层等待。Promise.all 里的 null 会原样返回。
   const [diffTex,armTex,norTex,dispTex]=await Promise.all([
    loadTex(diffBlob,true),loadTex(armBlob),loadTex(norBlob),loadTex(dispBlob),
   ]);
   // metalness/roughness 先给保守值：只有真挂上 ARM 图后才能放满 1，否则漫反射会被当成纯金属渲染成黑块。
   const sphereMat=new THREE.MeshStandardMaterial({roughness:0.9,metalness:0});
   sphereMat.map=diffTex;
   if(armTex){sphereMat.aoMap=armTex;sphereMat.roughnessMap=armTex;sphereMat.metalnessMap=armTex;sphereMat.roughness=1;sphereMat.metalness=1;}
   if(norTex){sphereMat.normalMap=norTex;sphereMat.normalScale=new THREE.Vector2(1,1);}
   if(dispTex){sphereMat.displacementMap=dispTex;sphereMat.displacementScale=materialHeight;}
   if(token!==loadToken)return false;
   // 地面用独立纹理实例：平铺份数不同（repeat 是 per-texture 的，共享会互相覆盖）。
   const groundMat=sphereMat.clone();
   for(const key of ['map','aoMap','roughnessMap','metalnessMap','normalMap','displacementMap']){
     const t=groundMat[key];
     if(t){const clone=t.clone();clone.repeat.set(4,4);clone.needsUpdate=true;groundMat[key]=clone;}
   }
   const sphere=new THREE.Mesh(new THREE.SphereGeometry(1.1,64,48),sphereMat);
   const ground=new THREE.Mesh(new THREE.CircleGeometry(8,48),groundMat);
   ground.rotation.x=-Math.PI/2;ground.position.y=-1.1;
   attachMaterialStage(sphere,ground);
   camera.position.set(2.2,1.4,2.8);
   camera.near=0.05;camera.far=200;camera.updateProjectionMatrix();
   controls.target.set(0,0,0);
   controls.minDistance=1.3;controls.maxDistance=30;
   controls.update();
   renderer.render(scene,camera);
   return true;
  }catch(err){
   if(token!==loadToken)return false;
   revokeBlobs();
   fail(`无法加载 Poly Haven 材质预览：${err.message}`,err);
   return false;
  }
 }

 /** HDRI 预览：1k 的 .hdr 做全景背景 + 反射球，拖动就是环视整个环境，
  *  球面上能看到反射和明暗分布 —— 这就是环境贴图最直观的检视方式。 */
 async function loadHdri(assetId){
  const token=++loadToken;
  beginAsset('ph:hdri:'+assetId);
  if(!prepareStage('左键旋转 · 右键缩放 · 中键平移 · 从 Poly Haven 官方 CDN 取 1K HDR 本地渲染','正在加载 Poly Haven 环境贴图…'))return false;
  try{
   const files=await fetchList(assetId,'hdris');
   // 1k 档优先 .hdr，没有就退 .exr（两张数据等价，只是容器不同）。
   const tier1k=files?.hdri?.['1k'];
   const hdrUrl=tier1k?.hdr?.url||tier1k?.exr?.url;
   if(!hdrUrl)throw new Error('该资产没有 1k HDR / EXR');
   revokeBlobs();
   const blobUrl=await toBlob(hdrUrl,blobs);
   if(token!==loadToken)return false;
   const loader=/\.exr$/i.test(hdrUrl)?new EXRLoader():new RGBELoader();
   const tex=await new Promise((res,rej)=>loader.load(blobUrl,res,undefined,rej));
   if(token!==loadToken){tex.dispose();return false;}
   tex.mapping=THREE.EquirectangularReflectionMapping;
   // 先复位旧 HDRI 再挂新的：同一时刻场景里只保留一张全景贴图，旧的必须 dispose。
   resetEnvironment();
   envTexture=tex;
   scene.background=tex;
   scene.environment=tex;
   clearRoot();
   setHint('');
   // 抛光反射球：环境光行不行，看球面有没有正确的反射与天空明暗分布。
   const ball=new THREE.Mesh(new THREE.SphereGeometry(1.3,64,48),new THREE.MeshStandardMaterial({metalness:1,roughness:0.06,color:0xffffff}));
   ball.position.y=-0.2;root.add(ball);
   const groundMat=new THREE.MeshStandardMaterial({color:0x11161d,roughness:0.35,metalness:0.1});
   const ground=new THREE.Mesh(new THREE.CircleGeometry(6,48),groundMat);
   ground.rotation.x=-Math.PI/2;ground.position.y=-1.5;
   root.add(ground);
   camera.position.set(2.6,1.2,2.6);
   camera.near=0.05;camera.far=500;camera.updateProjectionMatrix();
   controls.target.set(0,0,0);
   controls.minDistance=1.5;controls.maxDistance=40;
   controls.update();
   renderer.render(scene,camera);
   return true;
  }catch(err){
   if(token!==loadToken)return false;
   revokeBlobs();
   fail(`无法加载 Poly Haven 环境预览：${err.message}`,err);
   return false;
  }
 }

 /** 资源包预览（FreeStylized）：服务端已经把 ZIP 解好，这里只消费清单。
  *  清单里每项都是本机同源地址，不需要过 /api/proxy —— 但 x-sfx-local 头照带。 */
 async function toLocalBlobUrl(url){
  const res=await fetch(url,{headers:LOCAL_HEADER});
  if(!res.ok)throw new Error(`预览资源取不到 HTTP ${res.status}`);
  const created=URL.createObjectURL(await res.blob());
  blobs.push(created);
  return created;
 }

 /** 贴图槽位按文件名关键词认：与服务端 pickPreviewEntries 的 MAP_SLOTS 同一套命名规则
 *  （FreeStylized 的命名是 <Asset>_<Map>_<res>.png，与 ambientCG / Poly Haven 不通用）。
 *  左边是 three 材质上的槽位名，右边是匹配模式。 */
const PACK_TEXTURE_SLOTS=[
 ['map',/basecolor|basecolour|_color|albedo|diffuse/i],
 ['normalMap',/normal/i],
 ['roughnessMap',/roughness|_rough|rough/i],
 ['metalnessMap',/metallic|metalness|_metal/i],
 ['aoMap',/ambientocclusion|mixed_ao|_ao|occlusion/i],
];
function packSlotOf(name){
 return PACK_TEXTURE_SLOTS.find(([,pattern])=>pattern.test(String(name||'')))?.[0];
}
/** 从清单里按槽位挑贴图（每个槽位取第一个匹配项，manifest 里贴图按体积升序，即最小档）。
 *  返回 slot → 本机 blob URL；预览只需要小档，4K 全取前端等不起。 */
function packTextureSlots(manifest,byBase){
 const slots=new Map();
 for(const entry of manifest.entries||[]){
  if(entry.role!=='texture')continue;
  const slot=packSlotOf(entry.name);
  if(!slot||slots.has(slot))continue;
  const url=byBase.get(String(entry.name||'').toLowerCase());
  if(url)slots.set(slot,url);
 }
 return slots;
}
/** FreeStylized 的模型 FBX 是**不带贴图引用**的纯网格（实测 lod0 FBX 里没有 Video 节点），
 *  FBXLoader 只能给默认白材质——「预览只有白膜」就是这么来的。解析成功后把包里的
 *  base/normal/rough/metal/ao 按槽位补挂到材质上；glTF 包自带贴图（槽位已有值）的
 *  不动，只补缺的，所以两条路都安全。贴图加载是异步的，但 Texture 对象同步返回，
 *  图片解码完成后自然显示，不需要等。 */
function applyPackTextures(object,bySlot){
 if(!bySlot.size)return;
 const loader=new THREE.TextureLoader();
 const textures={};
 for(const [slot,url] of bySlot){
  const t=loader.load(url);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.anisotropy=renderer.capabilities.getMaxAnisotropy();
  textures[slot]=t;
 }
 // 只有 base color 走 sRGB；法线/粗糙/金属/AO 是数据图，保持线性，否则 AO 会发粉。
 if(textures.map)textures.map.colorSpace=THREE.SRGBColorSpace;
 object.traverse(node=>{
  if(!node.isMesh)return;
  for(const mat of [].concat(node.material||[])){
   if(!mat)continue;
   if(textures.map&&!mat.map)mat.map=textures.map;
   if(textures.normalMap&&!mat.normalMap)mat.normalMap=textures.normalMap;
   // phong（FBXLoader 的默认材质）没有 roughness/metalness 槽，用 in 守卫跳过；
   // aoMap 各材质都有，且默认走 uv 通道（FBX 几何自带 uv），直接挂。
   if(textures.aoMap&&'aoMap' in mat&&!mat.aoMap)mat.aoMap=textures.aoMap;
   if(textures.roughnessMap&&'roughnessMap' in mat&&!mat.roughnessMap){mat.roughnessMap=textures.roughnessMap;mat.roughness=1;}
   if(textures.metalnessMap&&'metalnessMap' in mat&&!mat.metalnessMap){mat.metalnessMap=textures.metalnessMap;mat.metalness=1;}
   mat.needsUpdate=true;   // map 槽从无到有要重编译 program，否则 define 不生效
  }
 });
}

 /** 包围盒自动取景 + 接影地面。FBX 单位常是厘米，glTF 常是米，写死距离必然忽远忽近。 */
 function frameObject(object){
  root.add(object);
  setChannelAvailable(true,object);
  mountAnimations(object,object.userData?.animations);
  const box=new THREE.Box3().setFromObject(object);
  if(box.isEmpty())throw new Error('模型是空的');
  const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  const radius=Math.max(size.length()*0.5,0.05);
  camera.position.copy(center).add(new THREE.Vector3(radius*1.4,radius*1.1,radius*1.7));
  camera.near=radius*0.01;camera.far=radius*120;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  controls.target.copy(center);
  controls.minDistance=radius*0.15;controls.maxDistance=radius*14;
  controls.update();rememberHome();
  const ground=new THREE.Mesh(new THREE.CircleGeometry(radius*3,48),new THREE.ShadowMaterial({opacity:0.28}));
  ground.rotation.x=-Math.PI/2;ground.position.set(center.x,box.min.y,center.z);
  ground.receiveShadow=true;root.add(ground);
  pfGround=ground;
  renderer.shadowMap.enabled=true;
  object.traverse(node=>{if(node.isMesh){node.castShadow=true;node.receiveShadow=true;}});
  renderer.render(scene,camera);
 }

 /** 按扩展名把字节解析成 Object3D。资源包预览与本地文件预览共用这一张格式表——
 *  两处各写一份必然走偏（改了这边忘了那边），所以格式判断只有这一处。 */
async function parseModelBuffer(buf,fileName,manager){
 if(/\.fbx$/i.test(fileName)){
  const object=new FBXLoader(manager).parse(buf,'');
  object.userData.animations=object.animations||[];
  return object;
 }
 if(/\.(glb|gltf)$/i.test(fileName)){
  const isBinary=/\.glb$/i.test(fileName);
  const source=isBinary?buf:JSON.parse(new TextDecoder().decode(buf));
  const parsed=await new Promise((resolve,reject)=>new GLTFLoader(manager).parse(source,'',g=>resolve(g),err=>reject(new Error(err?.message||'glTF 解析失败'))));
  // 动画 clip 挂在解析结果上而不是场景节点上，顺手带进 userData，交给 frameObject 统一挂载。
  if(parsed?.scene)parsed.scene.userData.animations=parsed.animations||[];
  return parsed?.scene||null;
 }
 if(/\.obj$/i.test(fileName)){
  const object=new OBJLoader(manager).parse(new TextDecoder().decode(buf));
  upgradePackMaterials(object);
  return object;
 }
 if(/\.stl$/i.test(fileName))return meshFromGeometry(new STLLoader().parse(buf));
 if(/\.ply$/i.test(fileName))return meshFromGeometry(new PLYLoader().parse(buf));
 if(/\.3mf$/i.test(fileName))return new ThreeMFLoader(manager).parse(buf);
 throw new Error(`暂不支持预览 ${fileName||'这种模型格式'}（支持 GLB / glTF / FBX / OBJ / STL / PLY / 3MF）`);
}

/** 全景环境贴图：EXR / HDR 各用各的 loader，普通的等距 PNG/JPG 走 sRGB 纹理。
 *  统一设成 Equirectangular 映射，调用方直接挂 scene.background / environment。 */
async function loadEnvironmentTexture(url,name){
 /** 全景图动辄几十 MB（4K/8K HDR），loader 卡住时没有任何错误回调 ——
  *  预览会一直停在空白。给一个上限，超时就按失败处理，至少能看见原因。 */
 const timed=(promise,label)=>Promise.race([promise,new Promise((_,rej)=>{
  const timer=setTimeout(()=>rej(new Error(`环境贴图加载超时：${label}`)),45000);
  promise.then(()=>clearTimeout(timer),()=>clearTimeout(timer));
 })]);
 let tex;
 if(/\.exr$/i.test(name))tex=await timed(new Promise((res,rej)=>new EXRLoader().load(url,res,undefined,rej)),name);
 else if(/\.hdr$/i.test(name))tex=await timed(new Promise((res,rej)=>new RGBELoader().load(url,res,undefined,rej)),name);
 else tex=await timed(new Promise((res,rej)=>new THREE.TextureLoader().load(url,t=>{t.colorSpace=THREE.SRGBColorSpace;res(t);},undefined,rej)),name);
 tex.mapping=THREE.EquirectangularReflectionMapping;
 return tex;
}

/** STL / PLY 只有几何、没有材质与 UV：包成 Mesh 并给一层中性标准材质，
 *  否则 three 默认材质在 PBR 灯光下会灰得看不出体积。 */
function meshFromGeometry(geometry){
 geometry.computeVertexNormals();
 const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0xb9bcc2,roughness:0.62,metalness:0.04}));
 mesh.castShadow=true;mesh.receiveShadow=true;
 return mesh;
}
/** OBJLoader 产的是 Phong / Lambert 材质，换成 Standard 才和场景里其它资产同一套光照。
 *  贴图槽能搬的都搬过去（包内贴图随后由 applyPackTextures 按槽位补）。 */
function upgradePackMaterials(root){
 const cache=new Map();
 root.traverse(node=>{
  if(!node.isMesh)return;
  const list=Array.isArray(node.material)?node.material:[node.material];
  const next=list.map(material=>{
   if(!material||material.isMeshStandardMaterial)return material;
   if(cache.has(material))return cache.get(material);
   const standard=new THREE.MeshStandardMaterial({
    name:material.name,
    color:material.color?material.color.clone():new THREE.Color(0xb9bcc2),
    map:material.map||null,
    normalMap:material.normalMap||null,
    alphaMap:material.alphaMap||null,
    bumpMap:material.bumpMap||null,
    specularMap:material.specularMap||null,
    emissive:material.emissive?material.emissive.clone():new THREE.Color(0x000000),
    emissiveMap:material.emissiveMap||null,
    transparent:!!material.transparent,
    opacity:material.opacity??1,
    side:material.side,
    roughness:0.72,
    metalness:0.04,
   });
   cache.set(material,standard);
   return standard;
  });
  node.material=Array.isArray(node.material)?next:next[0];
 });
}
async function showPackModel(manifest,token){
  const modelEntry=manifest.entries.find(e=>e.role==='model');
  if(!modelEntry)throw new Error('资源包里没有模型文件');
  revokeBlobs();
  // FBX 里写的是导出机上的绝对路径（`C:\...\Watering_Can_01_Base_color.png`），只有 basename
  // 能对上解出来的贴图。贴图请求是 loader 同步发出的，modifier 里没法 await —— 所以先全部预取
  // 成 blob 建好索引，再由 LoadingManager 按 basename 改写 URL。
  // 模型本体和贴图互不依赖，先同时把请求发出去；贴图之间也全部并行。
  // 结果按原顺序写回 byBase，保证 packTextureSlots 的匹配优先级不变。
  const modelPromise=fetch(modelEntry.url,{headers:LOCAL_HEADER});
  const textureEntries=manifest.entries.filter(e=>e.role==='texture');
  const byBase=new Map();
  const prefetched=await Promise.all(textureEntries.map(async entry=>{
   try{return [String(entry.name||'').toLowerCase(),await toLocalBlobUrl(entry.url)];}catch{return null;}
  }));
  for(const pair of prefetched)if(pair)byBase.set(pair[0],pair[1]);
  // 槽位索引：FBX 引用贴图时常带分辨率后缀（…_4K_Base_color.png），与包内实际挑中的
  // 最小档文件名对不上，按关键词槽位兜底改写；glTF 的贴图在文件内部，用不到这条。
  const bySlot=packTextureSlots(manifest,byBase);
  const modelRes=await modelPromise;
  if(!modelRes.ok)throw new Error(`模型文件取不到 HTTP ${modelRes.status}`);
  const buf=await modelRes.arrayBuffer();
  if(token!==loadToken)return false;
  clearRoot();
  setHint('');
  const manager=new THREE.LoadingManager();
  manager.setURLModifier(url=>{
   const base=String(url).split(/[\\/]/).pop().split('?')[0].toLowerCase();
   const exact=byBase.get(base)||byBase.get(decodeURIComponent(base));
   if(exact)return exact;
   const slot=packSlotOf(base);
   return (slot&&bySlot.get(slot))||url;
  });
  // 格式分派在 parseModelBuffer 里（资源包与本地文件共用同一张表）。
  const fileName=String(modelEntry.name||'');
  const object=await parseModelBuffer(buf,fileName,manager);
  if(!object)throw new Error('模型解析结果为空');
  if(token!==loadToken){disposeObject(object);return false;}
  // FBX 不带贴图引用时材质是默认白膜，OBJ 也常常只有 MTL 名字、纹理由包内提供；
  // 这两类按槽位把包里的贴图补上（见 applyPackTextures）。
  // STL/PLY/3MF 的几何没有 UV，挂贴图只会渲染成一片单色，跳过。
  if(/\.(fbx|obj|glb|gltf)$/i.test(fileName))applyPackTextures(object,bySlot);
  frameObject(object);
  return true;
 }

 /** 材质包预览：与 Poly Haven 贴图同一个舞台（球看高光法线、地面看平铺），
  *  区别只是槽位来自服务端按文件名认出来的角色，而不是官方 API 给的通道名。 */
 /** 材质资产的预览舞台（球 + 地面 / 单个球）挂给材质工具用。
  *  这些路径都调过 setChannelAvailable(false)，channelTarget 是 null —— 平铺 / 置换、
  *  几何预设、贴图侧栏全靠它找材质，所以必须单独挂回去。channelAvailable 保持 false：
  *  通道键与数字键仍然只出现在模型资产上。 */
 function attachMaterialStage(...objects){
  const stage=new THREE.Group();
  for(const object of objects)if(object)stage.add(object);
  root.add(stage);
  channelTarget=stage;channelAvailable=false;assetKind='material';
  applyCapabilityBar();
  syncMaterialBar();
  applyMaterialRepeat();
  updateTextureSidebar();
  return stage;
 }

 async function showPackTexture(manifest,token){
  revokeBlobs();
  const loader=new THREE.TextureLoader();
  /** 单张贴图的兜底超时：包里的 height / ao 动辄几 MB，某一张卡住时
   *  `Promise.all` 会永远不 resolve —— 画面就一直停在空白，连错误都看不到。 */
  const TEX_TIMEOUT_MS=45000;
  const loadTex=async(entry,srgb)=>{
   if(!entry)return null;
   const url=await toLocalBlobUrl(entry.url);
   return new Promise((res,rej)=>{
    const timer=setTimeout(()=>rej(new Error(`贴图解码超时：${entry.name||entry.role||''}`)),TEX_TIMEOUT_MS);
    loader.load(url,t=>{
     clearTimeout(timer);
     if(srgb)t.colorSpace=THREE.SRGBColorSpace;
     t.wrapS=t.wrapT=THREE.RepeatWrapping;
     t.anisotropy=renderer.capabilities.getMaxAnisotropy();
     res(t);
    },undefined,event=>{clearTimeout(timer);rej(new Error(`贴图解码失败：${entry.name||entry.role||''}`));});
   });
  };
  const role=r=>manifest.entries.find(e=>e.role===r);
  /** 辅助通道（法线 / 粗糙 / 金属 / AO / 高度）缺一张不该让整套材质报废：
   *  任何一张失败就退化成「只有基础色」，而不是整块预览变白。基础色仍然必须成功。 */
  const optional=(entry,srgb)=>loadTex(entry,srgb).catch(()=>null);
  // 六张贴图并行下载 + 解码：原来逐个 await，墙钟时间等于六次往返之和。
  const [base,nor,rough,metal,ao,disp]=await Promise.all([
   loadTex(role('base'),true),optional(role('nor')),optional(role('rough')),
   optional(role('metal')),optional(role('ao')),optional(role('height')),
  ]);
  if(!base)throw new Error('资源包里没有基础色贴图');
  if(token!==loadToken)return false;
  clearRoot();
  setHint('');
  // 挂上真实通道图才把 roughness/metalness 放满 1，否则漫反射会被当成纯金属渲染成黑块。
  const mat=new THREE.MeshStandardMaterial({roughness:rough?1:0.9,metalness:metal?1:0});
  mat.map=base;
  if(nor){mat.normalMap=nor;mat.normalScale=new THREE.Vector2(1,1);}
  if(rough)mat.roughnessMap=rough;
  if(metal)mat.metalnessMap=metal;
  if(ao)mat.aoMap=ao;
  if(disp){mat.displacementMap=disp;mat.displacementScale=materialHeight;mat.displacementBias=-materialHeight/2;}
  const groundMat=mat.clone();
  for(const key of ['map','aoMap','roughnessMap','metalnessMap','normalMap','displacementMap']){
   const t=groundMat[key];
   if(t){const clone=t.clone();clone.repeat.set(4,4);clone.needsUpdate=true;groundMat[key]=clone;}
  }
  const sphere=new THREE.Mesh(new THREE.SphereGeometry(1.1,64,48),mat);
  const ground=new THREE.Mesh(new THREE.CircleGeometry(8,48),groundMat);
  ground.rotation.x=-Math.PI/2;ground.position.y=-1.1;
  attachMaterialStage(sphere,ground);
  camera.position.set(2.2,1.4,2.8);
  camera.near=0.05;camera.far=200;camera.updateProjectionMatrix();
  controls.target.set(0,0,0);
  controls.minDistance=1.3;controls.maxDistance=30;
  controls.update();rememberHome();
  renderer.render(scene,camera);
  return true;
 }

 /** HDR / 等距柱状图共用的环境舞台：贴图直接当全景背景 + 抛光反射球。 */
 function showEnvironmentStage(tex){
  resetEnvironment();
  envTexture=tex;
  scene.background=tex;
  scene.environment=tex;
  clearRoot();
  setHint('');
  const ball=new THREE.Mesh(new THREE.SphereGeometry(1.3,64,48),new THREE.MeshStandardMaterial({metalness:1,roughness:0.06,color:0xffffff}));
  ball.position.y=-0.2;root.add(ball);
  const ground=new THREE.Mesh(new THREE.CircleGeometry(6,48),new THREE.MeshStandardMaterial({color:0x11161d,roughness:0.35,metalness:0.1}));
  ground.rotation.x=-Math.PI/2;ground.position.y=-1.5;
  root.add(ground);
  camera.position.set(2.6,1.2,2.6);
  camera.near=0.05;camera.far=500;camera.updateProjectionMatrix();
  controls.target.set(0,0,0);
  controls.minDistance=1.5;controls.maxDistance=40;
  controls.update();rememberHome();
  renderer.render(scene,camera);
 }

 async function showPackEnvironment(manifest,token){
  const entry=manifest.entries.find(e=>e.role==='env');
  if(!entry)throw new Error('资源包里没有环境贴图');
  revokeBlobs();
  const url=await toLocalBlobUrl(entry.url);
  const tex=await loadEnvironmentTexture(url,entry.name);
  if(token!==loadToken){tex.dispose();return false;}
  showEnvironmentStage(tex);
  return true;
 }

 async function loadFreestylized(slug,type='models'){
  const token=++loadToken;
  beginAsset('fs:'+type+':'+slug);
  const label=type==='textures'?'材质':type==='skybox'?'天空盒':'模型';
  if(!prepareStage('左键旋转 · 右键缩放 · 中键平移 · 资源包由服务端解出后本地渲染',`正在准备 FreeStylized ${label}预览…`))return false;
  // 复位环境贴图：上一张若是天空盒，场景的 environment/background 还挂在它上面，
  // 不复位的话模型/材质会被天空盒染色；天空盒分支随后会再设自己的全景。
  resetEnvironment();
  try{
   const res=await fetch(`/api/freestylized/preview?slug=${encodeURIComponent(slug)}&type=${encodeURIComponent(type)}`,{headers:LOCAL_HEADER,cache:'no-store'});
   const manifest=await res.json().catch(()=>({}));
   if(!res.ok||!manifest?.ok)throw new Error(manifest?.error||'这个 FreeStylized 资产没有可用于 3D 预览的内容');
   if(manifest.kind==='texture'){setChannelAvailable(false);return await showPackTexture(manifest,token);}
   if(manifest.kind==='hdri'||manifest.kind==='equirect'){setChannelAvailable(false);return await showPackEnvironment(manifest,token);}
   return await showPackModel(manifest,token);
  }catch(err){
   if(token!==loadToken)return false;
   revokeBlobs();
   fail(`无法加载 FreeStylized 预览：${err.message}`,err);
   return false;
  }
 }

 /** 本地文件预览：磁盘上的单个模型文件，复用资源包那套格式表与取景逻辑。
  *  url 由调用方拼好（/api/local/file?root=…&rel=…），这里只管取字节、解析、取景。 */
 async function loadSimready(assetId){
  const token=++loadToken;
  beginAsset('simready:'+assetId);
  if(!prepareStage('左键旋转 · 滚轮缩放 · 原始 USD 基础预览','正在读取 SimReady USD 图层…'))return false;
  resetEnvironment();
  try{
   const response=await fetch(`/api/simready/preview?id=${encodeURIComponent(assetId)}`,{headers:LOCAL_HEADER});
   const manifest=await response.json();
   if(!response.ok)throw new Error(manifest.error||`HTTP ${response.status}`);
   const object=await loadUsdPreview(manifest,async url=>(await previewCache.get(url)).arrayBuffer(),{isCurrent:()=>token===loadToken});
   if(!object)return false;
   if(token!==loadToken){disposeObject(object);return false;}
   clearRoot();
   frameObject(object);
   setHint(manifest.note);
   return true;
  }catch(error){if(token===loadToken)fail('SimReady USD 预览失败：'+error.message,error);return false;}
 }

 async function loadLocalModel({url,name='模型'}){
  const token=++loadToken;
  beginAsset('local:'+name);
  if(!prepareStage('左键旋转 · 右键缩放 · 中键平移 · 双击重置视角 · 本地文件',`正在加载 ${name}…`))return false;
  resetEnvironment();
  try{
   const res=await fetch(url,{cache:'no-store'});
   if(!res.ok)throw new Error(`取文件失败 HTTP ${res.status}`);
   const buf=await res.arrayBuffer();
   if(token!==loadToken)return false;
   clearRoot();setHint('');
   const object=await parseModelBuffer(buf,name,new THREE.LoadingManager());
   if(!object)throw new Error('模型解析结果为空');
   if(token!==loadToken){disposeObject(object);return false;}
   frameObject(object);
   return true;
  }catch(err){
   if(token!==loadToken)return false;
   fail(`无法预览 ${name}：${err.message}`,err);
   return false;
  }
 }

 /** 本地全景环境贴图（.hdr / .exr / 等距 PNG·JPG）：拖动能环视整个环境。 */
 async function loadLocalEnvironment({url,name='环境贴图'}){
  const token=++loadToken;
  beginAsset('local-env:'+name);
  if(!prepareStage('左键旋转 · 右键缩放 · 中键平移 · 本地全景预览',`正在加载 ${name}…`))return false;
  resetEnvironment();
  setChannelAvailable(false);
  try{
   const tex=await loadEnvironmentTexture(url,name);
   if(token!==loadToken){tex.dispose();return false;}
   showEnvironmentStage(tex);
   return true;
  }catch(err){
   if(token!==loadToken)return false;
   fail(`无法预览 ${name}：${err.message}`,err);
   return false;
  }
 }

 /* ── Polyfork 参数化预览 ────────────────────────────────────────────────────
  * 同一份资产有两类旋钮，代价差三个数量级，混在一起做就会又慢又烧额度：
  *   颜色 → GLB 里是顶点色（COLOR_0，线性空间）。就地改写 = 实时、零请求、零配额。
  *          官方也说明了「纯颜色变体在运行时应用」，所以重烘焙出来的文件颜色永远是默认涂装。
  *   几何 → 只能回服务端重新生成（/api/polyfork/variant，几秒，消耗匿名 40 次/小时额度）。
  * 换几何时**不动相机**：滑杆连拖两下如果每次都重新取景，用户会晕。
  */
 let pf=null;
 // 换几何时地面要复用：每帧重建一次 CircleGeometry + 重设阴影，白花一半时间还闪。
 let pfGround=null;
 // 一个资产的生成器只 import 一次。null 表示「试过了，没有/跑不起来」，别反复打接口。
 const pfModules=new Map();
 // 本次会话烘焙过的 GLB（同参数来回拖时直接复parse，省一次往返）。最多留 8 档。
 const pfBuffers=new Map();

 /** 取回资产的 .mjs 生成器并在页面里跑起来。它是官方文档推荐的用法：
  *  `import { createAsset } from './xxx.mjs'; scene.add(createAsset());`
  *  实测 5ms 一套几何，比服务端烘焙的 1.5~2 秒快三个数量级，也不吃烘焙额度。
  *  依赖注入走服务端改写 + 同源 URL：CSP 只放行 script-src 'self'，
  *  blob: 脚本会被拒（实测 "Failed to fetch dynamically imported module"）。 */
 async function pfLoadGenerator(assetId){
  if(pfModules.has(assetId))return pfModules.get(assetId);
  try{
   // 先摆好 three / mergeGeometries，被 import 的模块初始化时就要用。
   globalThis.__PF_THREE__=THREE;
   globalThis.__PF_BGU__={mergeGeometries};
   const mod=await import(`/api/polyfork/module?id=${encodeURIComponent(assetId)}`);
   const create=typeof mod?.createAsset==='function'?mod.createAsset:typeof mod?.default==='function'?mod.default:null;
   if(!create)throw new Error('生成器没有导出 createAsset');
   const entry={createAsset:create};
   pfModules.set(assetId,entry);
   return entry;
  }catch{
   pfModules.set(assetId,null);          // 记下「跑不起来」，同一资产别反复试
   return null;
  }
 }

 /** 把新几何换进场景。**不走完整 pfMount**：机位、地面、阴影配置、近远平面都沿用上一帧，
  *  只换模型本身 —— 滑杆每帧都会调到这里，重建地面那点开销乘上 60fps 就是肉眼可见的卡。
  *  机位不动也是产品决定：连拖时每次都重新取景会让人晕。 */
 function pfSwap(object){
  if(root){
   for(const child of [...root.children]){
    if(child===pfGround)continue;
    root.remove(child);disposeObject(child);
   }
  }
  root.add(object);
  setChannelAvailable(true,object);
  object.traverse(node=>{if(node.isMesh){node.castShadow=true;node.receiveShadow=true;}});
  pf.rows=pfIndexZones(object,pf.zones);
  pfPaint(pf.rows,pf.zones,pf.values);
  setHint('');
  renderer.render(scene,camera);
 }

 const pfColor=hex=>{const c=new THREE.Color();c.setStyle(hex);return c;};

 function pfDefaults(schema){
  const values={};
  for(const p of schema?.params||[])values[p.key]=p.type==='range'?Number(p.default):p.default;
  return values;
 }

 /** 只有「非默认值」才发给服务端：默认几何不烘焙，直接吃 CDN 上现成的那一份，
  *  既不烧额度也快一倍。字符串比较即可，range 的默认值是数字。 */
 function pfGeometry(schema,values){
  const out={};
  for(const p of schema?.params||[]){
   if(p.kind!=='geometry')continue;
   const value=values[p.key];
   if(value===undefined||value===null||value==='')continue;
   if(String(value)===String(p.default))continue;
   out[p.key]=p.type==='range'?Number(value):value;
  }
  return out;
 }

 function pfZones(schema){
  return (schema?.params||[]).filter(p=>p.kind==='color')
   .map(p=>({key:p.key,hex:p.default,color:pfColor(p.default)}));
 }

 /** 给每个顶点找归属色区。必须取**最近**而不是「近似就收」：
  *  iron #3c4550 与 interior #363f4a 转成线性后只差 0.017，用宽松阈值必然串色。
  *  顶点色是精确复制出来的浮点值（距离≈0），所以阈值收紧到 0.008 也不会漏。 */
 function pfIndexZones(object,zones){
  const rows=[];
  if(!zones.length)return rows;
  const seen=new Set();
  object.traverse(node=>{
   if(!node.isMesh)return;
   const attr=node.geometry?.attributes?.color;
   if(!attr||!attr.count||seen.has(attr))return;
   seen.add(attr);
   const index=new Uint8Array(attr.count);
   const array=attr.array,size=attr.itemSize;
   for(let i=0;i<attr.count;i++){
    const o=i*size,r=array[o],g=array[o+1],b=array[o+2];
    let best=255,bestDistance=0.008;
    for(let z=0;z<zones.length;z++){
     const c=zones[z].color;
     const distance=Math.hypot(r-c.r,g-c.g,b-c.b);
     if(distance<bestDistance){bestDistance=distance;best=z;}
    }
    index[i]=best;
   }
   rows.push({attr,index});
  });
  return rows;
 }

 /** 顶点色可能是 float、也可能是归一化的 Uint8/Uint16（glTF 允许，Loader 不会替你放大）。
  *  直接写 0.8 进 Uint8Array 会被截成 0，所以按数组类型换算到整型量程上。 */
 function pfPaint(rows,zones,values){
  if(!rows.length||!zones.length)return;
  const scale=rows.map(row=>row.attr.array instanceof Float32Array?1:(row.attr.array instanceof Uint16Array?65535:255));
  const colors=zones.map(zone=>pfColor(values?.[zone.key]||zone.hex));
  rows.forEach((row,i)=>{
   const {attr,index}=row;
   const array=attr.array,size=attr.itemSize,factor=scale[i];
   for(let v=0;v<attr.count;v++){
    const zone=index[v];
    if(zone===255)continue;
    const c=colors[zone],o=v*size;
    array[o]=c.r*factor;array[o+1]=c.g*factor;array[o+2]=c.b*factor;
   }
   attr.needsUpdate=true;
  });
 }

 /** 挂模型进场景。keepCamera=true 用于重建后的热替换：保留相机与观察目标，
  *  只更新裁剪面、缩放限制和地面阴影位置（几何变高时地面不会浮起来）。 */
 function pfMount(object,keepCamera){
  root.add(object);
  setChannelAvailable(true,object);
  const box=new THREE.Box3().setFromObject(object);
  if(box.isEmpty())throw new Error('模型是空的');
  const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  const radius=Math.max(size.length()*0.5,0.05);
  if(!keepCamera){
   camera.position.copy(center).add(new THREE.Vector3(radius*1.4,radius*1.1,radius*1.7));
   camera.lookAt(center);
   controls.target.copy(center);
  }
  camera.near=radius*0.01;camera.far=radius*120;
  camera.updateProjectionMatrix();
  controls.minDistance=radius*0.15;controls.maxDistance=radius*14;
  controls.update();
  if(!keepCamera)rememberHome();
  const ground=new THREE.Mesh(new THREE.CircleGeometry(radius*3,48),new THREE.ShadowMaterial({opacity:0.28}));
  ground.rotation.x=-Math.PI/2;ground.position.set(center.x,box.min.y,center.z);
  ground.receiveShadow=true;root.add(ground);
  renderer.shadowMap.enabled=true;
  object.traverse(node=>{if(node.isMesh){node.castShadow=true;node.receiveShadow=true;}});
  renderer.render(scene,camera);
 }

 async function fetchPolyforkParams(assetId){
  const res=await fetch(`/api/polyfork/params?id=${encodeURIComponent(assetId)}`,{headers:LOCAL_HEADER,cache:'no-store'});
  if(!res.ok){
   let detail='';
   try{detail=(await res.json())?.error||'';}catch{}
   throw new Error(detail||`参数清单请求失败 HTTP ${res.status}`);
  }
  return res.json();
 }

 async function fetchPolyforkGlb(assetId,geometry){
  const query=Object.keys(geometry||{}).length?`&p=${encodeURIComponent(JSON.stringify(geometry))}`:'';
  const res=await fetch(`/api/polyfork/variant?id=${encodeURIComponent(assetId)}${query}`,{headers:LOCAL_HEADER,cache:'no-store'});
  if(!res.ok){
   let detail='';
   try{detail=(await res.json())?.error||'';}catch{}
   throw new Error(detail||`变体请求失败 HTTP ${res.status}`);
  }
  return res.arrayBuffer();
 }

 /** 首次加载。返回 {schema, values} 供参数面板渲染；schema 可以由调用方预取后传入，
  *  免得「面板要一份、预览要一份」拉两遍。 */
 async function loadPolyfork(assetId,{schema=null,values=null}={}){
  const token=++loadToken;
  beginAsset('polyfork:'+assetId);
  const id=String(assetId||'').trim();
  if(!id){fail('缺少 Polyfork 资产 ID');return null;}
  if(!prepareStage('左键旋转 · 右键缩放 · 中键平移 · 双击重置 · 右侧可调参数','正在读取参数清单…'))return null;
  resetEnvironment();
  // 生成器和参数/模型并行取：首次 30~80KB 的源码下载藏在等模型的时间里，不额外拖慢首屏。
  const genPromise=pfLoadGenerator(id);
  try{
   const detail=schema||await fetchPolyforkParams(id);
   if(token!==loadToken)return null;
   const current={...pfDefaults(detail),...values};
   const geometry=pfGeometry(detail,current);
   setHint(Object.keys(geometry).length?'正在按参数重建模型…':'正在加载模型…');
   const buffer=await fetchPolyforkGlb(id,geometry);
   if(token!==loadToken)return null;
   const object=await parseModelBuffer(buffer,`${id}.glb`,new THREE.LoadingManager());
   if(!object)throw new Error('模型解析结果为空');
   clearRoot();setHint('');
   pfMount(object,false);
   pf={assetId:id,schema:detail,values:current,rows:null,zones:pfZones(detail),seq:0,gen:null};
   // 生成器晚到不影响首屏：等它到位再挂上，在那之前拖滑杆走服务端烘焙（慢但结果一样）。
   genPromise.then(gen=>{if(pf&&pf.assetId===id)pf.gen=gen;}).catch(()=>{});
   pf.rows=pfIndexZones(object,pf.zones);
   pfPaint(pf.rows,pf.zones,pf.values);
   renderer.render(scene,camera);
   return {schema:detail,values:{...current}};
  }catch(err){
   if(token!==loadToken)return null;
   fail(`无法加载 Polyfork 预览：${err.message}`,err);
   return null;
  }
 }

 /** 颜色改动：不动网络，直接改顶点色。values 只需传改动的键，其余沿用当前值。 */
 function setPolyforkColors(values){
  if(!pf)return false;
  Object.assign(pf.values,values||{});
  pfPaint(pf.rows,pf.zones,pf.values);
  if(renderer&&scene&&camera)renderer.render(scene,camera);
  return true;
 }

 /** 几何改动：三级策略，从快到慢。
  *  一、本地生成器（资产自带 .mjs）：重新算一遍几何，实测 4~20ms，零请求零配额；
  *  二、本次会话烘焙过的同一档 GLB：还留在内存里，重新 parse 就行；
  *  三、回服务端烘焙：1.5~2 秒，吃匿名每小时 40 次的额度（拖动中调用时 live=true 会跳过这一步）。
  *  三级都失败只提示一句，保留上一档几何 —— 重建失败不该把画面变空。 */
 async function bakePolyfork(values,{live=false}={}){
  if(!pf)return false;
  const next={...pf.values,...values};
  const geometry=pfGeometry(pf.schema,next);
  const key=JSON.stringify(geometry);

  if(pf.gen){
   try{
    const object=pf.gen.createAsset({...next});
    if(!object)throw new Error('生成结果为空');
    pf.values=next;
    pfSwap(object);
    return true;
   }catch{
    // 这个参数组合在生成器里跑炸了：退回服务端（同一份程序的服务端版本）。
    pf.gen=null;
   }
  }

  const stored=pfBuffers.get(key);
  if(stored){
   try{
    const object=await parseModelBuffer(stored.slice(0),`${pf.assetId}.glb`,new THREE.LoadingManager());
    if(!object)throw new Error('缓存结果为空');
    pf.values=next;
    pfSwap(object);
    return true;
   }catch{pfBuffers.delete(key);}
  }

  if(live)return false;                          // 拖动途中不发请求：1.5 秒 + 一次额度

  const seq=++pf.seq;
  setHint('正在按新参数重建…');
  try{
   const buffer=await fetchPolyforkGlb(pf.assetId,geometry);
   if(seq!==pf.seq)return false;
   const object=await parseModelBuffer(buffer,`${pf.assetId}.glb`,new THREE.LoadingManager());
   if(!object)throw new Error('重建结果为空');
   if(seq!==pf.seq)return false;
   pfBuffers.set(key,buffer.slice(0));
   if(pfBuffers.size>8)pfBuffers.delete(pfBuffers.keys().next().value);
   pf.values=next;
   pfSwap(object);
   return true;
  }catch(err){
   if(seq!==pf.seq)return false;
   setHint(`按新参数重建失败：${err.message}`);
   return false;
  }
 }

 function releaseIdleResources(){
  if(!disposed)return;
  previewCache.clearMemory();pfBuffers.clear();
  // 保留可复用的上下文，回收大画布的颜色/深度缓冲；重开由 resize 恢复。
  renderer?.setSize(1,1,false);viewW=0;viewH=0;
 }
 function close(){
  disposed=true;loadToken++;
  clearTimeout(cacheIdleTimer);
  cacheIdleTimer=setTimeout(releaseIdleResources,60000);
  resetEnvironment();
  disposeMaterialPreset();
  revokeBlobs();
  // 释放上一帧模型/地面的 GPU 资源（灯光在 scene 上保留，渲染器也长期复用、不销毁）。
  if(root){for(const child of [...root.children]){root.remove(child);disposeObject(child);}}
  channelTarget=null;disposeChannelResources();setChannelMode('off');
  stopAnimation();
  closeViewerPanels();
  const lightingMenu=document.getElementById('lighting-menu');
  if(lightingMenu)lightingMenu.hidden=true;
  undoStack=[];lastCommitted=null;
  resetRenderState();
  // 自定义环境是 PMREM 生成物，跟资产无关但要顺手放掉：关弹窗后没人再引用它。
  environmentRequest++;
  customEnvironment?.dispose();customEnvironment=null;
  stop();
  renderer?.renderLists.dispose();
  if(canvas)canvas.hidden=true;
  const iframe=document.getElementById('viewer');
  if(iframe){iframe.hidden=false;iframe.removeAttribute('src');}
  setCaption(DEFAULT_CAPTION);
  setHint('');
  const helpPanel=document.getElementById('viewer-help');
  if(helpPanel)helpPanel.hidden=true;
 }
 function resizeIfLive(){if(ready||renderer)resize();}

 /** SBSAR 预览：引擎按当前参数渲出的 basecolor / normal / roughness，贴到球体上。 */
 async function loadSubstance(urls){
  const token=++loadToken;
  beginAsset('substance');
  if(!prepareStage('左键旋转 · 滚轮缩放 · Substance 引擎按参数重渲','正在用 Substance 引擎渲染…'))return false;
  resetEnvironment();
  try{
   if(token!==loadToken)return false;
   clearRoot();
   const loader=new THREE.TextureLoader();
   const tex=async(url,srgb)=>{
    if(!url)return null;
    const local=await toLocalBlobUrl(url);
    return new Promise((res,rej)=>loader.load(local,t=>{t.wrapS=t.wrapT=THREE.RepeatWrapping;t.colorSpace=srgb?THREE.SRGBColorSpace:(THREE.NoColorSpace||THREE.LinearSRGBColorSpace);res(t);},undefined,rej));
   };
   // 四张 Substance 输出图并行取 + 并行解码，别把 RTT 串成一条链。
   const [map,normalMap,roughnessMap,metalnessMap]=await Promise.all([
    tex(urls.basecolor,true),tex(urls.normal,false),tex(urls.roughness,false),tex(urls.metalness,false),
   ]);
   if(token!==loadToken)return false;
   const ball=new THREE.Mesh(new THREE.SphereGeometry(1.2,80,56),new THREE.MeshStandardMaterial({map,normalMap,roughnessMap,roughness:roughnessMap?1:0.55,metalnessMap,metalness:metalnessMap?1:0}));
   attachMaterialStage(ball);
   camera.position.set(2.4,1.1,2.4);
   controls.target.set(0,0,0);
   controls.update();
   setHint('');
   renderer.render(scene,camera);
   return true;
  }catch(err){
   if(token!==loadToken)return false;
   fail(`无法显示 Substance 预览：${err.message}`,err);
   return false;
  }
 }

 /** 换资产时切一份「当前资产指纹」：视角标签按它分仓存，别的资产存的角度不会串过来。 */
 function beginAsset(key){
  assetKey=String(key||'');
  assetKind=kindOfAsset(assetKey);
  undoStack=[];lastCommitted=null;
  applyCapabilityBar();
  loadSavedViews();
  renderSavedViews();
  lastCommitted=captureParams();
 }

 /* ── 按资产类型裁剪工具条 ───────────────────────────────────────────────
  * AssetVault 比 art-canvas 多了贴图与 HDRI 资产：UV / 通道 / 贴图侧栏 / 显示三键
  * 只对模型有意义；材质预设条（几何、平铺、置换）反过来只给材质资产用。
  * 通用键（HDR 设置、帮助、全屏）始终保留，视角标签已并入 HDR 菜单。 */
 function kindOfAsset(key){
  const k=String(key||'').toLowerCase();
  if(k.startsWith('ph:hdri:')||k.startsWith('local-env:')||/skybox|hdri|environment/.test(k))return 'environment';
  if(k.startsWith('ph:texture:')||k==='substance'||/[:_-](texture|material|sbsar|substance)s?(:|$)/.test(k))return 'material';
  return 'model';
 }
 function applyCapabilityBar(){
  const model=assetKind==='model',material=assetKind==='material';
  for(const id of ['viewer-uv-btn','viewer-textures-btn','viewer-channels-btn']){
   const el=document.getElementById(id);if(!el)continue;
   const show=id==='viewer-textures-btn'?(model||material)
    :id==='viewer-channels-btn'?(model&&channelAvailable):model;
   el.hidden=!show;
  }
  const display=document.querySelector('.viewer-display');
  if(display)display.hidden=!model;
  const bar=document.getElementById('viewer-material');
  if(bar)bar.hidden=!material;
  if(!model){displayMode='material';setUVOpen(false);setTexturesOpen(false);}
  syncDisplayButtons();
 }

 /* ── 参数撤销（Ctrl / Cmd + Z）────────────────────────────────────────────
  * 只记「提交后的控件状态」：滑条拖动时 input 实时生效，change 才记一帧，拖十次也只撤一步。
  * 自定义 HDR 是文件二进制，没法塞进快照，故上传/重置不进撤销栈。 */
 const UNDO_LIMIT=60;
 const PARAM_IDS=['scene-lights','scene-world','environment-rotation','lighting-strength','environment-opacity','environment-blur','vm-repeat','vm-height'];
 function captureParams(){
  const state={};
  for(const id of PARAM_IDS){
   const el=document.getElementById(id);
   state[id]=el?(el.type==='checkbox'?el.checked:el.value):null;
  }
  state.geometry=materialGeometry;state.repeat=materialRepeat;state.height=materialHeight;
  state.display=displayMode;state.channel=channelMode;
  return state;
 }
 function applyParams(state){
  if(!state)return;
  for(const id of PARAM_IDS){
   const el=document.getElementById(id);if(!el||state[id]==null)continue;
   if(el.type==='checkbox')el.checked=!!state[id];else el.value=String(state[id]);
  }
  materialGeometry=state.geometry||'model';
  materialRepeat=Number(state.repeat)||1;materialHeight=Number(state.height)||0.1;
  if(channelMode!=='off')setChannelMode('off');
  channelMode=state.channel||'off';displayMode=state.display||'material';
  const overlay=document.getElementById('viewer-channels');
  if(overlay)overlay.hidden=channelMode==='off'||!channelTarget;
  renderChannelLabels();syncDisplayButtons();
  setLightStrength(document.getElementById('lighting-strength')?.value??1);
  updateEnvironmentSettings();applyMaterialRepeat();
  syncMaterialBar();renderMaterialPreset();renderFrame();
 }
 function commitUndo(){
  const now=captureParams();
  if(lastCommitted&&JSON.stringify(now)!==JSON.stringify(lastCommitted)){
   undoStack.push(lastCommitted);
   if(undoStack.length>UNDO_LIMIT)undoStack.shift();
  }
  lastCommitted=now;
 }
 function undoParams(){
  if(!undoStack.length)return false;
  applyParams(undoStack.pop());
  lastCommitted=captureParams();
  return true;
 }

 /* ── 工具栏（对齐 art-canvas 的 3D 预览界面）──────────────────────────────
  * 显示模式三键 / UV 展开 / 视角标签 / 场景设置 / 全屏 / 动画，全部复用同一块画布、
  * 同一套相机与灯光：不另开渲染器，也不换掉这个界面。 */
 // UV / 贴图是常驻侧栏，不参与浮层互斥；只有「临时浮层」才在点画布外面时自动收起。
 const PANEL_BUTTONS=[['viewer-help','viewer-help-btn']];

 /** 浮层互斥：同屏只开一块面板，省得设置面板和 UV 面板叠在一起互相挡。 */
 function closeFloatingPanels(except){
  for(const [panel,btn] of PANEL_BUTTONS){
   const el=document.getElementById(panel),button=document.getElementById(btn);
   if(el&&panel!==except)el.hidden=true;
   if(button&&panel!==except){button.classList.remove('on');button.setAttribute('aria-expanded','false');}
  }
 }
 function closeViewerPanels(except){
  closeFloatingPanels(except);
  // 无 except = 整体收起（换资产 / 关弹窗 / Esc）；此时两侧的常驻侧栏也要一起收。
  if(!except){setUVOpen(false);setTexturesOpen(false);}
 }
 function togglePanel(panel,btn){
  const el=document.getElementById(panel);if(!el)return;
  const open=el.hidden;
  closeFloatingPanels(open?panel:null);
  el.hidden=!open;
  const button=document.getElementById(btn);
  if(button){button.classList.toggle('on',open);button.setAttribute('aria-expanded',String(open));}
  if(!open)return;
  if(panel==='viewer-uv')updateUVPreview();
 }

 /** 显示模式：material 原材质 / white 白模 / wire 线框。和通道预览互斥（通道优先）。 */
 function syncDisplayButtons(){
  for(const button of document.querySelectorAll('[data-display]')){
   const active=channelMode==='off'&&button.dataset.display===displayMode;
   button.classList.toggle('on',active);
   button.setAttribute('aria-pressed',String(active));
   // 没有模型时白模/线框没意义：禁用但不隐藏，按键位置别跳。
   button.disabled=!channelTarget;
  }
 }
 function setDisplayMode(mode){
  if(!['material','white','wire'].includes(mode))mode='material';
  if(channelMode!=='off')setChannelMode('off');
  displayMode=mode;
  closeViewerPanels();
  syncDisplayButtons();
  renderFrame();
 }

 /* ── UV 展开 ─────────────────────────────────────────────────────────────
  * 只读地把 channelTarget 的 UV 三角形画到 2D 画布上，用来判断接缝与密度是否合理。
  * 面数多时按步长抽稀，几万面也只画 2000 条边，不至于卡住界面。 */
 function uvAttributes(target){
  const names=new Set();
  target?.traverse(node=>{
   if(!node.isMesh)return;
   for(const name of Object.keys(node.geometry?.attributes||{}))if(/^uv\d*$/.test(name))names.add(name);
  });
  return [...names].sort((a,b)=>(a==='uv'?0:Number(a.slice(2))+1)-(b==='uv'?0:Number(b.slice(2))+1));
 }
 function setUVOpen(open){
  const panel=document.getElementById('viewer-uv');if(!panel)return;
  if(open)closeViewerPanels('viewer-uv');
  panel.hidden=!open;
  // art-canvas 的面板是「挤窄画布」而不是浮在上面，靠 .uv-open 这个 class 生效。
  const wrap=document.querySelector('.viewer-wrap');
  if(wrap)wrap.classList.toggle('uv-open',open);
  const button=document.getElementById('viewer-uv-btn');
  if(button){button.classList.toggle('on',open);button.setAttribute('aria-expanded',String(open));}
  if(open)updateUVPreview();
 }
 /* 模型贴图侧栏：和 art-canvas 的 viewer-textures 同一套结构（figure + img + figcaption）。
  * 遍历当前模型的材质插槽，同一张纹理只列一次。 */
 const TEXTURE_LABELS={map:'颜色',normalMap:'法线',roughnessMap:'粗糙度',metalnessMap:'金属度',aoMap:'AO',emissiveMap:'自发光',displacementMap:'高度'};
 function setTexturesOpen(open){
  const sidebar=document.getElementById('viewer-textures');if(!sidebar)return;
  sidebar.hidden=!open;
  const wrap=document.querySelector('.viewer-wrap');
  if(wrap)wrap.classList.toggle('textures-open',open);
  const button=document.getElementById('viewer-textures-btn');
  if(button){button.classList.toggle('on',open);button.setAttribute('aria-expanded',String(open));}
  if(open)updateTextureSidebar();
 }
 function updateTextureSidebar(){
  const sidebar=document.getElementById('viewer-textures');
  if(!sidebar||sidebar.hidden)return;
  sidebar.replaceChildren();
  const entries=[],seen=new Set();
  channelTarget?.traverse(node=>{
   if(!node.isMesh)return;
   for(const material of Array.isArray(node.material)?node.material:[node.material]){
    if(!material)continue;
    for(const [slot,label] of Object.entries(TEXTURE_LABELS)){
     const texture=material[slot];
     if(!texture?.image)continue;
     try{
      const image=texture.image;
      let url=image.src;
      if(!url){const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);url=canvas.toDataURL();}
      if(seen.has(url))continue;
      seen.add(url);
      entries.push({url,label:(material.name?material.name+' · ':'')+label});
     }catch(_){}
    }
   }
  });
 bindTextureZoom();closeTextureZoom();textureZoomUrls=entries;
 if(!entries.length){sidebar.textContent='暂无贴图';return;}
 for(const entry of entries){
  const item=document.createElement('figure'),image=document.createElement('img'),label=document.createElement('figcaption');
  image.src=entry.url;image.alt=entry.label;label.textContent=entry.label;
  item.title=entry.label+' · 点击放大';item.tabIndex=0;item.setAttribute('role','button');
  item.append(image,label);sidebar.append(item);
 }
}
/* ── ANCHOR-DIFF 8：贴图放大查看（与 art-canvas viewer.html 同名同结构，可整段互相拷贝）──
 * 点侧栏缩略图开覆盖层看原图；滚轮缩放、←/→ 切图、双击还原、Esc / 点遮罩 / × 关闭。
 * 事件全部委托，侧栏每次重建缩略图都不会重复绑定。 */
let textureZoomUrls=[],textureZoomIndex=0,textureZoomScale=1;
function closeTextureZoom(){
 const layer=document.getElementById('viewer-texture-zoom');
 if(layer)layer.hidden=true;
}
function setTextureZoomImage(){
 const layer=document.getElementById('viewer-texture-zoom'),image=document.getElementById('texture-zoom-image');
 const caption=document.getElementById('texture-zoom-caption'),entry=textureZoomUrls[textureZoomIndex];
 if(!layer||!image||!entry)return;
 image.src=entry.url;image.alt=entry.label;
 if(caption)caption.textContent=entry.label+' · '+(textureZoomIndex+1)+'/'+textureZoomUrls.length+' · 滚轮缩放 / ←→ 切换 / Esc 关闭';
 textureZoomScale=1;layer.style.setProperty('--zoom-scale','1');
}
function openTextureZoom(index){
 const layer=document.getElementById('viewer-texture-zoom');
 if(!layer||!textureZoomUrls.length)return;
 bindTextureZoom();
 textureZoomIndex=Math.max(0,Math.min(index,textureZoomUrls.length-1));
 layer.hidden=false;setTextureZoomImage();
 document.getElementById('texture-zoom-close')?.focus();
}
function bindTextureZoom(){
 const layer=document.getElementById('viewer-texture-zoom');
 if(!layer||layer.dataset.bound)return;
 layer.dataset.bound='1';
 const sidebar=document.getElementById('viewer-textures');
 const indexOf=target=>[...sidebar.querySelectorAll('figure')].indexOf(target);
 sidebar?.addEventListener('click',event=>{
  const figure=event.target.closest?.('figure');
  if(figure&&sidebar.contains(figure))openTextureZoom(indexOf(figure));
 });
 sidebar?.addEventListener('keydown',event=>{
  if(event.key!=='Enter'&&event.key!==' ')return;
  const figure=event.target.closest?.('figure');
  if(!figure||!sidebar.contains(figure))return;
  event.preventDefault();openTextureZoom(indexOf(figure));
 });
 document.getElementById('texture-zoom-close')?.addEventListener('click',closeTextureZoom);
 layer.addEventListener('click',event=>{if(event.target===layer)closeTextureZoom();});
 // 兜底：点放大层以外的任何地方（工具条、画布、关闭弹窗）都顺手收起，
 // 免得关掉贴图侧栏后还留着一张大图挡住模型。
 document.addEventListener('pointerdown',event=>{
  if(!layer.hidden&&!layer.contains(event.target))closeTextureZoom();
 });
 layer.addEventListener('wheel',event=>{
  event.preventDefault();
  textureZoomScale=Math.min(6,Math.max(1,textureZoomScale+(event.deltaY<0?0.25:-0.25)));
  layer.style.setProperty('--zoom-scale',String(textureZoomScale));
 },{passive:false});
 document.getElementById('texture-zoom-image')?.addEventListener('dblclick',()=>{
  textureZoomScale=1;layer.style.setProperty('--zoom-scale','1');
 });
 document.addEventListener('keydown',event=>{
  if(layer.hidden)return;
  if(event.key==='Escape'){closeTextureZoom();return;}
  if(event.key!=='ArrowRight'&&event.key!=='ArrowLeft')return;
  if(!textureZoomUrls.length)return;
  event.preventDefault();
  textureZoomIndex=(textureZoomIndex+(event.key==='ArrowRight'?1:-1)+textureZoomUrls.length)%textureZoomUrls.length;
  setTextureZoomImage();
 });
}
 /* 材质预设条：模型 / 球 / 方 / 平板 + 平铺 + 置换，和 art-canvas 的 viewer-material 同构。
  * 切到球/方/平板时用模型第一个网格的材质克隆一份，挂到临时 group 上，模型本身隐藏。 */
 const MATERIAL_LABELS={model:'模型',sphere:'球',cube:'方',plane:'平板'};
 const MATERIAL_SLOTS=['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap','displacementMap'];
 let materialGeometry='model',materialRepeat=1,materialHeight=0.1,materialGroup=null;
 function geometryIcon(value){
  const paths={model:'M4 7 12 3l8 4v10l-8 4-8-4V7zm0 0 8 4 8-4m-8 4v10',sphere:'M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18',cube:'M4 7 12 3l8 4v10l-8 4-8-4V7zm0 0 8 4 8-4m-8 4v10',plane:'m3 8 12-4 6 12-12 4L3 8z'};
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">'+(value==='sphere'?'<circle cx="12" cy="12" r="9"/>':'')+'<path d="'+paths[value]+'"/></svg>';
 }
 function hasMaterial(){let found=false;channelTarget?.traverse(node=>{if(node.isMesh&&node.material)found=true;});return found;}
 function materialSource(){
  let mesh=null;
  channelTarget?.traverse(node=>{if(!mesh&&node.isMesh&&node.material)mesh=node;});
  return mesh;
 }
function applyMaterialRepeat(){
 const walk=object=>object?.traverse(node=>{
  if(!node.isMesh)return;
  for(const material of Array.isArray(node.material)?node.material:[node.material]){
   if(!material)continue;
   if(material.displacementMap){material.displacementScale=materialHeight;material.displacementBias=-materialHeight/2;}
   for(const slot of MATERIAL_SLOTS){
    const texture=material[slot];
    if(!texture)continue;
    // needsUpdate 会把整张贴图重新上传到 GPU。拖动平铺/置换滑条时每帧重传所有
    // 贴图是「调节参数巨卡顿」的元凶之一：wrap 只在首次切换时改一次，之后
    // repeat / displacementScale 都是 uniform，改完立即生效，无需重传。
    if(texture.wrapS!==THREE.RepeatWrapping||texture.wrapT!==THREE.RepeatWrapping){
     texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
     texture.needsUpdate=true;
    }
    texture.repeat.set(materialRepeat,materialRepeat);
   }
  }
 });
 walk(channelTarget);walk(materialGroup);
 requestRender();
}
 function disposeMaterialPreset(){
  if(!materialGroup)return;
  scene?.remove(materialGroup);
  materialGroup.traverse(node=>{if(!node.isMesh)return;node.geometry?.dispose();const m=node.material;(Array.isArray(m)?m:[m]).forEach(item=>item?.dispose());});
  materialGroup=null;
 }
 function buildMaterialPreset(){
  disposeMaterialPreset();
  const source=materialSource();
  if(!source)return;
  const base=Array.isArray(source.material)?source.material[0]:source.material;
  if(!base)return;
  const geometry=materialGeometry==='sphere'?new THREE.SphereGeometry(1,96,64)
   :materialGeometry==='cube'?new THREE.BoxGeometry(1.6,1.6,1.6,64,64,64)
   :new THREE.PlaneGeometry(2.4,2.4,192,192);
  const mesh=new THREE.Mesh(geometry,base.clone());
  mesh.castShadow=mesh.receiveShadow=true;
  if(materialGeometry==='plane')mesh.rotation.x=-Math.PI/2;
  materialGroup=new THREE.Group();
  materialGroup.add(mesh);
  scene?.add(materialGroup);
  applyMaterialRepeat();
 }
 function renderMaterialPreset(){
  const preset=materialGeometry!=='model';
  if(channelTarget)channelTarget.visible=!preset;
  if(preset)buildMaterialPreset();
  else disposeMaterialPreset();
  requestRender();
 }
 function syncMaterialBar(){
  const bar=document.getElementById('viewer-material');if(!bar)return;
  bar.hidden=assetKind!=='material';
  if(bar.hidden)return;
  bar.querySelectorAll('[data-geometry]').forEach(button=>{
   const value=button.dataset.geometry;
   button.classList.toggle('on',value===materialGeometry);
   button.disabled=value==='model'&&!channelTarget;
   button.innerHTML=geometryIcon(value)+'<span>'+MATERIAL_LABELS[value]+'</span>';
  });
  const geometryBtn=document.getElementById('vm-geometry-btn');
  if(geometryBtn)geometryBtn.innerHTML=geometryIcon(materialGeometry)+'<span>'+MATERIAL_LABELS[materialGeometry]+'</span>';
  const repeat=document.getElementById('vm-repeat');
  if(repeat)repeat.value=String(materialRepeat);
  const repeatOut=document.getElementById('vm-repeat-out');
  if(repeatOut)repeatOut.textContent=materialRepeat+'×';
  const height=document.getElementById('vm-height');
  if(height)height.value=String(materialHeight);
  const heightOut=document.getElementById('vm-height-out');
  if(heightOut)heightOut.textContent=materialHeight.toFixed(2);
 }
 function bindMaterialBar(){
  const bar=document.getElementById('viewer-material');if(!bar||bar.dataset.bound)return;
  // 预览弹窗可以反复打开，绑定只做一次，否则 document 上的监听会越积越多。
  bar.dataset.bound='1';
  const panels=['geometry','repeat','height'];
  const closeMenus=()=>panels.forEach(name=>{
   const menu=document.getElementById('vm-'+name+'-menu'),button=document.getElementById('vm-'+name+'-btn');
   if(menu)menu.hidden=true;
   if(button)button.setAttribute('aria-expanded','false');
  });
  for(const name of panels){
   const button=document.getElementById('vm-'+name+'-btn');
   if(!button)continue;
   button.addEventListener('click',()=>{
    const menu=document.getElementById('vm-'+name+'-menu');if(!menu)return;
    const open=menu.hidden;closeMenus();menu.hidden=!open;
    button.setAttribute('aria-expanded',String(open));
   });
  }
  document.addEventListener('pointerdown',event=>{if(!bar.contains(event.target))closeMenus();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenus();});
  bar.querySelectorAll('[data-geometry]').forEach(button=>button.addEventListener('click',()=>{
   if(button.disabled)return;
   materialGeometry=button.dataset.geometry;closeMenus();syncMaterialBar();renderMaterialPreset();
  }));
  const repeat=document.getElementById('vm-repeat');
  if(repeat)repeat.addEventListener('input',()=>{
   materialRepeat=Math.min(4,Math.max(0.5,Math.round((Number(repeat.value)||1)*10)/10));
   syncMaterialBar();applyMaterialRepeat();
  });
  const height=document.getElementById('vm-height');
  if(height)height.addEventListener('input',()=>{
   materialHeight=Math.min(0.5,Math.max(0,Number(height.value)||0));
   syncMaterialBar();applyMaterialRepeat();
  });
 }
 function updateUVPreview(){
  const panel=document.getElementById('viewer-uv');
  if(!panel||panel.hidden)return;
  const select=document.getElementById('viewer-uv-channel');
  const names=uvAttributes(channelTarget),previous=select?.value;
  if(select){
   select.replaceChildren(...names.map(name=>{
    const option=document.createElement('option');
    option.value=name;option.textContent=name==='uv'?'UV 0':'UV '+name.slice(2);
    return option;
   }));
   if(names.includes(previous))select.value=previous;
   select.disabled=!names.length;
  }
  drawUVLayout();
 }
 function drawUVLayout(){
  const canvasEl=document.getElementById('viewer-uv-canvas');
  const panel=document.getElementById('viewer-uv');
  if(!canvasEl||!panel||panel.hidden)return;
  const width=Math.max(1,canvasEl.clientWidth),height=Math.max(1,canvasEl.clientHeight),ratio=Math.min(window.devicePixelRatio||1,2);
  const nextW=Math.round(width*ratio),nextH=Math.round(height*ratio);
  if(canvasEl.width!==nextW||canvasEl.height!==nextH){canvasEl.width=nextW;canvasEl.height=nextH;}
  const ctx=canvasEl.getContext('2d');
  ctx.setTransform(ratio,0,0,ratio,0,0);
  ctx.clearRect(0,0,width,height);
  const meshes=[],name=document.getElementById('viewer-uv-channel')?.value||'uv';
  channelTarget?.traverse(mesh=>{if(mesh.isMesh&&mesh.geometry?.attributes[name])meshes.push(mesh);});
  const pad=10,size=Math.max(1,Math.min(width,height)-pad*2),ox=(width-size)/2,oy=(height-size)/2;
  const x=u=>ox+u*size,y=v=>height-oy-v*size;
  ctx.strokeStyle='#ffffff33';ctx.lineWidth=1;ctx.strokeRect(ox,oy,size,size);
  ctx.strokeStyle='#a5c880aa';ctx.lineWidth=0.65;ctx.beginPath();
  let shown=0,total=0;
  for(const mesh of meshes){
   const geometry=mesh.geometry,uv=geometry.attributes[name],index=geometry.index;
   const count=index?index.count:uv.count;
   total+=Math.floor(count/3);
   const data=uv.array,idx=index&&index.array;
   if(!data)continue;
   const step=Math.max(1,Math.floor(count/3/2000));
   for(let t=0;t<count/3;t+=step){
    const i=t*3,a=idx?idx[i]:i,b=idx?idx[i+1]:i+1,c=idx?idx[i+2]:i+2;
    if(a*2+1>=data.length||b*2+1>=data.length||c*2+1>=data.length)continue;
    ctx.moveTo(x(data[a*2]),y(data[a*2+1]));
    ctx.lineTo(x(data[b*2]),y(data[b*2+1]));
    ctx.lineTo(x(data[c*2]),y(data[c*2+1]));
    ctx.closePath();
    shown++;
   }
  }
  ctx.stroke();
  const status=document.getElementById('viewer-uv-status');
  if(status)status.textContent=!meshes.length?'当前物体没有这条 UV':
   (total>shown?`${shown.toLocaleString()} / ${total.toLocaleString()} 面`:`${meshes.length} 个网格 · ${total.toLocaleString()} 面`);
 }

 /* ── 视角标签 ─────────────────────────────────────────────────────────────
  * 相机机位按资产存进 localStorage：同一个资产下次打开还能回到「看细节的那个角度」。
  * 存的是 position/target/near/far，召回时逐项校验，脏数据直接丢掉而不是把相机开到 NaN。 */
 const VIEW_STORE='av:preview-views';
 function viewsKey(){return `${VIEW_STORE}:${assetKey||'default'}`;}
 function validSavedView(view){
  return view&&typeof view.name==='string'&&
   ['position','target'].every(key=>Array.isArray(view[key])&&view[key].length===3&&view[key].every(Number.isFinite))&&
   Number.isFinite(view.near)&&view.near>0&&Number.isFinite(view.far)&&view.far>view.near;
 }
 function loadSavedViews(){
  try{const raw=JSON.parse(localStorage.getItem(viewsKey())||'[]');savedViews=(Array.isArray(raw)?raw:[]).filter(validSavedView);}
  catch{savedViews=[];}
 }
 function persistSavedViews(){
  try{localStorage.setItem(viewsKey(),JSON.stringify(savedViews));}catch{}
 }
 function saveCurrentView(name){
  if(!camera||!controls)return;
  const view={
   id:Date.now().toString(36)+Math.random().toString(36).slice(2,6),
   name:String(name||'').trim().slice(0,24)||`视角 ${savedViews.length+1}`,
   position:camera.position.toArray(),target:controls.target.toArray(),
   near:camera.near,far:camera.far,minDistance:controls.minDistance,maxDistance:controls.maxDistance,
  };
  if(!validSavedView(view))return;
  savedViews.push(view);persistSavedViews();renderSavedViews();
 }
 function recallSavedView(view){
  if(!validSavedView(view)||!camera||!controls)return;
  const damping=controls.enableDamping;
  controls.enableDamping=false;controls.update();
  camera.position.fromArray(view.position);controls.target.fromArray(view.target);
  camera.near=view.near;camera.far=view.far;
  if(Number.isFinite(view.minDistance))controls.minDistance=view.minDistance;
  if(Number.isFinite(view.maxDistance))controls.maxDistance=view.maxDistance;
  camera.updateProjectionMatrix();controls.update();controls.enableDamping=damping;
  renderFrame();
 }
 function renderSavedViews(){
  const list=document.getElementById('viewer-views-list');
  if(!list)return;
  list.replaceChildren();
  if(!savedViews.length){
   const empty=document.createElement('p');
   empty.textContent='还没存视角：转到想要的角度，起个名保存';
   list.append(empty);
   return;
  }
  for(const view of savedViews){
   const row=document.createElement('div'),recall=document.createElement('button'),remove=document.createElement('button');
   recall.type=remove.type='button';
   recall.className='view-recall';recall.textContent=view.name;recall.title=view.name;
   recall.addEventListener('click',()=>recallSavedView(view));
   remove.className='view-remove';remove.textContent='×';
   remove.title='删除这个视角';remove.setAttribute('aria-label',`删除视角 ${view.name}`);
   remove.addEventListener('click',()=>{savedViews=savedViews.filter(item=>item.id!==view.id);persistSavedViews();renderSavedViews();});
   row.append(recall,remove);list.append(row);
  }
 }

 /* ── 场景设置：灯光强度 / 灯光与世界光开关 / 背景亮度与模糊 / 自定义环境 ──
  * 只动既有场景状态，不重建渲染器。背景亮度与模糊用的是 three r160 自带的
  * backgroundIntensity / backgroundBlurriness；环境旋转那两项 r160 还没有，不上。 */
 function setLightStrength(value){
  const strength=Math.min(3,Math.max(0,Number(value)||0));
  if(keyLight)keyLight.intensity=1.7*strength;
  if(fillLight)fillLight.intensity=0.7*strength;
  if(hemiLight)hemiLight.intensity=1.1*strength;
  const out=document.getElementById('lighting-value');
  if(out)out.textContent=strength.toFixed(2);
  requestRender();
 }
 function activeEnvironment(){return customEnvironment?.texture||baseEnvironment;}
 function updateEnvironmentSettings(){
  const get=id=>document.getElementById(id);
  if(!get('scene-lights'))return;
  const lights=get('scene-lights').checked;
  if(lightRig)lightRig.visible=lights;
  if(hemiLight)hemiLight.visible=lights;
  if(scene){
   scene.environment=get('scene-world').checked?activeEnvironment():null;
   scene.backgroundIntensity=Number(get('environment-opacity').value);
   scene.backgroundBlurriness=Number(get('environment-blur').value);
   // three r160 还没有 environmentRotation / backgroundRotation（r163 起才有）。
   // 有就生效、没有就只更新数值，引擎升级后这里不用改。
   const rotation=Number(get('environment-rotation')?.value||0)*Math.PI/180;
   if('environmentRotation' in scene)scene.environmentRotation.y=rotation;
   if('backgroundRotation' in scene)scene.backgroundRotation.y=rotation;
   const rotationOut=get('rotation-value');
   if(rotationOut)rotationOut.textContent=Math.round(rotation*180/Math.PI)+'°';
   const brightness=get('opacity-value');
   if(brightness)brightness.textContent=scene.backgroundIntensity.toFixed(2);
   const blur=get('blur-value');
   if(blur)blur.textContent=scene.backgroundBlurriness.toFixed(2);
  }
  const status=get('environment-status');
  if(status&&!status.dataset.file)status.textContent=customEnvironment?'自定义环境':'默认摄影棚';
  scheduleEnvironmentPreview();
  requestRender();
}
/* 环境缩略球是最贵的一步：离屏渲染 + readRenderTargetPixels 会把 GPU 流水线同步
 * 读回 CPU。滑条 input 每秒几十次都跑一遍，就会卡到完全没法拖。这里按「环境贴图
 * 是否变化」去重并合并到一帧：调参数期间签名不变，直接零开销跳过；只有打开 HDR
 * 面板、换环境、撤销参数时才真正重画一次。 */
let environmentPreviewSignature='',environmentPreviewFrame=0;
let environmentPreviewScene=null,environmentPreviewMaterial=null,environmentPreviewGeometry=null,environmentPreviewCamera=null;
function scheduleEnvironmentPreview(force){
 const panel=document.getElementById('lighting-menu');
 if(!panel||panel.hidden||!renderer)return;
 const texture=activeEnvironment();
 const signature=(texture?.uuid||'')+'|'+(customEnvironment?'1':'0');
 if(!force&&signature===environmentPreviewSignature)return;
 environmentPreviewSignature=signature;
 if(environmentPreviewFrame)return;
 environmentPreviewFrame=requestAnimationFrame(()=>{
  environmentPreviewFrame=0;
  if(!document.getElementById('lighting-menu')?.hidden)updateEnvironmentPreview(activeEnvironment());
 });
}
/** 设置面板里的环境缩略球：复用同一个 WebGL 上下文渲到 target 再读回 2D 画布。
 *  跨 renderer 共享 PMREM 纹理是失效的，所以必须用当前 renderer 现渲一张。 */
function updateEnvironmentPreview(texture){
 const thumb=document.getElementById('environment-thumb'),panel=document.getElementById('lighting-menu');
 if(!thumb||!renderer||!texture||!panel||panel.hidden)return;
 const size=thumb.width||112;
 try{
  if(!environmentPreviewTarget||environmentPreviewTarget.width!==size){
   environmentPreviewTarget?.dispose();
   environmentPreviewTarget=new THREE.WebGLRenderTarget(size,size);
  }
  // 场景 / 球 / 相机只建一次：反复 new + dispose 会拖慢换环境与反复开合面板。
  if(!environmentPreviewScene){
   environmentPreviewScene=new THREE.Scene();
   environmentPreviewMaterial=new THREE.MeshStandardMaterial({color:0xffffff,metalness:1,roughness:0.08});
   environmentPreviewGeometry=new THREE.SphereGeometry(1,32,20);
   environmentPreviewScene.add(new THREE.Mesh(environmentPreviewGeometry,environmentPreviewMaterial));
   environmentPreviewCamera=new THREE.PerspectiveCamera(40,1,0.1,10);
   environmentPreviewCamera.position.z=3.2;
  }
  environmentPreviewScene.environment=texture;
  const previous=renderer.getRenderTarget();
  const viewport=renderer.getViewport(new THREE.Vector4());
  const clear=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha();
  const scissor=renderer.getScissorTest();
  const pixels=new Uint8Array(size*size*4);
  try{
   renderer.setRenderTarget(environmentPreviewTarget);
   renderer.setScissorTest(false);
   renderer.setViewport(0,0,size,size);
   renderer.setClearColor(0x151c25,1);renderer.clear();
   renderer.render(environmentPreviewScene,environmentPreviewCamera);
   renderer.readRenderTargetPixels(environmentPreviewTarget,0,0,size,size,pixels);
  }finally{
   // viewport / 清屏色 / scissor 必须还原，否则主画布会被挤进左下角一小块。
   renderer.setRenderTarget(previous);
   renderer.setViewport(viewport);
   renderer.setScissorTest(scissor);
   renderer.setClearColor(clear,alpha);
  }
  const flipped=new Uint8ClampedArray(pixels.length);
  for(let y=0;y<size;y++)flipped.set(pixels.subarray(y*size*4,(y+1)*size*4),(size-1-y)*size*4);
  thumb.getContext('2d').putImageData(new ImageData(flipped,size,size),0,0);
 }catch(err){
  console.warn('[预览] 环境缩略图渲染失败',err);
 }
}
 /** 自定义 HDR / EXR / 全景图：PMREM 之后只留生成物（原贴图必须 dispose，否则每换一次漏一张）。 */
 async function replaceEnvironment(file){
  if(!file||!renderer)return;
  const request=++environmentRequest;
  const status=document.getElementById('environment-status');
  if(status){status.dataset.file='1';status.textContent=`正在加载 ${file.name}…`;}
  const url=URL.createObjectURL(file);
  let texture=null,generator=null,target=null;
  try{
   const hdr=/\.hdr$/i.test(file.name),exr=/\.exr$/i.test(file.name);
   const loader=hdr?new RGBELoader():exr?new EXRLoader():new THREE.TextureLoader();
   texture=await loader.loadAsync(url);
   if(request!==environmentRequest)return;
   texture.mapping=THREE.EquirectangularReflectionMapping;
   if(!hdr&&!exr)texture.colorSpace=THREE.SRGBColorSpace;
   generator=new THREE.PMREMGenerator(renderer);
   target=generator.fromEquirectangular(texture);
   customEnvironment?.dispose();
   customEnvironment=target;target=null;
   if(status)status.textContent=file.name;
   updateEnvironmentSettings();
  }catch(err){
   if(request===environmentRequest&&status)status.textContent='环境加载失败：请选 HDR / EXR / 全景图片';
   console.warn('[预览] 环境贴图加载失败',err);
  }finally{
   URL.revokeObjectURL(url);
   texture?.dispose();generator?.dispose();target?.dispose();
  }
 }
 function resetCustomEnvironment(){
  environmentRequest++;
  customEnvironment?.dispose();customEnvironment=null;
  const status=document.getElementById('environment-status');
  if(status){delete status.dataset.file;status.textContent='默认环境';}
  updateEnvironmentSettings();
 }

 /* ── 全屏 / 动画 ────────────────────────────────────────────────────────
  * 动画：模型自带 clip 时出现下拉与播放键；播放期间每帧续一次 raf，暂停后回到按需绘制。 */
 function toggleFullscreen(){
  const dialog=document.getElementById('preview-dialog');
  if(document.fullscreenElement){document.exitFullscreen?.().catch(()=>{});return;}
  const target=dialog||document.documentElement;
  if(!target?.requestFullscreen){setHint('当前环境不支持全屏');return;}
  target.requestFullscreen().catch(()=>setHint('当前环境不支持全屏'));
 }
 function syncPlayButton(){
  const button=document.getElementById('play');
  if(!button)return;
  button.textContent=playing?'Ⅱ':'▶';
  button.setAttribute('aria-pressed',String(playing));
  button.title=playing?'暂停动画':'播放动画';
 }
 function stopAnimation(){
  if(mixer){mixer.stopAllAction();mixer=null;}
  animClipList=[];animClock=null;animAction=null;playing=true;
  const tools=document.getElementById('animation-tools');
  if(tools)tools.hidden=true;
  syncPlayButton();
 }
 function playAnimation(index=0){
  if(!mixer||!animClipList.length)return;
  mixer.stopAllAction();
  const clip=animClipList[Number(index)]||animClipList[0];
  const action=mixer.clipAction(clip);
  action.reset();action.play();action.paused=!playing;
  animAction=action;
  syncPlayButton();requestRender();
 }
 function mountAnimations(object,animations){
  stopAnimation();
  if(!object||!Array.isArray(animations)||!animations.length)return;
  animClipList=animations;
  mixer=new THREE.AnimationMixer(object);
  animClock=new THREE.Clock();
  const select=document.getElementById('clip');
  if(select){
   select.replaceChildren(...animations.map((clip,index)=>{
    const option=document.createElement('option');
    option.value=String(index);option.textContent=clip.name||`动画 ${index+1}`;
    return option;
   }));
  }
  const tools=document.getElementById('animation-tools');
  if(tools)tools.hidden=false;
  playAnimation(0);
 }

 return {loadSimready,load,loadFreestylized,loadSubstance,loadLocalModel,loadLocalEnvironment,loadPolyfork,setPolyforkColors,bakePolyfork,polyforkLive:()=>!!pf?.gen,fetchPolyforkParams,close,resize:resizeIfLive,canPreview:type=>true};
}
function polyhavenAssetType(value){return value==='textures'||value==='hdris'?value:'models';}
/** 换资产时释放上一帧的 GPU 资源。只 remove 不 dispose 的话，纹理与几何会一直挂在
 *  WebGL 上下文上——连续看十几个模型后显存就够不上了（three 的 dispose 是必须的）。 */
function disposeObject(object){
 object.traverse(node=>{
  if(node.geometry)node.geometry.dispose();
  const materials=Array.isArray(node.material)?node.material:node.material?[node.material]:[];
  for(const material of materials){
    // 贴图本体是 blob 的 object URL，revoke 在 revokeBlobs 里做，这里只放 three 侧的 GPU 资源。
    for(const value of Object.values(material))if(value&&value.isTexture)value.dispose();
    material.dispose();
  }
 });
}
