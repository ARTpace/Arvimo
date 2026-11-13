import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {execFile} from 'node:child_process';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {blenderPath} from './blender.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const bridgeScript=path.join(here,'blender-bridge.py');
/** 桥接脚本在 Blender 那边的文件名。改它要同步改 README 和安装器里的提示文案。 */
const BRIDGE_NAME='assetvault_bridge_startup.py';
const legacyScript=path.join(here,'blender-import.py');
const EXT=/\.(glb|gltf|fbx|obj)$/i;
const HDRI_EXT=/\.(hdr|exr)$/i;
/** 世界环境能吃的格式：Poly Haven 给 .hdr/.exr，FreeStylized 天空盒给等距全景 PNG/JPG。 */
const ENV_IMAGE_EXT=/\.(hdr|exr|png|jpe?g)$/i;
const priority=file=>/\.glb$/i.test(file)?0:/\.gltf$/i.test(file)?1:/\.fbx$/i.test(file)?2:3;
export const BRIDGE_PORT=Number(process.env.SFX_BLENDER_BRIDGE_PORT||47752);
/** 探活超时：够判断「桥接是否在跑」，又不让用户干等。 */
const BRIDGE_TIMEOUT=Number(process.env.SFX_BLENDER_BRIDGE_TIMEOUT_MS||1800);
/** 导入超时：真正读模型并建场景，大模型可能十几秒，给足时间。 */
const BRIDGE_IMPORT_TIMEOUT=Number(process.env.SFX_BLENDER_BRIDGE_IMPORT_TIMEOUT_MS||120000);
/** 探活重试：Blender 刚启动时主线程忙于加载插件，timer 要等一会儿才开始跑。 */
const PING_ATTEMPTS=Number(process.env.SFX_BLENDER_BRIDGE_PING_ATTEMPTS||6);
const PING_INTERVAL_MS=Number(process.env.SFX_BLENDER_BRIDGE_PING_INTERVAL_MS||500);

function existsFile(p){try{return fs.statSync(p).isFile();}catch{return false;}}
function existsDir(p){try{return fs.statSync(p).isDirectory();}catch{return false;}}

export function findBlenderImportFile(location){
 return resolveBlenderImport(location).file;
}

/** 读取 ZIP 中央目录并逐条产出 {name, data}。只支持 Store/Deflate，
 *  带盘符或 .. 的路径直接跳过，防路径穿越。单独抽出来是因为材质 ZIP 和
 *  资源包 ZIP（Kenney / FreeStylized 的 pack.zip）用同一套读取逻辑。 */
function* zipEntries(buf){
 let eocd=-1;
 for(let i=buf.length-22;i>=0&&i>=buf.length-65557;i--){
  if(buf.readUInt32LE(i)===0x06054b50){eocd=i;break;}
 }
 if(eocd<0)throw Error('ZIP 无效：找不到目录结尾');
 const count=buf.readUInt16LE(eocd+10);
 let p=buf.readUInt32LE(eocd+16);
 for(let n=0;n<count;n++){
  if(p+46>buf.length||buf.readUInt32LE(p)!==0x02014b50)throw Error('ZIP 目录损坏');
  const method=buf.readUInt16LE(p+10),packed=buf.readUInt32LE(p+20),nl=buf.readUInt16LE(p+28),el=buf.readUInt16LE(p+30),cl=buf.readUInt16LE(p+32),offset=buf.readUInt32LE(p+42);
  const name=buf.subarray(p+46,p+46+nl).toString('utf8');
  p+=46+nl+el+cl;
  // Directory records have no file payload; parents are created by each consumer.
  if(name.endsWith('/')||/[\\:\0]/.test(name)||name.split('/').some(v=>v==='..'))continue;
  const start=offset+30+buf.readUInt16LE(offset+26)+buf.readUInt16LE(offset+28);
  const raw=buf.subarray(start,start+packed);
  const data=method===8?zlib.inflateRawSync(raw):Buffer.from(raw);
  yield {name,data};
 }
}

/** 把 ZIP 解到指定目录（不建目录、不清理），已经有同名文件就跳过。 */
function extractZipTo(zipPath,dir){
 const buf=fs.readFileSync(zipPath);
 for(const {name,data} of zipEntries(buf)){
  const target=path.resolve(dir,name);
  if(!target.startsWith(path.resolve(dir)))continue;
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if(!existsFile(target))fs.writeFileSync(target,data);
 }
 return dir;
}

/** 把整个 ZIP 解到临时目录。Blender 读不了压缩包，而资源包平台的交付目录里
 *  只有一个原始 pack.zip，真正的 glTF/FBX 在压缩包里，必须先落地。 */
function extractZip(zipPath){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sfx-pack-'));
 try{
  return extractZipTo(zipPath,dir);
 }catch(e){
  fs.rmSync(dir,{recursive:true,force:true});
  throw e;
 }
}

/** 压缩包配套的持久解包目录，落在压缩包旁边而不是系统临时目录。
 *  Blender 的 Image 数据块只记文件路径、像素是懒加载的，临时目录一删贴图整片变洋红
 *  （视口里就是「爆粉」），所以解出来的贴图/环境图必须长期留在交付物目录里。
 *  同一压缩包重复导入会复用这个目录，不重复落盘。 */
