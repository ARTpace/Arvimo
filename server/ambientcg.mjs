// ambientCG integration — CC0 免费 PBR 材质贴图库（www.ambientcg.com）。
//
// The public API (docs.ambientcg.com/api/v3) speaks plain JSON, no key:
//   GET /api/v3/assets?type=material&q=<kw>&limit=<n>&offset=<n>
//       &include=type,title,url,tags,maps,thumbnails
//     -> { totalResults, nextPageHttp, assets: [{ id, type, title, url, tags[], maps[],
//           thumbnails: {'512-JPG-242424': 'https://acg-media.../Ground054.jpg', ...} }] }
//   GET /api/v3/assets?id=<id>&include=downloads
//     -> { assets: [{ id, downloads: [{attributes:'2K-JPG', extension:'zip', url, size}] }] }
//
// Search answers one page per request (limit/offset are honoured upstream, unlike Poly Haven's
// map-shaped response, so paging stays a real server round-trip). A material download is one
// self-contained ZIP per resolution+format tier — the runner fetches it, keeps only the PBR map
// files (the DCC sources .blend/.usdc/.mtlx/.tres inside are recorded as skipped, not dropped
// silently), renames each map after its type and repacks with info.json, so the deliverable goes
// through the same verifier as every other job in the queue.
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createInflateRaw} from 'node:zlib';
import {openPublic} from './public-http.mjs';
import {crc32} from './archive.mjs';
import {writeEntriesDeliverable} from './deliverable-writer.mjs';

const API='https://ambientcg.com';
const PER_PAGE=24;
const SEARCH_INCLUDE='type,title,url,tags,maps,previews,thumbnails';

/** Library uid shape is `^[a-f0-9]{32}$` (inherited from Sketchfab), so hash the asset id. */
export function ambientcgUid(id){
  return createHash('md5').update(`ambientcg:${String(id||'')}`).digest('hex');
}

/** Cards want one still: prefer the 512 JPG on the site's dark background, then whatever exists. */
function thumbnailOf(asset){
  const t=asset?.thumbnails;
  if(!t||typeof t!=='object')return '';
  const pick=[...Object.keys(t)].sort((a,b)=>(Number(String(a).match(/^\d+/)?.[0])||0)-(Number(String(b).match(/^\d+/)?.[0])||0));
  const best=[...pick].reverse().find(k=>/JPG|PNG/i.test(k)&&Number(String(k).match(/^\d+/)?.[0])<=1024)||pick[pick.length-1];
  const url=best?t[best]:null;
  return typeof url==='string'&&/^https:\/\//i.test(url)?url:'';
}

/** The official embeddable PBR viewer (ambientCG's own asset pages use this exact one): one URL
 *  per asset with every texture URL already baked into the fragment, served from releases.pbr.one.
 *  Cards carry it so the workbench can embed the same interactive material preview the site has. */
