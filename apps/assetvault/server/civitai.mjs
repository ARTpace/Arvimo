// Civitai 模型下载适配器。
//
// 职责边界：只做「模型链接 / 关键词 → 版本与文件清单 → 原文件落盘 + info.json」。
// 出域一律走 public-http（DNS pinning / 代理 / cookie / 重定向鉴权裁剪都在那里），
// 队列状态、进度、校验与提交由 downloads.mjs 负责，这里不重复造一套任务系统。
//
// API key 只从调用方注入（library.mjs 从平台设置读），不写进任务、不写进日志、不随 HTTP 响应返回。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openPublic,readPublic} from './public-http.mjs';
import {tagList} from './tag-list.mjs';

const API='https://civitai.com/api/v1';
const SITE='https://civitai.com';
const HOSTS=new Set(['civitai.com','www.civitai.com']);
const WEIGHT_EXTS=['safetensors','ckpt','gguf','pt','pth','bin','onnx','zip'];
const MAX_META=4*1024*1024;

export function parseCivitaiUrl(value){
 const raw=String(value||'').trim();
 let u;
 try{u=new URL(raw);}catch{throw Error('请填写有效的 Civitai 模型链接');}
 if(!HOSTS.has(u.hostname.toLowerCase()))throw Error('只支持 civitai.com 的模型链接');
 const seg=u.pathname.split('/').filter(Boolean);
 let modelId='',versionId='';
 if(seg[0]==='api'&&seg[1]==='download'&&seg[2]==='models'){
  versionId=seg[3]||'';
 }else if(seg[0]==='models'){
  modelId=seg[1]||'';
  versionId=u.searchParams.get('modelVersionId')||u.searchParams.get('versionId')||(/^\d+$/.test(seg[3]||'')?seg[3]:'');
 }else throw Error('请填写 Civitai 模型页链接（/models/数字）或版本下载链接');
 if(!modelId&&!versionId)throw Error('链接里没有模型或版本编号');
 if(modelId&&!/^\d{1,16}$/.test(modelId))throw Error('Civitai 模型编号无效');
 if(versionId&&!/^\d{1,16}$/.test(versionId))throw Error('Civitai 版本编号无效');
 return {modelId,versionId,url:modelId?`${SITE}/models/${modelId}${versionId?`?modelVersionId=${versionId}`:''}`:`${SITE}/api/download/models/${versionId}`};
}

export const civitaiUid=(modelId,versionId)=>createHash('md5').update(`civitai:${modelId||'0'}:${versionId||'0'}`).digest('hex');

function headers(apiKey){
 return {'User-Agent':'Arvimo/1.0 (personal asset library)','Referer':`${SITE}/`,...(apiKey?{Authorization:`Bearer ${apiKey}`}:{})};
}

async function getJson(url,{signal,apiKey,read=readPublic}={}){
 const r=await read(url,{signal,timeout:45000,maxBytes:MAX_META,headers:headers(apiKey)});
 let data;
 try{data=JSON.parse(r.body.toString('utf8'));}catch{throw Error('Civitai 返回的数据不是有效 JSON');}
 if(data?.error)throw Error(`Civitai 拒绝请求：${String(data.error).slice(0,200)}`);
 return data;
}

function extOf(name){const m=String(name||'').toLowerCase().match(/\.([a-z0-9]+)$/);return m?.[1]||'';}

/** Size from the API is KB; keep bytes authoritative in info.json so verification is exact. */
export function civitaiFiles(version){
 return (Array.isArray(version?.files)?version.files:[])
  .filter(file=>file&&file.downloadUrl&&String(file.downloadUrl).startsWith('https://'))
  .map(file=>({...file,bytes:Math.max(0,Math.round(Number(file.sizeKB||0)*1024))}));
}

/** Prefer the primary safetensors/checkpoint; fall back by known weight extensions, never by array order alone. */
export function pickCivitaiFile(version,fileId){
 const files=civitaiFiles(version);
 if(!files.length)throw Error('这个版本没有可下载的文件');
 if(fileId){
  const picked=files.find(file=>String(file.id)===String(fileId)||String(file.name)===String(fileId));
  if(!picked)throw Error('所选文件在当前版本中已不存在，请重新选择');
  return picked;
 }
 const rank=file=>{const index=WEIGHT_EXTS.indexOf(extOf(file.name));return (file.primary?0:10)+(index<0?100:index);};
 return [...files].sort((a,b)=>rank(a)-rank(b)||b.bytes-a.bytes)[0];
}

