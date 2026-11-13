// Image-works pipeline: the ArtStation counterpart of runArtstationJob for artworks that carry no
// Marmoset scene.
//
// A large share of ArtStation is 2D illustration, and those artworks have no `.mview` to convert —
// the old path simply failed on them. The public project JSON still lists every uploaded image as an
// `image` asset, and each one can be repointed at the largest fetchable rendition, so an artwork
// without a 3D scene can still produce a useful local deliverable: the author's images, plus an
// info.json that records where each file came from.
//
// This module only fetches and stages. Saving, dedupe naming, retries, cancellation and provenance
// verification all stay in DownloadManager, and the uid/verifier contract is the same one the
// Marmoset pipeline uses — so both kinds of ArtStation job are ordinary entries in one shared queue.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {artstationHash,fetchProjectJson,projectImageAssets,projectJsonUrl} from './artstation-project.mjs';
import {coverUrl} from './artstation-cdn.mjs';
import {artstationStem} from './artstation.mjs';
import {downloadImage,sniffContainer,imageStem,IMAGE_MAX_BYTES,IMAGE_TOTAL_BYTES} from './image-store.mjs';
// The disk-level steps (stream one picture to a staging file, name it by its bytes) are shared with
// the bulk image downloader, so they live in image-store.mjs. Everything below is ArtStation policy:
// which assets count as pictures, and which rendition the CDN will actually serve.
import {planArtstationImages,IMAGE_MAX} from './image-sources.mjs';
// runArtstationImageJob 的默认参数写了 open = openPublic，但这个模块一直没导入它 —— 于是
// 所有「没有内嵌 Marmoset 场景」的作品（也就是全部 2D 插画）一进队列就抛
// ReferenceError: openPublic is not defined，任务停在 starting 阶段。补上导入即可。
import {openPublic} from './public-http.mjs';
import {writeEntriesDeliverable} from './deliverable-writer.mjs';
// 站点节奏与「限流值不值得等」的判定跟图站图片包共用同一份 —— 一个任务同时拉 ArtStation
// 与别的站点时，配额是分开的（按 host 认规则），但「429 就该等」这个结论不该有两套。
import {sharedHostThrottle,isTransientStatus} from './host-throttle.mjs';

/** Marks an info.json as an image bundle. The shared verifiers read this to decide whether a
 *  deliverable is checked as a model (needs a GLB) or as a set of images (needs its manifest). */
export const IMAGE_BUNDLE_KIND='images';
/** How many images one artwork may contribute. Real uploads sit far below this; an artwork that
 *  exceeds it is a collected gallery and is truncated rather than silently queued for gigabytes. */
export const ARTSTATION_IMAGE_MAX=IMAGE_MAX;
/** Per-file ceiling. `large` renditions are a few MB; anything past this is not an illustration. */
export const ARTSTATION_IMAGE_BYTES=IMAGE_MAX_BYTES;
/** Whole-bundle ceiling, kept under the 2GB ZIP/folder limit so the verifier never has to explain
 *  a size failure the downloader could have caught earlier. */
export const ARTSTATION_IMAGE_TOTAL_BYTES=IMAGE_TOTAL_BYTES;

const fmtMB=n=>n==null?'未知':`${(n/1048576).toFixed(n>=10485760?0:1)} MB`;
const pad2=n=>String(n).padStart(2,'0');

/**
 * The exact set of files a run will write: every `image` asset whose URL is an ArtStation CDN asset,
 * repointed at the largest fetchable rendition. Delegates the per-asset rules to the shared planner,
 * so this pipeline cannot drift from the bulk image downloader about what counts as a picture.
 */
export function planImages(assets,{limit=ARTSTATION_IMAGE_MAX}={}){
  return planArtstationImages(assets,{limit});
}

/** 并发度与图站图片包（image-bundle 的 `FETCH_CONCURRENCY`）保持一致：节流器管的是「什么时候
 *  允许发起下一个请求」，不是「什么时候能开始下一张」。串行时每张 = 等间隔 + 网络 + 写盘首尾
 *  相连；并发后网络与写盘落进等待间隙，墙钟时间趋近间隔本身 —— **请求速率一点没变**。
 *  ArtStation 的 CDN 默认没有间隔规则（`host-throttle` 里 minGap 0），所以这里是纯粹的流水线收益。 */
