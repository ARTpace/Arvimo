import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {openPublic} from './public-http.mjs';

const HOST='https://hf-mirror.com';
const REPO='nvidia/simready-assets';
const encodePath=value=>value.split('/').map(encodeURIComponent).join('/');
export const simreadyUid=id=>createHash('md5').update(`simready:${id}`).digest('hex');
export function simreadyId(value){
 const id=String(value||'');
 if(!/^[a-zA-Z0-9_-]{1,180}$/.test(id))throw Error('SimReady 资产 ID 无效');
 return id;
}
async function readJson(url,{signal,open}){
 const r=await open(url,{signal,timeout:60000});
 if(r.status!==200){r.stream.destroy();throw Error(`SimReady 接口返回 HTTP ${r.status}`);}
 const chunks=[];for await(const chunk of r.stream)chunks.push(chunk);
 return {data:JSON.parse(Buffer.concat(chunks).toString('utf8')),headers:r.headers};
}
async function tree(folder,{signal,open=openPublic}={}){
 let url=`${HOST}/api/datasets/${REPO}/tree/main${folder?'/'+encodePath(folder):''}?recursive=${Boolean(folder)}&limit=1000`;
 const rows=[],seen=new Set();
 while(url){
  signal?.throwIfAborted();
  if(seen.has(url))throw Error('SimReady 分页链接重复');
  seen.add(url);
  const {data,headers}=await readJson(url,{signal,open});
  if(!Array.isArray(data))throw Error('SimReady 文件列表无效');
  rows.push(...data);
  const next=String(headers?.link||'').match(/<([^>]+)>;\s*rel="next"/i)?.[1];
  url=next?new URL(next,HOST).href:'';
  if(url){
   const u=new URL(url);
   if(![HOST,'https://huggingface.co'].includes(u.origin)||u.pathname!==`/api/datasets/${REPO}/tree/main${folder?'/'+encodePath(folder):''}`)throw Error('SimReady 分页链接无效');
   // 镜像沿用官方分页响应头，后续请求仍通过镜像发送。
   url=HOST+u.pathname+u.search;
  }
 }
 return rows;
}
const fileUrl=file=>`${HOST}/datasets/${REPO}/resolve/main/${encodePath(file)}`;
export async function simreadySearch(input={},options={}){
 const cursor=input.cursor?JSON.parse(input.cursor):{};
 const q=String(cursor.q??input.q??'').trim().slice(0,200);
 const page=Math.max(1,Number(cursor.page)||1);
 const tokens=q.toLowerCase().split(/[\s_-]+/).filter(Boolean);
 const all=(await tree('',options)).filter(row=>row.type==='directory'&&/^[\w-]+$/.test(row.path)&&tokens.every(word=>row.path.toLowerCase().includes(word)));
 // ponytail: 官方目录名就是检索索引；不额外维护数据库或分类映射。
 const models=await Promise.all(all.slice((page-1)*24,page*24).map(async row=>{
  const id=simreadyId(row.path);
  const files=await tree(id,options);
  const thumb=files.find(f=>f.type==='file'&&/\/simready_usd\/\.thumbs\/256x256\/.*\.usd\.png$/i.test(f.path))||files.find(f=>/\/simready_usd\/\.thumbs\/[^/]+\.png$/i.test(f.path));
  return {uid:simreadyUid(id),platform:'simready',assetId:id,name:id.replace(/_/g,' '),author:'NVIDIA',license:'CC BY 4.0',downloadable:true,assetType:'models',thumbnail:thumb?fileUrl(thumb.path):'',url:`${HOST}/datasets/${REPO}/tree/main/${encodeURIComponent(id)}`};
 }));
 return {models,total:all.length,received:models.length,next:page*24<all.length?JSON.stringify({q,page:page+1}):null,pending:[],warnings:[],source:'NVIDIA SimReady',query:q};
}
export async function runSimreadyJob({uid,assetId,output},{signal,progress=()=>{},open=openPublic}={}){
 const id=simreadyId(assetId),rows=(await tree(id,{signal,open})).filter(row=>row.type==='file');
 if(!rows.some(row=>/\.(usd|usdc|usda|usdz)$/i.test(row.path)))throw Error('SimReady 目录里没有 USD 模型');
 const files=[];
 await fs.mkdir(output,{recursive:true});
 for(const row of rows){
  signal?.throwIfAborted();
  const relative=row.path.slice(id.length+1);
  if(!row.path.startsWith(id+'/')||!relative||relative.split('/').some(s=>!s||s==='.'||s==='..'||/[\\:\x00-\x1f]/.test(s)))throw Error('SimReady 文件路径无效');
  const dest=path.join(output,...relative.split('/'));
  await fs.mkdir(path.dirname(dest),{recursive:true});
  progress({stage:'transferring',message:`正在下载 SimReady ${files.length+1}/${rows.length}：${relative}`});
  const r=await open(fileUrl(row.path),{signal,timeout:120000});
  if(r.status!==200){r.stream.destroy();throw Error(`SimReady 文件下载返回 HTTP ${r.status}`);}
  const fd=await fs.open(dest,'w');let bytes=0;
  try{for await(const chunk of r.stream){signal?.throwIfAborted();await fd.writeFile(chunk);bytes+=chunk.length;}}finally{await fd.close();}
  if(bytes!==row.size)throw Error(`SimReady 文件不完整：${relative}`);
  files.push({file:relative,bytes});
 }
 await fs.writeFile(path.join(output,'info.json'),JSON.stringify({uid,platform:'simready',kind:'model',assetType:'models',assetId:id,name:id.replace(/_/g,' '),author:'NVIDIA',license:'CC BY 4.0',source_url:`https://huggingface.co/datasets/${REPO}/tree/main/${id}`,format:'usd',files,exportedAt:new Date().toISOString()},null,2));
 return {zipName:id+'.zip'};
}