function versionCard(model,version){
 const file=pickCivitaiFile(version);
 const image=(Array.isArray(version.images)?version.images:[]).find(item=>item?.url?.startsWith('https://'))||null;
 const tags=tagList([model.type,...(Array.isArray(model.tags)?model.tags:[]),version.name].filter(Boolean));
 return {
  uid:civitaiUid(model.id,version.id),platform:'civitai',assetId:String(model.id),
  modelId:String(model.id),versionId:String(version.id),
  fileId:String(file.id||file.name||''),
  name:String(model.name||'Civitai 模型').slice(0,200)+' · '+String(version.name||'默认版本').slice(0,80),
  author:String(model.creator?.username||model.username||'Civitai 作者').slice(0,100),
  license:String(model.license?.name||'请查看模型页面').slice(0,200),
  thumbnail:image?String(image.url).slice(0,2048):'',
  tags:tags.slice(0,32),downloadable:true,assetType:'models',
  url:`${SITE}/models/${model.id}?modelVersionId=${version.id}`,
  civitaiFiles:civitaiFiles(version).slice(0,30).map(item=>({id:String(item.id||item.name||''),name:String(item.name||'').slice(0,200),bytes:item.bytes,type:String(item.type||'')})),
 };
}

/** Search returns one card per model version (versions are what a download actually targets). */
export async function civitaiSearch({q,query,cursor,limit=24},{signal,apiKey,read=readPublic}={}){
 const term=String(q??query??'').trim().slice(0,200);
 if(!term)return {models:[],next:null,pending:[],warnings:['请输入关键词'],source:'Civitai',query:term};
 let page=1;
 try{page=Math.max(1,Number(JSON.parse(String(cursor||'{}')).page)||1);}catch{}
 const count=Math.min(24,Math.max(1,Number(limit)||24));
 const url=`${API}/models?query=${encodeURIComponent(term)}&limit=${count}&page=${page}&sort=Most%20Downloaded`;
 const data=await getJson(url,{signal,apiKey,read});
 const models=(Array.isArray(data.items)?data.items:[]).flatMap(model=>(Array.isArray(model.modelVersions)?model.modelVersions:[]).slice(0,3).map(version=>versionCard(model,version)));
 const nextPage=Number(data.metadata?.nextPage)||null;
 return {models,next:nextPage?JSON.stringify({q:term,page:nextPage,limit:count}):null,pending:[],warnings:[],source:'Civitai',query:term};
}

/** Link entry: resolves a model URL into cards + the full file list for the chosen version. */
export async function civitaiResolve(url,options={}){
 const parsed=parseCivitaiUrl(url);
 let model;
 if(parsed.modelId)model=await getJson(`${API}/models/${parsed.modelId}`,options);
 else{
  const version=await getJson(`${API}/model-versions/${parsed.versionId}`,options);
  model=version?.model||version;
 }
 if(!model||!Array.isArray(model.modelVersions))throw Error('没有读到这个模型的版本信息（可能已下架或需要登录）');
 const version=(parsed.versionId?model.modelVersions.find(item=>String(item.id)===String(parsed.versionId)):null)||model.modelVersions[0];
 if(!version)throw Error('这个模型暂时没有可用版本');
 const card=versionCard(model,version);
 return {...parsed,modelId:String(model.id),versionId:String(version.id),card,version,files:card.civitaiFiles,name:card.name,author:card.author,thumbnail:card.thumbnail};
}

