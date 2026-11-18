// 本地 3D 资产的真封面：Node 侧没有 WebGL，所以在前端离屏渲一帧，再把 PNG 写回服务端的
// 缩略图缓存（server/thumb-cache.mjs::saveModelThumb）。之后卡片走的就是普通 <img>，
// 第二次打开直接命中缓存、零渲染开销。
//
// 这是独立 bundle（见 build-library.mjs）：three.js 只在「模型卡片封面失败」时才下载，
// 不进 app.js 首屏。解析格式表与 gltf-preview.js::parseModelBuffer 保持一致。
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {FBXLoader} from 'three/examples/jsm/loaders/FBXLoader.js';
import {OBJLoader} from 'three/examples/jsm/loaders/OBJLoader.js';
import {STLLoader} from 'three/examples/jsm/loaders/STLLoader.js';
import {PLYLoader} from 'three/examples/jsm/loaders/PLYLoader.js';
import {ThreeMFLoader} from 'three/examples/jsm/loaders/3MFLoader.js';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {modelResourceRel} from './model-resource-path.js';

const SIZE = 512;
const MAX_MODEL_BYTES = 120 * 1024 * 1024;
const LOCAL_HEADER = {'x-sfx-local': '1'};

let renderer = null, envTexture = null, idleTimer = 0;

/** 整批卡片共用一个 WebGL 上下文（浏览器通常只给 8~16 个）。空闲 20s 后主动丢上下文，
 *  避免和一个长期开着的大图预览抢资源；下次再生成时自动重建。 */
function ensureRenderer() {
  clearTimeout(idleTimer);
  if (renderer) return renderer;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, preserveDrawingBuffer: true});
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const pmrem = new THREE.PMREMGenerator(renderer);
  envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return renderer;
}

function scheduleRelease() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!renderer) return;
    envTexture?.dispose(); envTexture = null;
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer = null;
  }, 20_000);
}

function meshFromGeometry(geometry) {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({color: 0xc9d2de, roughness: 0.62, metalness: 0.06, side: THREE.DoubleSide}));
}

/** glTF 分离文件（.bin / 贴图）要按 basename 拼到模型所在目录，走同一个本地文件接口。
 *  GLTFLoader 自己发的请求带不了自定义头，所以 /api/local/file 只按 root 白名单鉴权。 */
function localManager(root, rel,coverVersion) {
  const dir = String(rel).replace(/[\\/][^\\/]*$/, '');
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    const raw = String(url || '');
    if (/^(data:|blob:)/i.test(raw)) return raw;
    if(/\.(gltf|glb)$/i.test(rel)){
      const sibling=modelResourceRel(rel,raw);
      return `/api/local/file?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(sibling)}&v=${encodeURIComponent(coverVersion||'')}`;
    }
    const base = decodeURIComponent(raw.split(/[?]/)[0].split(/[\\/]/).pop() || '');
    if (!base) return raw;
    const sibling = dir ? `${dir}/${base}` : base;
    return `/api/local/file?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(sibling)}`;
  });
  return manager;
}

async function parseModel(buf, name, root, rel,coverVersion) {
  const manager = localManager(root, rel,coverVersion);
  if (/\.fbx$/i.test(name)) return new FBXLoader(manager).parse(buf, '');
  if (/\.(glb|gltf)$/i.test(name)) {
    const source = /\.glb$/i.test(name) ? buf : JSON.parse(new TextDecoder().decode(buf));
    const parsed = await new Promise((resolve, reject) => new GLTFLoader(manager).parse(
      source, '', g => resolve(g), err => reject(new Error(err?.message || 'glTF 解析失败'))));
    return parsed?.scene || null;
  }
  if (/\.obj$/i.test(name)) return new OBJLoader().parse(new TextDecoder().decode(buf));
  if (/\.stl$/i.test(name)) return meshFromGeometry(new STLLoader().parse(buf));
  if (/\.ply$/i.test(name)) return meshFromGeometry(new PLYLoader().parse(buf));
  if (/\.3mf$/i.test(name)) return new ThreeMFLoader(manager).parse(buf);
  throw new Error(`暂不支持 ${name || '这种模型格式'} 的封面`);
}

function disposeObject(object) {
  const seen = new Set();
  object.traverse(node => {
    if (node.geometry && !seen.has(node.geometry)) { seen.add(node.geometry); node.geometry.dispose(); }
    const mats = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const mat of mats) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      for (const value of Object.values(mat)) if (value?.isTexture && !seen.has(value)) { seen.add(value); value.dispose(); }
      mat.dispose();
    }
  });
}

/** 归一化到「包围球半径 = 1」，统一用一台固定机位相机取 3/4 视角，避免远近裁剪面被
 *  超大/超小模型或远离原点的坐标搞坏。 */
