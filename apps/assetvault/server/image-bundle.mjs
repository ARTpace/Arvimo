// Bulk image downloader: one asset -> one folder (or ZIP) of its pictures plus a manifest.
//
// This is the entry point the queue drives for any `kind:'images'` job, whatever the source
// platform. The platform-specific half — which pictures exist, which rendition is fetchable — lives
// entirely in image-sources.mjs; everything here is platform-neutral bookkeeping: stage the download,
// name each file by its bytes, write the manifest, hand the flat entry list to the deliverable
// writer. Split that way because picture *files* are the same problem everywhere: only the catalogue
// that lists them differs, and that catalogue already comes back in one uniform shape.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openPublic,publicJson} from './public-http.mjs';
import {IMAGE_BUNDLE_KIND} from './artstation-image.mjs';
import {collectImageAssets,IMAGE_MAX} from './image-sources.mjs';
import {canonicalPictureUrl,pictureUrlCandidates} from './picture-sites.mjs';
import {downloadImage,sniffContainer,imageStem,IMAGE_TOTAL_BYTES} from './image-store.mjs';
import {sharedHostThrottle} from './host-throttle.mjs';
import {isTransientStatus} from './net-errors.mjs';
import {writeEntriesDeliverable} from './deliverable-writer.mjs';
import {tagList,mergeTags} from './tag-list.mjs';

const fmtMB=n=>n==null?'未知':`${(n/1048576).toFixed(n>=10485760?0:1)} MB`;
const pad2=n=>String(n).padStart(2,'0');

/** 批量抓图时对「个别图取不回来」的容忍度：总量超过占比上限就认为整条链路断了（限流 / 离线），
 *  交给任务层去重试 —— 少几张可以接受，少一半必须报出来。 */
const FETCH_TOLERANCE={ratio:0.15,floor:4};
/** 失败率窗口：最近 20 次里 40% 失败 = 整片塌方。**不用「连续 N 张」** —— 并发下载时同时在飞
 *  三张，失败的「连续」只是调度巧合，用窗口才看得出是链路问题还是零星坏图。 */
const FAIL_WINDOW={size:20,ratio:0.4};

/** 同时在飞的下载数。节流器管「什么时候发起下一个请求」，下载与写盘在这个间隔里并行完成：
 *  串行时每张 = 等 825ms + 网络 250ms + 写盘 200ms 首尾相连；3 路之后后两段被等待吞掉。
 *  取 6 而不是 3：槽位是按 gap 发的（请求速率不变，不会更早撞限流），但大图 body 传输会占住
 *  worker —— 3 路时槽位会空转等人，6 路才让每个间隙都有活干（实测 40 张 0.91s→0.57s→更接近 gap）。 */
const FETCH_CONCURRENCY=6;

/** 图床限流是**按节点**的：同一时刻 `gd-hbimg-edge`（签名地址）被拦、`gd-hbimg` 或缩放档
 *  还能给图。而候选顺序是固定的「签名 → 裸路径 → 缩放档」，于是一旦签名节点被拦，
 *  每张图都要先白撞一个 567、再换候选成功 —— 实测限流期 79 个请求里 39 个是这种白撞，
 *  每次白撞还要吃掉一整个节流间隔，速度直接腰斩。
 *
 *  所以记住「上一次哪个主机真的给了图」（5 分钟内的记忆才算数），下一次优先它。
 *  这是纯进程内记忆，不写盘：网络一变、记忆过期，最多多撞一次就自动纠正。 */
const LAST_GOOD_HOST=new Map();
const HOST_MEMORY_MS=5*60*1000;
const hostOfUrl=value=>{try{return new URL(String(value)).hostname.toLowerCase();}catch{return '';}};
function preferKnownGood(candidates){
  const now=Date.now();
  const rank=url=>{
    const at=LAST_GOOD_HOST.get(hostOfUrl(url));
    return at&&now-at<HOST_MEMORY_MS?at:0;
  };
  return candidates
    .map((url,index)=>({url,index,rank:rank(url)}))
    .sort((a,b)=>b.rank-a.rank||a.index-b.index)
    .map(entry=>entry.url);
}
function noteGoodHost(url){
  const host=hostOfUrl(url);
  if(!host)return;
  const now=Date.now();
  LAST_GOOD_HOST.set(host,now);
  if(LAST_GOOD_HOST.size>8)for(const [key,at] of LAST_GOOD_HOST)if(now-at>HOST_MEMORY_MS)LAST_GOOD_HOST.delete(key);
}