/** Stream one model file to disk with Range resume; never accept a truncated payload as success. */
export async function downloadCivitaiFile(url,dest,{signal,open=openPublic,progress=()=>{},apiKey}={}){
 await fs.mkdir(path.dirname(dest),{recursive:true});
 const fd=await fs.open(dest,'w');
 let bytes=0,total=null,last=0,validator=null;
 const started=Date.now();
 const report=(force=false)=>{
  const now=Date.now();if(!force&&now-last<250)return;last=now;
  progress({stage:'transferring',message:'正在下载 Civitai 模型…',bytesWritten:bytes,totalBytes:total,transferRate:Math.round(bytes*1000/Math.max(1,now-started))});
 };
 try{
  for(let attempt=0;attempt<3;attempt++){
   signal?.throwIfAborted();
   let response,timer,abort;
   try{
    report(true);
    const extra=headers(apiKey);
    if(bytes)extra.Range=`bytes=${bytes}-`,validator&&(extra['If-Range']=validator);
    response=await open(url,{signal,timeout:45000,headers:extra});
    if(response.status<200||response.status>=300)throw Object.assign(Error(`Civitai 文件下载失败 HTTP ${response.status}`),{permanent:true});
    if(String(response.headers['content-type']||'').includes('text/html'))throw Object.assign(Error('下载源返回了网页，请确认模型是否可下载'),{permanent:true});
    const range=String(response.headers['content-range']||'').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if(response.status===206){
     if(!range||Number(range[1])!==bytes||(total!==null&&Number(range[3])!==total))throw Object.assign(Error('续传范围不一致，已停止以避免文件损坏'),{permanent:true});
     total=Number(range[3]);
    }else{
     if(bytes){bytes=0;await fd.truncate(0);}
     const length=Number(response.headers['content-length']);total=Number.isSafeInteger(length)&&length>0?length:null;
    }
    const etag=String(response.headers.etag||'');
    validator=etag&&!etag.startsWith('W/')?etag:response.headers['last-modified']||null;
    abort=()=>response.stream.destroy(signal.reason||Error('任务已取消'));
    signal?.addEventListener('abort',abort,{once:true});
    const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>response.stream.destroy(Error('下载连续 45 秒未收到数据')),45000);timer.unref?.();};
    arm();report(true);
    for await(const chunk of response.stream){
     signal?.throwIfAborted();arm();
     let written=0;
     while(written<chunk.length){
      const result=await fd.write(chunk,written,chunk.length-written,bytes).catch(error=>{error.permanent=true;throw error;});
      if(!result.bytesWritten)throw Object.assign(Error('下载文件写入失败'),{permanent:true});
      bytes+=result.bytesWritten;written+=result.bytesWritten;
     }
     report();
    }
    if(!bytes||total!==null&&bytes!==total)throw Error('模型文件传输不完整');
    report(true);return;
   }catch(error){
    if(signal?.aborted||error.permanent||attempt===2)throw error;
    progress({stage:'transferring',message:`连接中断，正在续传（${attempt+1}/2）…`,bytesWritten:bytes,totalBytes:total});
   }finally{
    clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);
    response?.stream.destroy();
   }
  }
 }finally{await fd.close();}
}

function safeName(name){
 const base=path.basename(String(name||'model.safetensors')).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').trim().slice(0,180);
 return base||'model.safetensors';
}

export async function runCivitaiJob({uid,modelId,versionId,fileId,url,name,author,tags,output},{signal,progress=()=>{},open=openPublic,read=readPublic,apiKey=''}={}){
 const parsed=parseCivitaiUrl(url||`${SITE}/models/${modelId}${versionId?`?modelVersionId=${versionId}`:''}`);
 const resolved=await civitaiResolve(parsed.url,{signal,read,apiKey});
 const chosen=pickCivitaiFile(resolved.version,fileId);
 const relative=safeName(chosen.name||`${modelId||'model'}-${versionId||'version'}.safetensors`);
 progress({stage:'starting',message:`正在读取 Civitai 版本 ${resolved.card.versionId}…`});
 await downloadCivitaiFile(chosen.downloadUrl,path.join(output,relative),{signal,open,progress,apiKey});
 const info={
  uid,platform:'civitai',kind:'model',assetType:'models',
  modelId:resolved.card.modelId,versionId:resolved.card.versionId,
  fileId:String(chosen.id||relative||''),name:String(name||resolved.card.name).slice(0,240),
  author:String(author||resolved.card.author).slice(0,100),
  license:resolved.card.license,tags:tagList(tags),
  source_url:parsed.url,model_page:`${SITE}/models/${resolved.card.modelId}`,
  format:extOf(relative),files:[{file:relative,bytes:chosen.bytes||null,sha256:String(chosen.sha256||'').toLowerCase()||null}],
  exportedAt:new Date().toISOString(),
 };
 await fs.writeFile(path.join(output,'info.json'),JSON.stringify(info,null,2));
 return {zipName:`${info.name.replace(/[\\/:*?"<>|]/g,'_')}.zip`};
}
