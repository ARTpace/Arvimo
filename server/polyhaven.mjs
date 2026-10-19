// Poly Haven integration — CC0 永久免费模型库（模型 + 环境光 + 贴图 + HDRIs）。
//
// The public API (github.com/Poly-Haven/Public-API) speaks plain JSON, no key:
//   GET /assets?type=models  -> { [assetId]: { name, authors, categories, tags,
//                                           thumbnail_url, max_resolution, ... } }   (a MAP, not an array)
//   GET /files/<id>?type=models          -> { gltf|blend|fbx|usd: { '1k'|'2k'|'4k': { <fmt>:
//                                                  { include: { <relativePath>: {url,md5,size} } } } } }
//
// `/assets` filters on type / categories / authors only — it does NOT take a keyword parameter
// (verified: query, q, search and name all return the identical map). So keywords are matched
// locally in polyhavenSearch; see polyhavenHaystack below.
//
// Search returns the whole matching map at once and ignores ?per_page, so paging is done locally:
// one upstream request yields every match, sliced into pages here. Downloads are plain direct
// links (no zip/texture assembly, no third-party converter) — simpler than the Sketchfab path.
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {openPublic} from './public-http.mjs';

const API='https://api.polyhaven.com';
/** Files live on their CDN, not on the API host — the API only ever answers *what* exists. */
const CDN='https://cdn.polyhaven.com';
/** Library uid shape is `^[a-f0-9]{32}$` (inherited from Sketchfab), so hash the asset id. */
export function polyhavenUid(id){
  return createHash('md5').update(`polyhaven:${String(id||'')}`).digest('hex');
}
/** The search map has no `thumbnail` field — only `thumbnail_url` (cdn.polyhaven.com, with query). */
function thumbnailOf(asset){
  const t=typeof asset?.thumbnail_url==='string'?asset.thumbnail_url.trim():'';
  return /^https:\/\//i.test(t)?t:'';
}
function authorOf(asset){
  const a=asset?.authors;
  if(a&&typeof a==='object'){const name=Object.keys(a)[0];if(name)return name.slice(0,100);}
  if(typeof a==='string'&&a)return a.slice(0,100);
  return 'Poly Haven';
}
/** One search row -> the model card shape the front-end grid already knows how to render. */
export function normalizePolyhavenAsset(id,asset){
  if(!id||!asset||typeof asset!=='object')return null;
  const slug=String(id);
  return {
    uid:polyhavenUid(slug),
    platform:'polyhaven',
    assetId:slug,
    name:String(asset.name||slug).trim().slice(0,240)||`Poly Haven ${slug}`,
    author:authorOf(asset),
    thumbnail:thumbnailOf(asset),
    url:`https://polyhaven.com/a/${slug}`,
    license:'CC0 1.0 通用公共领域贡献',
    downloadable:true,
    // 类型必须原样保留：HDRI 之前被折成 models，卡片预览按钮就按 models 分流、永远走不到 HDRI 的预览路径。
    assetType:asset.assetType==='textures'||asset.assetType==='hdris'?asset.assetType:'models',
    categories:Array.isArray(asset.categories)?asset.categories.map(String).slice(0,12):[],
    tags:Array.isArray(asset.tags)?asset.tags.map(String).slice(0,24):[],
    faces:null,vertices:null,likes:0,views:0,animations:0,
    maxResolution:Array.isArray(asset.max_resolution)?asset.max_resolution.slice(0,2):null,
  };
}
async function readStreamText(r,limit=8*1024*1024){
  const chunks=[];let bytes=0;
  try{
    for await(const chunk of r.stream){
      bytes+=chunk.length;
      if(bytes>limit){try{r.stream.destroy();}catch{}break;}
      chunks.push(chunk);
    }
  }catch(e){try{r.stream.destroy();}catch{}throw e;}
  return Buffer.concat(chunks).toString('utf8');
}
const PER_PAGE=24;
const ASSET_TYPES=new Set(['models','textures','hdris']);
export function polyhavenAssetType(value){return ASSET_TYPES.has(value)?value:'models';}
/**
 * 关键词必须在本地匹配：上游 `/assets` 只认 type / categories / authors，**任何关键词参数都被
 * 忽略**（实测 query、q、search、name 四种写法都返回同一批结果）。原先把关键词拼进上游 URL，
 * 于是「搜索」看起来毫无作用——不管搜什么都是同一份热门列表。
 *
 * 命中范围是名称 + 标签 + 分类（含 "Furniture/Seating/Chairs" 这种路径串）+ 作者名；拼成一条
 * 小写串放进索引，搜索时只做子串判断，不必每次重新扫对象。
 */