/** 单张图内部允许吃几轮「图站限流」冷却（image-store 的 rateLimitRounds）。 */
const ITEM_LIMIT_ROUNDS=2;
/** 整包级别的冷却轮数：连续多张都限流时不要判死，先让这个站点歇一会儿再继续。
 *  1923 张的花瓣画板一定会撞上 IP 配额，靠这一层把它跑完，而不是靠任务层反复从头重扫画板。 */
const BUNDLE_COOL_ROUNDS=6;

/** 清单里记的出处：换域后的稳定地址。签名地址会过期，不能当出处，否则续传时对不上、以后也复现不了。 */
const provenanceUrl=item=>canonicalPictureUrl(item.url)||item.url;

/** Download every planned picture into `<work>/images`, naming each after what its bytes really are.
 *
 *  `existing` 是上一次尝试已经落盘的清单（续传）：按出处命中就跳过，不再重下 —— 一个 294 张的
 *  画板断在第 200 张时，重试只该补剩下的 94 张，而不是把前 200 张再抓一遍。
 *
 *  **并发**：节流器（host-throttle）管的是「什么时候允许发起下一个请求」，不是「什么时候能开始下一张」。
 *  串行时每张要「等 825ms + 网络 250ms + 写盘 200ms」首尾相连；并发后网络与写盘落进等待里，
 *  每张的墙钟时间趋近节流间隔本身 —— **请求速率一点没变**，所以不会更早撞限流。
 *
 *  单张失败不判死整包：图站对同一张图常有多个可用地址（签名地址 / 稳定地址 / 缩放档），
 *  真全都取不到时跳过这一张并记进 `failed`；失败判定从「连续 N 张」改成「最近 20 次结果的失败占比」，
 *  因为并发下同时在飞三张，「连续」已经没有意义。
 *
 *  `maxBytes` 是体积上限，**边下边判**：1923 张 4K 原图有 8GB，等全部下完再检查体积、发现超限，
 *  等于白跑两小时。到上限就停止派发新任务并如实报告还剩几张没下（`truncated`）。
 */
