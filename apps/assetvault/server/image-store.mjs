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
import {isTransientNetworkError,isTransientStatus} from './net-errors.mjs';
import {inspectImage,IMAGE_PREFIX_BYTES} from './archive.mjs';

/** Per-file ceiling. A large rendition is a few MB; anything past this is not an illustration. */
export const IMAGE_MAX_BYTES=48*1024*1024;
/** Whole-bundle ceiling, kept well under the 2GB limit the verifier enforces, so an oversized
 *  bundle fails here with a message worth reading instead of during validation. */
export const IMAGE_TOTAL_BYTES=512*1024*1024;
/** 同一地址的连接级失败重试次数。「掐连接」是图床限流的常见表现，隔半秒再连几乎都能过，
 *  所以默认重试一次；HTTP 错误不在此列（换地址而不是重试同一条 URL）。
 *  例外是限流：见 `rateLimitRounds` —— 换地址没用（额度是按 IP 算的），只能等。 */
export const IMAGE_RETRIES=1;
/** Which outbound allowlist one request must carry: derived from the platform, never guessed. */
// pixiv 的图床 i.pximg.net 按 Referer 放行：缺 Referer 直接 403，所以这里把伪装头随请求带出去。
export const IMAGE_CLIENTS=Object.freeze({sketchfab:{sketchfabOnly:true},artstation:{artstation:true},polyhaven:{},ambientcg:{},pixiv:{headers:{Referer:'https://www.pixiv.net/'}},safebooru:{headers:{Referer:'https://safebooru.org/'}},yandere:{headers:{Referer:'https://yande.re/'}},konachan:{headers:{Referer:'https://konachan.com/'}},wallhaven:{headers:{Referer:'https://wallhaven.cc/'}},civitai:{headers:{Referer:'https://civitai.com/'}},zcool:{headers:{Referer:'https://www.zcool.com.cn/'}},designspiration:{headers:{Referer:'https://www.designspiration.com/'}},huaban:{headers:{Referer:'https://huaban.com/'}},pexels:{headers:{Referer:'https://www.pexels.com/'}},flickr:{headers:{Referer:'https://www.flickr.com/'}},'500px':{headers:{Referer:'https://500px.com/'}},pinterest:{headers:{Referer:'https://www.pinterest.com/'}},xiaohongshu:{headers:{Referer:'https://www.xiaohongshu.com/'}}});

const fmtMB=n=>`${(n/1048576).toFixed(n>=10485760?0:1)} MB`;

/** Stream `url` into `dest` atomically: a `.part` sibling becomes `dest` only once fully written,
 *  so an interrupted download can never be mistaken for a finished file by a later stage.
 *
 *  `alternates` 是同一个对象的其它可取地址（签名地址 / 稳定地址 / 缩放档），按顺序兜底：
 *  图床限流、原图被移走、尺寸超限时，换一个地址往往就能取到，而不是把整包图拖死在一张上。
 *  连接被掐断（socket hang up）这类「同一地址再试一次就好」的错误才原地重试。
 *
 *  `throttle`（host-throttle.mjs）给的是「什么时候允许发下一个请求」。带上它之后，限流状态码
 *  的处理分两拍：先把剩下的候选试一遍（缩放档走的是边缘缓存，被限流时往往还能 200，代价只有
 *  几百毫秒），全都回限流才认定是「IP 级配额用光」，等冷却（`rateLimitRounds` 轮）后整组重来。
 *  每轮重启都从首选地址开始 —— 冷却之后原图往往就恢复了，没必要退到小尺寸缩放档。 */
export async function downloadImage(url,dest,{open=openPublic,signal,onProgress,maxBytes=IMAGE_MAX_BYTES,client='artstation',alternates=[],retries=IMAGE_RETRIES,retryDelayMs=500,throttle=null,rateLimitRounds=0,onRateLimit=null}={}){
  const candidates=[url,...alternates].filter((item,index,list)=>item&&list.indexOf(item)===index);
  if(!candidates.length)throw Error('缺少可用的图片地址');
  let lastError=null;
  // 限流冷却轮数按「这一张图」算，而不是按候选地址各算一份：配额是 IP 级的。
  let limitedRounds=0;
  for(;;){
    let rateLimited=false;
    for(const candidate of candidates){
      for(let attempt=0;;attempt++){
        if(throttle)await throttle.wait(candidate,{signal});
        try{
          const written=await streamToFile(candidate,dest,{open,signal,onProgress,maxBytes,client});
          throttle?.reward(candidate);
          return written;
        }catch(error){
          lastError=error;
          signal?.throwIfAborted();
          // 有状态码 = 「这个地址这一刻给不出东西」：先换下一个候选（可能是边缘缓存变体）。
          if(error.status!==undefined){
            if(isTransientStatus(error.status))rateLimited=true;
            break;
          }
          if(attempt>=retries||!isTransientNetworkError(error))break;
          await new Promise(resolve=>setTimeout(resolve,retryDelayMs*(attempt+1)));
        }
      }
    }
    // 整组候选都取不到：限流的话等冷却再来一轮，其它状态码就是真的没有这张图。
    if(!rateLimited||rateLimitRounds<=0||limitedRounds>=rateLimitRounds)throw lastError;
    limitedRounds++;
    const cool=throttle?.penalise(candidates[0],lastError?.status)||0;
    onRateLimit?.({status:lastError?.status,round:limitedRounds,coolMs:cool,url:candidates[0]});
    if(!throttle)await new Promise(resolve=>setTimeout(resolve,Math.max(retryDelayMs,cool||retryDelayMs)*2**(limitedRounds-1)));
  }
}

/** 单次请求：拿响应流、边写边报进度、写完才改名。 */
async function streamToFile(url,dest,{open,signal,onProgress,maxBytes,client}){
  const r=await open(url,{...(IMAGE_CLIENTS[client]||IMAGE_CLIENTS.artstation),signal,timeout:120000});
  if(r.status<200||r.status>=300){
    try{r.stream.destroy();}catch{}
    const error=Error(`下载图片失败：HTTP ${r.status}`);
    error.status=r.status;
    throw error;
  }
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
    // 不逐张 fsync：写的是 `.part`、写完才改名，所以「成品文件半截」本来就不可能；
    // 而每张强制刷盘在图床任务里要 20~80ms（上千张就是 1~2 分钟）。断电最坏是最后一张
    // 落成截断文件 —— 续传时会按清单里的 bytes 校验大小，对不上就删掉重下。
    ok=true;
  }finally{
    await fd.close().catch(()=>{});
    if(!ok)await fsp.rm(tmp,{force:true}).catch(()=>{});
  }
  await fsp.rename(tmp,dest);
  // 带上实际生效的地址：上层据此记住「哪个主机真的给了图」（图床按节点限流，换个节点往往就通）。
  return {bytes,total,url};
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
