// ArtStation project JSON API access.
//
// The `/artwork/<hash>` page is now an Angular SPA shell that no longer carries
// the Marmoset embed markup in its server HTML, so scraping it fails. The public
// project JSON (`/projects/<hash>.json`) still lists every asset, including the
// `marmoset` one whose `player_embedded` iframe points at `/embed/<id>`.
import {createHash} from 'node:crypto';
import {openPublic} from './public-http.mjs';
import {normalizePlatformCategories} from './platform-categories.mjs';

/** ArtStation hash ids are 4–20 alphanumerics (`lEVE8J`). */
export const ARTSTATION_HASH=/^[A-Za-z0-9]{4,20}$/;

/** Stable 32-hex identity: the library's uid shape is `^[a-f0-9]{32}$` (inherited from
 *  Sketchfab), so hashing the ArtStation hash lets favourites, the model library, task
 *  persistence and dedupe work for both platforms without a second id scheme. */
export function artstationUid(hashId){
  const hash=String(hashId||'').trim();
  if(!ARTSTATION_HASH.test(hash))return null;
  return createHash('md5').update(`artstation:${hash}`).digest('hex');
}

/** `https://www.artstation.com/artwork/lEVE8J` -> `lEVE8J` (or null). */
export function artstationHash(href){
  try{const m=new URL(href).pathname.match(/^\/artwork\/([A-Za-z0-9]+)\/?$/);return m?m[1]:null;}
  catch{return null;}
}

export async function readStreamText(r,limit=4*1024*1024){
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

/** Public project JSON URL for an artwork href, or null when the href is not an artwork page. */
export function projectJsonUrl(href){
  const hash=artstationHash(href);
  return hash?`https://www.artstation.com/projects/${hash}.json`:null;
}

/** artwork URL -> parsed project JSON, or null when it cannot be read. The one fetch both the
 *  Marmoset and the image pipelines share: the endpoint is Cloudflare-gated, so hitting it twice
 *  for one job would double the chance of a challenge fallback. */
export async function fetchProjectJson(href,{open=openPublic,signal}={}){
  const url=projectJsonUrl(href);
  if(!url)return null;
  const r=await open(url,{artstation:true,signal,timeout:30000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}return null;}
  try{return JSON.parse(await readStreamText(r));}
  catch{return null;}
}

/**
 * The `image` assets of a project, in author order, as plain data — no URL rewriting here.
 * `has_image` is false on derived renditions (the `cover` asset points at another asset's file),
 * so type alone is not enough to tell a real upload apart from a repackaged one.
 */
export function projectImageAssets(json){
  return (json?.assets||[])
    .filter(a=>a&&a.asset_type==='image'&&a.has_image!==false&&typeof a.image_url==='string'&&a.image_url)
    .map((a,i)=>({
      id:String(a.id||''),
      position:Number.isFinite(a.position)?a.position:i,
      title:typeof a.title==='string'?a.title.trim():'',
      width:Number.isFinite(a.width)?a.width:null,
      height:Number.isFinite(a.height)?a.height:null,
      url:a.image_url,
    }))
    .sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));
}

/** artwork URL -> { ids, title, author } from the project JSON, or null when unavailable. */
export function project3dAssets(json){
  return (json?.assets||[]).filter(a=>a?.asset_type==='marmoset')
    .map((a,i)=>{
      const id=String(a.player_embedded||'').match(/https?:\/\/(?:www\.)?artstation\.com\/embed\/(\d+)(?=[/?"'\s<]|$)/i)?.[1];
      return id?{id,type:'3d',embedUrl:`https://www.artstation.com/embed/${id}`,title:a.title||`3D 场景 ${i+1}`,thumb:a.image_url||null,position:Number.isFinite(a.position)?a.position:i}:null;
    }).filter(Boolean).sort((a,b)=>a.position-b.position);
}

export async function fetchProjectAssets(href,{open=openPublic,signal}={}){
  const json=await fetchProjectJson(href,{open,signal});
  if(!json)return null;
  const ids=project3dAssets(json).map(asset=>asset.id);
  return {ids:[...new Set(ids)],title:json.title||null,author:(json.user&&json.user.username)||null,
    platformCategories:normalizePlatformCategories('artstation',[...(Array.isArray(json.categories)?json.categories:[]),...(Array.isArray(json.category_ids)?json.category_ids:[])])};
}