const AS_CONCURRENCY=6;
/** 个别图取不回来的容忍度：一个作品通常十几张，缺一两张可以接受，缺一半必须报出去。 */
const AS_TOLERANCE={ratio:0.15,floor:3};
/** 判「是不是整片塌方」的窗口：ArtStation CDN 被墙/断网时是一片失败，不是零星失败。 */
const AS_FAIL_WINDOW={size:20,ratio:0.4};
/** 单张图最多吃几轮限流冷却（App 级重试交给上层任务队列）。 */
const AS_ITEM_ROUNDS=2;

/** Download every planned image into `<work>/images`, naming each by its sniffed container.
 *
 *  失败语义与图站图片包对齐：单张取不回来只跳过并记进 `failed`，只有「最近 20 次里失败占比
 *  过高」才判定链路断了（`collapsed`）并把真实原因抛给任务层。原来一张失败就抛死整包，等于
 *  几十张里有一张 CDN 抖动就白跑一遍。
 *
 *  `maxBytes` 边下边判：到上限就停止派发、已取到的照常成包，剩余张数记进 `truncated` ——
 *  等全部下完再 `if(bytes>limit)throw` 等于白白跑完再宣布作废。 */
async function collectImages(work,items,{open,signal,progress,startedAt,maxBytes=ARTSTATION_IMAGE_TOTAL_BYTES,throttle=null}={}){
  const dir=path.join(work,'images');
  await fsp.mkdir(dir,{recursive:true});
  const results=new Array(items.length).fill(null);
  const used=new Set();
  const failed=[],recent=[];
  let cursor=0,doneCount=0,written=0,stopped=false,truncated=0,fatal=null;
  const tolerance=Math.max(AS_TOLERANCE.floor,Math.ceil(items.length*AS_TOLERANCE.ratio));
  const gate=throttle||sharedHostThrottle();

  const rate=()=>Math.round(written/Math.max(.001,(Date.now()-startedAt)/1000));
  const report=message=>progress({stage:'transferring',message,bytesWritten:written,totalBytes:null,transferRate:rate()});
  const remember=ok=>{recent.push(ok);if(recent.length>AS_FAIL_WINDOW.size)recent.shift();};
  // 整片塌方：窗口够长（至少 10 次）且失败占比过高 —— 断网/被墙就是这种形态。
  const collapsed=()=>recent.length>=Math.min(AS_FAIL_WINDOW.size,10)&&recent.filter(ok=>!ok).length/recent.length>=AS_FAIL_WINDOW.ratio;
  const giveUp=error=>{fatal=error;stopped=true;};
  const noteFailure=(index,item,error)=>{
    failed.push({index:index+1,url:item.url,message:String(error?.message||error)});
    remember(false);
    if(failed.length>tolerance||collapsed())giveUp(error);
  };

  const one=async(index,item)=>{
    signal?.throwIfAborted();
    const raw=path.join(work,`.part-${pad2(index+1)}`);
    // 进度不写「第 N 张」：并发下它会来回跳，看了等于没看。说清「本张传到哪 + 整体到哪」。
    const tick=p=>progress({
      stage:'transferring',
      message:`正在下载作品图片${p.total?`（${fmtMB(p.bytes)} / ${fmtMB(p.total)}）`:'…'} · 已完成 ${doneCount}/${items.length}`,
      bytesWritten:written+p.bytes,totalBytes:null,transferRate:rate(),
    });
    let error=null;
    for(let round=0;round<=AS_ITEM_ROUNDS;round++){
      try{
        await downloadImage(item.url,raw,{open,signal,onProgress:tick,throttle:gate,rateLimitRounds:1});
        error=null;break;
      }catch(e){
        signal?.throwIfAborted();
        error=e;
        // 有状态码且是限流类，才值得整包歇一会儿再回到这一张；断网（无状态码）不该拖时间。
        if(round>=AS_ITEM_ROUNDS||!isTransientStatus(e?.status))break;
        const rule=gate.ruleForUrl(item.url);
        const cool=gate.coolDown(item.url,Math.min(rule.coolMaxMs,Math.max(rule.coolBaseMs*2,20000)),e.status);
        report(`ArtStation 限流（HTTP ${e.status}），暂停 ${Math.ceil(cool/1000)} 秒后继续（已完成 ${doneCount}/${items.length}）`);
      }
    }
    if(error){
      await fsp.rm(raw,{force:true}).catch(()=>{});
      noteFailure(index,item,error);
      if(!stopped)report(`第 ${index+1} 张取不回来，已跳过（共 ${failed.length} 张）：${error?.message||error}`);
      return;
    }
    // The extension comes from the bytes, not from the URL: a renamed CDN object would otherwise be
    // written with an extension that contradicts its content, which the verifier would reject.
    let sniffed;
    try{
      sniffed=await sniffContainer(raw);
    }catch(e){
      await fsp.rm(raw,{force:true}).catch(()=>{});
      noteFailure(index,item,Error(`图片内容不完整：${e.message}`));
      return;
    }
    const stem=imageStem(artstationStem(item.title||item.id),`image-${index+1}`);
    // 同一作品里标题重名很常见（多张都叫 "Untitled"）：后缀去重必须在 `used` 上做，
    // 而不是靠 index —— index 只保证顺序，不保证文件名唯一。
    let name=`${pad2(index+1)}-${stem}.${sniffed.extension}`;
    for(let n=2;used.has(name);n++)name=`${pad2(index+1)}-${stem}-${n}.${sniffed.extension}`;
    used.add(name);
    const relative=`images/${name}`;
    try{
      await fsp.rename(raw,path.join(work,relative));
    }catch(e){
      noteFailure(index,item,Error(`图片写入失败：${e.message}`));
      return;
    }
    const entry={file:relative,title:item.title||null,width:item.width,height:item.height,bytes:sniffed.bytes,format:sniffed.format,sourceUrl:item.url};
    doneCount++;written+=sniffed.bytes;
    results[index]=entry;
    remember(true);
    report(`已取回作品图片 ${doneCount}/${items.length}`);
  };

  const worker=async()=>{
    for(;;){
      if(stopped||fatal)return;
      const index=cursor++;
      if(index>=items.length)return;
      if(written>=maxBytes){
        stopped=true;truncated=items.length-index;
        report(`已达 ZIP 体积上限（${fmtMB(maxBytes)}），还有 ${truncated} 张未下载`);
        return;
      }
      try{
        await one(index,items[index]);
      }catch(e){
        signal?.throwIfAborted();          // 取消：如实向外抛
        if(failed.length>tolerance||collapsed())giveUp(e);
        else noteFailure(index,items[index],e);
      }
    }
  };

  await Promise.all(Array.from({length:Math.max(1,Math.min(AS_CONCURRENCY,items.length))},()=>worker()));
  if(fatal)throw fatal;
  // 按计划顺序压实：清单要按 `NN-` 排，不能按「谁先下完」排。
  return {files:results.filter(Boolean),failed,truncated};
}

