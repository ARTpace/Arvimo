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
import {openPublic,publicJson} from './public-http.mjs';
import {IMAGE_BUNDLE_KIND} from './artstation-image.mjs';
import {collectImageAssets,IMAGE_MAX} from './image-sources.mjs';
import {downloadImage,sniffContainer,imageStem,IMAGE_TOTAL_BYTES} from './image-store.mjs';
import {writeEntriesDeliverable} from './deliverable-writer.mjs';

const fmtMB=n=>n==null?'未知':`${(n/1048576).toFixed(n>=10485760?0:1)} MB`;
const pad2=n=>String(n).padStart(2,'0');

/** Download every planned picture into `<work>/images`, naming each after what its bytes really are. */
async function collectFiles(work,items,{client,open,signal,progress,startedAt,onFile}){
  const dir=path.join(work,'images');
  await fsp.mkdir(dir,{recursive:true});
  const files=[],used=new Set();
  let done=0,written=0;
  for(const [index,item] of items.entries()){
    signal?.throwIfAborted();
    const raw=path.join(work,`.part-${pad2(index+1)}`);
    await downloadImage(item.url,raw,{open,client,signal,onProgress:p=>progress({
      stage:'transferring',
      message:`正在下载高清图片 ${index+1}/${items.length}${p.total?`（${fmtMB(p.bytes)} / ${fmtMB(p.total)}）`:''}`,
      bytesWritten:written+p.bytes,totalBytes:null,
      transferRate:Math.round((written+p.bytes)/Math.max(.001,(Date.now()-startedAt)/1000)),
    })});
    // The extension comes from the bytes, not from the URL: a renamed CDN object would otherwise be
    // written with an extension that contradicts its content, which the verifier would reject.
    const sniffed=await sniffContainer(raw).catch(e=>{throw Error(`${e.message}（${item.url}）`);});
    const stem=imageStem(item.title,`image-${index+1}`);
    let name=`${pad2(index+1)}-${stem}.${sniffed.extension}`;
    for(let n=2;used.has(name);n++)name=`${pad2(index+1)}-${stem}-${n}.${sniffed.extension}`;
    used.add(name);
    const relative=`images/${name}`;
    await fsp.rename(raw,path.join(work,relative));
    written+=sniffed.bytes;done++;
    files.push({file:relative,title:item.title||null,width:item.width??null,height:item.height??null,bytes:sniffed.bytes,format:sniffed.format,sourceUrl:item.url});
    // Streaming delivery: hand each finished picture out at once instead of waiting for the whole
    // board, so the folder (and the library card built from it) is usable from the first image.
    if(onFile)await onFile(files[files.length-1]);
    progress({
      stage:'converting',message:`已取回高清图片 ${done}/${items.length}`,
      bytesWritten:written,totalBytes:null,
      transferRate:Math.round(written/Math.max(.001,(Date.now()-startedAt)/1000)),
    });
  }
  return files;
}

/**
 * For an image bundle the manifest *is* the provenance: the verifier requires every declared file to
 * be present and every present file to be declared, so it cannot be trimmed afterwards without the
 * next validation noticing. Each picture therefore carries its measured pixels and its remote URL.
 */
function imageManifest({job,plan,files,skipped}){
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
    imageCount:files.length,
    // The manifest *is* the provenance for an image bundle: see the note above.
    images:files.map(f=>({file:f.file,title:f.title,width:f.width,height:f.height,bytes:f.bytes,format:f.format,url:f.sourceUrl})),
    note:'作者在原站公开的图片（已取最大可下载尺寸）。请遵守原作品许可，未经授权请勿商用。',
    exportedAt:new Date().toISOString(),
    tool:'AssetVault / asset images',
  };
  if(skipped)info.skippedCount=skipped;
  return info;
}

/** `<name>-images`: the exported tree always says what it holds, next to the model export it may share a stem with. */
export function bundleStem(name,plan){
  return imageStem(plan?.title||name||'images','images')+'-images';
}