function renderOne(object) {
  const r = ensureRenderer();
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) throw new Error('模型是空的');
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 1e-4);

  const pivot = new THREE.Group();
  pivot.add(object);
  pivot.position.copy(center).multiplyScalar(-1);
  const fit = new THREE.Group();
  fit.add(pivot);
  fit.scale.setScalar(1 / radius);

  const scene = new THREE.Scene();
  scene.background = null;
  scene.environment = envTexture;
  scene.add(fit, new THREE.HemisphereLight(0xffffff, 0x364152, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(3, 5, 4); scene.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, 0.8); fill.position.set(-4, 2, -3); scene.add(fill);

  // 按 8 个包围盒角点算最小可见距离，而不是拿「包围球半径」估一个固定机位 ——
  // 后者对扁长模型会留出一大圈空白（实测天鹅封面只占画面四成）。留 6% 边距防贴边裁切。
  const fov = 38 * Math.PI / 360;
  const tan = Math.tan(fov);
  const view = new THREE.Vector3(1.15, 0.9, 1.45).normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), view).normalize();
  const up = new THREE.Vector3().crossVectors(view, right).normalize();
  const fitted = new THREE.Box3().setFromObject(fit);
  let dist = 0;
  for (const x of [fitted.min.x, fitted.max.x])
    for (const y of [fitted.min.y, fitted.max.y])
      for (const z of [fitted.min.z, fitted.max.z]) {
        const corner = new THREE.Vector3(x, y, z);
        const depth = corner.dot(view);
        dist = Math.max(dist, depth + Math.abs(corner.dot(right)) / tan, depth + Math.abs(corner.dot(up)) / tan);
      }
  dist = Math.max(dist * 1.06, 0.1);
  const camera = new THREE.PerspectiveCamera(38, 1, Math.max(dist * 0.01, 0.001), dist * 10);
  camera.position.copy(view).multiplyScalar(dist);
  camera.lookAt(0, 0, 0);
  r.render(scene, camera);
  const png = r.domElement.toDataURL('image/png');
  try { disposeObject(fit); } catch { /* 释放失败不影响已经拿到的 PNG */ }
  return png;
}

/** 浏览器这边解析不了的格式：.blend 是闭源二进制，USD 系列要先有 USD 运行时。
 *  这两类交给服务端出图（.blend 先读文件内嵌预览，读不到才上 Blender）。 */
const SERVER_COVER_EXT = /\.(blend|usd|usda|usdc|usdz)$/i;

async function generate({root, rel, width,coverVersion}) {
  const name = String(rel).split(/[\\/]/).pop();
  if (SERVER_COVER_EXT.test(name)) {
    const res = await fetch('/api/local/thumb/render', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...LOCAL_HEADER},
      body: JSON.stringify({root, rel, width}),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail?.error || `服务端封面生成失败 HTTP ${res.status}`);
    }
    return true;
  }
  const fileUrl = `/api/local/file?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`;
  const res = await fetch(fileUrl, {headers: LOCAL_HEADER,cache:'no-store'});
  if (!res.ok) throw new Error(`模型文件取不到 HTTP ${res.status}`);
  const bytes = Number(res.headers.get('content-length') || 0);
  if (bytes > MAX_MODEL_BYTES) throw new Error('模型文件过大，跳过封面');
  const buf = await res.arrayBuffer();
  const object = await parseModel(buf, name, root, rel,coverVersion);
  if (!object) throw new Error('模型解析结果为空');
  const png = renderOne(object);
  const post = await fetch('/api/local/thumb/model', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...LOCAL_HEADER},
    body: JSON.stringify({root, rel, width, png,coverVersion}),
  });
  if (!post.ok) throw new Error(`封面写入失败 HTTP ${post.status}`);
  return true;
}

// 串行队列：一屏几十张 3D 卡同时报错时只渲一个，且同一文件只渲一次。
const results = new Map();
let chain = Promise.resolve();

/** @returns {Promise<boolean>} true = 封面已写进缓存，调用方重设 img.src 即可显示。 */
export async function ensureModelThumb(target) {
  const root = String(target?.root || ''), rel = String(target?.rel || '');
  const width = Math.min(2048, Math.max(64, Number(target?.width) || 512));
  if (!root || !rel) return Promise.resolve(false);
  let coverVersion;
  if(/\.(gltf|glb)$/i.test(rel)){
    try{
      const response=await fetch(`/api/local/thumb/version?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`,{headers:LOCAL_HEADER,cache:'no-store'});
      if(!response.ok)throw Error(`glTF 依赖版本检查失败 HTTP ${response.status}`);
      coverVersion=(await response.json()).version;
      if(typeof coverVersion!=='string')throw Error('glTF 版本响应无效');
    }catch(error){console.warn('[model-thumb]',error);return false;}
  }
  const key = `${root}|${rel}|${width}|${coverVersion||''}`;
  if (results.has(key)) return results.get(key);
  const job = chain.then(() => generate({root, rel, width,coverVersion}))
    .catch(error => { console.warn('[model-thumb] 封面生成失败：', error); return false; })
    .finally(scheduleRelease);
  results.set(key, job);
  chain = job.then(() => {}, () => {});
  return job;
}