async function collectFiles(work,items,{client,platform,open,signal,progress,startedAt,onFile,existing=null,throttle=null,maxBytes=Infinity}={}){
  const dir=path.join(work,'images');
  await fsp.mkdir(dir,{recursive:true});
  const results=new Array(items.length).fill(null);
  const used=new Set();
  const failed=[];
  const recent=[];                       // 最近 N 次结果，true=成功；用来判「是不是整片塌方」
  let cursor=0,doneCount=0,written=0,inFlight=0,cools=0,stopped=false,truncated=0,fatal=null;
  const tolerance=Math.max(FETCH_TOLERANCE.floor,Math.ceil(items.length*FETCH_TOLERANCE.ratio));
  const gate=throttle||sharedHostThrottle();

  const rate=()=>Math.round(written/Math.max(.001,(Date.now()-startedAt)/1000));
  const report=message=>progress({stage:'transferring',message,bytesWritten:written,totalBytes:null,transferRate:rate()});
  const remember=ok=>{recent.push(ok);if(recent.length>FAIL_WINDOW.size)recent.shift();};
  // 整片塌方：窗口够长（至少 10 次）且失败占比过高 —— 限流 / 离线时就是这种形态。
  const collapsed=()=>recent.length>=Math.min(FAIL_WINDOW.size,10)&&recent.filter(ok=>!ok).length/recent.length>=FAIL_WINDOW.ratio;
  const giveUp=error=>{fatal=error;stopped=true;};
  const noteFailure=(index,item,error)=>{
    failed.push({index:index+1,url:item.url,message:String(error?.message||error)});
    remember(false);
    if(failed.length>tolerance||collapsed())giveUp(error);
  };

  const one=async(index,item)=>{
    signal?.throwIfAborted();
    const kept=existing?.get(provenanceUrl(item));
    if(kept){
      // 续传：文件已在输出目录里，直接接回清单 —— 不重下，也不再拷一遍。
      used.add(path.basename(kept.file));
      results[index]=kept;doneCount++;written+=kept.bytes||0;
      report(`续传：已取回高清图片 ${doneCount}/${items.length}`);
      return;
    }
    const raw=path.join(work,`.part-${pad2(index+1)}`);
    // 一张图可以有好几条「该去要的地址」：花瓣的裸路径被限流时，签名地址和缩放档还活着。
    // 顺序由 picture-sites.mjs 统一给，下载层只负责按顺序试；但会先按「上次谁真的给了图」重排。
    const candidates=preferKnownGood(pictureUrlCandidates(item.url));
    const primary=candidates[0]||item.url;
    // 进度只说「本张到哪了 + 整体到哪了」：并发下「第 N 张」会来回跳，看了等于没看。
    const tick=p=>progress({
      stage:'transferring',
      message:`正在下载图片${p.total?`（${fmtMB(p.bytes)} / ${fmtMB(p.total)}）`:'…'} · 已完成 ${doneCount}/${items.length}`,
      bytesWritten:written+p.bytes,totalBytes:null,transferRate:rate(),
    });
    let error=null;
    // 限流的恢复分两层：单张内部等短冷却（image-store），还不行就在这里整包歇一会儿再回到这一张。
    // 「歇一会儿」比「判死重来」便宜得多 —— 重来要重新扫一遍上千张的清单，还可能又被拦。
    for(let round=0;round<=BUNDLE_COOL_ROUNDS;round++){
      try{
        const written=await downloadImage(primary,raw,{open,client,signal,alternates:candidates.slice(1),onProgress:tick,throttle:gate,rateLimitRounds:ITEM_LIMIT_ROUNDS});
        // 记下真实生效的主机：下一张优先它，限流期就不会每张都先撞一次坏节点。
        noteGoodHost(written?.url||primary);
        error=null;break;
      }catch(e){
        signal?.throwIfAborted();
        error=e;
        if(round>=BUNDLE_COOL_ROUNDS||!isTransientStatus(e?.status))break;
        const rule=gate.ruleForUrl(item.url);
        const cool=gate.coolDown(item.url,Math.min(rule.coolMaxMs,Math.max(rule.coolBaseMs*2,30000)),e.status);
        cools++;
        report(`图站限流（HTTP ${e.status}），暂停 ${Math.ceil(cool/1000)} 秒后继续（第 ${cools} 次冷却，已完成 ${doneCount}/${items.length}）`);
      }
    }
    if(error){
      noteFailure(index,item,error);
      if(!stopped)report(`第 ${index+1} 张取不回来，已跳过（共 ${failed.length} 张）：${error?.message||error}`);
      return;
    }
    // 扩展名来自字节本身，不来自 URL：CDN 改名后仍按真实格式落盘，否则校验器会以
    // 「扩展名与内容矛盾」把这张退掉。
    let sniffed;
    try{
      sniffed=await sniffContainer(raw);
    }catch(e){
      await fsp.rm(raw,{force:true}).catch(()=>{});
      noteFailure(index,item,Error(`图片内容不完整：${e.message}`));
      return;
    }
    // 文件名前带平台标识（如 flickr_01-Twin Suns.png），一眼看出来自哪个图站。
    // platform 取 info.json 的 platform id（flickr / 500px / pinterest ...）；未识别到的下载不硬加。
    const tag=platform?`${imageStem(platform,'')}_`:'';
    const stem=imageStem(item.title,`image-${index+1}`);
    let name=`${tag}${pad2(index+1)}-${stem}.${sniffed.extension}`;
    for(let n=2;used.has(name);n++)name=`${tag}${pad2(index+1)}-${stem}-${n}.${sniffed.extension}`;
    used.add(name);
    const relative=`images/${name}`;
    try{
      await fsp.rename(raw,path.join(work,relative));
    }catch(e){
      noteFailure(index,item,Error(`图片写入失败：${e.message}`));
      return;
    }
    const entry={file:relative,title:item.title||null,width:item.width??null,height:item.height??null,bytes:sniffed.bytes,format:sniffed.format,sourceUrl:provenanceUrl(item),tags:tagList(item.tags)};
    doneCount++;written+=sniffed.bytes;
    results[index]=entry;
    remember(true);
    // Streaming delivery: hand each finished picture out at once instead of waiting for the whole
    // board, so the folder (and the library card built from it) is usable from the first image.
    if(onFile)await onFile(entry);
    report(`已取回高清图片 ${doneCount}/${items.length}`);
  };

  const worker=async()=>{
    for(;;){
      if(stopped||fatal)return;
      const index=cursor++;
      if(index>=items.length)return;
      if(written>=maxBytes){
        stopped=true;truncated=items.length-index;
        report(`已达本机体积上限（${fmtMB(maxBytes)}），还有 ${truncated} 张未下载`);
        return;
      }
      inFlight++;
      try{
        await one(index,items[index]);
      }catch(e){
        signal?.throwIfAborted();       // 取消：如实向外抛
        if(failed.length>tolerance||collapsed())giveUp(e);
        else noteFailure(index,items[index],e);
      }finally{
        inFlight--;
      }
    }
  };

  await Promise.all(Array.from({length:Math.max(1,Math.min(FETCH_CONCURRENCY,items.length))},()=>worker()));
  if(fatal)throw fatal;
  // 按计划顺序压实：清单要按 `NN-` 排，不能按「谁先下完」排。
  return {files:results.filter(Boolean),failed,truncated};
}