export function polyhavenHaystack(asset){
  if(!asset||typeof asset!=='object')return '';
  return [
    asset.name,
    asset.category,
    ...(Array.isArray(asset.categories)?asset.categories:[]),
    ...(Array.isArray(asset.tags)?asset.tags:[]),
    ...Object.keys(asset.authors||{}),
  ].filter(Boolean).join(' ').toLowerCase();
}
/** 多词 AND：「arm chair」要求两个词都出现；空关键词等于不过滤。 */
export function polyhavenMatch(haystack,query){
  const words=String(query||'').toLowerCase().split(/\s+/).filter(Boolean);
  return !words.length||words.every(word=>haystack.includes(word));
}
/**
 * 上游 `/assets` 与关键词无关，同一 type 的全量（0.5–1MB）只需拉一次，缓存 5 分钟；搜索索引
 * 一起缓存，省掉每次请求对上千条资产的重复拼接。只在走真实上游时启用：测试会注入自己的
 * `open`，共用缓存会让彼此的 mock 串味。
 */
const ASSET_CACHE_MS=5*60*1000;
const assetCache=new Map();
async function loadAssets(type,{signal,open}){
  const shared=open===openPublic,hit=shared?assetCache.get(type):null;
  if(hit&&Date.now()-hit.at<ASSET_CACHE_MS)return hit;
  const r=await open(`${API}/assets?type=${type}`,{signal,timeout:45000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`Poly Haven 搜索返回 HTTP ${r.status}`);}
  const payload=JSON.parse(await readStreamText(r));
  const index=new Map();
  for(const id of Object.keys(payload||{}))index.set(id,polyhavenHaystack(payload[id]));
  const entry={payload,index,at:Date.now()};
  if(shared)assetCache.set(type,entry);
  return entry;
}
/** Keyword search with local paging. `cursor` is `{q,page,type,category}` so paging keeps the filters. */
export async function polyhavenSearch(input={},{signal,open=openPublic}={}){
  signal?.throwIfAborted();
  const cursor=input.cursor
    ?(typeof input.cursor==='string'?safeJson(input.cursor):input.cursor)||{}
    :{};
  const query=String(cursor.q??input.q??'').trim().slice(0,120);
  const page=cursor.page??input.page;
  const type=polyhavenAssetType(cursor.type??input.type);
  const category=String(cursor.category??input.category??'').trim().slice(0,200);
  const {payload,index}=await loadAssets(type,{signal,open});
  let ids=Object.keys(payload||{});
  if(query)ids=ids.filter(id=>polyhavenMatch(index.get(id)||'',query));
  const wanted=new Set(category.split(',').map(item=>item.trim()).filter(Boolean));
  if(wanted.size)ids=ids.filter(id=>Array.isArray(payload[id]?.categories)&&payload[id].categories.map(String).some(item=>wanted.has(item)));
  const total=ids.length;
  const current=Math.max(1,Math.min(1000,Number(page)||1));
  const start=(current-1)*PER_PAGE;
  const slice=ids.slice(start,start+PER_PAGE);
  const models=slice.map(id=>normalizePolyhavenAsset(id,{...payload[id],assetType:type})).filter(Boolean);
  const hasMore=start+PER_PAGE<total;
  const noun=type==='hdris'?'HDRI':type==='textures'?'材质':'模型';
  return {
    models,received:slice.length,total,page:current,
    next:hasMore?JSON.stringify({q:query,page:current+1,type,category}):null,
    pending:[],
    source:`Poly Haven · CC0 ${noun}`,
    warnings:total?[]:[query||category
      ?`Poly Haven 上没有匹配 “${query||category}” 的${noun}。关键词按英文匹配名称、标签、分类与作者名。`
      :`Poly Haven 暂未返回可用的${noun}`],
    query:query,type,category,
  };
}
/**
 * Official `/categories/<type>` is a flat map of slug → asset count, already ordered by popularity
 * (`{"outdoor":507,"wood":138}`). `all` is the unfiltered total, so the sidebar's「全部分类」covers it.
 */
