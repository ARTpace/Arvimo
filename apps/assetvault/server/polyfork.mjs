// Polyfork 是一个「AI 原生」资产库：每个模型本质是一段程序（.mjs），改参数重建几何，
// 低模全站免费。它给了正经 REST 接口，所以这里不打网页、不解析 DOM —— 这是本仓库里
// 第一个完全走官方 JSON 的模型源，别照 Poly Pizza 那套去抓 HTML。
//
// 浏览与下载都不需要 key：/api/* 匿名可读，/cdn/{id}.glb 与 /dl/{id}.fbx 匿名可下。
// key 只解锁「已有 HD 版」和 .mjs 源码 / 打包 zip，本模块不碰。
//
// 配额只算「生成新变体」（remix bake），浏览搜索下载都不消耗，所以不用担心刷搜索把额度烧掉。
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {openPublic} from './public-http.mjs';

const SITE='https://polyfork.dev';
const PER_PAGE=32;

/** 它的官方分类，值就是 API 的 `class` 参数；中文只是卡片与下拉的显示文案。 */
export const POLYFORK_CLASSES=[
 {value:'prop',label:'道具'},
 {value:'building',label:'建筑'},
 {value:'vehicle',label:'载具'},
 {value:'character',label:'角色'},
 {value:'animal',label:'动物'},
 {value:'attachment',label:'附件与装饰'},
 {value:'terrain',label:'地形'},
 {value:'hand',label:'手持物'},
 {value:'ultra',label:'超低模'},
];
const CLASS_VALUES=new Set(POLYFORK_CLASSES.map(item=>item.value));

/** 稳定 uid：服务端 uidPattern 只认 32 位十六进制，和 Poly Pizza 同一套做法。 */
export function polyforkUid(id){
 return createHash('md5').update(`polyfork:${String(id||'')}`).digest('hex');
}
export const polyforkClassLabel=value=>POLYFORK_CLASSES.find(item=>item.value===value)?.label||'';

/** 许可只有一份，全站低模都一样；写进卡片省得每条去详情取。 */
const LICENSE='商用免署名 · 禁止再分发文件';
const AUTHOR='Polyfork';

function cardOf(asset){
 const id=String(asset?.id||'').trim();
 if(!id)return null;
 const hd=asset?.hd&&typeof asset.hd==='object'?asset.hd:null;
 return {
  uid:polyforkUid(id),
  platform:'polyfork',
  assetId:id,
  name:String(asset.title||id).slice(0,240),
  author:AUTHOR,
  thumbnail:typeof asset.thumbnail==='string'&&asset.thumbnail.startsWith('https://')?asset.thumbnail:'',
  url:String(asset.page||`${SITE}/asset/${id}`),
  license:LICENSE,
  downloadable:true,
  faces:Number.isFinite(Number(asset.triangles))?Number(asset.triangles):null,
  vertices:null,
  likes:0,
  views:0,
  animations:asset.has_rig?1:0,
  // 以下字段本仓库其他源没有，是 Polyfork 的特色，卡片与筛选直接读：
  assetClass:CLASS_VALUES.has(asset.class)?asset.class:'',
  hasRig:asset.has_rig===true,
  remixable:asset.remixable===true,
  hasHd:Boolean(hd),
  kit:String(asset.kit||''),
 };
}

async function readText(r){
 const chunks=[];
 for await(const chunk of r.stream)chunks.push(chunk);
 return Buffer.concat(chunks).toString('utf8');
}

/**
 * 关键词检索。q 在官方那边是「分词打分」，不是精确包含：搜不到时它**不会**报错，
 * 只会给一批低分近邻，所以 total 为 0 才写警告，有结果就老实展示。
 */
export async function polyforkSearch(input={},{signal,open=openPublic}={}){
 signal?.throwIfAborted();
 const cursor=input.cursor?(typeof input.cursor==='string'?JSON.parse(input.cursor):input.cursor):{};
 const q=String(cursor.q??input.q??'').trim().slice(0,80);
 const page=Math.max(1,Number(cursor.page??input.page)||1);
 const rawClass=String(cursor.assetClass??input.assetClass??'').trim();
 const assetClass=CLASS_VALUES.has(rawClass)?rawClass:'';
 // tris = 面数从少到多，适合「先挑最省的道具」；其余走官方默认相关性 / 最新。
 const sort=String(cursor.sort??input.sort??'')==='tris'?'tris':'';

 const params=new URLSearchParams();
 if(q)params.set('q',q);
 if(assetClass)params.set('class',assetClass);
 if(sort)params.set('sort',sort);
 // 无关键词的浏览态按最新排，避免每次进来都是同一批。有 q 时交给官方相关性。
 if(!q&&!sort)params.set('sort','latest');
 params.set('page',String(page));
 params.set('per_page',String(PER_PAGE));

 const r=await open(`${SITE}/api/assets?${params}`,{signal,timeout:45000});
 if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`Polyfork 搜索返回 HTTP ${r.status}`);}
 let data=null;
 try{data=JSON.parse(await readText(r));}catch{throw Error('Polyfork 搜索返回的不是 JSON');}
 const rows=Array.isArray(data?.assets)?data.assets:[];
 const models=rows.map(cardOf).filter(Boolean);
 const total=Number(data?.total)||models.length;
 const hasMore=models.length>0&&page*PER_PAGE<total;
 return {
  models,received:models.length,total,page,
  next:hasMore?JSON.stringify({q,page:page+1,assetClass,sort}):null,
  pending:[],
  source:'Polyfork',
  warnings:models.length?[]:[`Polyfork 上没有匹配 “${q||'当前筛选'}” 的低模${assetClass?`（分类：${polyforkClassLabel(assetClass)}）`:''}`],
  query:q,
 };
}