/**
 * For an image bundle the manifest *is* the provenance: the verifier requires every declared file to
 * be present and every present file to be declared, so it cannot be trimmed afterwards without the
 * next validation noticing. Each picture therefore carries its measured pixels and its remote URL.
 */
export function imageManifest({job,plan,files,skipped,status,failedCount,truncatedCount}){
  const info={
    uid:job.uid,
    kind:IMAGE_BUNDLE_KIND,
    platform:plan.platform,
    title:plan.title||job.name||null,
    author:plan.author||job.author||null,
    url:job.url||null,
    source_url:job.url||null,
    source:plan.source||null,
    rendition:plan.rendition||null,
    // 标签有三路来源：站点 / 作品级（`plan.tags`，如 ArtStation 整个作品的标签）、任务级
    // （`job.tags`，资产库里已有的那一组）、每张图自己的（booru 的 post tag、Pexels 的照片 tag）。
    // 顶层这份是「这一包是什么」；每张图另留自己那组 —— 一包上千张时，
    // 「这张图是什么」只有图自己的标签答得上来。
    tags:mergeTags(plan.tags,job.tags,files.flatMap(f=>f.tags||[])),
    imageCount:files.length,
    // The manifest *is* the provenance for an image bundle: see the note above.
    images:files.map(f=>({file:f.file,title:f.title,width:f.width,height:f.height,bytes:f.bytes,format:f.format,url:f.sourceUrl,...(f.tags?.length?{tags:f.tags}:{})})),
    note:'作者在原站公开的图片（已取最大可下载尺寸）。请遵守原作品许可，未经授权请勿商用。',
    exportedAt:new Date().toISOString(),
    tool:'Arvimo / asset images',
  };
  if(skipped)info.skippedCount=skipped;
  // 取不回来、被跳过的张数：卡片据此提示「这包少了几张」，而不是让人以为原站只有这么多。
  if(failedCount)info.failedCount=failedCount;
  // 到了本机体积上限、没下完的张数：与「取不回来」分开记 —— 一个是图站的锅，一个是本地空间。
  if(truncatedCount)info.truncatedCount=truncatedCount;
  // `status` only exists while the bundle is still growing. The library card reads it to say
  // "下载中 / 未完成" instead of presenting a half-finished board as a finished asset.
  if(status)info.status=status;
  return info;
}

