// What pictures one asset owns, per platform.
//
// Every image pipeline starts from the same two questions — which pictures does this asset have,
// and what is the largest copy of each one a visitor is allowed to fetch — and every platform
// answers them differently. Those answers are the only part of image downloading that changes when
// a platform joins or an API shifts, so they live in one registry and nowhere else: the bundle
// writer and the queue ask a name here, and never branch on a platform themselves.
import {isSketchfabHost,publicJson} from './public-http.mjs';
import {fetchProjectJson,projectImageAssets,project3dAssets} from './artstation-project.mjs';
import {downloadUrl as artstationDownloadUrl} from './artstation-cdn.mjs';
import {polyhavenRenders,polyhavenAssetMeta} from './polyhaven.mjs';
import {ambientcgRenders} from './ambientcg.mjs';
import {collectPictureAssets,isPictureSite} from './picture-sites.mjs';
import {tagList} from './tag-list.mjs';

/** How many pictures one asset may contribute. Real uploads sit far below this; anything larger is
 *  a collected gallery and is truncated rather than silently queued for gigabytes. */
export const IMAGE_MAX=60;

/** Keep only https URLs on the platform's own CDN — nothing else is allowed to reach the disk. */
function mediaUrl(value,allowed){
  try{const u=new URL(value);return u.protocol==='https:'&&allowed(u.hostname)?u.href:null;}
  catch{return null;}
}
const authorName=data=>data?.user?.displayName||data?.user?.username||null;
const trimmed=value=>typeof value==='string'&&value.trim()?value.trim():null;

/**
 * Sketchfab publishes one cover in several renditions; they are all the same picture, so the widest
 * one *is* the original as far as a download is concerned and every smaller one would be a duplicate
 * file in the bundle. Returning exactly one item keeps that decision here rather than in the writer.
 */
export function largestSketchfabPreview(data){
  const images=(data?.thumbnails?.images||[])
    .map(i=>({url:mediaUrl(i.url,isSketchfabHost),width:Number(i.width)||0,height:Number(i.height)||0}))
    .filter(i=>i.url&&i.width>0)
    .sort((a,b)=>b.width-a.width||b.height-a.height);
  if(!images.length)return null;
  const best=images[0];
  return {url:best.url,width:best.width,height:best.height,title:trimmed(data?.name)};
}

/**
 * Which of a project's assets may be fetched: `image` assets whose URL sits on ArtStation's CDN,
 * repointed at the largest rendition the CDN actually serves (`large` — `original` answers 403 to
 * everyone but the author). Anything the CDN would refuse is reported as skipped rather than dropped
 * silently, because a job that downloads fewer pictures than expected has to be able to say so.
 */
export function planArtstationImages(assets,{limit=IMAGE_MAX}={}){
  const items=[],skipped=[];
  for(const asset of assets||[]){
    const url=artstationDownloadUrl(asset.url);
    if(!url){skipped.push({...asset,reason:'not-cdn'});continue;}
    if(items.length>=limit){skipped.push({...asset,reason:'over-limit'});continue;}
    items.push({...asset,url});
  }
  return {items,skipped};
}