/**
 * Worker body for one image job. Mirrors runArtstationImageJob's contract exactly (`deliver` picks
 * the shape of `output`, the uid comes from the caller), so DownloadManager treats image jobs as
 * ordinary members of the same queue: one verifier, one retry policy, one task list.
 */
export async function runImageJob({uid,name,author,platform,url,assetId,output,deliver='folder',workRoot,open=openPublic,json=publicJson,limit=IMAGE_MAX,totalBytes=IMAGE_TOTAL_BYTES}={},{signal,progress=()=>{}}={}){
  signal?.throwIfAborted();
  await fsp.mkdir(deliver==='folder'?output:path.dirname(output),{recursive:true});
  progress({stage:'starting',message:'正在读取资产的图片清单…'});
  const plan=await collectImageAssets(platform,{uid,url,assetId},{open,json,signal});
  const assets=plan.items.slice(0,limit);
  const skipped=(plan.skipped?.length||0)+Math.max(0,plan.items.length-assets.length);
  signal?.throwIfAborted();
  progress({stage:'transferring',message:`已找到 ${assets.length} 张高清图片${skipped?`（另有 ${skipped} 项不可下载）`:''}，开始下载…`});
  await fsp.mkdir(workRoot||os.tmpdir(),{recursive:true});
  const work=await fsp.mkdtemp(path.join(workRoot||os.tmpdir(),'sva-images-'));
  try{
    const startedAt=Date.now();
    let outWritten=0;const outBegin=Date.now();
    // 直接存文件夹：每取回一张就 copy 进输出目录（而不是等全部下完再统一写）。
    // 图站整站动辄上百张，先落地的那张就等于资产库里已经能打开的一张图。
    const copyOut=deliver!=='folder'?null:async file=>{
      signal?.throwIfAborted();
      const target=path.join(output,...file.file.split('/'));
      await fsp.mkdir(path.dirname(target),{recursive:true});
      await fsp.copyFile(path.join(work,...file.file.split('/')),target);
      outWritten+=file.bytes;
      progress({stage:'transferring',message:`已写入本机 ${outWritten?Math.round(outWritten/1024):0} KB`,bytesWritten:outWritten,totalBytes:null,transferRate:Math.round(outWritten/Math.max(.001,(Date.now()-outBegin)/1000))});
    };
    const files=await collectFiles(work,assets,{client:plan.client,open,signal,progress,startedAt,onFile:copyOut});
    const bytes=files.reduce((n,f)=>n+f.bytes,0);
    if(bytes>totalBytes)throw Error(`图片合计超过 ${fmtMB(totalBytes)} 限制`);
    signal?.throwIfAborted();
    progress({stage:'converting',message:deliver==='folder'?'正在写出图片文件夹…':'正在打包 ZIP…'});
    const manifest=imageManifest({job:{uid,name,author,url},plan,files,skipped});
    const summary={zipName:bundleStem(name,plan),title:plan.title||name||null,author:plan.author||author||null,thumbnail:plan.cover||null,imageCount:files.length};
    // 文件夹模式的图片已经在 copyOut 里逐张落盘，这里只补清单：不把每张图读进内存，
    // 图站整站上千张（单张几百 KB）攒成 entries 会在 Node 堆里堆到 GB 级。
    if(deliver==='folder'){
      await fsp.writeFile(path.join(output,'info.json'),JSON.stringify(manifest,null,2));
      return {bytes,folder:true,fileCount:files.length+1,...summary};
    }
    const entries=[];
    for(const file of files)entries.push({name:file.file,data:await fsp.readFile(path.join(work,...file.file.split('/')))});
    entries.push({name:'info.json',data:Buffer.from(JSON.stringify(manifest,null,2),'utf8')});
    const written=await writeEntriesDeliverable({entries,output,deliver,signal,progress,message:'高清图片已取回'});
    return {...written,...summary};
  }finally{
    await fsp.rm(work,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
  }
}