/** 侧栏分类：固定 9 个 class，官方不提供计数，所以只给值不编数字。 */
export async function polyforkCategories(){
 return {categories:POLYFORK_CLASSES.map(item=>({value:item.value,label:item.label}))};
}

function wantsFbx(requested){
 return String(requested||'').toLowerCase()==='fbx';
}

/**
 * 下载任务。和其他源最大的不同：**不需要任何本地转换**。
 * glb 走 /cdn 静态文件，fbx 是它服务端转好的（顶点色已烘焙成具名材质，正好是 Unity 想要的）。
 *
 * GLB 永远要下一份：队列的内容校验认的就是 GLB 网格，预览、Blender 桥、资产库也都靠它。
 * 用户要 FBX 时再额外取一份同一个快照的 fbx 放进同一目录 —— 两者来自同一套参数，
 * 不会出现「预览是一个样、进 Unity 是另一个样」。
 */
export async function runPolyforkJob({uid,output,assetId,options={}},{signal,progress=()=>{},open=openPublic}={}){
 signal?.throwIfAborted();
 const id=String(assetId||'').trim();
 if(!id)throw Error('Polyfork 资产 ID 缺失');
 await fs.mkdir(output,{recursive:true});
 progress({stage:'starting',message:`正在读取 Polyfork 资产信息（${id}）…`});

 const detail=await open(`${SITE}/api/assets/${encodeURIComponent(id)}`,{signal,timeout:45000});
 if(detail.status<200||detail.status>=300){try{detail.stream.destroy();}catch{}throw Error(`Polyfork 资产信息返回 HTTP ${detail.status}`);}
 let meta=null;
 try{meta=JSON.parse(await readText(detail));}catch{throw Error('Polyfork 资产信息不是 JSON');}

 const glbUrl=typeof meta?.download?.glb==='string'?meta.download.glb:`${SITE}/cdn/${id}.glb`;
 const fbxUrl=typeof meta?.export_formats?.fbx?.url==='string'?meta.export_formats.fbx.url:`${SITE}/dl/${id}.fbx`;
 const files=[['glb',glbUrl]];
 if(wantsFbx(options?.format))files.push(['fbx',fbxUrl]);

 const written=[];
 for(const [format,url] of files){
  progress({stage:'transferring',message:`正在下载 ${format.toUpperCase()}…`});
  const file=await open(url,{signal,timeout:180000});
  if(file.status<200||file.status>=300){try{file.stream.destroy();}catch{}throw Error(`${format.toUpperCase()} 下载失败 HTTP ${file.status}`);}
  const dest=path.join(output,`model.${format}`);
  const fd=await fs.open(dest,'w');
  let bytes=0;
  try{
   for await(const chunk of file.stream){signal?.throwIfAborted();await fd.write(chunk);bytes+=chunk.length;}
  }finally{await fd.close();}
  if(!bytes)throw Error(`Polyfork 返回的 ${format.toUpperCase()} 是空文件`);
  written.push({format,bytes});
  if(format==='glb')progress({stage:'transferring',message:files.length>1?'GLB 已就位，接着取 FBX…':'GLB 已就位…'});
 }

 const record={
  uid,platform:'polyfork',assetId:id,
  name:String(meta?.title||id).slice(0,240),
  url:String(meta?.page||`${SITE}/asset/${id}`),
  format:wantsFbx(options?.format)?'glb+fbx':'glb',
  formats:written.map(item=>item.format),
  assetClass:String(meta?.class||''),
  triangles:Number.isFinite(Number(meta?.triangles))?Number(meta.triangles):null,
  kit:String(meta?.kit||''),
  sizeM:meta?.size_m||null,
  originY:Number.isFinite(Number(meta?.origin_y))?Number(meta.origin_y):0,
  license:String(meta?.license||LICENSE),
  exports:Object.keys(meta?.export_formats||{}),
  exportedAt:new Date().toISOString(),
  tool:'Arvimo · Polyfork',
  note:'Polyfork 低模，商用免署名，禁止把文件本身再分发。它是程序化资产：几何由参数生成，这份文件是其中一档参数的快照。GLB 与 FBX 取自同一档参数。',
 };
 await fs.writeFile(path.join(output,'info.json'),JSON.stringify(record,null,2),'utf8');
 return {zipName:`${String(meta?.title||id).replace(/[^\w.-]/g,'_').slice(0,80)}.zip`};
}