/**
 * Atomically (re)write the manifest. The disk scanner reads this file at any moment, so a
 * half-written JSON would make the card fall back to a nameless folder. The temp name starts
 * with a dot so `walkPackage` never lists it as a package entry; the writer cleans it up even
 * when rename fails, because `verifyFolder` hashes every file it finds.
 */
export async function writeImageManifest(dir,info){
 const target=path.join(dir,'info.json');
 const temp=path.join(dir,`.info-live-${randomUUID()}.tmp`);
 try{
  await fsp.writeFile(temp,JSON.stringify(info,null,2));
  await fsp.rename(temp,target);
 }finally{
  await fsp.rm(temp,{force:true}).catch(()=>{});
 }
}

/** A cancelled / failed / interrupted image job must not leave a card that claims to be downloading.
 *  返回「这个目录真的能续传吗」：调用方（服务重启时的恢复）要据此决定提示「接着补下剩下的」
 *  还是老实说「从头下载」—— 一句不准的文案会让人以为白下的图能接回来。 */
export async function markImageBundleIncomplete(dir){
 if(!dir)return false;
 try{
  const info=JSON.parse(await fsp.readFile(path.join(dir,'info.json'),'utf8'));
  if(info.status==='downloading')await writeImageManifest(dir,{...info,status:'incomplete'});
  return Array.isArray(info.images)&&info.images.length>0;
 }catch{return false;}
}

/** `<name>-images`: the exported tree always says what it holds, next to the model export it may share a stem with. */
export function bundleStem(name,plan){
  return imageStem(plan?.title||name||'images','images')+'-images';
}

/** 上一次尝试留下了什么：清单是唯一凭据，磁盘上「清单里没有」的图片说明写到一半进程就没了，
 *  必须删掉 —— 最终校验两边对不上，会因为「存在未登记的作品图片」把整包退回。
 *  返回 Map<出处, 清单条目>，只收「清单里有且文件还在」的那些。 */
async function resumableEntries(dir){
  if(!dir)return null;
  let info;
  try{info=JSON.parse(await fsp.readFile(path.join(dir,'info.json'),'utf8'));}catch{return null;}
  if(!Array.isArray(info?.images)||!info.images.length)return null;
  const entries=new Map(),declared=new Set();
  for(const item of info.images){
    const file=String(item?.file||'');
    if(!file.startsWith('images/'))continue;
    declared.add(path.basename(file));
    const full=path.join(dir,...file.split('/'));
    let stat;
    try{stat=await fsp.stat(full);}catch{continue;}   // 声明了但磁盘上没有：重下
    // 大小对不上 = 上次写到一半就断了（进程被杀 / 断电）。留着会让「半张图」被当成成品接回来，
    // 而且续传只看文件在不在，不会发现它是坏的 —— 所以这里直接删掉重下。
    const recorded=Number(item.bytes)||0;
    if(!stat.size||(recorded>0&&stat.size!==recorded)){await fsp.rm(full,{force:true}).catch(()=>{});continue;}
    entries.set(String(item.url||''),{...item});
  }
  try{
    for(const name of await fsp.readdir(path.join(dir,'images'))){
      if(declared.has(name))continue;
      // 只清「我们自己命名的图片」：用户手放进去的文件不认识，也轮不到这里删。
      if(!/^\d{2,4}-.*\.(?:jpe?g|png|webp|gif|avif|bmp|tiff|ico)$/i.test(name))continue;
      await fsp.rm(path.join(dir,'images',name),{force:true});
    }
  }catch{}
  return entries;
}

/** 清掉下载中的临时文件（`.part-NN`）。文件夹模式下它们就写在输出目录里，
 *  留着会让最终校验把它当成「未登记的额外文件」。 */
