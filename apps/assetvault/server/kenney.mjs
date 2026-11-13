// Kenney lists packs as server-rendered cards. The zip lives on the pack page.
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {openPublic} from './public-http.mjs';

const SITE='https://kenney.nl';
export function kenneyUid(slug){
 return createHash('md5').update(`kenney:${String(slug||'')}`).digest('hex');
}
export function parseKenneyCards(html){
 return String(html).split("class='asset'>").slice(1).map(block=>{
  const slug=block.match(/kenney\.nl\/assets\/([a-z0-9-]+)/i)?.[1];
  const name=block.match(/<h2><a [^>]*>([^<]+)/)?.[1];
  const thumbnail=block.match(/background-image:url\("([^"]+)"\)/)?.[1]||'';
  const category=block.match(/category:([^']+)'>([^<]+)/);
  const series=block.match(/series:([^']+)'>([^<]+)/);
  if(!slug||!name||slug.startsWith('category:')||slug.startsWith('series:')||slug.startsWith('page:'))return null;
  return {
   slug,name:name.trim(),thumbnail,
   category:category?decodeURIComponent(category[1]):'',
   categoryLabel:category?.[2]||'',
   series:series?decodeURIComponent(series[1]):'',
   seriesLabel:series?.[2]||'',
  };
 }).filter(Boolean);
}
export function kenneyZipUrl(html){
 return String(html).match(/https:\/\/kenney\.nl\/media\/[^"' ]+\.zip/i)?.[0]||'';
}
function cardOf(pack){
 return {
  uid:kenneyUid(pack.slug),
  platform:'kenney',
  assetId:pack.slug,
  assetType:'pack',
  name:pack.name,
  author:'Kenney',
  thumbnail:pack.thumbnail.startsWith('https://')?pack.thumbnail:'',
  url:`${SITE}/assets/${pack.slug}`,
  license:'CC0 1.0 通用公共领域贡献',
  downloadable:true,
  categories:[pack.categoryLabel,pack.seriesLabel].filter(Boolean),
  faces:null,vertices:null,likes:0,views:0,animations:0,
 };
}
let catalogPromise=null;
async function readText(r){
 const chunks=[];
 for await(const chunk of r.stream)chunks.push(chunk);
 return Buffer.concat(chunks).toString('utf8');
}
async function loadCatalog({signal,open}){
 const packs=[];
 const seen=new Set();
 for(let page=1;page<=20;page++){
  signal?.throwIfAborted();
  const url=page===1?`${SITE}/assets`:`${SITE}/assets/page:${page}`;
  const r=await open(url,{signal,timeout:45000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}break;}
  const cards=parseKenneyCards(await readText(r));
  const fresh=cards.filter(card=>!seen.has(card.slug));
  if(!fresh.length)break;
  for(const card of fresh){seen.add(card.slug);packs.push(card);}
 }
 return packs;
}
export async function kenneySearch(input={},{signal,open=openPublic}={}){
 signal?.throwIfAborted();
 const cursor=input.cursor?(typeof input.cursor==='string'?JSON.parse(input.cursor):input.cursor):{};
 const q=String(cursor.q??input.q??'').trim().toLowerCase();
 const category=String(cursor.category??input.category??'');
 const series=String(cursor.series??input.series??'');
 const page=Math.max(1,Number(cursor.page??input.page)||1);
 if(!catalogPromise)catalogPromise=loadCatalog({signal,open}).catch(error=>{catalogPromise=null;throw error;});
 const packs=await catalogPromise;
 const filtered=packs.filter(pack=>{
  if(category&&pack.category!==category)return false;
  if(series&&pack.series!==series)return false;
  if(q&&!`${pack.name} ${pack.slug} ${pack.seriesLabel}`.toLowerCase().includes(q))return false;
  return true;
 });
 const start=(page-1)*24;
 const slice=filtered.slice(start,start+24);
 return {
  models:slice.map(cardOf),received:slice.length,total:filtered.length,page,
  next:start+24<filtered.length?JSON.stringify({q,category,series,page:page+1}):null,
  pending:[],
  source:'Kenney · CC0 资源包',
  warnings:filtered.length?[]:['Kenney 上没有匹配当前筛选的资源包'],
  query:q,
 };
}
export async function kenneyCategories({signal,open=openPublic}={}){
 if(!catalogPromise)catalogPromise=loadCatalog({signal,open}).catch(error=>{catalogPromise=null;throw error;});
 const packs=await catalogPromise;
 const count=(key,field)=>{
  const map=new Map();
  for(const pack of packs){
   const value=pack[field];
   if(!value)continue;
   const row=map.get(value)||{value,label:pack[`${field}Label`]||value,count:0};
   row.count++;map.set(value,row);
  }
  return [...map.values()].sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label));
 };
 return {categories:count('category','category'),series:count('series','series')};
}
export async function runKenneyJob({uid,output,assetId},{signal,progress=()=>{}}={}){
 signal?.throwIfAborted();
 const slug=String(assetId||'').trim();
 if(!/^[a-z0-9-]{1,80}$/i.test(slug))throw Error('Kenney 资源包 ID 无效');
 await fs.mkdir(output,{recursive:true});
 progress({stage:'starting',message:`正在读取 Kenney 资源包（${slug}）…`});
 const page=await openPublic(`${SITE}/assets/${slug}`,{signal,timeout:45000});
 if(page.status<200||page.status>=300){try{page.stream.destroy();}catch{}throw Error(`Kenney 资源页返回 HTTP ${page.status}`);}
 const zip=kenneyZipUrl(await readText(page));
 if(!zip)throw Error('这个 Kenney 资源包没有公开的 ZIP');
 progress({stage:'transferring',message:'正在下载资源包…'});
 const file=await openPublic(zip,{signal,timeout:120000});
 if(file.status<200||file.status>=300){try{file.stream.destroy();}catch{}throw Error(`资源包下载失败 HTTP ${file.status}`);}
 const dest=path.join(output,'pack.zip');
 const fd=await fs.open(dest,'w');
 try{for await(const chunk of file.stream){signal?.throwIfAborted();await fd.write(chunk);}}finally{await fd.close();}
 const stat=await fs.stat(dest);
 const meta={uid,kind:'pack',platform:'kenney',assetId:slug,url:`${SITE}/assets/${slug}`,license:'CC0 1.0 通用公共领域贡献',files:[{file:'pack.zip',bytes:stat.size,url:zip}],note:'Kenney 资源包，CC0，可商用无需署名。',exportedAt:new Date().toISOString(),tool:'AssetVault · Kenney'};
 await fs.writeFile(path.join(output,'info.json'),JSON.stringify(meta,null,2),'utf8');
 return {zipName:`${slug}-pack`};
}