/* ── 参数化（remixable）──────────────────────────────────────────────────────
 * 2600 多个资产是「程序」而不是网格：-params.json 给出旋钮清单。要分清两类旋钮，
 * 因为它们的代价差三个数量级：
 *   color  颜色  → GLB 里存的是顶点色（COLOR_0，线性空间）。浏览器就地改写即可，
 *                  零请求、零配额、拖动是实时的。注意 remix 出来的文件颜色**永远是默认涂装**，
 *                  官方说明也写了「colour-only variant is applied at runtime」。
 *   geometry 几何 → 必须在服务端重新生成（/cdn/{id}-remix.glb?p=...），耗时几秒，
 *                  且匿名调用有 40 次/小时的烘焙额度。
 * 所以这里把 schema 归一化时就把两者标出来，前端不会误把颜色改动送去烘焙。
 */
const PARAM_GROUPS=new Set(['color','choice','range','toggle']);
const HEX_RE=/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function paramKind(spec,key,presets){
 const type=String(spec?.type||'').toLowerCase();
 // 官方只在几何旋钮上标 affects:'geometry'，颜色旋钮没有这个键 —— 有就照它走。
 if(spec?.affects==='geometry')return 'geometry';
 if(type==='range'||type==='toggle')return 'geometry';
 if(type==='color')return 'color';
 // choice 没有 affects：成套配色（colorway）的每个选项都在 presets 里（presets 的键是预设名，
 // 不是参数名 —— 别拿 key 去查）；或是纯色列表；其余（例如风帆数 4/5）改的是网格。
 if(type==='choice'){
  const options=Array.isArray(spec.options)?spec.options.map(String):[];
  if(options.length&&options.every(value=>presets[value]))return 'preset';
  return options.length&&options.every(value=>HEX_RE.test(value))?'color':'geometry';
 }
 return 'geometry';
}

export function polyforkVariantUrl(assetId,params){
 const id=String(assetId||'').trim();
 if(!id)throw Error('Polyfork 资产 ID 缺失');
 const clean={};
 for(const [key,value] of Object.entries(params||{})){
  if(value===undefined||value===null||value==='')continue;
  clean[key]=value;
 }
 const query=Object.keys(clean).length?`?p=${encodeURIComponent(JSON.stringify(clean))}`:'';
 return `${SITE}/cdn/${encodeURIComponent(id)}-remix.glb${query}`;
}

/** 把 -params.json 归一化成前端能直接渲染的形状。抽成纯函数是为了能脱网回归：
 *  颜色/几何分错类的后果不是显示错，而是「拖一下滑杆就烧掉一次烘焙额度」。 */
export function normalizePolyforkParams(raw){
 const presets=raw?.presets&&typeof raw.presets==='object'&&!Array.isArray(raw.presets)?raw.presets:{};
 const params=[];
 for(const [key,spec] of Object.entries(raw?.params||{})){
  if(!spec||typeof spec!=='object')continue;
  const type=String(spec.type||'').toLowerCase();
  if(!PARAM_GROUPS.has(type))continue;
  const kind=paramKind(spec,key,presets);
  const row={
   key,type,kind,
   label:String(spec.label||key).slice(0,80),
   describe:String(spec.describe||'').slice(0,600),
   icon:typeof spec.icon==='string'?spec.icon.slice(0,4):'',
   default:spec.default,
   options:Array.isArray(spec.options)?spec.options.map(String).slice(0,40):[],
  };
  if(type==='range'){
   const min=Number(spec.min),max=Number(spec.max);
   row.min=Number.isFinite(min)?min:0;
   row.max=Number.isFinite(max)?max:1;
   row.step=Number.isFinite(Number(spec.step))&&Number(spec.step)>0?Number(spec.step):Number(((row.max-row.min)/100).toPrecision(3));
  }
  params.push(row);
 }
 return {params,presets,night:raw?.night||null,rev:raw?.rev||null,remixable:params.length>0};
}

/** 读 -params.json。没有参数清单（非 remixable）返回空清单，不报错 —— 调用方按「不可调」处理，
 *  预览照常显示。 */
