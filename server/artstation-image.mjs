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
import {writeEntriesDeliverable} from './deliverable-writer.mjs';

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

/** Download every planned image into `<work>/images`, naming each by its sniffed container. */
async function collectImages(work,items,{open,signal,progress,startedAt}){
  const dir=path.join(work,'images');
  await fsp.mkdir(dir,{recursive:true});
  const files=[],used=new Set();
  let done=0,written=0;
  for(const [index,item] of items.entries()){
    signal?.throwIfAborted();
    const raw=path.join(work,`.part-${pad2(index+1)}`);
    await downloadImage(item.url,raw,{open,signal,onProgress:p=>progress({
      stage:'transferring',
      message:`正在下载作品图片 ${index+1}/${items.length}${p.total?`（${fmtMB(p.bytes)} / ${fmtMB(p.total)}）`:''}`,
      bytesWritten:written+p.bytes,totalBytes:null,
      transferRate:Math.round((written+p.bytes)/Math.max(.001,(Date.now()-startedAt)/1000)),
    })});
    // The extension comes from the bytes, not from the URL: a renamed CDN object would otherwise be
    // written with an extension that contradicts its content, which the verifier would reject.
    const stem=imageStem(artstationStem(item.title||item.id),`image-${index+1}`);
    const sniffed=await sniffContainer(raw).catch(e=>{throw Error(`${e.message}（${item.url}）`);});
    let name=`${pad2(index+1)}-${stem}.${sniffed.extension}`;
    for(let n=2;used.has(name);n++)name=`${pad2(index+1)}-${stem}-${n}.${sniffed.extension}`;
    used.add(name);
    const relative=`images/${name}`;
    await fsp.rename(raw,path.join(work,relative));
    written+=sniffed.bytes;done++;
    files.push({file:relative,title:item.title||null,width:item.width,height:item.height,bytes:sniffed.bytes,format:sniffed.format,sourceUrl:item.url});
    progress({
      stage:'converting',message:`已取回作品图片 ${done}/${items.length}`,
      bytesWritten:written,totalBytes:null,
      transferRate:Math.round(written/Math.max(.001,(Date.now()-startedAt)/1000)),
    });
  }
  return files;
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
export async function runArtstationImageJob({uid,url,output,deliver='zip',workRoot,open=openPublic,limit=ARTSTATION_IMAGE_MAX}={},{signal,progress=()=>{}}={}){
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
    const files=await collectImages(work,items,{open,signal,progress,startedAt});
    const bytes=files.reduce((n,f)=>n+f.bytes,0);
    if(bytes>ARTSTATION_IMAGE_TOTAL_BYTES)throw Error(`作品图片合计超过 ${fmtMB(ARTSTATION_IMAGE_TOTAL_BYTES)} 限制`);
    signal?.throwIfAborted();
    progress({stage:'converting',message:deliver==='folder'?'正在写出导出文件夹…':'正在打包 ZIP…'});
    const written=await writeArtstationImageDeliverable({work,meta,uid,files,output,deliver,signal,progress});
    return {...written,title:meta.title,author:meta.author,thumbnail:coverUrl(json.cover_url)??null,imageCount:files.length};
  }finally{
    await fsp.rm(work,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
  }
}
