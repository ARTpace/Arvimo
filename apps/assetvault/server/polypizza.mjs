// Poly Pizza publishes its search results inside the page (no anonymous API key).
// Each model page names a static glTF binary: https://static.poly.pizza/<resourceId>.glb
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {openPublic} from './public-http.mjs';

const SITE='https://poly.pizza';
const PER_PAGE=32;
export function polypizzaUid(id){
 return createHash('md5').update(`polypizza:${String(id||'')}`).digest('hex');
}
export function parsePolyPizzaState(html){
 const start=String(html).indexOf('window.__SERVER_APP_STATE__');
 if(start<0)return null;
 const raw=String(html).slice(start).replace(/^[\s\S]*?=\s*/,'').replace(/;?\s*<\/script>[\s\S]*$/,'');
 try{return JSON.parse(raw);}catch{return null;}
}
function cardOf(item){
 const id=String(item?.publicID||'').trim();
 if(!id)return null;
 return {
  uid:polypizzaUid(id),
  platform:'polypizza',
  assetId:id,
  name:String(item.title||id).slice(0,240),
  author:String(item.creator?.username||'Poly Pizza').slice(0,100),
  thumbnail:typeof item.previewUrl==='string'&&item.previewUrl.startsWith('https://')?item.previewUrl:'',
  url:`${SITE}/m/${id}`,
  license:String(item.licence||'查看许可').slice(0,80),
  downloadable:true,
  faces:null,vertices:null,likes:0,views:0,animations:0,
 };
}
async function readText(r){
 const chunks=[];
 for await(const chunk of r.stream)chunks.push(chunk);
 return Buffer.concat(chunks).toString('utf8');
}
export async function polypizzaSearch(input={},{signal,open=openPublic}={}){
 signal?.throwIfAborted();
 const cursor=input.cursor?(typeof input.cursor==='string'?JSON.parse(input.cursor):input.cursor):{};
 const q=String(cursor.q??input.q??'').trim().slice(0,80);
 const page=Math.max(1,Number(cursor.page??input.page)||1);
 const cc0=cursor.cc0??input.cc0;
 const slug=encodeURIComponent(q||'tree');
 const url=page<=1?`${SITE}/search/${slug}`:`${SITE}/search/${slug}/${page}`;
 const r=await open(url,{signal,timeout:45000});
 if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`Poly Pizza 搜索返回 HTTP ${r.status}`);}
 const state=parsePolyPizzaState(await readText(r));
 const rows=Array.isArray(state?.initialData?.result)?state.initialData.result:[];
 const models=rows.map(cardOf).filter(Boolean).filter(model=>cc0!==true||/cc0/i.test(model.license));
 const total=Number(state?.initialData?.resultCount)||models.length;
 const hasMore=models.length>0&&page*PER_PAGE<total;
 return {
  models,received:models.length,total,page,
  next:hasMore?JSON.stringify({q,page:page+1,cc0:cc0===true}):null,
  pending:[],
  source:'Poly Pizza',
  warnings:models.length?[]:[`Poly Pizza 上没有匹配 “${q||'当前筛选'}” 的模型`],
  query:q,
 };
}
export function polypizzaGlbUrl(html){
 const page=String(html);
 const hit=page.match(/https:\/\/static\.poly\.pizza\/[0-9a-f-]{36}\.glb/i);
 return hit?hit[0].replace(/\.glb\.br$/i,'.glb'):'';
}
export async function runPolypizzaJob({uid,output,assetId},{signal,progress=()=>{}}={}){
 signal?.throwIfAborted();
 if(!assetId)throw Error('Poly Pizza 资产 ID 缺失');
 await fs.mkdir(output,{recursive:true});
 progress({stage:'starting',message:`正在读取 Poly Pizza 模型页（${assetId}）…`});
 const page=await openPublic(`${SITE}/m/${encodeURIComponent(assetId)}`,{signal,timeout:45000});
 if(page.status<200||page.status>=300){try{page.stream.destroy();}catch{}throw Error(`Poly Pizza 模型页返回 HTTP ${page.status}`);}
 const glb=polypizzaGlbUrl(await readText(page));
 if(!glb)throw Error('这个 Poly Pizza 模型没有公开的 glTF 文件');
 progress({stage:'transferring',message:'正在下载 glTF…'});
 const file=await openPublic(glb,{signal,timeout:120000});
 if(file.status<200||file.status>=300){try{file.stream.destroy();}catch{}throw Error(`glTF 下载失败 HTTP ${file.status}`);}
 const dest=path.join(output,'model.glb');
 const fd=await fs.open(dest,'w');
 try{for await(const chunk of file.stream){signal?.throwIfAborted();await fd.write(chunk);}}finally{await fd.close();}
 const meta={uid,platform:'polypizza',assetId,url:`${SITE}/m/${assetId}`,format:'glb',exportedAt:new Date().toISOString(),tool:'AssetVault · Poly Pizza',note:'Poly Pizza 公开 glTF。许可以模型页为准，CC0 与 CC-BY 都会出现。'};
 await fs.writeFile(path.join(output,'info.json'),JSON.stringify(meta,null,2),'utf8');
 return {zipName:`${String(assetId).replace(/[^\w.-]/g,'_').slice(0,80)}.zip`};
}
