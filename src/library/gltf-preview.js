// Poly Haven 的本地 3D 预览。
//
// 官方页面能转视角，靠的是浏览器自己去 glTF CDN 取 1k 档模型自己渲染；他们**没有**可嵌入的
// iframe viewer。所以这里做等价的事：同一个 1k glTF，同一个 CDN，只是渲染器在我们这边。
//
// 有个坑必须处理：glTF 里贴图写的是打包时的相对路径（`textures/Armchair_01_diff_1k.jpg`），
// 而 CDN 上并没有这个目录，直接加载必然 404。官方是靠自己的文件清单把 basename 映射回真实 URL，
// 我们照同样的做法——先要清单，再按 basename 改写 GLTFLoader 要用的 URL。
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {RGBELoader} from 'three/examples/jsm/loaders/RGBELoader.js';
// FreeStylized 的模型包里只有 FBX（没有 glTF），所以除了 glTF 还得会读 FBX。
import {FBXLoader} from 'three/examples/jsm/loaders/FBXLoader.js';

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

/** 跨预览复用的 blob 缓存。
 *
 *  /api/proxy 只给 /api/image 做了缓存，预览要用的 glTF / .bin / 贴图**完全没有缓存** ——
 *  每打开一次预览就把整个模型重新下一遍（本机代理 + 跨境 CDN，一个 1K 模型常要好几秒）。
 *
 *  这里按 URL 缓存 ArrayBuffer 并登记 blob URL：同一份资源只在第一次下载，之后再建 blob URL
 *  是纯本地操作（微秒级），重复预览就只剩「解码 + 解析 + 渲染」这部分必然要花的功夫。
 *
 *  为什么缓存的是 ArrayBuffer 而不是 blob URL：blob URL 会被 revokeBlobs() 连带回收，
 *  而模型一旦解析完，贴图像素已经进 GPU 了，源字节留着也不会占显存；下次要时重新建 URL 即可。
 *
 *  容量双封顶：条目数 + 总字节。只按条目数封顶不够 —— 贴图从几百 KB 到几 MB 都有，
 *  单看条数最坏能吃掉几百 MB，对常驻的桌面应用太重；字节上限才是真正约束内存的那一头。
 *  上限内按 LRU 淘汰（Map 保序，命中即移到队尾）。
 *
 *  淘汰时**不需要** revoke blob URL：它们早已被 revokeBlobs() 在换资产时回收过，
 *  这里只把字节从 Map 里丢掉，剩下的交给 GC。
 */
const BLOB_CACHE_MAX_ENTRIES=96;
const BLOB_CACHE_MAX_BYTES=160*1024*1024;
const blobCache=new Map();
let blobCacheBytes=0;
function cacheGet(url){
 if(!blobCache.has(url))return null;
 const bytes=blobCache.get(url);
 // 命中就移到队尾（Map 保序），实现 LRU。
 blobCache.delete(url);blobCache.set(url,bytes);
 return bytes;
}
function cachePut(url,bytes){
 blobCache.set(url,bytes);
 blobCacheBytes+=bytes.byteLength;
 while(blobCache.size>BLOB_CACHE_MAX_ENTRIES||blobCacheBytes>BLOB_CACHE_MAX_BYTES){
  const oldest=[...blobCache.keys()][0];
  blobCacheBytes-=blobCache.get(oldest).byteLength;
  blobCache.delete(oldest);
 }
 return bytes;
}

/** 把远程资源抓成本地 blob URL（登记进 registry，关预览时统一 revoke）。
 *  命中缓存时只重建 URL，不发请求 —— 这是「重复预览同一个模型快很多」的全部原因。 */
