// Low-level image plumbing shared by every image pipeline.
//
// Fetching a picture is two things: streaming it to a staging file under a size ceiling, and naming
// it after the bytes rather than the URL (the verifier refuses a file whose extension contradicts
// its content, so a CDN rename must never decide the extension). Both the ArtStation image-works
// pipeline and the bulk asset image pipeline need exactly this pair — once there are two copies of
// this loop there are two chances to disagree with the verifier, so the loop lives here once.
import fsp from 'node:fs/promises';
import path from 'node:path';
import {openPublic} from './public-http.mjs';
import {inspectImage,IMAGE_PREFIX_BYTES} from './archive.mjs';

/** Per-file ceiling. A large rendition is a few MB; anything past this is not an illustration. */
export const IMAGE_MAX_BYTES=48*1024*1024;
/** Whole-bundle ceiling, kept well under the 2GB limit the verifier enforces, so an oversized
 *  bundle fails here with a message worth reading instead of during validation. */
export const IMAGE_TOTAL_BYTES=512*1024*1024;
/** Which outbound allowlist one request must carry: derived from the platform, never guessed. */
// pixiv 的图床 i.pximg.net 按 Referer 放行：缺 Referer 直接 403，所以这里把伪装头随请求带出去。
export const IMAGE_CLIENTS=Object.freeze({sketchfab:{sketchfabOnly:true},artstation:{artstation:true},polyhaven:{},ambientcg:{},pixiv:{headers:{Referer:'https://www.pixiv.net/'}},safebooru:{headers:{Referer:'https://safebooru.org/'}},yandere:{headers:{Referer:'https://yande.re/'}},konachan:{headers:{Referer:'https://konachan.com/'}},wallhaven:{headers:{Referer:'https://wallhaven.cc/'}},civitai:{headers:{Referer:'https://civitai.com/'}},zcool:{headers:{Referer:'https://www.zcool.com.cn/'}},designspiration:{headers:{Referer:'https://www.designspiration.com/'}},huaban:{headers:{Referer:'https://huaban.com/'}},pexels:{headers:{Referer:'https://www.pexels.com/'}},flickr:{headers:{Referer:'https://www.flickr.com/'}},'500px':{headers:{Referer:'https://500px.com/'}},pinterest:{headers:{Referer:'https://www.pinterest.com/'}}});

const fmtMB=n=>`${(n/1048576).toFixed(n>=10485760?0:1)} MB`;

/** Stream `url` into `dest` atomically: a `.part` sibling becomes `dest` only once fully written,
 *  so an interrupted download can never be mistaken for a finished file by a later stage. */
export async function downloadImage(url,dest,{open=openPublic,signal,onProgress,maxBytes=IMAGE_MAX_BYTES,client='artstation'}={}){
  const r=await open(url,{...(IMAGE_CLIENTS[client]||IMAGE_CLIENTS.artstation),signal,timeout:120000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`下载图片失败：HTTP ${r.status}`);}
  const total=Number(r.headers['content-length'])||null;
  if(total&&total>maxBytes){try{r.stream.destroy();}catch{}throw Error(`图片超过 ${fmtMB(maxBytes)} 限制`);}
  const tmp=dest+'.part';
  const started=Date.now();
  let bytes=0,ok=false;
  const fd=await fsp.open(tmp,'w');
  try{
    for await(const chunk of r.stream){
      signal?.throwIfAborted();
      await fd.write(chunk);
      bytes+=chunk.length;
      if(bytes>maxBytes)throw Error(`图片超过 ${fmtMB(maxBytes)} 限制`);
      onProgress?.({bytes,total,elapsedMs:Date.now()-started});
    }
    await fd.sync();
    ok=true;
  }finally{
    await fd.close().catch(()=>{});
    if(!ok)await fsp.rm(tmp,{force:true}).catch(()=>{});
  }
  await fsp.rename(tmp,dest);
  return {bytes,total};
}

/** Read just enough of a staged file to name it by what it actually is. */
export async function sniffContainer(file){
  const handle=await fsp.open(file,'r');
  try{
    const buffer=Buffer.alloc(IMAGE_PREFIX_BYTES);
    const {bytesRead}=await handle.read(buffer,0,IMAGE_PREFIX_BYTES,0);
    const size=(await handle.stat()).size;
    return inspectImage(buffer.subarray(0,bytesRead),path.basename(file),size);
  }finally{await handle.close();}
}

/** Filesystem-safe, capped stem for one picture. Whatever the source called it, never a path. */
export function imageStem(raw,fallback='image'){
  const cleaned=String(raw||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,40);
  return cleaned||fallback;
}