export function normalizePolyhavenCategories(payload){
  const rows=[];
  const push=(value,label,count)=>{
    const slug=String(value||'').trim();
    if(!slug||slug==='all'||slug.length>80)return;
    rows.push({value:slug,label:String(label||slug).slice(0,80),count:Number(count)||0});
  };
  if(Array.isArray(payload)){
    for(const item of payload){
      if(typeof item==='string')push(item,item,0);
      else if(item&&typeof item==='object')push(item.slug||item.name,item.name||item.slug,item.count??item.asset_count);
    }
  }else if(payload&&typeof payload==='object'){
    for(const [key,value] of Object.entries(payload)){
      if(typeof value==='number')push(key,key,value);
      else if(Array.isArray(value))push(key,key,value.length);
      else if(value&&typeof value==='object')push(key,value.name||key,value.count??value.asset_count);
    }
  }
  const seen=new Set();
  return rows.filter(row=>seen.has(row.value)?false:seen.add(row.value)).sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label));
}
export async function polyhavenCategories(type='models',{signal,open=openPublic}={}){
  signal?.throwIfAborted();
  const kind=polyhavenAssetType(type);
  const r=await open(`${API}/categories/${kind}`,{signal,timeout:45000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`Poly Haven 分类返回 HTTP ${r.status}`);}
  return normalizePolyhavenCategories(JSON.parse(await readStreamText(r)));
}
function safeJson(text){
  try{return JSON.parse(text);}catch{return null;}
}
/** `/files/<id>` response, mapped to { format: { resolution: { include: {relPath:{url,md5,size}} } } }. */
export async function polyhavenFiles(id,{signal,open=openPublic,type='models'}={}){
 signal?.throwIfAborted();
 const kind=polyhavenAssetType(type);
 const r=await open(`${API}/files/${encodeURIComponent(id)}?type=${kind}`,{signal,timeout:45000});
 if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`Poly Haven 文件清单返回 HTTP ${r.status}`);}
 return JSON.parse(await readStreamText(r));
}
/** `clay.png` -> `clay`: the file name is the author's render name, the title only drops the suffix. */
function renderTitle(name){
 return String(name).replace(/\.[a-z0-9]+$/i,'').replace(/[_-]+/g,' ').trim().slice(0,120)||'render';
}
/**
 * Poly Haven 的「图片」= 官方渲染图（clay 渲染 + 正交三视图），CC0。
 *
 * `/renders/<id>` 只回答「有哪些渲染图」——名字表的值是占位符，**不是链接**，真实文件在 CDN 的
 * `asset_img/renders/<id>/<文件名>` 下，所以可下载地址由这里拼出来，调用方拿到的永远是能直接
 * 取回的 https 地址。名字表为空（新资产还没出渲染图）时退回官方主图：宁可少给一张，也不给 404
 * —— 这正是「图片下载跑去另一个平台的域名找」要避免的那类失败。
 */