function unpackDirFor(container){
 // 旧品牌下载目录可能是 junction；在真实目录旁创建解包目录，避免旧路径 mkdir 失败。
 const src=fs.realpathSync(container);
 const target=path.join(path.dirname(src),path.basename(src).replace(/\.zip$/i,'')+'.unpacked');
 fs.mkdirSync(target,{recursive:true});
 return target;
}

/** 递归收集目录下匹配的文件，按「路径短优先」排序。 */
function collectFiles(dir,re){
 const out=[];
 const walk=d=>{
  let entries=[];
  try{entries=fs.readdirSync(d,{withFileTypes:true});}catch{return;}
  for(const entry of entries){
   const full=path.join(d,entry.name);
   if(entry.isDirectory())walk(full);
   else if(entry.isFile()&&re.test(entry.name))out.push(full);
  }
 };
 walk(dir);
 return out.sort((a,b)=>a.length-b.length||a.localeCompare(b));
}

/** Other DCCs reuse our persistent ZIP extraction, but prefer their native FBX/OBJ importers. */
export function resolveDccImport(location){
 const root=fs.realpathSync(location),stat=fs.statSync(root);
 if(stat.isFile()&&/\.(fbx|obj)$/i.test(root))return {file:root};
 let dir=root;
 if(stat.isFile()&&/\.zip$/i.test(root))dir=extractZipTo(root,unpackDirFor(root));
 else if(!stat.isDirectory())throw Error('该软件需要 FBX 或 OBJ，请重新下载 GLB + FBX 格式');
 let files=collectFiles(dir,/\.(fbx|obj)$/i);
 if(!files.length){
  const pack=findPackZip(dir);
  if(pack)dir=extractZipTo(pack,unpackDirFor(pack));
  files=collectFiles(dir,/\.(fbx|obj)$/i);
 }
 files.sort((a,b)=>Number(/\.obj$/i.test(a))-Number(/\.obj$/i.test(b))||a.length-b.length||a.localeCompare(b));
 if(!files.length)throw Error('资源中没有 FBX 或 OBJ，请选择包含 FBX 的下载格式');
 return {file:files[0]};
}

/** 在目录树里按「glb > gltf > fbx、路径短优先」挑最合适的模型文件。 */
function pickModel(root){
 const found=[];
 const walk=dir=>{
  for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   const full=path.join(dir,entry.name);
   if(entry.isDirectory())walk(full);
   else if(entry.isFile()&&EXT.test(entry.name))found.push(full);
  }
 };
 walk(root);
 found.sort((a,b)=>priority(a)-priority(b)||a.length-b.length||a.localeCompare(b));
 return found[0]||null;
}

/** 解析交付物里真正能喂给 Blender 的模型文件，返回 {file, tmpDir}。
 *  tmpDir 非 null 表示模型是从 ZIP 解出来的，调用方在导入完成后必须清理。
 *  glTF 带 .bin/贴图的相对引用在解包目录里原样保留，Blender 导入器能按相对路径找到。 */
function resolvedPackModel(file,tmp,zip){
 if(!/\.obj$/i.test(file))return {file,tmpDir:tmp};
 // OBJ materials retain relative texture paths after import; keep the unpacked payload beside its ZIP.
 const target=unpackDirFor(zip),relative=path.relative(tmp,file);
 extractZipTo(zip,target);
 fs.rmSync(tmp,{recursive:true,force:true});
 return {file:path.join(target,relative),tmpDir:null};
}

export function resolveBlenderImport(location){
 const root=path.resolve(location||'');
 const stat=fs.statSync(root);
 if(stat.isFile()){
  if(/\.zip$/i.test(root)){
   const tmp=extractZip(root);
   try{
    const file=pickModel(tmp);
    if(!file)throw Error('资源包里没有可导入 Blender 的 GLB、glTF、FBX 或 OBJ 模型');
    return resolvedPackModel(file,tmp,root);
   }catch(e){
    fs.rmSync(tmp,{recursive:true,force:true});
    throw e;
   }
  }
  if(!EXT.test(root))throw Error('Blender 只能自动导入 GLB、glTF、FBX 或 OBJ 文件');
  return {file:root,tmpDir:null};
 }
 if(!stat.isDirectory())throw Error('保存位置不是可导入的文件或文件夹');
 const loose=pickModel(root);
 if(loose)return {file:loose,tmpDir:null};
 // 文件夹里没有散置模型：这是 Kenney / FreeStylized 的资源包交付，解 pack.zip 再挑。
 const zips=fs.readdirSync(root,{withFileTypes:true})
  .filter(e=>e.isFile()&&/\.zip$/i.test(e.name))
  .map(e=>path.join(root,e.name))
  .sort((a,b)=>a.length-b.length||a.localeCompare(b));
 for(const zip of zips){
  const tmp=extractZip(zip);
  const file=(()=>{try{return pickModel(tmp);}catch{return null;}})();
  if(file)return resolvedPackModel(file,tmp,zip);
  fs.rmSync(tmp,{recursive:true,force:true});
 }
 // 有资源包却挑不出模型（FreeStylized 贴图包 / 天空盒）与真的什么都没有，要说两种话。
 if(zips.length)throw Error('资源包里没有可导入 Blender 的 GLB、glTF、FBX 或 OBJ 模型');
 throw Error('导出结果中没有可导入 Blender 的 GLB、glTF、FBX 或 OBJ 文件');
}