export const IMAGE_SOURCES=Object.freeze({
  sketchfab:{
    id:'sketchfab',
    label:'Sketchfab 封面原图',
    client:'sketchfab',
    async resolve({uid},{json=publicJson,signal}={}){
      const data=await json(`https://api.sketchfab.com/v3/models/${uid}`,{signal});
      const preview=largestSketchfabPreview(data);
      if(!preview)throw Error('这个 Sketchfab 模型没有提供公开图片');
      return {items:[preview],skipped:[],title:trimmed(data?.name),author:authorName(data),tags:tagList(data?.tags),cover:preview.url,source:`https://api.sketchfab.com/v3/models/${uid}`,rendition:'original'};
    },
  },
  artstation:{
    id:'artstation',
    label:'ArtStation 作品图片',
    client:'artstation',
    async resolve({url},{open,signal}={}){
      const json=await fetchProjectJson(url,{open,signal});
      if(!json)throw Error('读取 ArtStation 作品信息失败（站点可能要求验证），请稍后重试');
      const planned=planArtstationImages(projectImageAssets(json));
      const scenes=project3dAssets(json);
      if(!planned.items.length&&!scenes.length)throw Error('这个作品没有可预览的图片或 3D 场景');
      return {...planned,scenes,title:trimmed(json.title),author:trimmed(json.user?.full_name||json.user?.username),authorUrl:json.user?.username?`https://www.artstation.com/${encodeURIComponent(json.user.username)}`:'',description:trimmed(json.description),tags:tagList(json.tags),cover:planned.items[0]?.url||null,source:typeof url==='string'?url:null,rendition:'large'};
    },
  },
  polyhaven:{
    id:'polyhaven',
    label:'Poly Haven 官方渲染图',
    client:'polyhaven',
    async resolve({assetId},{open,signal}={}){
      if(!assetId)throw Error('Poly Haven 资产 ID 缺失');
      const list=await polyhavenRenders(assetId,{signal,open});
      if(!list.length)throw Error('这个 Poly Haven 资产暂时没有提供可下载图片');
      const first=list[0]||{};
      // Poly Haven 资产的 categories（如 Furniture/Seating/Chairs 路径串）与 tags 是最现成的
      // 「分类 / 关联信息 → 标签」来源；renders 接口不含它们，这里单独补一次元数据查询。
      const meta=await polyhavenAssetMeta(assetId,{signal,open});
      const tags=tagList([...(meta.categories||[]),...(meta.tags||[])]);
      return {items:list.map(x=>({url:x.url,title:x.title||null,width:null,height:null,tags})),skipped:[],title:String(assetId).slice(0,120),author:'Poly Haven',cover:first?.url||null,source:first?.source||null,rendition:'original',tags};
    },
  },
  ambientcg:{
    id:'ambientcg',
    label:'ambientCG 官方缩略图',
    client:'ambientcg',
    async resolve({assetId},{open,signal}={}){
      if(!assetId)throw Error('ambientCG 资产 ID 缺失');
      const list=await ambientcgRenders(assetId,{signal,open});
      if(!list.length)throw Error('这个 ambientCG 材质暂时没有提供可下载图片');
      const first=list[0]||{};
      // ambientcgRenders 已把素材自带 tags 一并取回；逐图与结果顶层都带上，
      // 下载包 info.json 的「逐图 + 顶层」两路都会收进去。
      return {items:list.map(x=>({url:x.url,title:x.title||null,width:null,height:null,tags:x.tags})),skipped:[],title:String(assetId).slice(0,120),author:'ambientCG',cover:first?.url||null,source:first?.source||null,rendition:'original',tags:first?.tags};
    },
  },
});

/** Ask one platform for the pictures of one asset. The registry is the whole dispatch. */
export async function collectImageAssets(platform,{uid,url,assetId}={},options={}){
  // 图站抓取（素材下载器整合）：命中 PICTURE_SITES 走独立注册表，否则回落 3D 资产图片源。
  // 图站结果里混着视频（Civitai 的 mp4 投稿）：预览层要播它，但图片库只收图片，
  // 否则 mp4 会被当成 jpg 存进库里，后面缩略图/对比这些流程全部报错。
  if(isPictureSite(platform)){
    const data=await collectPictureAssets(platform,{url},options);
    const all=Array.isArray(data.items)?data.items:[];
    const items=all.filter(item=>item.type!=='video');
    return {...data,items};
  }
  const source=IMAGE_SOURCES[platform];
  if(!source)throw Error('这个来源暂时不支持下载图片');
  return {...(await source.resolve({uid,url,assetId},options)),platform:source.id,client:source.client,label:source.label};
}
