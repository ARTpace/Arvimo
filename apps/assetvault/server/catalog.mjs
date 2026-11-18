import { isSketchfabHost, validateUrl, publicJson, readPublic } from './public-http.mjs';
import {searchParams,SORTS} from '../src/library/search-options.js';
import {normalizePlatformCategories} from './platform-categories.mjs';
export const UID=/^[a-f0-9]{32}$/i;
export function modelUid(value, base) {
  try {
    const u=new URL(value,base);
    if(!/^(www\.)?sketchfab\.com$/i.test(u.hostname)||!['https:','http:'].includes(u.protocol))return null;
    const m=u.pathname.match(/^\/(?:3d-models\/(?:[^/]+-)?|models\/)([a-f0-9]{32})(?:\/embed)?\/?$/i);
    return m?m[1].toLowerCase():null;
  }catch{return null;}
}
export function extractModelLinks(html, base) {
  const text=String(html).replace(/\\u002[fF]/g,'/').replace(/\\\//g,'/').replace(/&amp;|&#38;|&#x26;/gi,'&').replace(/&quot;|&#34;/gi,'"');
  const ids=new Set();const own=modelUid(base);if(own)ids.add(own);
  for(const match of text.matchAll(/(?:https?:)?\/\/(?:www\.)?sketchfab\.com\/(?:3d-models|models)\/[^\s"'<>\\]+|(?:href|src)\s*=\s*["']([^"']+)["']/gi)){
    const id=modelUid(match[1]||match[0],base);if(id)ids.add(id);
  }
  return [...ids];
}
const safeImage = value => {try {const u=new URL(value);return u.protocol==='https:'&&isSketchfabHost(u.hostname)?u.href:null;}catch{return null;}};
function licenseLink(value){try{const u=new URL(value);return u.hostname==='creativecommons.org'&&['http:','https:'].includes(u.protocol)?`https://creativecommons.org${u.pathname}`:null;}catch{return null;}}
export function normalizeModel(m) {
  if(!UID.test(m?.uid||''))return null;
  const images=(m.thumbnails?.images||[]).filter(i=>safeImage(i.url));
  images.sort((a,b)=>Math.abs((a.width||0)-720)-Math.abs((b.width||0)-720));
  const license=typeof m.license==='object'?m.license?.label||m.license?.fullName||m.license?.slug:m.license;
  return {uid:m.uid.toLowerCase(),name:String(m.name||'未命名模型').slice(0,240),
    author:String(m.user?.displayName||m.user?.username||'未知作者').slice(0,100),username:m.user?.username||'',
    thumbnail:images[0]?.url||null,url:`https://sketchfab.com/models/${m.uid.toLowerCase()}`,
    vertices:Number.isFinite(m.vertexCount)?m.vertexCount:null,faces:Number.isFinite(m.faceCount)?m.faceCount:null,
    likes:Number(m.likeCount)||0,views:Number(m.viewCount)||0,animations:Number(m.animationCount)||0,
    licenseUrl:licenseLink(m.license?.url),downloadable:m.isDownloadable===true,license:license?String(license).slice(0,200):'许可请查看原页面',
    platform:'sketchfab',platformCategories:normalizePlatformCategories('sketchfab',m.categories),
    categories:normalizePlatformCategories('sketchfab',m.categories).map(c=>c.name||c.slug).filter(Boolean),
    tags:(m.tags||[]).map(t=>String(t.name||t.slug||'')).slice(0,20),publishedAt:m.publishedAt||null};
}
function validNext(next) {
  if(!next)return null;const u=validateUrl(next,{sketchfabOnly:true});
  if(u.hostname!=='api.sketchfab.com'||!/^\/v3\/(?:search|models|users\/[a-f0-9]{32}\/(?:models|likes)|collections\/[a-f0-9]{32}\/models)(?:\/|$)/i.test(u.pathname))throw new Error('无效的模型分页地址');
  return u.href;
}
export async function searchPage(input, {signal,json=publicJson}={}) {
  if(input?.cursor){
    const next=validNext(input.cursor),u=new URL(next);
    if(u.pathname!=='/v3/search'||u.searchParams.get('type')!=='models')throw new Error('无效的资产搜索分页地址');
    return result(await json(next,{signal}),'Sketchfab 在线搜索');
  }
  const params=searchParams(input),api=new URL('https://api.sketchfab.com/v3/search');
  api.searchParams.set('type','models');api.searchParams.set('count','24');
  if(params.q)api.searchParams.set('q',params.q);
  if(params.category)api.searchParams.set('categories',params.category);
  // 浏览态：没关键词、没分类、排序还停在默认、也没勾任何筛选 —— 用户什么都没要求，界面就该给
  // 「新鲜的官方精选」，而不是一份永远不变的历史点赞榜（2026-10-16 用户反馈：每次打开都一样）。
  // 实测最新精选出的都是像样的模型；纯「最新发布」则会混进 Switch NSP、网络解锁文件这类垃圾上传。
  const browsing=!params.q&&!params.category&&params.sort==='relevance'&&!params.downloadable&&!params.animated&&!params.staffpicked;
  if(browsing){api.searchParams.set('staffpicked','true');api.searchParams.set('sort_by','-publishedAt');}
  else{const sort=SORTS[params.sort]||(!params.q?'-likeCount':null);if(sort)api.searchParams.set('sort_by',sort);}
  for(const key of ['downloadable','animated','staffpicked'])if(params[key])api.searchParams.set(key,'true');
  return {...result(await json(api.href,{signal}),'Sketchfab 在线搜索'),query:params};
}
export async function scanPage({url,cursor,ids}, {signal,json=publicJson,read=readPublic}={}) {
  if(Array.isArray(ids)) {
    const unique=[...new Set(ids)].filter(id=>UID.test(id)).slice(0,500);
    return hydrate(unique.slice(0,24),unique.slice(24),'网页中的模型链接',json,signal);
  }
  if(cursor){const api=validNext(cursor);const data=await json(api,{signal});return result(data,'继续检索');}
  const u=validateUrl(url);const id=modelUid(u.href);
  if(id){const m=normalizeModel(await json(`https://api.sketchfab.com/v3/models/${id}`,{signal}));return {models:m?[m]:[],next:null,pending:[],source:'单个模型',warnings:[]};}
  if(/^(www\.)?sketchfab\.com$/i.test(u.hostname)) {
    const collection=u.pathname.match(/\/collections\/[^/]*?([a-f0-9]{32})(?:\/|$)/i);
    if(collection)return result(await json(`https://api.sketchfab.com/v3/collections/${collection[1]}/models?count=24`,{signal}),'Sketchfab 合集');
    if(u.pathname==='/search'||u.pathname.startsWith('/3d-models')||u.pathname==='/'){
      if(u.searchParams.get('type')&&!['models'].includes(u.searchParams.get('type')))throw new Error('请使用模型搜索页，而不是用户搜索页');
      const api=new URL('https://api.sketchfab.com/v3/search');api.searchParams.set('type','models');api.searchParams.set('count','24');
      for(const key of ['q','sort_by','categories','tags','animated','downloadable','staffpicked'])if(u.searchParams.has(key))api.searchParams.set(key,u.searchParams.get(key));
      const features=u.searchParams.get('features')||'';if(features.includes('downloadable'))api.searchParams.set('downloadable','true');if(features.includes('animated'))api.searchParams.set('animated','true');if(features.includes('staffpicked'))api.searchParams.set('staffpicked','true');
      if(u.pathname.includes('popular'))api.searchParams.set('sort_by','-likeCount');if(u.pathname.includes('staffpicks'))api.searchParams.set('staffpicked','true');
      return result(await json(api.href,{signal}),'Sketchfab 搜索');
    }
    const segments=u.pathname.split('/').filter(Boolean);
    if(segments.length<=2 && !['models','collections','features','about','plans','feed'].includes(segments[0])) {
      const username=decodeURIComponent(segments[0]);
      const found=await json(`https://api.sketchfab.com/v3/search?type=users&q=${encodeURIComponent(username)}&count=24`,{signal});
      const user=found.results?.find(user=>user.username?.toLowerCase()===username.toLowerCase());
      if(!user?.uid||!UID.test(user.uid))throw new Error('未找到这个 Sketchfab 用户，请检查用户名或使用其模型/合集网址');
      if(segments[1]&&!['models','likes'].includes(segments[1]))throw new Error('请填写作者模型页、喜欢列表，或某个具体合集的网址');
      return result(await json(`https://api.sketchfab.com/v3/models?${segments[1]==='likes'?'liked_by':'user'}=${encodeURIComponent(user.username)}&count=24`,{signal}),`作者 · ${username}`);
    }
  }
  const page=await read(u.href,{signal});
  const type=String(page.headers['content-type']||'');
  if(!/html|text|json/i.test(type))throw new Error('这个地址不是可检索的网页');
  const found=extractModelLinks(page.body.toString('utf8'),page.url);
  const r=await hydrate(found.slice(0,24),found.slice(24,500),u.hostname,json,signal);
  r.warnings.push('普通网页仅解析本页已返回的链接与嵌入，不执行页面脚本，也不递归遍历整个网站。');
  if(found.length>500)r.warnings.push('本页链接超过 500 个，已截断；请缩小检索范围。');
  if(!found.length)r.warnings.push('未发现 Sketchfab 模型链接。登录内容、短链接或纯 JavaScript 加载的内容可能无法识别。');
  return r;
}
function result(data,source) {
  if(!Array.isArray(data.results))throw new Error('模型列表数据格式不符合预期');
  const normalized=data.results.map(normalizeModel).filter(Boolean);
  // Sketchfab 的搜索索引里混着已下架/已删除的模型（典型如 Google Poly 存档导入）：详情接口
  // 已经 404，缩略图也随之下架，渲染出来就是一张「缩略图加载失败」的空卡片（2026-10-19
  // 用户反馈）。搜索结果一律剔除没有可用缩略图的条目，连着卡片一起不出现在网格里。
  const models=normalized.filter(m=>m.thumbnail);
  const skipped=data.results.length-models.length;
  return {models,received:data.results.length,next:validNext(data.next),pending:[],source,warnings:skipped?[`本页有 ${skipped} 个已下架或不受支持的条目（无可用缩略图/旧式 ID），已过滤；结果不是完整合集。`]:[]};
}
async function hydrate(ids,pending,source,json,signal) {
  const models=[],warnings=[];let position=0;
  await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{
    while(position<ids.length){signal?.throwIfAborted();const id=ids[position++];
      try {const m=normalizeModel(await json(`https://api.sketchfab.com/v3/models/${id}`,{signal}));if(m)models.push(m);}
      catch(e){if(signal?.aborted)throw e;warnings.push(`${id.slice(0,8)}：${e.message}`);models.push({uid:id,name:`模型 ${id.slice(0,8)}`,author:'元数据暂不可用',url:`https://sketchfab.com/models/${id}`,thumbnail:null,downloadable:false,license:'许可待确认',tags:[],categories:[],animations:0,likes:0,views:0,metadataError:e.message});}
    }
  }));
  models.sort((a,b)=>ids.indexOf(a.uid)-ids.indexOf(b.uid));return {models,next:null,pending,source,warnings};
}