/* ── 材质导入 ──────────────────────────────────────────────────────────────
   材质交付物里没有网格，只有一包按 map 命名的贴图 + info.json。这里把它解析成
   {name, dir, maps:{Map:绝对路径}}；ZIP 交付先解到临时目录（Blender 只认真实路径）。 */

/** ambientCG 的 map 名 → Blender 里的目标语义。只认这些，其余贴图忽略而不是乱接。 */
const MATERIAL_SLOTS=Object.freeze({
  color:'baseColor',
  roughness:'roughness',
  metalness:'metalness',
  metallic:'metalness',
  normalgl:'normal',
  normal:'normal',
  normaldx:'normalDX',
  displacement:'displacement',
  height:'displacement',
  opacity:'alpha',
  emissive:'emission',
  emission:'emission',
  ambientocclusion:'ao',
});

/** 文件名（去掉分辨率尾缀）→ Blender 语义槽位。同时吃两类命名：
 *  - FreeStylized：wood_11_baseColor_1k.png / wood_11_normal_dx_1k.png（旧逻辑取最后一个下划线 token 会抓到 1k）；
 *  - ambientCG：Color.jpg / NormalGL.png（gl 走 Blender 默认的 OpenGL 法线，dx 才归 normalDX）。
 *  打包图（同时出现多个 map 关键词，如 ARM）不强行塞进单一槽位，返回 null。 */
function detectSlotsFromName(filename){
 const base=String(filename).replace(/\.[^.]+$/,'');
 const lower=base.replace(/[_.-]?(?:1k|2k|4k|8k)$/i,'').toLowerCase();
 const has=re=>re.test(lower);
 const color=has(/base_?color|albedo|diffuse|\bcolor\b/);
 const rough=has(/roughness/);
 const metal=has(/metal(?:ness|lic)/);
 const normal=has(/normal/);
 const disp=has(/displacement|height/);
 const ao=has(/ambient_?occlusion|\bao\b/);
 const emissive=has(/emissive|emission/);
 const alpha=has(/opacity|\balpha\b/);
 if([color,rough,metal,normal,disp,ao,emissive,alpha].filter(Boolean).length>1)return null;
 if(color)return 'baseColor';
 if(rough)return 'roughness';
 if(metal)return 'metalness';
 if(normal)return /_?dx\b|directx|d3d/i.test(lower)?'normalDX':'normal';
 if(disp)return 'displacement';
 if(ao)return 'ao';
 if(emissive)return 'emission';
 if(alpha)return 'alpha';
 return null;
}
/** 递归扫目录，把识别到的 PBR 贴图收进 maps。资源包平台（FreeStylized）的贴图常嵌套在
 *  子目录里（wood_11_1k/...），所以必须递归，只看根目录和 textures/ 会漏。 */
function scanImagesForMaps(root){
 const maps={};
 const walk=dir=>{
  let entries;
  try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const e of entries){
   const full=path.join(dir,e.name);
   if(e.isDirectory())walk(full);
   else if(e.isFile()&&/\.(jpe?g|png|tif|webp|exr|hdr)$/i.test(e.name)){
    const slot=detectSlotsFromName(e.name);
    if(slot&&!maps[slot])maps[slot]=full;
   }
  }
 };
 walk(root);
 return maps;
}
/** 交付目录里只有资源包平台那种整包 ZIP 时，挑出它解包再识别贴图 / 环境图。 */
function findPackZip(dir){
 try{
  const zips=fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&/\.zip$/i.test(e.name)).sort((a,b)=>a.name.length-b.name.length||a.name.localeCompare(b.name));
  return zips.length?path.join(dir,zips[0].name):null;
 }catch{return null;}
}
/** 从一堆图里挑等距全景图：排除立方体六面（px/nx/py/ny/pz/nz）与布局图，
 *  优先带分辨率尾缀（1k/2k/4k/8k）或顶层目录里的那张。 */
function pickEquirectImage(files){
 if(!files.length)return null;
 const faces=/[._-](?:px|nx|py|ny|pz|nz)[._-]?/i;
 const cubemap=/cubemap|skybox.*face|faces/i;
 const layout=/layout|cross|strip|pano_?layout/i;
 const drop=f=>layout.test(f)||faces.test(path.basename(f))||cubemap.test(f);
 const usable=files.filter(f=>!drop(f));
 if(!usable.length)return null;
 const withRes=usable.filter(f=>/(?:1k|2k|4k|8k)/i.test(path.basename(f)));
 const pool=withRes.length?withRes:usable;
 return pool.sort((a,b)=>a.length-b.length||a.localeCompare(b))[0];
}

function readInfo(dir){
 const file=path.join(dir,'info.json');
 if(!existsFile(file))return null;
 try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}
}

/** 目录交付：优先信 info.json 的 textures 清单（ambientcg.mjs 写的时候已带 map 名），
 *  没有清单就退回按文件名末尾的 map token 猜，与服务端同一套约定。 */