export async function polyhavenRenders(id,{signal,open=openPublic}={}){
 signal?.throwIfAborted();
 const assetId=String(id||'').trim();
 if(!assetId)throw Error('Poly Haven 资产 ID 缺失');
 const encoded=encodeURIComponent(assetId);
 const r=await open(`${API}/renders/${encoded}`,{signal,timeout:45000});
 if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`Poly Haven 渲染图清单返回 HTTP ${r.status}`);}
 const table=JSON.parse(await readStreamText(r));
 const names=Object.keys(table&&typeof table==='object'?table:{}).filter(name=>/\.(?:png|jpe?g|webp)$/i.test(name));
 if(!names.length)return [{url:`${CDN}/asset_img/primary/${encoded}.png`,title:assetId.slice(0,120),rendition:'original',source:`${API}/renders/${encoded}`}];
 return names.map(name=>({url:`${CDN}/asset_img/renders/${encoded}/${encodeURIComponent(name)}`,title:renderTitle(name),rendition:'original',source:`${API}/renders/${encoded}`}));
}
const RES_EDGES={'1k':1024,'2k':2048,'4k':4096,'8k':8192};
/** Pick the best-resolution tier: highest when maxEdge<=0, else the largest tier not exceeding it. */
function pickResolution(resMap,maxEdge){
  const avail=Object.keys(resMap||{}).filter(k=>k in RES_EDGES).sort((a,b)=>RES_EDGES[a]-RES_EDGES[b]);
  if(!avail.length)return null;
  if(!maxEdge||maxEdge<=0)return avail[avail.length-1];
  const fit=avail.filter(k=>RES_EDGES[k]<=maxEdge);
  return fit.length?fit[fit.length-1]:avail[0];
}
async function downloadFile(url,dest,{signal}={}){
  const r=await openPublic(url,{signal,timeout:120000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`下载失败 HTTP ${r.status}`);}
  await fs.mkdir(path.dirname(dest),{recursive:true});
  const tmp=`${dest}.part`;
  const fd=await fs.open(tmp,'w');
  try{
    let bytes=0;
    for await(const chunk of r.stream){
      signal?.throwIfAborted();
      await fd.write(chunk);
      bytes+=chunk.length;
      if(bytes>2*1024*1024*1024)throw Error('文件超过 2GB 限制');
    }
    await fd.sync();
  }finally{await fd.close();}
  await fs.rename(tmp,dest);
}
/**
 * Runner contract (mirrors the Sketchfab worker): write loose files into `output`, return
 * `{zipName}`. The manager verifies, packs (zip when asked) and commits afterwards.
 * `format:'fbx'` downloads Poly Haven's self-contained .fbx; anything else downloads `gltf`
 * (glTF + .bin + textures, kept in their relative layout) — no second conversion step needed.
 */