async function cleanDownloadParts(dir){
  try{
    for(const name of await fsp.readdir(dir)){
      if(/^\.part-/.test(name))await fsp.rm(path.join(dir,name),{force:true}).catch(()=>{});
    }
  }catch{}
}

/**
 * Worker body for one image job. Mirrors runArtstationImageJob's contract exactly (`deliver` picks
 * the shape of `output`, the uid comes from the caller), so DownloadManager treats image jobs as
 * ordinary members of the same queue: one verifier, one retry policy, one task list.
 */
export async function runImageJob({uid,name,author,platform,url,assetId,tags,output,deliver='folder',workRoot,open=openPublic,json=publicJson,limit=IMAGE_MAX,totalBytes=IMAGE_TOTAL_BYTES,throttle=null}={},{signal,progress=()=>{}}={}){
  signal?.throwIfAborted();
  await fsp.mkdir(deliver==='folder'?output:path.dirname(output),{recursive:true});
  progress({stage:'starting',message:'正在读取资产的图片清单…'});
  // job 级别的标签是「资产库里已经有的那组」，随任务从界面带下来；源站抓不到标签的
  // 平台（Kenney / Poly Pizza / 花瓣…）全靠它，源站抓得到的则和它取并集。
  const jobTags=tagList(tags);
  const plan=await collectImageAssets(platform,{uid,url,assetId},{open,json,signal});
  const assets=plan.items.slice(0,limit);
  const skipped=(plan.skipped?.length||0)+Math.max(0,plan.items.length-assets.length);
  signal?.throwIfAborted();
  progress({stage:'transferring',message:`已找到 ${assets.length} 张高清图片${skipped?`（另有 ${skipped} 项不可下载）`:''}，开始下载…`});
  const jobMeta={uid,name,author,url,tags:jobTags};
  const liveDir=deliver==='folder'?output:null;
  // 直接存文件夹时 work 就是输出目录本身：下载完成 → 按字节嗅探格式 → 原地改名就位。
  // 原来「先写 tmp、再逐张拷进输出」等于多搬一遍全部图片（上千张大图就是多读写 8GB），
  // 现在省掉了；ZIP 模式仍用 tmp 暂存，因为最终要打包、不留目录。
  let work;
  if(liveDir)work=liveDir;
  else{
    await fsp.mkdir(workRoot||os.tmpdir(),{recursive:true});
    work=await fsp.mkdtemp(path.join(workRoot||os.tmpdir(),'sva-images-'));
  }
  // 续传：上一次尝试已经落盘的图片先接回来，这次只补缺的那些。
  const resumed=liveDir?await resumableEntries(liveDir):null;
  const liveFiles=resumed?[...resumed.values()]:[];
  let failed=[];
  let lastLiveWrite=0,lastLiveCount=0,finished=false;
  // 活清单：目录一建好就带一份有身份的 info.json，扫描器第一眼就能当正式包出卡，
  // 不必等几百张图全部下完。写盘要节流：1923 张时整份 JSON 约 700KB，每秒重写一次纯属浪费；
  // 改成「3 秒一次」或「又多了 10 张」才写，第一张仍然立刻写（卡片要马上有封面和数目）。
  const writeLive=async(force=false)=>{
   if(!liveDir)return;
   const now=Date.now();
   if(!force&&!liveFiles.length&&lastLiveWrite)return;
   if(!force&&now-lastLiveWrite<3000&&liveFiles.length-lastLiveCount<10)return;
   lastLiveWrite=now;lastLiveCount=liveFiles.length;
   try{await writeImageManifest(liveDir,imageManifest({job:jobMeta,plan,files:liveFiles,skipped,status:'downloading'}));}
   catch(e){progress({stage:'converting',message:`资产库清单写入失败：${e.message}`});}
  };
  try{
    const startedAt=Date.now();
    let outWritten=liveFiles.reduce((n,f)=>n+(f.bytes||0),0);const outBegin=Date.now();
    await writeLive(true);
    if(liveFiles.length)progress({stage:'transferring',message:`续传：已有 ${liveFiles.length} 张，继续补剩下的…`});
    // 图片在下载时就已经原地落进输出目录（见上面 work 的取法），这里只登记清单 + 报进度。
    // 「先落盘再声明」的顺序不变：清单里的每一条都保证此刻已经能在磁盘上打开。
    const copyOut=deliver!=='folder'?null:async file=>{
      signal?.throwIfAborted();
      outWritten+=file.bytes;
      liveFiles.push(file);
      // 第一张必须立刻写进清单：卡片要能马上显示「下载中 · 1 张」并拿到封面，
      // 不能等到节流窗口或第 10 张才更新。
      await writeLive(liveFiles.length===1);
      progress({stage:'transferring',message:`已写入本机 ${outWritten?Math.round(outWritten/1024):0} KB`,bytesWritten:outWritten,totalBytes:null,transferRate:Math.round(outWritten/Math.max(.001,(Date.now()-outBegin)/1000))});
    };
    const collected=await collectFiles(work,assets,{client:plan.client,platform:plan.platform,open,signal,progress,startedAt,onFile:copyOut,existing:resumed,throttle,maxBytes:totalBytes});
    const files=collected.files;
    failed=collected.failed;
    // 一张都没取回来 → 这不是「少了几张」，是整条链路都不通，必须如实失败（错误消息带上真实原因）。
    if(!files.length)throw Error(`没有取到任何图片${failed.length?`：${failed[0].message}`:''}`);
    const bytes=files.reduce((n,f)=>n+f.bytes,0);
    signal?.throwIfAborted();
    progress({stage:'converting',message:deliver==='folder'?'正在写出图片文件夹…':'正在打包 ZIP…'});
    const truncated=collected.truncated||0;
    const manifest=imageManifest({job:jobMeta,plan,files,skipped,failedCount:failed.length||undefined,truncatedCount:truncated||undefined});
    const summary={zipName:bundleStem(name,plan),title:plan.title||name||null,author:plan.author||author||null,thumbnail:plan.cover||null,imageCount:files.length,failedCount:failed.length,truncatedCount:truncated};
    // 文件夹模式的图片已经在 copyOut 里逐张落盘，这里只补清单：不把每张图读进内存，
    // 图站整站上千张（单张几百 KB）攒成 entries 会在 Node 堆里堆到 GB 级。
    if(deliver==='folder'){
      // 最终清单去掉 status：校验器随后跑，目录里只剩成品文件。
      await writeImageManifest(output,manifest);
      finished=true;
      return {bytes,folder:true,fileCount:files.length+1,...summary};
    }    const entries=[];
    for(const file of files)entries.push({name:file.file,data:await fsp.readFile(path.join(work,...file.file.split('/')))});
    entries.push({name:'info.json',data:Buffer.from(JSON.stringify(manifest,null,2),'utf8')});
    const written=await writeEntriesDeliverable({entries,output,deliver,signal,progress,message:'高清图片已取回'});
    return {...written,...summary};
  }finally{
    // 下载残留（`.part-NN`）在文件夹模式下就躺在输出目录根里：不清掉，最终校验会以
    // 「存在未登记的文件」把整包退回。成功、失败、取消都要清。
    if(liveDir)await cleanDownloadParts(liveDir);
    if(liveDir&&!finished){
      // 失败 / 取消时也要让清单和磁盘对齐：节流写入可能落后几张，留下一份「声明 5 张、磁盘 6 张」
      // 的半成品，资产库那张卡显示的数目就永远对不上。
      try{await writeImageManifest(liveDir,imageManifest({job:jobMeta,plan,files:liveFiles,skipped,status:'incomplete',failedCount:failed.length||undefined}));}
      catch{await markImageBundleIncomplete(liveDir);}
    }
    // 免二次拷贝时 work 就是输出目录本身：绝不能整个删掉，只有 ZIP 模式才需要清 tmp。
    if(work!==liveDir)await fsp.rm(work,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
  }
}