/** 目录交付：优先信 info.json 的 textures 清单（ambientcg.mjs 写的时候已带 map 名），
 *  没有清单就递归扫文件名识别，最后才退到解资源包 ZIP（FreeStylized 的贴图在 pack.zip 里）。 */
function materialFromFolder(dir){
 const info=readInfo(dir);
 const maps={};
 const listed=Array.isArray(info?.textures)?info.textures:[];
 for(const item of listed){
  const map=String(item?.map||'').trim();
  const file=String(item?.file||'').trim();
  if(!map||!file)continue;
  const slot=MATERIAL_SLOTS[map.toLowerCase()];
  if(!slot||maps[slot])continue;
  const full=path.resolve(dir,file);
  if(existsFile(full))maps[slot]=full;
 }
 if(!Object.keys(maps).length)Object.assign(maps,scanImagesForMaps(dir));
 let workDir=dir;
 if(!Object.keys(maps).length){
  const pack=findPackZip(dir);
  if(pack){
   // 贴图包解到压缩包旁的持久目录：Blender 材质只记文件路径，临时目录一删贴图就废。
   workDir=extractZipTo(pack,unpackDirFor(pack));
   Object.assign(maps,scanImagesForMaps(workDir));
  }
 }
 if(!Object.keys(maps).length)throw Error('这个材质文件夹里没有识别到可用的 PBR 贴图');
 return {name:String(info?.title||path.basename(dir)).slice(0,120),dir:workDir,maps,tmpDir:null};
}

/** ZIP 交付：Blender 不能读压缩包，所以解到压缩包旁边的持久目录再导入。
 *  只解 textures/ 下的贴图与 info.json，不做通用解包，避免路径穿越。
 *  用的是持久目录（unpackDirFor），因为 Blender 材质贴图只记住路径、像素懒加载，
 *  临时目录一删，材质球上的贴图就全丢——视口里正是用户看到的「爆粉」。 */
function materialFromZip(zip){
 const dir=unpackDirFor(zip);
 const buf=fs.readFileSync(zip);
 const wanted=/^(?:textures\/[^/]+|info\.json)$/i;
 for(const {name,data} of zipEntries(buf)){
  if(!wanted.test(name))continue;
  const target=path.resolve(dir,name);
  if(!target.startsWith(path.resolve(dir)))continue;
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if(!existsFile(target))fs.writeFileSync(target,data);
 }
 return materialFromFolder(dir);
}

/** 材质交付物 →贴图映射。ZIP 会解到压缩包旁的持久目录，导入后不清理。 */
export function findMaterialBundle(location){
 const root=path.resolve(location||'');
 const stat=fs.statSync(root);
 if(stat.isDirectory())return materialFromFolder(root);
 if(stat.isFile()&&/\.zip$/i.test(root))return materialFromZip(root);
 throw Error('材质交付物不是文件夹或 ZIP');
}

export function startupRoots(){
 const roots=[];
 if(process.env.SFX_BLENDER_STARTUP_DIR)roots.push(process.env.SFX_BLENDER_STARTUP_DIR);
 // APPDATA 在某些启动方式下会缺失，此时退回用户目录推导，否则会静默装不上。
 if(process.platform==='win32'){
  const roaming=process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming');
  if(roaming)roots.push(path.join(roaming,'Blender Foundation','Blender'));
 }else if(process.platform==='darwin'){
  roots.push(path.join(os.homedir(),'Library','Application Support','Blender'));
 }else{
  roots.push(path.join(os.homedir(),'.config','blender'));
 }
 return roots;
}

export function versionDirs(root){
 if(!root)return [];
 if(/[\\/]startup$/i.test(root))return [root];
 if(!existsDir(root))return [];
 const direct=path.join(root,'scripts','startup');
 if(existsDir(direct))return [direct];
 // 注意：这里必须用 statSync 判目录，不能用 Dirent.isDirectory()。
 // 很多人把版本配置目录做成符号链接（例如 5.0 -> J:\资产库\Blender\Presets），
 // 而 Dirent.isDirectory() 对符号链接返回 false，会静默跳过该版本。
 return fs.readdirSync(root,{withFileTypes:true})
  .filter(e=>/^\d+(?:\.\d+){0,2}$/.test(e.name))
  .filter(e=>existsDir(path.join(root,e.name)))
  .map(e=>path.join(root,e.name,'scripts','startup'));
}

function sameFile(a,b){
 try{return fs.readFileSync(a,'utf8')===fs.readFileSync(b,'utf8');}catch{return false;}
}

/** 往一个 startup 目录装脚本；返回 target 与是否真的重写了。
 *  单独抽出来是因为「进度任务」要按目录逐个报进度，而 ensure* 只需要结果。 */
function installBridgeInto(startup){
 fs.mkdirSync(startup,{recursive:true});
 const target=path.join(startup,BRIDGE_NAME);
 const changed=!sameFile(bridgeScript,target);
 if(changed)fs.copyFileSync(bridgeScript,target);
 return {target,changed};
}

export function ensureBlenderBridgeInstalled(){
 if(!existsFile(bridgeScript))return {installed:false,locations:[],error:'缺少 Blender 桥接脚本：'+bridgeScript};
 const locations=[],errors=[];
 for(const root of startupRoots()){
  for(const startup of versionDirs(root)){
   try{
    locations.push(installBridgeInto(startup).target);
   }catch(e){errors.push(`${startup}: ${e.message}`);}
  }
 }
 return {installed:locations.length>0,locations,errors};
}