function viewerUrlOf(asset){
  const previews=Array.isArray(asset?.previews)?asset.previews:[];
  const hit=previews.find(p=>p&&p.type==='pbr-one-material-shading'&&typeof p.url==='string'&&/^https:\/\//i.test(p.url));
  return hit?hit.url:'';
}

/** One search row -> the model card shape the front-end grid already knows how to render. */
export function normalizeAmbientcgAsset(asset){
  if(!asset||typeof asset!=='object')return null;
  const slug=String(asset.id||'').trim();
  if(!slug)return null;
  return {
    uid:ambientcgUid(slug),
    platform:'ambientcg',
    assetId:slug,
    name:String(asset.title||slug).trim().slice(0,240)||`ambientCG ${slug}`,
    author:'ambientCG',
    thumbnail:thumbnailOf(asset),
    url:`https://ambientcg.com/a/${slug}`,
    license:'CC0 1.0 通用公共领域贡献',
    downloadable:true,
    categories:[asset.type].filter(Boolean).map(String),
    tags:Array.isArray(asset.tags)?asset.tags.map(String).slice(0,24):[],
    faces:null,vertices:null,likes:0,views:0,animations:0,
    maps:Array.isArray(asset.maps)?asset.maps.map(String).slice(0,12):[],
    viewerUrl:viewerUrlOf(asset),
  };
}
/** Lazy preview resolution: cards saved into the local library before this version carry no
 *  `viewerUrl`, so the front-end asks for it by asset id on first open (same extraction as the
 *  search normaliser, one small API call). Empty string = the site ships no embeddable preview. */
export async function ambientcgViewer(id,{signal,open=openPublic}={}){
  signal?.throwIfAborted();
  const assetId=String(id||'').trim();
  if(!assetId)throw Error('ambientCG 资产 ID 缺失');
  const params=new URLSearchParams({id:assetId,include:'previews'});
  const r=await open(`${API}/api/v3/assets?${params}`,{signal,timeout:45000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`ambientCG 资产信息返回 HTTP ${r.status}`);}
  const payload=JSON.parse(await readStreamText(r));
  const asset=(Array.isArray(payload?.assets)?payload.assets:[]).find(a=>a&&a.id===assetId);
  if(!asset)throw Error(`ambientCG 上找不到材质 ${assetId}`);
  return viewerUrlOf(asset);
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
function safeJson(text){
  try{return JSON.parse(text);}catch{return null;}
}
/** Keyword search with real server paging (`limit`+`offset` are honoured upstream).
 *  `category` narrows to one of the ids from /api/v3/categories and rides in the cursor, so
 *  pagination keeps the narrowed scope without the front-end re-sending it. */
export async function ambientcgSearch(input={},{signal,open=openPublic}={}){
  signal?.throwIfAborted();
  // 分类随游标走：翻页请求只带 cursor， narrows 的范围在游标里原样续上。
  const cursor=input.cursor?(typeof input.cursor==='string'?safeJson(input.cursor):input.cursor)||{}:null;
  const {q,page,category:cursorCategory}=cursor||{};
  const query=String(q??input?.q??'').trim();
  const rawCategory=input.category!==undefined?input.category:cursorCategory;
  const category=String(rawCategory??'').trim().slice(0,80);
  const current=Math.max(1,Math.min(1000,Number(page)||1));
  const offset=(current-1)*PER_PAGE;
  const params=new URLSearchParams({type:'material',limit:String(PER_PAGE),offset:String(offset),include:SEARCH_INCLUDE});
  if(query)params.set('q',query);
  if(category)params.set('category',category);
  const r=await open(`${API}/api/v3/assets?${params}`,{signal,timeout:45000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`ambientCG 搜索返回 HTTP ${r.status}`);}
  const payload=JSON.parse(await readStreamText(r));
  const rows=Array.isArray(payload?.assets)?payload.assets:[];
  const models=rows.map(normalizeAmbientcgAsset).filter(Boolean);
  const total=Number(payload?.totalResults)||models.length;
  const hasMore=offset+models.length<total;
  return {
    models,received:models.length,total,page:current,
    next:hasMore?JSON.stringify({q:query,category,page:current+1}):null,
    pending:[],
    source:'ambientCG · CC0 材质',
    warnings:total?[]:[`ambientCG 上没有匹配 “${query||category}” 的材质`],
    query:query,
  };
}
/**
 * The site's own category facets, material ones only. The API ignores its `type` filter here
 * (HDRI rows come back regardless), so the material cut happens client-side; rows are already
 * sorted by asset count descending upstream, which is exactly the order a picker wants.
 */
export async function ambientcgCategories({signal,open=openPublic}={}){
  signal?.throwIfAborted();
  const r=await open(`${API}/api/v3/categories`,{signal,timeout:45000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`ambientCG 分类返回 HTTP ${r.status}`);}
  const payload=JSON.parse(await readStreamText(r));
  const rows=Array.isArray(payload)?payload:Array.isArray(payload?.categories)?payload.categories:[];
  return rows
    .filter(row=>row&&String(row.type)==='material'&&row.id)
    .map(row=>({value:String(row.id).slice(0,80),label:String(row.title||row.id).slice(0,80),count:Number(row.numberOfAssets)||0}));
}
async function readAt(handle,buffer,position){
  const {bytesRead}=await handle.read(buffer,0,buffer.length,position);
  if(bytesRead!==buffer.length)throw Error('下载的 ZIP 数据截断');
  return buffer;
}
/**
 * Walk the downloaded ZIP's central directory and stream out the entries we keep. The structural
 * checks mirror verifyArchive() on purpose: an archive that would fail the final verification is
 * better rejected here, where the reason ("下载的 ZIP …") still points at the download.
 */
async function readZipDirectory(zipPath,{signal}={}){
  const handle=await fs.open(zipPath,'r');
  try{
    const size=(await handle.stat()).size;
    if(size<22)throw Error('下载的 ZIP 无效');
    const tailLen=Math.min(size,65557);
    const tail=await readAt(handle,Buffer.alloc(tailLen),size-tailLen);
    let end=-1;
    for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
    if(end<0)throw Error('下载的 ZIP 目录缺失');
    const count=tail.readUInt16LE(end+10),cdSize=tail.readUInt32LE(end+12),cdOffset=tail.readUInt32LE(end+16);
    if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||tail.readUInt16LE(end+8)!==count||!count||count>10000||cdSize>8*1024**2||cdOffset+cdSize>size-tail.length+end)throw Error('不支持此 ZIP 结构');
    const directory=await readAt(handle,Buffer.alloc(cdSize),cdOffset);
    const entries=[];let p=0;
    for(let n=0;n<count;n++){
      signal?.throwIfAborted();
      if(p+46>directory.length||directory.readUInt32LE(p)!==0x02014b50)throw Error('下载的 ZIP 目录损坏');
      const flags=directory.readUInt16LE(p+8),method=directory.readUInt16LE(p+10),crc=directory.readUInt32LE(p+16),packed=directory.readUInt32LE(p+20),length=directory.readUInt32LE(p+24),nl=directory.readUInt16LE(p+28),el=directory.readUInt16LE(p+30),cl=directory.readUInt16LE(p+32),offset=directory.readUInt32LE(p+42);
      const name=directory.subarray(p+46,p+46+nl).toString('utf8');p+=46+nl+el+cl;
      if(p>directory.length)throw Error('下载的 ZIP 目录损坏');
      if(!name||/[\\\x00:]/.test(name)||name.startsWith('/')||name.split('/').some(v=>v==='..'))throw Error(`下载的 ZIP 条目路径不安全：${name||'(空)'}`);
      if(flags&1)throw Error(`下载的 ZIP 条目已加密：${name}`);
      if(![0,8].includes(method))throw Error(`下载的 ZIP 压缩方式不受支持：${name} (method ${method})`);
      const local=await readAt(handle,Buffer.alloc(30),offset);
      if(local.readUInt32LE(0)!==0x04034b50||local.readUInt16LE(8)!==method||local.readUInt16LE(6)!==flags)throw Error('下载的 ZIP 本地头损坏');
      const localName=await readAt(handle,Buffer.alloc(local.readUInt16LE(26)),offset+30);
      if(localName.toString('utf8')!==name)throw Error('下载的 ZIP 文件名不一致');
      const start=offset+30+local.readUInt16LE(26)+local.readUInt16LE(28);
      entries.push({name,method,crc,packed,length,start});
    }
    return entries;
  }finally{await handle.close();}
}
/** Inflate one stored/deflated entry and check its CRC — a truncated download must fail loudly. */
async function extractEntry(zipPath,entry,{signal}={}){
  if(!entry.packed)return Buffer.alloc(0);
  const source=createReadStream(zipPath,{start:entry.start,end:entry.start+entry.packed-1,signal});
  const stream=entry.method===8?source.pipe(createInflateRaw()):source;
  source.on('error',e=>stream.destroy(e));
  const chunks=[];let bytes=0,sum=0xffffffff;
  try{
    for await(const chunk of stream){
      signal?.throwIfAborted();
      bytes+=chunk.length;
      if(bytes>entry.length||bytes>2*1024**3)throw Error(`下载的 ZIP 解压长度异常：${entry.name}`);
      sum=crc32(chunk,sum);chunks.push(chunk);
    }
  }finally{source.destroy();stream.destroy();}
  if(bytes!==entry.length||((sum^0xffffffff)>>>0)!==entry.crc)throw Error(`下载的 ZIP 校验失败：${entry.name}`);
  return Buffer.concat(chunks);
}
/** AmbientCG names maps `<id>_<res>-<fmt>_<Map>.<ext>`; the token after the last `_` is the map. */
const MAP_TOKENS=new Set(['color','displacement','normaldx','normalgl','normal','roughness','ambientocclusion','metalness','metallic','height','opacity','emissive','emission','specular','glossiness','ambientocclusionroughnessmetalness']);
function mapTokenOf(name){
  const m=String(name||'').match(/^(?:.+)_([A-Za-z0-9]+)\.(jpe?g|png)$/i);
  const token=m&&m[1].toLowerCase();
  return token&&MAP_TOKENS.has(token)?{map:m[1],extension:m[2].toLowerCase()==='jpeg'?'jpg':m[2].toLowerCase()}:null;
}
/**
 * ambientCG 的「图片」= 官方缩略图（最大 2048px，同一画面的 JPG/PNG/WEBP 变体），CC0。
 * 多档尺寸是同一张图的不同缩放，多背景/格式变体是同尺寸的重复文件——照 Sketchfab 封面的
 * 同一约定，这里只返回一张（最大的 JPG 变体），其余留在外面，不往交付里塞重复文件。
 */
export async function ambientcgRenders(id,{signal,open=openPublic}={}){
  signal?.throwIfAborted();
  const assetId=String(id||'').trim();
  if(!assetId)throw Error('ambientCG 资产 ID 缺失');
  const params=new URLSearchParams({id:assetId,include:'title,thumbnails'});
  const r=await open(`${API}/api/v3/assets?${params}`,{signal,timeout:45000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`ambientCG 资产信息返回 HTTP ${r.status}`);}
  const payload=JSON.parse(await readStreamText(r));
  const asset=(Array.isArray(payload?.assets)?payload.assets:[]).find(a=>a&&a.id===assetId);
  if(!asset)throw Error(`ambientCG 上找不到材质 ${assetId}`);
  const t=asset.thumbnails&&typeof asset.thumbnails==='object'?asset.thumbnails:{};
  const ranked=Object.keys(t)
    .map(key=>({key,url:t[key],size:Number(String(key).match(/^(\d+)/)?.[1])||0}))
    .filter(x=>typeof x.url==='string'&&/^https:\/\//i.test(x.url)&&x.size>0)
    .sort((a,b)=>b.size-a.size);
  const best=ranked.find(x=>/JPG/i.test(x.key))||ranked[0];
  if(!best)throw Error('这个 ambientCG 材质暂时没有可下载图片');
  return [{url:best.url,title:assetId.slice(0,120),rendition:'original',source:`${API}/api/v3/assets?id=${encodeURIComponent(assetId)}`}];
}
const RES_K={'1K':1,'2K':2,'4K':4,'8K':8};
/** Pick one ZIP tier: exact `<res>-<fmt>` first, else the same format nearest to the request. */
export function pickAmbientcgDownload(downloads,{resolution='2K',textureFormat='JPG'}={}){
  const list=(Array.isArray(downloads)?downloads:[]).filter(d=>d&&typeof d.url==='string'&&(!d.extension||/^zip$/i.test(String(d.extension))));
  const wantedRes=RES_K[resolution]||2,wantedFmt=String(textureFormat).toUpperCase()==='PNG'?'PNG':'JPG';
  const parse=a=>{const m=String(a||'').match(/^(\d+)K-([A-Za-z]+)$/i);return m?{res:Number(m[1]),fmt:m[2].toUpperCase()}:null;};
  const scored=list.map(d=>({d,info:parse(d.attributes)})).filter(x=>x.info);
  if(!scored.length)return null;
  const sameFmt=scored.filter(x=>x.info.fmt===wantedFmt);
  const pool=sameFmt.length?sameFmt:scored;
  const exact=pool.find(x=>x.info.res===wantedRes);
  if(exact)return exact.d;
  const fits=pool.filter(x=>x.info.res<=wantedRes).sort((a,b)=>b.info.res-a.info.res);
  if(fits.length)return fits[0].d;
  return pool.slice().sort((a,b)=>a.info.res-b.info.res)[0].d;
}
async function downloadFile(url,dest,{open=openPublic,signal,progress}={}){
  const r=await open(url,{signal,timeout:120000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`下载失败 HTTP ${r.status}`);}
  const total=Number(r.headers['content-length'])||null;
  await fs.mkdir(path.dirname(dest),{recursive:true});
  const tmp=`${dest}.part`;
  const fd=await fs.open(tmp,'w');
  const started=Date.now();
  try{
    let bytes=0,lastReport=0;
    for await(const chunk of r.stream){
      signal?.throwIfAborted();
      await fd.write(chunk);
      bytes+=chunk.length;
      if(bytes>2*1024*1024*1024)throw Error('文件超过 2GB 限制');
      // 进度按时间节流：一个 8K 材质包会流过几十万个 chunk，逐 chunk 上报会把任务快照
      // 冲得不停重写（前端轮询每次都会拉到新 revision）。
      const now=Date.now();
      if(progress&&now-lastReport>300){
        lastReport=now;
        progress({stage:'transferring',message:`正在下载材质包（${(bytes/1048576).toFixed(1)} MB${total?` / ${(total/1048576).toFixed(1)} MB`:''}）`,bytesWritten:bytes,totalBytes:total,transferRate:Math.round(bytes/Math.max(.001,(now-started)/1000))});
      }
    }
    await fd.sync();
  }finally{await fd.close();}
  await fs.rename(tmp,dest);
}
/**
 * Runner contract (mirrors the Poly Haven worker): turn one ambientCG material into
 * `textures/<Map>.<ext>` + info.json inside `output`, return `{zipName}`. Only PBR map files are
 * kept — the DCC sources inside the ZIP (.blend/.usdc/.mtlx/.tres) are recorded under
 * `skippedFiles` so nothing vanishes silently. The manager verifies, packs (zip when asked)
 * and commits afterwards, exactly like every other job in the queue.
 */
export async function runAmbientcgJob({uid,options,output,deliver='folder',workRoot,assetId,open=openPublic},{signal,progress=()=>{}}={}){
  signal?.throwIfAborted();
  if(!assetId)throw Error('ambientCG 资产 ID 缺失');
  const opts=options||{};
  await fs.mkdir(deliver==='folder'?output:path.dirname(output),{recursive:true});
  progress({stage:'starting',message:`正在获取 ambientCG 材质信息（${assetId}）…`});
  const params=new URLSearchParams({id:assetId,include:'title,url,maps,downloads'});
  const r=await open(`${API}/api/v3/assets?${params}`,{signal,timeout:45000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`ambientCG 资产信息返回 HTTP ${r.status}`);}
  const payload=JSON.parse(await readStreamText(r));
  const asset=(Array.isArray(payload?.assets)?payload.assets:[]).find(a=>a&&a.id===assetId);
  if(!asset)throw Error(`ambientCG 上找不到材质 ${assetId}`);
  const chosen=pickAmbientcgDownload(asset.downloads,{resolution:opts.resolution,textureFormat:opts.textureFormat});
  if(!chosen)throw Error('ambientCG 没有提供可下载的材质包');
  await fs.mkdir(workRoot||path.dirname(output),{recursive:true});
  const work=await fs.mkdtemp(path.join(workRoot||path.dirname(output),'acg-material-'));
  try{
    const zipPath=path.join(work,'source.zip');
    await downloadFile(chosen.url,zipPath,{open,signal,progress});
    signal?.throwIfAborted();
    const entries=await readZipDirectory(zipPath,{signal});
    const kept=[],skipped=[],used=new Set();
    for(const [index,entry] of entries.entries()){
      signal?.throwIfAborted();
      const token=mapTokenOf(entry.name);
      if(!token){skipped.push({file:entry.name,bytes:entry.length});continue;}
      const data=await extractEntry(zipPath,entry,{signal});
      let name=`${token.map}.${token.extension}`;
      for(let n=2;used.has(name);n++)name=`${token.map}-${n}.${token.extension}`;
      used.add(name);
      kept.push({name:`textures/${name}`,data,map:token.map,bytes:data.length,sourceFile:entry.name,index});
      progress({stage:'converting',message:`已解出贴图 ${kept.length}：${name}`,bytesWritten:kept.length,totalBytes:entries.length});
    }
    if(!kept.length)throw Error('这个材质包里没有识别到 PBR 贴图');
    const meta={
      uid,kind:'material',platform:'ambientcg',assetId,
      title:String(asset.title||assetId).slice(0,240),
      url:`https://ambientcg.com/a/${assetId}`,
      source_url:chosen.url,
      license:'CC0 1.0 通用公共领域贡献',
      resolution:String(opts.resolution||'2K'),format:String(opts.textureFormat||'JPG'),
      maps:Array.isArray(asset.maps)?asset.maps.map(String):[],
      textures:kept.map(k=>({file:k.name,map:k.map,bytes:k.bytes,sourceFile:k.sourceFile,url:chosen.url})),
      ...(skipped.length?{skippedFiles:skipped}:{}),
      note:'ambientCG 材质，CC0 1.0 通用公共领域贡献，可商用无需署名。贴图重命名自官方材质包。',
      exportedAt:new Date().toISOString(),tool:'AssetVault · ambientCG (CC0)',
    };
    const payloadEntries=kept.map(k=>({name:k.name,data:k.data}));
    payloadEntries.push({name:'info.json',data:Buffer.from(JSON.stringify(meta,null,2),'utf8')});
    progress({stage:'converting',message:deliver==='folder'?'正在写出材质文件夹…':'正在打包材质 ZIP…'});
    const written=await writeEntriesDeliverable({entries:payloadEntries,output,deliver,signal,progress,message:'材质贴图已就绪'});
    const stem=String(assetId).replace(/[^\w.-]/g,'_').slice(0,80)||'ambientcg';
    return {...written,zipName:`${stem}-material`,title:meta.title,author:'ambientCG',thumbnail:null};
  }finally{
    await fs.rm(work,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
  }
}
