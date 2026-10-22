// FreeStylized 的 3D 预览资源。
//
// 官网没有可嵌入的 viewer，模型包里只有 FBX（没有 glTF），而且两个下载源（Google Drive /
// r2.dev）都不在图床白名单上 —— 前端拿不到直链。所以只能由服务端把 ZIP 拉下来，按需解出
// 需要的条目，再以本地 URL 的形式喂给前端渲染（前端逻辑见 src/library/gltf-preview.js）。
//
// 缓存策略：ZIP 落在数据目录的 preview-cache/ 下，24 小时内复用。预览是「点开才拉」，
// 同一个资产反复看不应该每次都去 Google Drive 排队。
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {openPublic} from './public-http.mjs';
import {readStreamText} from './artstation-project.mjs';
import {FREESTYLIZED_TYPES,freestylizedType,freestylizedFileUrl} from './freestylized.mjs';

const SITE='https://freestylized.com';
const MAX_ZIP=200*1024*1024;
const CACHE_TTL=24*60*60*1000;
/** 预览只取贴图的一部分：4K PNG 单张就十几 MB，全取前端要等太久。 */
const TEXTURE_BUDGET=32*1024*1024;
const TEXTURE_LIMIT=8;

const IMAGE_EXT=/\.(png|jpe?g|webp)$/i;
const HDR_EXT=/\.(hdr|exr)$/i;
/** 贴图槽位按「名字里的关键词」认：FreeStylized 的命名是 <Asset>_<Map>_<res>.png，
 *  与 ambientCG / Poly Haven 都不通用，所以这里自有一份匹配表（顺序即优先级）。 */
const MAP_SLOTS=[
 ['base',/basecolor|basecolour|_color|albedo|diffuse/i],
 ['nor',/normal/i],
 ['rough',/roughness|_rough|rough/i],
 ['metal',/metallic|metalness|_metal/i],
 ['ao',/ambientocclusion|mixed_ao|_ao|occlusion/i],
 ['height',/height|displacement/i],
];

export function previewCachePath(cacheDir,type,slug){
 return path.join(cacheDir,`fs-${freestylizedType(type)}-${createHash('md5').update(String(slug)).digest('hex').slice(0,16)}.zip`);
}

/** ZIP 中央目录解析：只要目录，不解压。返回每条的偏移与长度，取文件是后面的事。 */
export function zipIndex(buf){
 let eocd=-1;
 for(let i=buf.length-22;i>=0&&i>=buf.length-65557;i--){if(buf.readUInt32LE(i)===0x06054b50){eocd=i;break;}}
 if(eocd<0)throw Error('资源包不是有效的 ZIP');
 const count=buf.readUInt16LE(eocd+10);
 let p=buf.readUInt32LE(eocd+16);
 const entries=[];
 for(let n=0;n<count;n++){
  if(p+46>buf.length||buf.readUInt32LE(p)!==0x02014b50)throw Error('资源包目录损坏');
  const method=buf.readUInt16LE(p+10),packed=buf.readUInt32LE(p+20),length=buf.readUInt32LE(p+24);
  const nl=buf.readUInt16LE(p+28),el=buf.readUInt16LE(p+30),cl=buf.readUInt16LE(p+32),offset=buf.readUInt32LE(p+42);
  const name=buf.subarray(p+46,p+46+nl).toString('utf8');
  p+=46+nl+el+cl;
  if(!name||/[\\:\0]/.test(name)||name.split('/').some(v=>v==='..'))continue;
  if(method!==0&&method!==8)throw Error(`资源包用了不支持的压缩方式：${name}`);
  entries.push({name,method,packed,length,start:offset+30+buf.readUInt16LE(offset+26)+buf.readUInt16LE(offset+28)});
 }
 return entries;
}

export function zipRead(buf,entry){
 const raw=buf.subarray(entry.start,entry.start+entry.packed);
 const data=entry.method===8?zlib.inflateRawSync(raw):Buffer.from(raw);
 if(data.length!==entry.length)throw Error(`资源包条目解压异常：${entry.name}`);
 return data;
}

const lodRank=e=>/lod0|_lod_?0/i.test(e.name)?0:/lod1/i.test(e.name)?1:2;