function fileText(file){try{return fs.readFileSync(file,'utf8');}catch{return null;}}

/** 版本号从 `<配置>/<版本>/scripts/startup` 里取，取不到就报 startup 目录名。 */
function versionLabel(startup){
 const version=path.basename(path.dirname(path.dirname(startup)));
 return version&&version!=='Blender'?version:'Blender';
}

/** 交给界面用的桥接现状：脚本装到哪些版本目录。
 *  `blenderRunning` 需要拉一次 tasklist，所以是异步的，由调用方 await；
 *  端口在线探测也是异步的（见 probeBridge），同样不在这里做。 */
export async function blenderBridgeStatus(){
 const source=fileText(bridgeScript);
 const targets=[];
 for(const root of startupRoots()){
  for(const startup of versionDirs(root)){
   const target=path.join(startup,BRIDGE_NAME);
   const current=fileText(target);
   targets.push({
    path:target,
    version:versionLabel(startup),
    state:current===null?'missing':(current===source?'current':'stale'),
   });
  }
 }
 return {
  port:BRIDGE_PORT,
  source:bridgeScript,
  sourceReady:source!==null,
  targets,
  // 必须 await：漏掉的话这里会塞一个 Promise 进JSON，界面上「Blender 是否运行」永远拿不到值。
  blenderRunning:await blenderProcessRunning(),
 };
}

/** ── 安装进度 ────────────────────────────────────────────────────────────
 * 手动点「安装 / 更新」时界面得看得见在做什么。真实安装只有几毫秒，所以这里做两件事：
 *   1. 拆成有真实依据的阶段：读源文件 → 枚举版本目录 → 逐个写入 → 回读校验 → 探活端口；
 *   2. 阶段之间让出事件循环并停留一小会儿，否则进度条一闪而过，用户会以为没反应。
 * 阶段的名称、明细、成败全部来自真实执行结果，不编造进度。
 */
const INSTALL_PACING_MS=Number(process.env.SFX_BLENDER_BRIDGE_INSTALL_PACING_MS||260);
const INSTALL_JOB_TTL=10*60*1000;
const INSTALL_STEPS=[
 {key:'source',label:'读取桥接脚本',weight:6},
 {key:'scan',label:'查找 Blender 版本目录',weight:10},
 {key:'write',label:'写入启动脚本',weight:52},
 {key:'verify',label:'校验写入结果',weight:14},
 {key:'probe',label:'测试桥接端口',weight:18},
];
const installJobs=new Map();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function stepPercent(job){
 if(job.state!=='running')return 100;
 let percent=0;
 for(const step of job.steps){
  if(step.state==='done'||step.state==='error')percent+=step.weight;
  // 写入阶段按目录数折算真实比例；其余进行中的阶段只给一点前导值，免得进度条卡在 0。
  else if(step.state==='active')percent+=step.weight*(step.total?step.current/step.total:0.25);
 }
 return Math.min(99,Math.round(percent));
}

export function bridgeInstallJob(id){return installJobs.get(id)||null;}

/** 起一个安装任务，立刻返回 id；调用方轮询 bridgeInstallJob 读进度。 */
export function startBridgeInstallJob(){
 for(const [id,job] of installJobs)if(Date.now()-(job.endedAt||job.startedAt)>INSTALL_JOB_TTL)installJobs.delete(id);
 const job={
  id:randomUUID(),
  state:'running',
  percent:0,
  message:'正在安装桥接脚本…',
  error:null,
  steps:INSTALL_STEPS.map(s=>({...s,state:'pending',detail:null,notes:[],current:0,total:0})),
  status:null,
  startedAt:Date.now(),
  endedAt:null,
 };
 installJobs.set(job.id,job);
 runBridgeInstallJob(job);
 return job.id;
}

/** 收尾：把结果和一份新的桥接状态一起挂到任务上，界面据此渲染成功 / 失败 / 部分失败。 */
async function settleInstallJob(job,{locations,errors,online,reason}){
 const status=await blenderBridgeStatus();
 const ok=!reason&&locations.length>0;
 let message=reason;
 let error=reason;
 if(!reason&&errors.length&&!locations.length){
  // 有目录但一个都没写进去：要说清是「写不进去」，不能笼统说成「找不到 Blender」。
  message='所有 Blender 版本目录都写入失败';
  error=errors[0];
 }else if(!reason&&!locations.length){
  message='没有找到可安装的 Blender 配置目录';
  error='这台电脑还没装过 Blender，或装了但从未启动过：找不到 <APPDATA>\\Blender Foundation\\Blender\\<版本>\\scripts\\startup。先打开一次 Blender，再点安装。';
 }else if(!reason&&errors.length){
  message=`已写入 ${locations.length} 个版本，另有 ${errors.length} 处失败`;
  error=errors[0];
 }else if(!reason){
  message=online?`已同步 ${locations.length} 个 Blender 版本；当前连接不受影响`
   :status.blenderRunning?`已安装到 ${locations.length} 个 Blender 版本；重启 Blender 后生效`
   :`已安装到 ${locations.length} 个 Blender 版本，打开 Blender 即可使用`;
 }
 job.state=!ok?(locations.length?'partial':'failed'):'ok';
 job.message=message;
 job.error=ok&&!errors.length?null:error;
 job.status={ok,written:locations,errors,...status,bridgeOnline:status.sourceReady?online:false};
 job.endedAt=Date.now();
 job.percent=100;
 return job;
}