export async function polyforkParams(assetId,{signal,open=openPublic}={}){
 const id=String(assetId||'').trim();
 if(!id)throw Error('Polyfork 资产 ID 缺失');
 signal?.throwIfAborted();
 const r=await open(`${SITE}/cdn/${encodeURIComponent(id)}-params.json`,{signal,timeout:30000});
 if(r.status===404){try{r.stream.destroy();}catch{}return {params:[],presets:{},remixable:false};}
 if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`Polyfork 参数清单返回 HTTP ${r.status}`);}
 let raw=null;
 try{raw=JSON.parse(await readText(r));}catch{throw Error('Polyfork 参数清单不是 JSON');}
 return normalizePolyforkParams(raw);
}

/** 把变体 GLB 流转发出去。前端不直连 CDN，原因和缩略图一样：统一超时与错误信息，
 *  而且以后要挂本地缓存时只改这一处。 */
export async function polyforkVariant(assetId,params,{signal,open=openPublic}={}){
 const url=polyforkVariantUrl(assetId,params);
 const r=await open(url,{signal,timeout:180000});
 if(r.status<200||r.status>=300){
  let detail='';
  try{const text=await readText(r);detail=text.slice(0,300);}catch{}
  if(r.status===429)throw Error('Polyfork 烘焙额度已用完（匿名每小时 40 次），颜色仍可实时调整');
  throw Error(`Polyfork 变体生成失败 HTTP ${r.status}${detail?`：${detail}`:''}`);
 }
 return r;
}

/* ── 生成器源码 ────────────────────────────────────────────────────────────
 * 每个资产在 /cdn/{id}.mjs 放着它的「程序」：官方文档就是这么用的 ——
 *   import { createAsset } from './windmill-3aad49.mjs'; scene.add(createAsset());
 * 拿回浏览器里跑，改参数到看见新几何只要几毫秒；走 -remix.glb 要 1.5~2 秒，
 * 还吃匿名每小时 40 次的烘焙额度。所以这里只负责取源码 + 落盘缓存。
 *
 * 缓存按 7 天软过期：脚本随资产更新，但一天里不会变，过期只是重新下一次 30KB。
 */
const GENERATOR_TTL_MS=7*24*60*60*1000;

/** 把生成器源码改写成「依赖由页面注入」的形态。
 *  浏览器里 `import 'three'` 是裸说明符，没有 importmap 就解析不了；而页面的 CSP 只允许
 *  `script-src 'self'`，blob: 脚本会被直接拒（实测 "Failed to fetch dynamically imported
 *  module"）。所以这一步放服务端做，前端用同源 URL import，既不用放宽 CSP，
 *  也不用让浏览器再下一份 three —— 用页面里已经有的那一份。
 *  改不动（还有别的裸依赖）返回 null，调用方退回服务端烘焙。 */
export function patchGeneratorSource(code){
 const patched=String(code||'')
  .replace(/import\s+\*\s+as\s+THREE\s+from\s+['"]three['"];?/,'const THREE = globalThis.__PF_THREE__;')
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]three\/addons\/utils\/BufferGeometryUtils\.js['"];?/,'const {$1} = globalThis.__PF_BGU__;');
 if(/(^|\n)\s*import[\s{*]/.test(patched))return null;
 return patched;
}

export function generatorCachePath(cacheDir,assetId){
 const safe=String(assetId).replace(/[^\w.-]/g,'_').slice(0,60);
 return path.join(cacheDir,'polyfork-gen',`${safe}.mjs`);
}

export async function polyforkGenerator(assetId,{cacheDir=null,signal,open=openPublic}={}){
 const id=String(assetId||'').trim();
 if(!id)throw Error('Polyfork 资产 ID 缺失');
 const file=cacheDir?generatorCachePath(cacheDir,id):null;
 if(file){
  try{
   const stat=await fs.stat(file);
   if(Date.now()-stat.mtimeMs<GENERATOR_TTL_MS)return fs.readFile(file,'utf8');
  }catch{}
 }
 signal?.throwIfAborted();
 const r=await open(`${SITE}/cdn/${encodeURIComponent(id)}.mjs`,{signal,timeout:30000});
 if(r.status===404){try{r.stream.destroy();}catch{}throw Error('这个资产没有提供生成器源码，只能用服务端烘焙');}
 if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`生成器源码返回 HTTP ${r.status}`);}
 const code=await readText(r);
 // 只认「导出 createAsset / default」这一种形态；别的形态给了浏览器也跑不起来。
 if(!/(export\s+(async\s+)?function\s+createAsset|export\s+default\s+createAsset|export\s*\{[^}]*createAsset)/.test(code)){
  throw Error('生成器源码格式不认识，只能用服务端烘焙');
 }
 if(file){
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,code,'utf8');
 }
 return code;
}