/** Build the flat entry list for an image bundle: the staged images plus the manifest. */
export async function artstationImageEntries({work,meta,uid,files}){
  const entries=[];
  for(const file of files)entries.push({name:file.file,data:await fsp.readFile(path.join(work,...file.file.split('/')))});
  const info={
    uid,
    kind:IMAGE_BUNDLE_KIND,
    platform:'artstation',
    title:meta.title||null,
    author:meta.author||null,
    url:meta.artworkUrl,
    source_url:meta.artworkUrl,
    source:meta.projectUrl||null,
    rendition:meta.rendition||null,
    imageCount:files.length,
    // The manifest *is* the provenance for an image bundle: the verifier requires every declared
    // file to be present and every present file to be declared, so it cannot be trimmed later.
    images:files.map(f=>({file:f.file,title:f.title,width:f.width,height:f.height,bytes:f.bytes,format:f.format,url:f.sourceUrl})),
    note:'作者上传的作品图片（ArtStation 最大可下载尺寸）。请遵守原作品许可，未经授权请勿商用。',
    exportedAt:new Date().toISOString(),
    tool:'sketchfab-exporter / ArtStation images',
  };
  if(meta.skipped)info.skippedCount=meta.skipped;
  // 取不回来 / 因体积上限没下的张数：卡片据此提示「这包少了几张」，而不是让人以为
  // 作者只上传了这么多。校验器只看「声明 ↔ 实际」双向一致，不关心这两个附加字段。
  if(meta.failedCount)info.failedCount=meta.failedCount;
  if(meta.truncatedCount)info.truncatedCount=meta.truncatedCount;
  entries.push({name:'info.json',data:Buffer.from(JSON.stringify(info,null,2),'utf8')});
  return {zipName:`${artstationStem(meta.title||'ArtStation')}-${meta.hash||uid.slice(0,8)}.zip`,entries};
}