async function runBridgeInstallJob(job){
 const get=key=>job.steps.find(s=>s.key===key);
 const settle=(key,state,detail)=>{const s=get(key);s.state=state;if(detail!==undefined)s.detail=detail;job.percent=stepPercent(job);};
 const begin=async key=>{const s=get(key);s.state='active';s.detail=null;job.percent=stepPercent(job);await pause(INSTALL_PACING_MS);};
 const out={locations:[],errors:[],online:false,reason:null};
 try{
  await begin('source');
  if(!existsFile(bridgeScript)){
   settle('source','error','源脚本不存在');
   out.reason='缺少 Blender 桥接脚本：'+bridgeScript+'（安装包不完整，请重新获取这一份工具）';
   return await settleInstallJob(job,out);
  }
  settle('source','done',`${path.basename(bridgeScript)} · ${(fs.statSync(bridgeScript).size/1024).toFixed(1)} KB`);

  await begin('scan');
  const startups=[];
  for(const root of startupRoots())for(const startup of versionDirs(root))startups.push(startup);
  settle('scan',startups.length?'done':'error',startups.length?`找到 ${startups.length} 个版本目录`:'没有找到任何 Blender 版本目录');
  if(!startups.length)return await settleInstallJob(job,out);

  const write=get('write');
  write.total=startups.length;
  await begin('write');
  for(const startup of startups){
   const label=versionLabel(startup);
   try{
    const {target,changed}=installBridgeInto(startup);
    out.locations.push(target);
    write.notes.push(`${label} · ${changed?'已写入':'已是最新'} → ${target}`);
   }catch(e){
    out.errors.push(`${startup}: ${e.message}`);
    write.notes.push(`${label} · 写入失败：${e.message}`);
   }
   write.current+=1;
   write.detail=`${write.current}/${write.total} 个版本目录`;
   job.percent=stepPercent(job);
   if(write.current<write.total)await pause(INSTALL_PACING_MS);
  }
  const failed=out.errors.length&&!out.locations.length;
  settle('write',out.errors.length?'error':'done',failed?`${out.errors.length} 处写入失败：${out.errors[0]}`:`${out.locations.length}/${write.total} 个目录已写入`);

  await begin('verify');
  const broken=out.locations.filter(file=>!sameFile(bridgeScript,file));
  if(!out.locations.length)settle('verify','pending','没有写入成功的文件，跳过校验');
  else settle('verify',broken.length?'error':'done',broken.length?`${broken.length} 个文件回读不一致`:`${out.locations.length} 个文件内容一致`);

  await begin('probe');
  out.online=await probeBridge({port:BRIDGE_PORT});
  settle('probe','done',out.online?'端口已应答':`端口 ${BRIDGE_PORT} 无应答（Blender 未启动或需要重启）`);
 }catch(e){
  out.reason=String(e.message||e);
 }
 return await settleInstallJob(job,out);
}

/** 真发一次 ping 才算在线：端口在监听但 Blender 主线程忙（还在加载插件）时不该算通，
 *  否则界面会显示「已连接」而点击导入却超时。 */
export function probeBridge({port=BRIDGE_PORT,timeout=1200}={}){
 return new Promise(resolve=>{
  let settled=false;
  const socket=createConnection({host:'127.0.0.1',port});
  const finish=ok=>{if(settled)return;settled=true;try{socket.destroy();}catch{}resolve(ok);};
  socket.setEncoding('utf8');
  socket.setTimeout(timeout,()=>finish(false));
  socket.on('error',()=>finish(false));
  socket.on('connect',()=>socket.write('{"op":"ping"}\n'));
  socket.on('data',chunk=>{if(String(chunk).includes('\n'))finish(true);});
 });
}

/** Blender 是否开着。同样用异步 execFile —— 同步版在这台机器上一律 EBUSY。 */
export function blenderProcessRunning(){
 const [bin,args]=process.platform==='win32'
  ?['tasklist.exe',['/FI','IMAGENAME eq blender.exe','/NH']]
  :['pgrep',['-x','blender']];
 return new Promise(resolve=>{
  execFile(bin,args,{encoding:'utf8',timeout:1500,windowsHide:true},(err,out)=>{
   if(err)return resolve(false);
   resolve(process.platform==='win32'?/blender\.exe/i.test(out):/\d+/.test(out));
  });
 });
}

/** 发一次桥接请求并等它回话。
 *
 *  这里刻意在**当前进程内**直接开 socket，而不是 execFileSync 再拉一个 node 子进程。
 *  原因有二：一是同步派生子进程在部分 Windows 环境下会直接抛 EBUSY（连 cmd.exe 都一样），
 *  整条链路就被打断成「Blender 没响应」；二是子进程冷启动要几十到上百毫秒，导入大贴图时
 *  纯属浪费。Blender 桥接只有一行 JSON 往返，异步 socket 三十毫秒内就回来了。
 *
 *  失败时抛 Error 并挂上 bridgeCode，让 waitForBridge 还能区分「没人监听」和「主线程忙」。
 */
