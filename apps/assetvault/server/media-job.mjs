import fs from 'node:fs/promises';
import path from 'node:path';
import {collectPictureAssets} from './picture-sites.mjs';
import {openPublic} from './public-http.mjs';
import {downloadImage,imageStem} from './image-store.mjs';
import {inspectMedia} from './media-file.mjs';

/** Same queue, commit and library scanner as other downloads. Media are streamed, never buffered in RAM. */
export async function runMediaJob(job,{signal,progress=()=>{},collect=collectPictureAssets,open=openPublic}={}){
 const plan=await collect(job.platform,{url:job.url},{signal,maxItems:120});
 if(plan.search)throw Error('请选择一首歌曲下载，不支持将搜索结果作为作品下载');
 if(plan.partial)throw Error('只读取到笔记封面，未取得完整媒体；请登录该平台并完成验证后重试');
 const items=(plan.items||[]).filter(item=>['image','video','audio'].includes(item.type||item.mediaType||'image'));
 if(!items.length)throw Error('此作品没有可下载的媒体');
 await fs.mkdir(job.output,{recursive:true});
 const files=[];let total=0;const pairs=new Map();
 for(const [index,item] of items.entries()){
  signal?.throwIfAborted();
  const type=item.type||item.mediaType||'image',raw=path.join(job.output,`${index}.part-media`);
  const remaining=2*1024**3-total;if(remaining<=0)throw Error('本次媒体超过 2GB 限制');
  const cap=Math.min(type==='image'?48*1024**2:1024**3,remaining);
  let downloaded,media,lastError;
  for(const candidate of [...new Set([item.url,...(item.alternates||[])])].slice(0,12)){
   try{
    downloaded=await downloadImage(candidate,raw,{open,signal,client:job.platform,maxBytes:cap,onProgress:({bytes})=>progress({stage:'transferring',message:`正在保存${type==='audio'?'音频':type==='video'?'视频':'图片'} ${index+1}/${items.length}`,bytesWritten:total+bytes,totalBytes:null})});
    if(downloaded.total&&downloaded.bytes!==downloaded.total)throw Error('媒体下载不完整');
    const handle=await fs.open(raw,'r');let prefix;
    try{const buffer=Buffer.alloc(65536),read=await handle.read(buffer,0,buffer.length,0);prefix=buffer.subarray(0,read.bytesRead);}finally{await handle.close();}
    media=inspectMedia(prefix,type,String(index),downloaded.bytes);break;
   }catch(error){lastError=error;signal?.throwIfAborted();await fs.rm(raw,{force:true}).catch(()=>{});}
  }
  if(!media)throw lastError||Error('没有可用媒体地址');
  if(item.pairId&&!pairs.has(item.pairId))pairs.set(item.pairId,pairs.size+1);
  const stem=item.pairId?`live-${String(pairs.get(item.pairId)).padStart(3,'0')}`:`${String(index+1).padStart(3,'0')}-${imageStem(item.title||plan.title||job.name,'media')}`;
  const file=`${stem}.${media.format}`;
  await fs.rename(raw,path.join(job.output,file));total+=downloaded.bytes;
  files.push({file,bytes:downloaded.bytes,type,sourceUrl:item.url,resolvedUrl:downloaded.url,pairId:item.pairId||null,title:item.title||plan.title||'',duration:item.duration||null,width:item.width||null,height:item.height||null});
 }
 const info={uid:job.uid,kind:'media',platform:job.platform,title:plan.title||job.name,description:plan.description||'',author:plan.author||job.author,authorUrl:plan.authorUrl||'',url:plan.source||job.url,cover:plan.cover||'',thumbnail:plan.cover||'',assetType:items.some(item=>item.type==='audio')?'audio':items.some(item=>item.type==='video')?'video':'images',album:plan.album||'',lyrics:String(plan.lyrics||'').slice(0,100000),bitrate:plan.bitrate||null,publishedAt:plan.publishedAt||null,music:plan.music||null,tags:plan.tags||[],files,exportedAt:new Date().toISOString()};
 await fs.writeFile(path.join(job.output,'info.json'),JSON.stringify(info,null,2));
 return {folder:true,bytes:total,zipName:info.title,fileCount:files.length};
}
