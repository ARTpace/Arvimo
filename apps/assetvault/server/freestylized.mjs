// FreeStylized — stylized models, skyboxes, textures and packs.
// Public WordPress REST lists the assets. The file itself is a Google Drive link on the asset page.
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {openPublic} from './public-http.mjs';
import {readStreamText} from './artstation-project.mjs';

const SITE='https://freestylized.com';
const PER_PAGE=24;
export const FREESTYLIZED_TYPES={
 models:{rest:'3d_models',path:'3d_models',label:'3D 模型',category:slug=>/_3d_models$/i.test(slug)},
 skybox:{rest:'skybox',path:'skybox',label:'天空盒',category:slug=>/sky/i.test(slug)||slug==='anime'||slug==='90s_anime'},
 textures:{rest:'material',path:'material',label:'材质',category:slug=>!/_3d_models$/i.test(slug)&&!/sky/i.test(slug)&&!['anime','90s_anime','free','stylized','asset_pack','blog','3d-model','stylized-textures','skybox'].includes(slug)},
 packs:{rest:'asset_pack',path:'asset_pack',label:'资源包',category:()=>false},
 alphas:{rest:'alpha',path:'alpha',label:'Alpha',category:()=>false},
 smart:{rest:'smart_material',path:'smart_material',label:'智能材质',category:()=>false},
};
export function freestylizedType(value){return FREESTYLIZED_TYPES[value]?value:'models';}
export function freestylizedUid(type,slug){return createHash('md5').update(`freestylized:${type}:${slug}`).digest('hex');}

export function freestylizedDriveId(html){
 const text=String(html||'');
 const uc=text.match(/drive\.google\.com\/uc\?[^"'\\\s]*id=([a-zA-Z0-9_-]{10,})/);
 if(uc)return uc[1];
 const file=text.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{10,})/);
 return file?file[1]:'';
}
const ZIP_TIERS=['1k','2k','4k','8k'];
/** Prefer the requested resolution, then the next lower public zip, then any zip on the page. */
export function freestylizedFileUrl(html,{resolution='2K'}={}){
 const text=String(html||'');
 const zips=[...text.matchAll(/https:\/\/pub-[a-z0-9]+\.r2\.dev\/[^"'\\\s<>]+\.zip/gi)].map(m=>m[0]);
 if(zips.length){
  const want=String(resolution||'2K').toLowerCase();
  const tier=url=>(url.match(/\/(\d+k)\//i)||[])[1]?.toLowerCase()||'';
  const exact=zips.find(url=>tier(url)===want);
  if(exact)return exact;
  const ranked=zips.map(url=>({url,tier:tier(url)})).filter(row=>ZIP_TIERS.includes(row.tier));
  const wantIndex=ZIP_TIERS.indexOf(want);
  const lower=ranked.filter(row=>ZIP_TIERS.indexOf(row.tier)<=wantIndex).sort((a,b)=>ZIP_TIERS.indexOf(b.tier)-ZIP_TIERS.indexOf(a.tier));
  if(lower.length)return lower[0].url;
  if(ranked.length)return ranked.sort((a,b)=>ZIP_TIERS.indexOf(a.tier)-ZIP_TIERS.indexOf(b.tier))[0].url;
  return zips[0];
 }
 const id=freestylizedDriveId(text);
 return id?`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`:'';
}

function thumbOf(item){
 const media=item?._embedded?.['wp:featuredmedia']?.[0];
 const sizes=media?.media_details?.sizes||{};
 const url=sizes.medium?.source_url||sizes.medium_large?.source_url||media?.source_url||'';
 return /^https:\/\//i.test(url)?url:'';
}
function titleOf(item){
 const raw=item?.title?.rendered||item?.slug||'';
 return String(raw).replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').trim().slice(0,240);
}
export function normalizeFreestylized(item,type){
 const spec=FREESTYLIZED_TYPES[freestylizedType(type)];
 const slug=String(item?.slug||'').trim();
 if(!slug)return null;
 return {
  uid:freestylizedUid(spec===FREESTYLIZED_TYPES[type]?type:freestylizedType(type),slug),
  platform:'freestylized',
  assetId:slug,
  assetType:freestylizedType(type),
  name:titleOf(item)||slug,
  author:'FreeStylized',
  thumbnail:thumbOf(item),
  url:item?.link||`${SITE}/${spec.path}/${slug}/`,
  license:'FreeStylized 免费资源，下载前请在官网确认授权范围',
  downloadable:true,
 };
}

async function wpJson(url,{signal,open}){
 const r=await open(url,{signal,timeout:45000});
 if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`FreeStylized 返回 HTTP ${r.status}`);}
 return {json:JSON.parse(await readStreamText(r)),headers:r.headers};
}

export async function freestylizedSearch(input={},{signal,open=openPublic}={}){
 signal?.throwIfAborted();
 const cursor=input.cursor?(typeof input.cursor==='string'?JSON.parse(input.cursor):input.cursor)||{}:{};
 const type=freestylizedType(cursor.type??input.type);
 const spec=FREESTYLIZED_TYPES[type];
 const q=String(cursor.q??input.q??'').trim().slice(0,200);
 const category=String(cursor.category??input.category??'').replace(/\D/g,'').slice(0,12);
 const page=Math.max(1,Math.min(200,Number(cursor.page??input.page)||1));
 const params=new URLSearchParams({per_page:String(PER_PAGE),page:String(page),_embed:'1',orderby:(cursor.sort??input.sort)==='newest'||!q?'date':'relevance',order:'desc'});
 if(q)params.set('search',q);
 if(category)params.set('categories',category);
 const {json,headers}=await wpJson(`${SITE}/wp-json/wp/v2/${spec.rest}?${params}`,{signal,open});
 const models=(Array.isArray(json)?json:[]).map(item=>normalizeFreestylized(item,type)).filter(Boolean);
 const total=Number(headers['x-wp-total'])||models.length;
 const pages=Number(headers['x-wp-totalpages'])||1;
 return {
  models,received:models.length,total,page,
  next:page<pages?JSON.stringify({q,page:page+1,type,category,sort:cursor.sort??input.sort??''}):null,
  pending:[],
  source:`FreeStylized · ${spec.label}`,
  warnings:models.length?[]:[`FreeStylized 上没有匹配的${spec.label}`],
  query:q,
 };
}

export async function freestylizedCategories(type,{signal,open=openPublic}={}){
 const spec=FREESTYLIZED_TYPES[freestylizedType(type)];
 const {json}=await wpJson(`${SITE}/wp-json/wp/v2/categories?per_page=100`,{signal,open});
 const categories=(Array.isArray(json)?json:[])
  .filter(row=>row?.count>0&&spec.category(String(row.slug||'')))
  .map(row=>({value:String(row.id),label:String(row.name||row.slug),count:row.count}))
  .sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label));
 return {type:freestylizedType(type),categories};
}

async function downloadFile(url,dest,{signal,open}){
 const r=await open(url,{signal,timeout:180000});
 if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`Google Drive 下载失败 HTTP ${r.status}`);}
 const mime=String(r.headers['content-type']||'');
 if(mime.includes('text/html')){try{r.stream.destroy();}catch{}throw Error('Google Drive 没有直接返回文件，请到资产页手动确认下载');}
 await fs.mkdir(path.dirname(dest),{recursive:true});
 const fd=await fs.open(dest,'w');
 try{
  let bytes=0;
  for await(const chunk of r.stream){
   signal?.throwIfAborted();
   bytes+=chunk.length;
   if(bytes>2*1024*1024*1024)throw Error('文件超过 2GB 限制');
   await fd.write(chunk);
  }
 }finally{await fd.close();}
}