function bridgeRequest(payload,{port=BRIDGE_PORT,timeout=BRIDGE_TIMEOUT}={}){
 return new Promise((resolve,reject)=>{
  let settled=false,data='';
  const finish=(fn,value)=>{if(settled)return;settled=true;try{socket.destroy();}catch{}fn(value);};
  const socket=createConnection({host:'127.0.0.1',port},()=>socket.write(JSON.stringify(payload)+'\n'));
  socket.setEncoding('utf8');
  socket.setTimeout(timeout,()=>finish(reject,bridgeError('TIMEOUT','等待已打开的 Blender 响应超时')));
  socket.on('error',err=>finish(reject,bridgeError(err.code==='ECONNREFUSED'?'ECONNREFUSED':(err.code||'ERROR'),err.code==='ECONNREFUSED'?'未发现正在监听的 Arvimo Blender Bridge':err.message)));
  socket.on('close',()=>finish(reject,bridgeError('CLOSED','Blender 桥接连接已关闭')));
  socket.on('data',chunk=>{
   data+=chunk;
   const idx=data.indexOf('\n');
   if(idx<0)return;
   let result;
   try{result=JSON.parse(data.slice(0,idx));}
   catch(e){return finish(reject,bridgeError('BAD_RESPONSE','Blender 桥接返回了无效响应：'+e.message));}
   if(!result.ok)return finish(reject,bridgeError(result.code||null,result.error||'Blender 桥接导入失败'));
   finish(resolve,result);
  });
 });
}