async function toBlob(url,registry,kind='资源'){
 const cached=cacheGet(url);
 if(cached){
  const reused=URL.createObjectURL(new Blob([cached]));
  registry.push(reused);
  return reused;
 }
 const res=await fetchLocal(url);
 const bytes=await res.arrayBuffer();
 cachePut(url,bytes);
 const created=URL.createObjectURL(new Blob([bytes]));
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
 // 灯光 rig：Shift+左键拖动时转它（八猴的 rotate lights），绕视线中心旋转。
 let lightRig=null,homeShot=null,lightDrag=null,gesturesBound=false,uiBound=false;
 // 上一次真正同步过的画布尺寸：渲染 buffer 必须等于显示尺寸，否则画面被拉伸变形。
 let viewW=0,viewH=0,sizeObserver=null;
 // 通道预览（复刻 ArtStation mviewer）：'off' 关闭 / 'all' 五通道拆分 / 单通道名 = 单独预览。
 let channelMode='off',channelTarget=null,channelAvailable=false,pressInfo=null,channelRadius=1;
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

 function setHint(text){
  const hint=document.querySelector('.viewer-hint');if(!hint)return;
  hint.textContent=text||'';
  // 有文字 = 正在加载或出错，加 busy 让它转起来（CSS 见 app.css 的 viewer-spin）。
  hint.classList.toggle('busy',!!text);
 }
function setCaption(text){
  const caption=document.getElementById('viewer-caption');
  if(!caption)return;
  // 保留原来的图标，只换文案 —— 图标节点是 fillIcons 填的，重建会把它清掉。
  const iconEl=caption.querySelector('[data-icon],i');
  caption.textContent=text;
  if(iconEl)caption.prepend(iconEl);
}
const DEFAULT_CAPTION='左键旋转 · 右键缩放 · 中键平移 · 双击重置视角 · Shift+左键旋转灯光';

 function fail(message,detail){
  stop();
  // 释放上一帧的 GPU 资源（灯光在 scene 上、不会被清），避免连续预览显存堆积。
  if(root){for(const child of [...root.children]){root.remove(child);disposeObject(child);}}
  if(canvas)canvas.hidden=true;
  const iframe=document.getElementById('viewer');
  if(iframe)iframe.hidden=false;
  channelTarget=null;disposeChannelResources();setChannelMode('off');
  setCaption(DEFAULT_CAPTION);
  setHint(message);
  if(detail)console.warn('[Poly Haven 预览]',message,detail);
 }

 /** 渲染循环：controls.update() 与 render 都挂在这一帧上，没有它拖动就只是改了内部状态、
  *  画面永远停在 load 末尾手动 render 的那一帧。放在闭包级是为了「渲染器还在、循环却断了」
  *  时能重新点火（见 ensureRenderer）。 */
 function loop(){
  if(disposed||!renderer)return;
  frame=requestAnimationFrame(loop);
  // 兜底：个别 WebView 上 ResizeObserver 可能不吭声，低频再比对一次（约每 15 帧）。
  // resize() 自带早退，尺寸没变时只是读一次 clientWidth。
  if(!viewW||!viewH||frame%15===0)resize();
  controls.update();
  renderFrame();
 }

 /** 弹窗打开时才建渲染器：<dialog>关闭时尺寸是 0，建了也白建。 */
 function ensureRenderer(){
  // 复用渲染器（连着看多个资产）时也要保证循环是活的，并重新对齐画布尺寸
  // （窗口可能在上次预览后变过宽高，否则画布会被 CSS 拉伸、画面错位）。
  if(renderer){disposed=false;if(!frame)loop();observeStage();resize();return true;}
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
  const key=new THREE.DirectionalLight(0xffffff,1.7);key.position.set(3,5,4);lightRig.add(key);
  const fill=new THREE.DirectionalLight(0xbcd0ff,0.7);fill.position.set(-4,2,-3);lightRig.add(fill);
  const rim=new THREE.HemisphereLight(0xdfe8ff,0x2b3440,1.1);scene.add(rim);
  // w/h 来自上面 canvasSize()：画布此刻已经亮出（有真实高度），不要退回写死的 465。
  camera=new THREE.PerspectiveCamera(45,w/(h||465),0.01,2000);
  camera.position.set(1.6,1.2,1.9);
  controls=new OrbitControls(camera,canvas);
  controls.enableDamping=true;controls.dampingFactor=0.08;
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
  if(!frame)loop();   // loop 已在跑就别再点一次火，否则会叠出两条 rAF 链
  return true;
 }

 /** 把渲染 buffer 对齐到画布当前显示尺寸。尺寸没变就直接返回——它现在会被每帧的兜底检查
  *  调到，早退是必要的，否则每帧重算投影矩阵纯属浪费。 */
 function resize(){
  if(!renderer||!camera||!canvas)return;
  const {w,h}=canvasSize();
  if(!w||!h)return;
  if(w===viewW&&h===viewH)return;
  viewW=w;viewH=h;
  camera.aspect=w/h;camera.updateProjectionMatrix();
  renderer.setSize(w,h,false);
 }
const onResize=()=>resize();
window.addEventListener('resize',onResize);
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
  *  灯光 rig 转动的重绘不用管：loop() 常驻每帧 render。 */
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
  if(helpBtn&&helpPanel)helpBtn.addEventListener('click',()=>{helpPanel.hidden=!helpPanel.hidden;});
  const helpClose=helpPanel?.querySelector('[data-close]');
  if(helpClose&&helpPanel)helpClose.addEventListener('click',()=>{helpPanel.hidden=true;});
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
   if(event.target&&/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))return;
   if(event.key==='Escape'){if(helpPanel)helpPanel.hidden=true;return;}
   if(!channelAvailable||!channelTarget)return;
   if(event.key==='0'){setChannelMode('all');return;}
   const n=Number(event.key);
   if(n>=1&&n<=CHANNELS.length)setChannelMode(channelMode===CHANNELS[n-1]?'all':CHANNELS[n-1]);
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
  const btn=document.getElementById('viewer-channels-btn');
  if(btn)btn.classList.toggle('on',mode!=='off');
  const overlay=document.getElementById('viewer-channels');
  if(overlay)overlay.hidden=mode==='off'||!channelTarget;
  renderChannelLabels();
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
  if(btn)btn.hidden=!channelAvailable;
  if(!channelAvailable)setChannelMode('off');
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
  if(channelMode==='off'||!channelTarget){renderer.render(scene,camera);return;}
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
  renderer.setScissorTest(false);
  renderer.setViewport(0,0,w,h);
  camera.aspect=baseAspect;camera.updateProjectionMatrix();
  camera.position.copy(logical);
  restoreMaterials();
 }

 function applyChannel(name){
  if(!channelTarget)return;
  channelTarget.traverse(node=>{
   if(!node.isMesh)return;
   if(!originalMaterials.has(node))originalMaterials.set(node,node.material);
   node.material=channelMaterial(name,originalMaterials.get(node))||node.material;
  });
 }
 function restoreMaterials(){
  for(const [mesh,material] of originalMaterials)mesh.material=material;
  originalMaterials.clear();
 }

 /** 各通道的覆盖材质。albedo/gloss 与源材质一对一（要拿它的 map/color/roughnessMap），
  *  按源材质 uuid 缓存；normals/reflectivity/topology 与资产无关，全预览共用一份。 */
 function channelMaterial(name,src){
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
  if(!ensureRenderer())return false;
  setCaption(caption);
  setHint(hint);
  resetEnvironment();
  clearRoot();
  // 先按新尺寸对齐一次（复用渲染器时上一轮可能停在别的窗口宽度上），再刷一帧空白。
  resize();
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
  if(!prepareStage('左键旋转 · 右键缩放 · 中键平移 · 从 Poly Haven 官方 CDN 取 1K 贴图本地渲染','正在加载 Poly Haven 材质…'))return false;
  resetEnvironment();
  try{
   const files=await fetchList(assetId,'textures');
   const pick=names=>{for(const n of names){const e=files?.[n]?.['1k']?.jpg;if(e?.url)return e.url;}return null;};
   const diffUrl=pick(['Diffuse','diff']);
   if(!diffUrl)throw new Error('该资产没有 Diffuse 贴图');
   const armUrl=pick(['arm','rough_ao']);
   const norUrl=pick(['nor_gl']);
   revokeBlobs();
   const diffBlob=await toBlob(diffUrl,blobs);
   const armBlob=armUrl?await toBlob(armUrl,blobs):null;
   const norBlob=norUrl?await toBlob(norUrl,blobs):null;
   if(token!==loadToken)return false;
   clearRoot();
   setHint('');
   const loader=new THREE.TextureLoader();
   const loadTex=(blobUrl,srgb)=>new Promise((res,rej)=>loader.load(blobUrl,t=>{
     if(srgb)t.colorSpace=THREE.SRGBColorSpace;
     t.wrapS=t.wrapT=THREE.RepeatWrapping;
     t.anisotropy=renderer.capabilities.getMaxAnisotropy();
     res(t);
   },undefined,rej));
   // metalness/roughness 先给保守值：只有真挂上 ARM 图后才能放满 1，否则漫反射会被当成纯金属渲染成黑块。
   const sphereMat=new THREE.MeshStandardMaterial({roughness:0.9,metalness:0});
   sphereMat.map=await loadTex(diffBlob,true);
   if(armBlob){sphereMat.aoMap=await loadTex(armBlob);sphereMat.roughnessMap=sphereMat.aoMap;sphereMat.metalnessMap=sphereMat.aoMap;sphereMat.roughness=1;sphereMat.metalness=1;}
   if(norBlob){sphereMat.normalMap=await loadTex(norBlob);sphereMat.normalScale=new THREE.Vector2(1,1);}
   if(token!==loadToken)return false;
   // 地面用独立纹理实例：平铺份数不同（repeat 是 per-texture 的，共享会互相覆盖）。
   const groundMat=sphereMat.clone();
   for(const key of ['map','aoMap','roughnessMap','metalnessMap','normalMap']){
     const t=groundMat[key];
     if(t){const clone=t.clone();clone.repeat.set(4,4);clone.needsUpdate=true;groundMat[key]=clone;}
   }
   const sphere=new THREE.Mesh(new THREE.SphereGeometry(1.1,64,48),sphereMat);
   root.add(sphere);
   const ground=new THREE.Mesh(new THREE.CircleGeometry(8,48),groundMat);
   ground.rotation.x=-Math.PI/2;ground.position.y=-1.1;
   root.add(ground);
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
  if(!prepareStage('左键旋转 · 右键缩放 · 中键平移 · 从 Poly Haven 官方 CDN 取 1K HDR 本地渲染','正在加载 Poly Haven 环境贴图…'))return false;
  try{
   const files=await fetchList(assetId,'hdris');
   const hdrUrl=files?.hdri?.['1k']?.hdr?.url;
   if(!hdrUrl)throw new Error('该资产没有 1k HDR');
   revokeBlobs();
   const blobUrl=await toBlob(hdrUrl,blobs);
   if(token!==loadToken)return false;
   const tex=await new Promise((res,rej)=>new RGBELoader().load(blobUrl,res,undefined,rej));
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

 /** 包围盒自动取景 + 接影地面。FBX 单位常是厘米，glTF 常是米，写死距离必然忽远忽近。 */
 function frameObject(object){
  root.add(object);
  setChannelAvailable(true,object);
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
  renderer.shadowMap.enabled=true;
  object.traverse(node=>{if(node.isMesh){node.castShadow=true;node.receiveShadow=true;}});
  renderer.render(scene,camera);
 }

 async function showPackModel(manifest,token){
  const modelEntry=manifest.entries.find(e=>e.role==='model');
  if(!modelEntry)throw new Error('资源包里没有模型文件');
  revokeBlobs();
  // FBX 里写的是导出机上的绝对路径（`C:\...\Watering_Can_01_Base_color.png`），只有 basename
  // 能对上解出来的贴图。贴图请求是 loader 同步发出的，modifier 里没法 await —— 所以先全部预取
  // 成 blob 建好索引，再由 LoadingManager 按 basename 改写 URL。
  const byBase=new Map();
  for(const entry of manifest.entries.filter(e=>e.role==='texture')){
   try{byBase.set(String(entry.name||'').toLowerCase(),await toLocalBlobUrl(entry.url));}catch{}
  }
  const modelRes=await fetch(modelEntry.url,{headers:LOCAL_HEADER});
  if(!modelRes.ok)throw new Error(`模型文件取不到 HTTP ${modelRes.status}`);
  const buf=await modelRes.arrayBuffer();
  if(token!==loadToken)return false;
  clearRoot();
  setHint('');
  const manager=new THREE.LoadingManager();
  manager.setURLModifier(url=>{
   const base=String(url).split(/[\\/]/).pop().split('?')[0].toLowerCase();
   return byBase.get(base)||byBase.get(decodeURIComponent(base))||url;
  });
  let object=null;
  if(/\.fbx$/i.test(modelEntry.name)){
   object=new FBXLoader(manager).parse(buf,'');
  }else{
   const isBinary=/\.glb$/i.test(modelEntry.name);
   const source=isBinary?buf:JSON.parse(new TextDecoder().decode(buf));
   const parsed=await new Promise((resolve,reject)=>new GLTFLoader(manager).parse(source,'',g=>resolve(g),err=>reject(new Error(err?.message||'glTF 解析失败'))));
   object=parsed?.scene;
  }
  if(!object)throw new Error('模型解析结果为空');
  if(token!==loadToken){disposeObject(object);return false;}
  frameObject(object);
  return true;
 }

 /** 材质包预览：与 Poly Haven 贴图同一个舞台（球看高光法线、地面看平铺），
  *  区别只是槽位来自服务端按文件名认出来的角色，而不是官方 API 给的通道名。 */
 async function showPackTexture(manifest,token){
  revokeBlobs();
  const loader=new THREE.TextureLoader();
  const loadTex=async(entry,srgb)=>{
   if(!entry)return null;
   const url=await toLocalBlobUrl(entry.url);
   return new Promise((res,rej)=>loader.load(url,t=>{
    if(srgb)t.colorSpace=THREE.SRGBColorSpace;
    t.wrapS=t.wrapT=THREE.RepeatWrapping;
    t.anisotropy=renderer.capabilities.getMaxAnisotropy();
    res(t);
   },undefined,rej));
  };
  const role=r=>manifest.entries.find(e=>e.role===r);
  const base=await loadTex(role('base'),true);
  if(!base)throw new Error('资源包里没有基础色贴图');
  const nor=await loadTex(role('nor'));
  const rough=await loadTex(role('rough'));
  const metal=await loadTex(role('metal'));
  const ao=await loadTex(role('ao'));
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
  const groundMat=mat.clone();
  for(const key of ['map','aoMap','roughnessMap','metalnessMap','normalMap']){
   const t=groundMat[key];
   if(t){const clone=t.clone();clone.repeat.set(4,4);clone.needsUpdate=true;groundMat[key]=clone;}
  }
  const sphere=new THREE.Mesh(new THREE.SphereGeometry(1.1,64,48),mat);
  root.add(sphere);
  const ground=new THREE.Mesh(new THREE.CircleGeometry(8,48),groundMat);
  ground.rotation.x=-Math.PI/2;ground.position.y=-1.1;
  root.add(ground);
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
  let tex;
  if(/\.exr$/i.test(entry.name))throw new Error('这个天空盒是 EXR 格式，暂不支持在线预览');
  if(/\.hdr$/i.test(entry.name)){
   tex=await new Promise((res,rej)=>new RGBELoader().load(url,res,undefined,rej));
  }else{
   tex=await new Promise((res,rej)=>new THREE.TextureLoader().load(url,t=>{t.colorSpace=THREE.SRGBColorSpace;res(t);},undefined,rej));
  }
  if(token!==loadToken){tex.dispose();return false;}
  tex.mapping=THREE.EquirectangularReflectionMapping;
  showEnvironmentStage(tex);
  return true;
 }

 async function loadFreestylized(slug,type='models'){
  const token=++loadToken;
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

 function close(){
  disposed=true;loadToken++;
  revokeBlobs();
  // 释放上一帧模型/地面的 GPU 资源（灯光在 scene 上保留，渲染器也长期复用、不销毁）。
  if(root){for(const child of [...root.children]){root.remove(child);disposeObject(child);}}
  channelTarget=null;disposeChannelResources();setChannelMode('off');
  stop();
  if(canvas)canvas.hidden=true;
  const iframe=document.getElementById('viewer');
  if(iframe){iframe.hidden=false;iframe.removeAttribute('src');}
  setCaption(DEFAULT_CAPTION);
  setHint('');
  const helpPanel=document.getElementById('viewer-help');
  if(helpPanel)helpPanel.hidden=true;
 }
 function resizeIfLive(){if(ready||renderer)resize();}

 return {load,loadFreestylized,close,resize:resizeIfLive,canPreview:type=>true};
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