/** Write the image bundle into the staging path DownloadManager owns (ZIP file, or loose folder). */
export async function writeArtstationImageDeliverable({work,meta,uid,files,output,deliver='zip',signal,progress=()=>{}}={}){
  const {zipName,entries}=await artstationImageEntries({work,meta,uid,files});
  const written=await writeEntriesDeliverable({entries,output,deliver,signal,progress,message:'作品图片已取回'});
  return {zipName,...written};
}

/**
 * Worker body for one image-only ArtStation job: artwork URL -> project JSON -> the author's images
 * -> a deliverable written to `output`. Mirrors runArtstationJob's contract exactly (`deliver` picks
 * the shape of `output`, the uid comes from the caller), so DownloadManager treats both as the same
 * kind of job: one queue, one verifier, one retry policy.
 */
export async function runArtstationImageJob({uid,url,output,deliver='zip',workRoot,open=openPublic,limit=ARTSTATION_IMAGE_MAX,maxBytes=ARTSTATION_IMAGE_TOTAL_BYTES}={},{signal,progress=()=>{}}={}){
  signal?.throwIfAborted();
  await fsp.mkdir(deliver==='folder'?output:path.dirname(output),{recursive:true});
  progress({stage:'starting',message:'正在读取作品信息（图片作品，无 3D 场景）…'});
  const json=await fetchProjectJson(url,{open,signal});
  if(!json)throw Error('读取 ArtStation 作品信息失败（站点可能要求验证），请稍后重试');
  signal?.throwIfAborted();
  const hash=artstationHash(url);
  const meta={
    artworkUrl:String(url).replace(/\/$/,''),
    projectUrl:projectJsonUrl(url),
    title:typeof json.title==='string'&&json.title.trim()?json.title.trim():null,
    author:(json.user&&json.user.username)||null,
    hash,
    rendition:'large',
  };
  const {items,skipped}=planImages(projectImageAssets(json),{limit});
  if(!items.length)throw Error('这个作品没有可下载的图片（可能只包含视频或外链内容）');
  if(skipped.length)meta.skipped=skipped.length;
  progress({stage:'transferring',message:`已找到 ${items.length} 张作品图片${skipped.length?`（另有 ${skipped.length} 项不可下载）`:''}，开始下载…`});
  await fsp.mkdir(workRoot||os.tmpdir(),{recursive:true});
  const work=await fsp.mkdtemp(path.join(workRoot||os.tmpdir(),'sfx-asimg-'));
  try{
    const startedAt=Date.now();
    const {files,failed,truncated}=await collectImages(work,items,{open,signal,progress,startedAt,maxBytes});
    // 一张都没取到 → 这不是「少了几张」，是整条链路都不通，必须如实失败（错误消息带真实原因）。
    if(!files.length)throw Error(`没有取到任何作品图片${failed.length?`：${failed[0].message}`:''}`);
    if(failed.length)meta.failedCount=failed.length;
    if(truncated)meta.truncatedCount=truncated;
    signal?.throwIfAborted();
    progress({stage:'converting',message:deliver==='folder'?'正在写出导出文件夹…':'正在打包 ZIP…'});
    const written=await writeArtstationImageDeliverable({work,meta,uid,files,output,deliver,signal,progress});
    return {...written,title:meta.title,author:meta.author,thumbnail:coverUrl(json.cover_url)??null,imageCount:files.length,failedCount:failed.length,truncatedCount:truncated};
  }finally{
    await fsp.rm(work,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
  }
}