export async function runFreestylizedJob({uid,output,assetId,assetType,options},{signal,progress=()=>{},open=openPublic}={}){
 const type=freestylizedType(assetType);
 const spec=FREESTYLIZED_TYPES[type];
 const slug=String(assetId||'').trim();
 if(!/^[a-z0-9_-]{1,80}$/i.test(slug))throw Error('FreeStylized 资产 ID 无效');
 await fs.mkdir(output,{recursive:true});
 const pageUrl=`${SITE}/${spec.path}/${slug}/`;
 progress({stage:'starting',message:`正在读取 FreeStylized ${spec.label}（${slug}）…`});
 const page=await open(pageUrl,{signal,timeout:45000});
 if(page.status<200||page.status>=300){try{page.stream.destroy();}catch{}throw Error(`资产页返回 HTTP ${page.status}`);}
 const html=await readStreamText(page);
 const fileUrl=freestylizedFileUrl(html,{resolution:options?.resolution});
 if(!fileUrl)throw Error('这个 FreeStylized 资产没有公开下载（部分资源包只在 Patreon 提供）');
 progress({stage:'transferring',message:'正在下载资源包…'});
 const dest=path.join(output,'pack.zip');
 await downloadFile(fileUrl,dest,{signal,open});
 const stat=await fs.stat(dest);
 const meta={uid,kind:'pack',platform:'freestylized',assetId:slug,assetType:type,url:pageUrl,license:'FreeStylized 免费资源，下载前请在官网确认授权范围',files:[{file:'pack.zip',bytes:stat.size,url:fileUrl}],note:`FreeStylized ${spec.label}。`,exportedAt:new Date().toISOString(),tool:'AssetVault · FreeStylized'};
 await fs.writeFile(path.join(output,'info.json'),JSON.stringify(meta,null,2),'utf8');
 return {zipName:`${slug}-pack`};
}