/** 从 ZIP 条目里挑出这一类型预览真正需要的那几项。返回 null 表示这类没法预览。 */
export function pickPreviewEntries(entries,type){
 const files=entries.filter(e=>e.length>0&&!e.name.endsWith('/'));
 const images=()=>files.filter(e=>IMAGE_EXT.test(e.name)&&!/readme|license|preview|thumb/i.test(e.name));
 if(type==='models'){
  // 优先级：glTF/GLB（自带贴图与材质）> FBX > OBJ/STL/PLY/3MF（纯网格，前端给默认材质）。
  // 每一档内部先按 lod 再按体积排，避免拿到 4K 大包里的高模。
  const byLod=(a,b)=>lodRank(a)-lodRank(b)||b.length-a.length;
  const gltf=files.filter(e=>/\.(glb|gltf)$/i.test(e.name)).sort(byLod);
  const fbx=files.filter(e=>/\.fbx$/i.test(e.name)).sort(byLod);
  const plain=files.filter(e=>/\.(obj|stl|ply|3mf)$/i.test(e.name)).sort(byLod);
  const model=gltf[0]||fbx[0]||plain[0];
  if(!model)return null;
  let budget=TEXTURE_BUDGET,count=0;
  const textures=[];
  for(const e of images().sort((a,b)=>a.length-b.length)){
   if(count>=TEXTURE_LIMIT||e.length>budget)continue;
   textures.push({entry:e,role:'texture'});budget-=e.length;count++;
  }
  return {kind:'model',items:[{entry:model,role:'model'},...textures]};
 }
 if(type==='textures'){
  const pool=images();
  const items=[];
  for(const [role,pattern] of MAP_SLOTS){
   const hits=pool.filter(e=>pattern.test(e.name));
   if(!hits.length)continue;
   // 法线有 GL / DX 两套，three 认 OpenGL 约定（绿通道向上），所以 gl 优先。
   const sorted=role==='nor'?hits.sort((a,b)=>(/gl/i.test(b.name)?1:0)-(/gl/i.test(a.name)?1:0)||a.length-b.length):hits.sort((a,b)=>a.length-b.length);
   items.push({entry:sorted[0],role});
  }
  if(!items.some(i=>i.role==='base'))return null;
  return {kind:'texture',items};
 }
 if(type==='skybox'){
  const hdr=files.find(e=>HDR_EXT.test(e.name));
  if(hdr)return {kind:'hdri',items:[{entry:hdr,role:'env'}]};
  const img=images().sort((a,b)=>b.length-a.length)[0];
  if(img)return {kind:'equirect',items:[{entry:img,role:'env'}]};
  return null;
 }
 return null;
}

async function ensureZip(slug,type,cacheDir,{signal,open=openPublic}={}){
 const spec=FREESTYLIZED_TYPES[freestylizedType(type)];
 const zipPath=previewCachePath(cacheDir,type,slug);
 try{
  const stat=await fs.stat(zipPath);
  if(stat.isFile()&&stat.size>0&&Date.now()-stat.mtimeMs<CACHE_TTL)return {zipPath,pageUrl:''};
 }catch{}
 const pageUrl=`${SITE}/${spec.path}/${slug}/`;
 const page=await open(pageUrl,{signal,timeout:45000});
 if(page.status<200||page.status>=300){try{page.stream.destroy();}catch{}throw Error(`资产页返回 HTTP ${page.status}`);}
 const html=await readStreamText(page);
 const zipUrl=freestylizedFileUrl(html);
 if(!zipUrl)throw Error('这个 FreeStylized 资产没有公开下载，无法预览');
 const file=await open(zipUrl,{signal,timeout:180000});
 if(file.status<200||file.status>=300){try{file.stream.destroy();}catch{}throw Error(`资源包下载失败 HTTP ${file.status}`);}
 await fs.mkdir(cacheDir,{recursive:true});
 const tmp=`${zipPath}.part`;
 let bytes=0;
 const chunks=[];
 try{
  for await(const chunk of file.stream){
   signal?.throwIfAborted();
   bytes+=chunk.length;
   if(bytes>MAX_ZIP){try{file.stream.destroy();}catch{}throw Error('资源包超过 200MB，不做在线预览');}
   chunks.push(chunk);
  }
 }finally{try{file.stream.destroy();}catch{}}
 const buf=Buffer.concat(chunks);
 if(!buf.length)throw Error('资源包是空的');
 await fs.writeFile(tmp,buf);
 await fs.rename(tmp,zipPath);
 return {zipPath,pageUrl};
}

/** 预览清单：前端拿它决定渲染哪几张图 / 哪个模型，条目本身走 preview-file 按需取。 */
export async function freestylizedPreview({slug,type},{cacheDir,signal,open=openPublic}={}){
 const safeType=freestylizedType(type);
 const key=String(slug||'').trim();
 if(!/^[a-z0-9_-]{1,80}$/i.test(key))throw Error('FreeStylized 资产 ID 无效');
 const {zipPath,pageUrl}=await ensureZip(key,safeType,cacheDir,{signal,open});
 const buf=await fs.readFile(zipPath);
 const picked=pickPreviewEntries(zipIndex(buf),safeType);
 if(!picked)return {ok:false,slug:key,type:safeType,error:'这个资源包里没有可用于 3D 预览的模型或贴图'};
 const query=`slug=${encodeURIComponent(key)}&type=${encodeURIComponent(safeType)}`;
 return {
  ok:true,slug:key,type:safeType,kind:picked.kind,
  url:pageUrl||`${SITE}/${FREESTYLIZED_TYPES[safeType].path}/${key}/`,
  zipBytes:buf.length,
  entries:picked.items.map((item,index)=>({index,role:item.role,name:item.entry.name.split('/').pop(),bytes:item.entry.length,url:`/api/freestylized/preview-file?${query}&i=${index}`})),
 };
}

/** 单个条目的字节流：清单里的 index 是解包时算的，重解一次 ZIP 取同名条目即可。 */
export async function freestylizedPreviewFile({slug,type,index},{cacheDir}={}){
 const safeType=freestylizedType(type);
 const key=String(slug||'').trim();
 if(!/^[a-z0-9_-]{1,80}$/i.test(key))throw Error('FreeStylized 资产 ID 无效');
 const zipPath=previewCachePath(cacheDir,safeType,key);
 const buf=await fs.readFile(zipPath);
 const picked=pickPreviewEntries(zipIndex(buf),safeType);
 const item=picked?.items[Number(index)];
 if(!item)throw Error('预览条目不存在');
 return {data:zipRead(buf,item.entry),name:item.entry.name.split('/').pop()};
}