// ponytail: preview only the render layers; keep simulation/MDL files in the original download.
export async function simreadyPreview(value,options={}){
 const id=simreadyId(value),rows=await tree(id,options);
 const layers=rows.filter(r=>r.type==='file'&&/\.(usd|usda|usdc)$/i.test(r.path)&&!r.path.includes('/source_assets/'));
 if(!layers.length)throw new Error('SimReady 目录里没有可预览的 USD 图层');
 for(const row of layers){
  const relative=row.path.slice(id.length+1);
  if(!row.path.startsWith(id+'/')||relative.split('/').some(p=>!p||p==='.'||p==='..'||/[\\:\x00-\x1f]/.test(p)))throw new Error('SimReady 文件路径无效');
 }
 const rootIndex=rows.find(r=>r.path===`${id}/.metadata/com.nvidia.simready.root_usds.json`);
 const roots=rootIndex?(await readJson(fileUrl(rootIndex.path),{...options,open:options.open||openPublic})).entries:[];
 const root=roots?.find(name=>layers.some(r=>r.path===`${id}/${name}`))||layers.find(r=>/^simready_usd\/[^/]+\.(usd|usda|usdc)$/i.test(r.path.slice(id.length+1)))?.path.slice(id.length+1);
 if(!root)throw new Error('SimReady 缺少入口 USD 图层');
 const visual=layers.find(r=>r.path===`${id}/simready_usd/payloads/base.usda`);
 return {originalRoot:root,root:visual?visual.path.slice(id.length+1):root,entries:layers.map(r=>({path:r.path.slice(id.length+1),url:fileUrl(r.path),bytes:r.size})),note:'直接读取原始 USD；MDL 材质显示为基础材质，仿真属性不参与预览。'};
}

export function isSimreadyFileUrl(url){
 return url.protocol==='https:'&&['hf-mirror.com','huggingface.co'].includes(url.hostname)&&url.pathname.startsWith('/datasets/nvidia/simready-assets/resolve/main/');
}