/** Poly Haven texture map name → the same map token ambientCG writes, so Blender import is one path. */
const TEXTURE_SLOTS={
 diffuse:'Color',diff:'Color',albedo:'Color',col:'Color',color:'Color',
 nor_gl:'NormalGL',normalgl:'NormalGL',normal_gl:'NormalGL',normal:'NormalGL',nor:'NormalGL',
 nor_dx:'NormalDX',normaldx:'NormalDX',normal_dx:'NormalDX',
 rough:'Roughness',roughness:'Roughness',
 disp:'Displacement',displacement:'Displacement',height:'Displacement',bump:'Displacement',
 ao:'AmbientOcclusion',ambientocclusion:'AmbientOcclusion',
 metal:'Metalness',metallic:'Metalness',metalness:'Metalness',
};
const RES_ORDER=['1k','2k','4k','8k'];
export function pickPolyhavenTextureFiles(files,{resolution='2K',textureFormat='JPG'}={}){
 const wanted=String(resolution||'2K').toLowerCase();
 const fmt=String(textureFormat).toUpperCase()==='PNG'?'png':'jpg';
 const wantedIndex=Math.max(0,RES_ORDER.indexOf(wanted));
 const picked=[];
 for(const [mapName,tiers] of Object.entries(files||{})){
  if(!tiers||typeof tiers!=='object')continue;
  const slot=TEXTURE_SLOTS[String(mapName).toLowerCase()];
  if(!slot)continue;
  const names=Object.keys(tiers).filter(name=>RES_ORDER.includes(String(name).toLowerCase()));
  const exact=names.find(name=>String(name).toLowerCase()===wanted);
  const under=names.filter(name=>RES_ORDER.indexOf(String(name).toLowerCase())<=wantedIndex)
   .sort((a,b)=>RES_ORDER.indexOf(String(b).toLowerCase())-RES_ORDER.indexOf(String(a).toLowerCase()));
  const over=names.slice().sort((a,b)=>RES_ORDER.indexOf(String(a).toLowerCase())-RES_ORDER.indexOf(String(b).toLowerCase()));
  const tierName=exact||under[0]||over[0];
  if(!tierName)continue;
  const formats=tiers[tierName];
  const chosen=formats?.[fmt]||formats?.jpg||formats?.png||formats;
  const url=typeof chosen==='string'?chosen:chosen?.url;
  if(typeof url!=='string'||!url.startsWith('https://'))continue;
  picked.push({map:slot,url,resolution:String(tierName).toLowerCase(),extension:fmt==='png'?'png':'jpg'});
 }
 return picked;
}
async function runPolyhavenMaterial({uid,options,output,assetId},{signal,progress}){
 const opts=options||{};
 await fs.mkdir(output,{recursive:true});
 progress({stage:'starting',message:`正在获取 Poly Haven 材质清单（${assetId}）…`});
 const files=await polyhavenFiles(assetId,{signal,type:'textures'});
 const maps=pickPolyhavenTextureFiles(files,{resolution:opts.resolution,textureFormat:opts.textureFormat});
 if(!maps.length)throw Error('Poly Haven 没有提供可下载的材质贴图');
 const texturesDir=path.join(output,'textures');
 await fs.mkdir(texturesDir,{recursive:true});
 const kept=[];
 let done=0;
 for(const map of maps){
  signal?.throwIfAborted();
  const name=`${map.map}.${map.extension}`;
  const dest=path.join(texturesDir,name);
  await downloadFile(map.url,dest,{signal});
  const stat=await fs.stat(dest);
  kept.push({file:`textures/${name}`,map:map.map,bytes:stat.size,url:map.url,resolution:map.resolution});
  done++;
  progress({stage:'transferring',message:`已下载贴图 ${done}/${maps.length}：${name}`,bytesWritten:done,totalBytes:maps.length});
 }
 const meta={
  uid,kind:'material',platform:'polyhaven',assetId,
  title:String(assetId).slice(0,240),
  url:`https://polyhaven.com/a/${assetId}`,
  license:'CC0 1.0 通用公共领域贡献',
  resolution:String(opts.resolution||'2K'),format:String(opts.textureFormat||'JPG'),
  textures:kept,
  note:'Poly Haven 材质，CC0 1.0 通用公共领域贡献，可商用无需署名。贴图按与 ambientCG 相同的 map 名保存。',
  exportedAt:new Date().toISOString(),tool:'AssetVault · Poly Haven (CC0)',
 };
 await fs.writeFile(path.join(output,'info.json'),JSON.stringify(meta,null,2),'utf8');
 const stem=String(assetId).replace(/[^\w.-]/g,'_').slice(0,80)||'polyhaven';
 return {zipName:`${stem}-material`,title:meta.title,author:'Poly Haven',thumbnail:null};
}
const HDRI_ORDER=['1k','2k','4k','8k','16k','24k'];
export function pickPolyhavenHdri(files,{resolution='2K',textureFormat='HDR'}={}){
 const map=files?.hdri;
 if(!map||typeof map!=='object')return null;
 const wanted=String(resolution||'2K').toLowerCase();
 const fmt=String(textureFormat).toUpperCase()==='EXR'?'exr':'hdr';
 const names=Object.keys(map).filter(name=>HDRI_ORDER.includes(String(name).toLowerCase()));
 const wantedIndex=Math.max(0,HDRI_ORDER.indexOf(wanted));
 const exact=names.find(name=>String(name).toLowerCase()===wanted);
 const under=names.filter(name=>HDRI_ORDER.indexOf(String(name).toLowerCase())<=wantedIndex).sort((a,b)=>HDRI_ORDER.indexOf(String(b).toLowerCase())-HDRI_ORDER.indexOf(String(a).toLowerCase()));
 const tierName=exact||under[0]||names.slice().sort((a,b)=>HDRI_ORDER.indexOf(String(a).toLowerCase())-HDRI_ORDER.indexOf(String(b).toLowerCase()))[0];
 if(!tierName)return null;
 const formats=map[tierName];
 const chosen=formats?.[fmt]||formats?.hdr||formats?.exr;
 const url=typeof chosen==='string'?chosen:chosen?.url;
 if(typeof url!=='string'||!url.startsWith('https://'))return null;
 const actual=formats?.[fmt]?fmt:formats?.hdr?'hdr':'exr';
 return {url,resolution:String(tierName).toLowerCase(),extension:actual};
}
async function runPolyhavenHdri({uid,options,output,assetId},{signal,progress}){
 const opts=options||{};
 await fs.mkdir(output,{recursive:true});
 progress({stage:'starting',message:`正在获取 Poly Haven HDRI 清单（${assetId}）…`});
 const files=await polyhavenFiles(assetId,{signal,type:'hdris'});
 const chosen=pickPolyhavenHdri(files,{resolution:opts.resolution,textureFormat:opts.textureFormat});
 if(!chosen)throw Error('Poly Haven 没有提供可下载的 HDRI');
 const name=`environment.${chosen.extension}`;
 await downloadFile(chosen.url,path.join(output,name),{signal});
 const stat=await fs.stat(path.join(output,name));
 const meta={
  uid,kind:'hdri',platform:'polyhaven',assetId,
  title:String(assetId).slice(0,240),
  url:`https://polyhaven.com/a/${assetId}`,
  license:'CC0 1.0 通用公共领域贡献',
  resolution:chosen.resolution,format:chosen.extension.toUpperCase(),
  files:[{file:name,bytes:stat.size,url:chosen.url}],
  note:'Poly Haven HDRI，CC0 1.0 通用公共领域贡献，可商用无需署名。',
  exportedAt:new Date().toISOString(),tool:'AssetVault · Poly Haven (CC0)',
 };
 await fs.writeFile(path.join(output,'info.json'),JSON.stringify(meta,null,2),'utf8');
 const stem=String(assetId).replace(/[^\w.-]/g,'_').slice(0,80)||'polyhaven';
 return {zipName:`${stem}-hdri`,title:meta.title,author:'Poly Haven',thumbnail:null};
}
export async function runPolyhavenJob({uid,options,output,profile,assetId,assetType='models'},{signal,progress=()=>{}}={}){
  signal?.throwIfAborted();
  if(!assetId)throw Error('Poly Haven 资产 ID 缺失');
  if(polyhavenAssetType(assetType)==='textures')return runPolyhavenMaterial({uid,options,output,assetId},{signal,progress});
  if(polyhavenAssetType(assetType)==='hdris')return runPolyhavenHdri({uid,options,output,assetId},{signal,progress});
  await fs.mkdir(output,{recursive:true});
  const maxEdge=Number(options?.maxTextureEdge)||0;
  progress({stage:'starting',message:`正在获取 Poly Haven 文件清单（${assetId}）…`});
  const files=await polyhavenFiles(assetId,{signal});
  // 降级判据必须是「这个资产有没有模型格式」，**不能**是「有没有贴图」。
  // 模型资产的清单顶层同样挂着 Diffuse/Rough/nor_gl/arm 等贴图项（models 与 textures 共用
  // 同一套 map 命名），所以拿 pickPolyhavenTextureFiles 的结果去判断，会把每个正常的
  // Poly Haven 模型都误判成「其实是材质」→ 转去跑材质导出 → 导出目录里没有 .fbx，
  // 校验阶段才报「导出目录里没有 Poly Haven 的模型文件」，错误信息完全指不到真因。
  // 只有确实一个模型格式都不提供的资产（纯材质图）才该走材质分支。
  const MODEL_FORMATS=['fbx','gltf','blend','usd'];
  const hasModelFormat=MODEL_FORMATS.some(key=>files?.[key]&&typeof files[key]==='object');
  if(!hasModelFormat&&pickPolyhavenTextureFiles(files,{resolution:'2K'}).length){
    return runPolyhavenMaterial({uid,options,output,assetId},{signal,progress});
  }
  // 格式降级要看「这个格式的包里有没有模型文件」，不能只看 files[format] 这个键在不在：
  // Poly Haven 的清单里 fbx 条目**总是存在**，但里面常常只有贴图（真正的几何数据在
  // gltf 条目的 <asset>.bin 里）。按「键是否存在」判断会让降级永远不触发，
  // 于是选出一个只有贴图、没有模型文件的格式，最后在校验环节报
  // 「导出目录里没有 Poly Haven 的模型文件」。
  const MODEL_FILE=/\.(?:fbx|gltf|glb|bin|blend|usdc|usd)$/i;
  const formatHasModel=key=>{
    const tiers=files?.[key];
    if(!tiers||typeof tiers!=='object')return false;
    for(const tier of Object.values(tiers)){
      const include=tier?.[key]?.include;
      if(include&&Object.keys(include).some(rel=>MODEL_FILE.test(rel)))return true;
    }
    return false;
  };
  let format=(options&&options.format)==='fbx'?'fbx':'gltf';
  // 逐级往后找第一个真带模型文件的格式：请求的 → gltf → blend → usd。
  if(!formatHasModel(format)){
    const fallback=MODEL_FORMATS.find(key=>formatHasModel(key));
    if(!fallback)throw Error('Poly Haven 没有可用的模型格式（只有贴图）');
    format=fallback;
  }
  const resMap=files?.[format];
  if(!resMap||typeof resMap!=='object')throw Error(`Poly Haven 未提供 ${format} 格式`);
  const resName=pickResolution(resMap,maxEdge);
  if(!resName)throw Error(`Poly Haven 没有可用分辨率的 ${format} 格式`);
  const entries=resMap[resName]?.[format]?.include;
  const rels=Object.keys(entries||{});
  if(!rels.length)throw Error('Poly Haven 文件清单为空');
  progress({stage:'transferring',message:`正在下载 ${format} 模型（${resName}），共 ${rels.length} 个文件`,bytesWritten:0,totalBytes:rels.length});
  let done=0;
  for(const rel of rels){
    signal?.throwIfAborted();
    const info=entries[rel];
    const url=typeof info==='string'?info:info?.url;
    if(!url)continue;
    const dest=path.join(output,rel);
    await downloadFile(url,dest,{signal});
    done++;
    progress({stage:'transferring',message:`已下载 ${done}/${rels.length} · ${path.basename(rel)}`,bytesWritten:done,totalBytes:rels.length});
  }
  const meta={
    uid,platform:'polyhaven',assetId,format,resolution:resName,
    url:`https://polyhaven.com/a/${assetId}`,license:'CC0 1.0 通用公共领域贡献',
    exportedAt:new Date().toISOString(),tool:'AssetVault · Poly Haven (CC0)',
    note:'Poly Haven 资产，CC0 1.0 通用公共领域贡献，可商用无需署名。',
  };
  await fs.writeFile(path.join(output,'info.json'),JSON.stringify(meta,null,2),'utf8');
  const stem=String(assetId).replace(/[^\w.-]/g,'_').slice(0,80)||'polyhaven';
  return {zipName:`${stem}-${polyhavenUid(assetId).slice(0,8)}.zip`};
}