function bridgeError(code,message){
 const err=Error(message);
 err.bridgeCode=code;
 return err;
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** 探活，并区分两种失败：
 *  - `no-listener`：端口没人监听，桥接根本没在跑（重试无意义，立刻报错）
 *  - `busy`：连得上但不回话，说明 Blender 主线程被占住（刚启动要加载全部插件，
 *    或在做长任务），这时候值得多等一会儿 —— 刚开机的 Blender 往往要十几秒才轮到 timer。
 */
async function waitForBridge({attempts=PING_ATTEMPTS,intervalMs=PING_INTERVAL_MS,timeout=BRIDGE_TIMEOUT}={}){
 let last=null;
 for(let i=0;i<attempts;i++){
  try{
   await bridgeRequest({op:'ping'},{timeout});
   return {online:true,tries:i+1};
  }catch(e){
   last=e;
   if(e.bridgeCode==='ECONNREFUSED')return {online:false,reason:'no-listener',error:e,tries:i+1};
   if(i<attempts-1)await sleep(intervalMs);
  }
 }
 return {online:false,reason:'busy',error:last,tries:attempts};
}

function bridgeHint(install,running){
 const parts=[];
 if(running)parts.push('检测到 Blender 已经打开，但当前实例还没有启用 Arvimo Bridge。');
 else parts.push('未连接到已打开并启用 Arvimo Bridge 的 Blender。');
 if(install.installed)parts.push('已把桥接启动脚本安装到 Blender 配置目录；请重启/重新打开 Blender 一次，然后重新点击“Blender”。');
 else parts.push('没有找到可安装的 Blender 用户配置目录；请先打开一次 Blender，或把 '+bridgeScript+' 放到 Blender 的 scripts/startup 目录。');
 if(install.errors?.length)parts.push('安装提示：'+install.errors.slice(0,2).join('；'));
 parts.push('为避免打开新窗口，AssetVault 现在不会再启动新的 Blender 进程。');
 return parts.join('');
}

/** Imports into the current scene of an already-open Blender instance via Arvimo Bridge. */
export async function launchBlenderImport(location,{blender=blenderPath}={}){
 const asset=resolveBlenderImport(location);
 try{
  await prepareBridge(blender);

  try{
   // 导入单独给长超时：大模型建场景可能要十几秒，不能沿用探活那 1.8 秒。
   const result=await bridgeRequest({op:'import',file:asset.file,frame:true},{timeout:BRIDGE_IMPORT_TIMEOUT});
   return {ok:true,mode:'existing-blender',bridgePort:BRIDGE_PORT,file:asset.file,imported:result.imported??null,receivedAt:Date.now()};
  }catch(e){
   if(/\.obj$/i.test(asset.file)&&/Unsupported model format/i.test(e.message))throw Error('Blender 当前加载的是旧版桥接。新版 OBJ 支持已安装，请保存场景并重启 Blender 后重新发送。');
   throw Error(`已连上 Blender，但导入失败：${e.message}`);
  }
 }finally{
  // 模型是从 pack.zip 解出来的情况：桥接应答成功即代表 Blender 已读入文件，
  // 失败也代表这次导入不会发生，两种结局临时目录都不再需要。
  if(asset.tmpDir)fs.rmSync(asset.tmpDir,{recursive:true,force:true});
 }
}

/** 把「已装桥接 + 探活 + 报错提示」这套流程抽出来：模型导入和材质导入共用同一段前置，
 *  区别只在最后发什么 op、期望什么返回。 */
async function prepareBridge(blender){
 if(!existsFile(bridgeScript))throw Error('缺少 Blender 桥接脚本：'+bridgeScript);
 const install=ensureBlenderBridgeInstalled();
 const ping=await waitForBridge();
 if(ping.online)return;
 if(ping.reason==='busy'){
  throw Error('已经连上 Blender 里的 Arvimo Bridge，但它一直没有响应：Blender 可能仍在启动（正在加载插件/场景），或正在执行其它耗时操作。请等几秒后重新点击“Blender”。');
 }
 const executable=blender?.();
 const hasExecutable=!!executable&&existsFile(executable);
 const running=await blenderProcessRunning();
 const suffix=hasExecutable?'':'未找到 Blender：请安装 Blender，或设置 SFX_BLENDER 指向 blender.exe。';
 const error=bridgeHint(install,running)+(suffix?(' '+suffix):'');
 throw Error(`${error}（连接详情：${String(ping.error?.message||'')}）`);
}

/** 材质导入：在已打开的 Blender 里建一个接好贴图的材质球。
 *  ZIP 交付解到压缩包旁的持久目录，贴图路径长期有效，导入后不做清理。 */
export async function launchBlenderMaterialImport(location,{blender=blenderPath}={}){
 const bundle=findMaterialBundle(location);
 await prepareBridge(blender);
 const result=await bridgeRequest({op:'material',name:bundle.name,maps:bundle.maps,preview:true,assignSelection:true},{timeout:BRIDGE_IMPORT_TIMEOUT});
 return {ok:true,mode:'existing-blender',kind:'material',bridgePort:BRIDGE_PORT,name:bundle.name,dir:bundle.dir,maps:Object.keys(bundle.maps),material:result.material??null,applied:result.applied??null,receivedAt:Date.now()};
}

/** HDRI 交付物 → 环境贴图文件路径。贴图一律落在持久位置（解包时也不会产生临时目录），
 *  tmpDir 恒为 null，只为兼容老调用方签名。 */
export function findHdriFile(location){
 const root=fs.realpathSync(path.resolve(location||''));
 const stat=fs.statSync(root);
 if(stat.isFile()&&HDRI_EXT.test(root))return {file:root,tmpDir:null};
 if(stat.isFile()&&ENV_IMAGE_EXT.test(root))return {file:root,tmpDir:null};
 if(!stat.isDirectory())throw Error('HDRI 交付物不是文件夹或 .hdr/.exr 文件');
 const info=readInfo(root);
 const listed=Array.isArray(info?.files)?info.files:[];
 for(const item of listed){
  const file=String(item?.file||'').trim();
  if(!file||!HDRI_EXT.test(file))continue;
  const full=path.resolve(root,file);
  if(existsFile(full))return {file:full,tmpDir:null};
 }
 // 目录里散着的 .hdr/.exr（含上面解出来的 .unpacked 子目录）都算，路径短的优先。
 const loose=collectFiles(root,HDRI_EXT);
 if(loose.length)return {file:loose[0],tmpDir:null};
 // 交付目录里只有一个整包 ZIP（ambientCG / FreeStylized 天空盒）：解到压缩包旁边的
 // 持久目录再挑图。绝不能解到 os.tmpdir 再删，Blender 那边贴图会直接失效变洋红。
 const pack=findPackZip(root);
 if(pack){
  const dir=unpackDirFor(pack);
  const entries=zipEntries(fs.readFileSync(pack));
  const hdri=entries.filter(e=>HDRI_EXT.test(e.name));
  const images=hdri.length?hdri:entries.filter(e=>ENV_IMAGE_EXT.test(e.name));
  for(const {name,data} of images){
   const target=path.resolve(dir,name);
   if(!target.startsWith(path.resolve(dir)))continue;
   fs.mkdirSync(path.dirname(target),{recursive:true});
   if(!existsFile(target))fs.writeFileSync(target,data);
  }
  // 真 HDRI（.hdr/.exr）优先，别把 TONEMAPPED 的 LDR 全景图当环境图喂给 Blender。
  const wide=collectFiles(dir,HDRI_EXT);
  if(wide.length)return {file:wide[0],tmpDir:null};
  const equirect=pickEquirectImage(collectFiles(dir,ENV_IMAGE_EXT));
  if(equirect)return {file:equirect,tmpDir:null};
 }
 throw Error('这个文件夹里没有可用于世界环境的 .hdr/.exr 或等距全景图（.png/.jpg）');
}

/** 把已下载的 HDRI / 天空盒设为已打开 Blender 场景的世界环境。
 *  环境图始终落在持久位置（交付目录或旁边的 .unpacked），导入后不清理。 */
export async function launchBlenderHdriImport(location,{blender=blenderPath}={}){
 const {file}=findHdriFile(location);
 try{
  await prepareBridge(blender);
  const result=await bridgeRequest({op:'environment',file},{timeout:BRIDGE_IMPORT_TIMEOUT});
  return {ok:true,mode:'existing-blender',kind:'hdri',bridgePort:BRIDGE_PORT,file,world:result.world??null,image:result.image??null,receivedAt:Date.now()};
 }catch(e){
  throw Error(`已连上 Blender，但设置环境贴图失败：${e.message}`);
 }
}

export const blenderImportScript=legacyScript;
export const blenderBridgeScript=bridgeScript;
