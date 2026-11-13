import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openPublic, validateUrl} from './public-http.mjs';
import {fetchProjectAssets,artstationHash,artstationUid} from './artstation-project.mjs';
import {coverUrl} from './artstation-cdn.mjs';
import {writeEntriesDeliverable} from './deliverable-writer.mjs';
import {browserPath} from './export-worker.mjs';
import {resolveDataDir} from './data-dir.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const MVIEWER_VERSION='2.1.2';
export const MVIEWER_RELEASE_BASE=`https://github.com/majimboo/mviewer/releases/download/v${MVIEWER_VERSION}/mviewer-v${MVIEWER_VERSION}-`;

export const isArtstationHost=host=>/^(?:[a-z0-9-]+\.)*artstation\.com$/i.test(host);

/** Only accept public ArtStation artwork pages. */
export function normalizeArtstationUrl(raw){
  const u=validateUrl(String(raw||''),{artstation:true});
  if(!/^\/artwork\/[A-Za-z0-9]+\/?$/.test(u.pathname))throw Error('请粘贴 ArtStation 作品页地址（artstation.com/artwork/…）');
  u.hash='';
  return u;
}

export function extractEmbedIds(html){
  const out=new Set();
  for(const m of String(html).matchAll(/https?:\/\/(?:www\.)?artstation\.com\/embed\/(\d+)/g))out.add(m[1]);
  return [...out];
}

/** Pull the marmoset.embed() scene URL, thumbnail and title out of an embed page. */
export function extractMview(html){
  const text=String(html);
  let mviewUrl=null;
  const m=text.match(/marmoset\.embed\(\s*["']([^"']+)["']/);
  if(m&&/^https?:\/\//i.test(m[1]))mviewUrl=m[1];
  const t=text.match(/thumbnailURL\s*=\s*["']([^"']+)["']/);
  const titleRaw=(text.match(/<title[^>]*>([^<]*)<\/title>/i)||[])[1];
  const title=titleRaw?titleRaw.replace(/^\s*ArtStation\s*[-–—]?\s*/i,'').trim():null;
  return {mviewUrl,thumbnail:t?t[1]:null,title:title||null};
}

export function looksLikeChallenge(html){
  return /cf-chl|cf_chl_opt|challenge-platform|Just a moment/i.test(String(html));
}


// Reuse browser state for ArtStation's Cloudflare gate. A blank headless profile is routinely
// stopped by managed challenges; a persistent local profile can carry clearance cookies between
// retries. When headless still cannot pass, the same profile is opened in a visible browser window
// so the user can complete the site-owned verification once, then the queued task continues.
function artstationProfile(executable,profileRoot){
  const base=path.join(profileRoot||resolveDataDir(root).dir,'artstation-browser-profile');
  fs.mkdirSync(base,{recursive:true});
  if(process.platform==='win32'&&process.env.LOCALAPPDATA){
    const exe=path.basename(executable).toLowerCase();
    let app=null;
    if(/msedge/.test(exe))app=path.join(process.env.LOCALAPPDATA,'Microsoft','Edge','User Data');
    else if(/chrome/.test(exe))app=path.join(process.env.LOCALAPPDATA,'Google','Chrome','User Data');
    // Seed once from the user's normal browser if possible. Never overwrite an already-used
    // AssetVault profile; it may now contain a fresh cf_clearance cookie from the visible fallback.
    if(app&&fs.existsSync(path.join(app,'Default'))&&!fs.existsSync(path.join(base,'Default','Network','Cookies'))){
      for(const rel of ['Local State','Default/Network/Cookies','Default/Preferences']){
        const from=path.join(app,rel),to=path.join(base,rel);
        if(!fs.existsSync(from))continue;
        try{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}catch{/* locked or unreadable: keep the persistent profile as-is */}
      }
    }
  }
  return base;
}

async function dumpWithBrowser(url,{profileRoot,timeout=90000,headless=true}={}){
  const executable=browserPath();
  if(!executable)throw Error('需要 Chrome/Edge 才能读取 ArtStation 页面（站点有 Cloudflare 验证）。请安装浏览器后重试');
  const profile=artstationProfile(executable,profileRoot);
  const port=18400+Math.floor(Math.random()*4000);
  const args=[
    ...(headless?['--headless=new']:['--new-window','--window-size=1120,860']),
    '--no-first-run','--no-default-browser-check','--disable-gpu','--disable-extensions',
    ...(fs.existsSync(path.join(profile,'Default'))?['--profile-directory=Default']:[]),
    `--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'about:blank'
  ];
  const child=spawn(executable,args,{stdio:'ignore',windowsHide:headless});
  let ws=null;
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{
    if(!ws||ws.readyState!==1)return reject(Error('浏览器调试通道不可用'));
    const id=Math.floor(Math.random()*1e9);
    const onMsg=ev=>{const msg=JSON.parse(ev.data);if(msg.id===id){ws.removeEventListener('message',onMsg);msg.error?reject(Error(String(msg.error.message||'').slice(0,160))):resolve(msg.result);}};
    ws.addEventListener('message',onMsg);
    ws.send(JSON.stringify({id,method,params}));
  });
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  try{
    const started=Date.now(),deadline=started+Math.min(timeout,headless?95000:190000);
    let target=null;
    while(Date.now()<deadline){
      try{
        const r=await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,{method:'PUT'});
        if(r.ok){target=await r.json();break;}
      }catch{/* browser still starting */}
      if(child.exitCode!==null)throw Error('后台浏览器启动后立即退出，请检查浏览器安装');
      await sleep(400);
    }
    if(!target)throw Error('后台浏览器启动超时');
    ws=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',()=>reject(Error('浏览器调试通道连接失败')),{once:true});});
    await cdp('Page.enable').catch(()=>{});
    let sawChallenge=false;
    while(Date.now()<deadline){
      let v=null;
      try{
        const probe=await cdp('Runtime.evaluate',{expression:"(()=>{const h=document.documentElement.innerHTML;return{ready:document.readyState==='complete'&&!/cf-chl|cf_chl_opt|challenge-platform|Just a moment/i.test(h)&&(h.indexOf('marmoset.embed')>=0||h.length>60000),cf:/cf-chl|cf_chl_opt|challenge-platform|Just a moment/i.test(h),len:h.length,title:document.title};})()",returnByValue:true});
        v=probe&&probe.result?probe.result.value:null;
      }catch{await sleep(1000);continue;}
      if(v&&v.ready)break;
      if(v&&v.cf){
        sawChallenge=true;
        // Headless Chrome almost never clears ArtStation's managed challenge. Fail fast so the
        // caller can open a visible verification window instead of making every task wait 90s.
        if(headless&&Date.now()-started>12000)throw Error('CF_CHALLENGE_STUCK');
      }
      await sleep(headless?1200:1500);
    }
    let html='';
    try{
      const shot=await cdp('Runtime.evaluate',{expression:'document.documentElement.outerHTML',returnByValue:true});
      html=shot&&shot.result?String(shot.result.value||''):'';
    }catch{}
    if(!html||html.length<1000||looksLikeChallenge(html)){
      throw Error(headless||!sawChallenge
        ?'ArtStation 要求 Cloudflare 验证，后台浏览器也未通过。'
        :'ArtStation 验证窗口已打开，但验证仍未通过或已超时。请在弹出的浏览器中完成验证后重试。');
    }
    return html;
  }finally{
    try{ws&&ws.close();}catch{}
    try{child.kill('SIGKILL');}catch{}
  }
}

/** Fallback reader for Cloudflare-protected pages: first try a persistent headless browser; if
 * ArtStation blocks automation, open a visible verification window and keep polling until the page
 * is readable. This does not bypass Cloudflare; it lets the user pass the site's normal check. */
export async function headlessDump(url,{profileRoot,timeout=90000}={}){
  try{
    return await dumpWithBrowser(url,{profileRoot,timeout,headless:true});
  }catch(e){
    const msg=String(e.message||e);
    if(!/CF_CHALLENGE_STUCK|Cloudflare|验证|challenge/i.test(msg))throw e;
    return await dumpWithBrowser(url,{profileRoot,timeout:Math.max(timeout,180000),headless:false});
  }
}

export async function fetchArtstationHtml(url,{open=openPublic,headless=headlessDump,profileRoot,signal}={}){
  signal?.throwIfAborted();
  let directError=null;
  try{
    const r=await open(url,{artstation:true,signal,timeout:30000});
    const chunks=[];let bytes=0;
    try{
      for await(const chunk of r.stream){
        bytes+=chunk.length;
        if(bytes>4*1024*1024){r.stream.destroy();break;}
        chunks.push(chunk);
      }
    }catch(e){r.stream.destroy();throw e;}
    const html=Buffer.concat(chunks).toString('utf8');
    if(r.status>=200&&r.status<300&&html.length>512&&!looksLikeChallenge(html))return html;
    directError=Error(`HTTP ${r.status}`);
  }catch(e){directError=e;}
  try{
    const html=await headless(url,{profileRoot});
    if(looksLikeChallenge(html))throw Error('ArtStation 要求 Cloudflare 验证，后台浏览器也未通过。请稍后重试，或先在浏览器中打开该作品页。');
    return html;
  }catch(e){
    if(signal?.aborted)throw e;
    throw Error(`读取 ArtStation 页面失败：${e.message}${directError?`（直接访问：${String(directError.message).slice(0,120)}）`:''}`);
  }
}

/** artwork URL -> { artworkUrl, embedUrl, mviewUrl, thumbnail, title, author, size } */
export async function resolveArtstationModel(rawUrl,{open=openPublic,headless,profileRoot,signal}={}){
  const artwork=normalizeArtstationUrl(rawUrl);
  signal?.throwIfAborted();
  // 1) 首选：公开的项目 JSON 接口（作品页已是 SPA 空壳，直接抓 HTML 拿不到 embed）。
  let embedIds=[],title=null,author=null;
  try{
    const viaApi=await fetchProjectAssets(artwork.href,{open,signal});
    if(viaApi){embedIds=viaApi.ids;title=viaApi.title;author=viaApi.author;}
  }catch{/* 网络层失败时退回 HTML 抓取 */}
  // 2) 兜底：抓作品页 HTML（老页面仍把 Marmoset iframe 直接内联在 HTML 里）。
  if(!embedIds.length){
    const page=await fetchArtstationHtml(artwork.href,{open,headless,profileRoot,signal});
    signal?.throwIfAborted();
    author=author||(page.match(/"author"\s*:\s*"([^"]+)"/)||page.match(/"author"\s*:\s*\{[^{}]*?"name"\s*:\s*"([^"]+)"/)||[])[1]||null;
    embedIds=extractEmbedIds(page);
  }
  if(!embedIds.length)throw Error('这个作品页没有内嵌 Marmoset 3D 预览');
  for(const id of embedIds.slice(0,3)){
    signal?.throwIfAborted();
    const embed=await fetchArtstationHtml(`https://www.artstation.com/embed/${id}`,{open,headless,profileRoot,signal});
    const found=extractMview(embed);
    if(!found.mviewUrl)continue;
    let size=null;
    try{
      const r=await open(found.mviewUrl,{artstation:true,signal,timeout:30000});
      const len=r.headers['content-length'];
      if(/^\d+$/.test(String(len||'')))size=Number(len);
      r.stream.destroy();
    }catch{}
    // `uid` is part of the resolved model, not just a search-time extra: pasting an artwork link
    // must produce a model the shared download queue can identify, verify and dedupe. The thumbnail
    // goes through the same CDN rule as search rows, so a future embed template handing back a
    // square rendition cannot leave this card broken while the grid stays fine.
    return {uid:artstationUid(artstationHash(artwork.href)),artworkUrl:artwork.href,embedUrl:`https://www.artstation.com/embed/${id}`,mviewUrl:found.mviewUrl,thumbnail:coverUrl(found.thumbnail)??found.thumbnail,title:found.title||title,author,size};
  }
  throw Error('embed 页面中没有找到 marmoset 场景（该作品可能不含 Marmoset 预览）');
}

/** Stream the .mview scene file to disk with progress. */
export async function downloadMview(url,dest,{open=openPublic,signal,onProgress}={}){
  const u=validateUrl(url,{artstation:true});
  const r=await open(u.href,{artstation:true,signal,timeout:120000});
  if(r.status<200||r.status>=300){r.stream.destroy();throw Error(`Marmoset 场景文件返回 HTTP ${r.status}`);}
  const total=Number(r.headers['content-length'])||null;
  const tmp=dest+'.part';
  const started=Date.now();
  let bytes=0;
  const fd=await fsp.open(tmp,'w');
  try{
    for await(const chunk of r.stream){
      signal?.throwIfAborted();
      await fd.write(chunk);
      bytes+=chunk.length;
      if(bytes>800*1024*1024)throw Error('场景文件超过 800MB 限制');
      onProgress?.({bytes,total,elapsedMs:Date.now()-started});
    }
    await fd.sync();
  }finally{await fd.close();}
  await fsp.rename(tmp,dest);
  return {bytes,total};
}

export function mviewerBinary(){
  const fromEnv=process.env.SFX_MVIEWER;
  if(fromEnv&&fs.existsSync(fromEnv))return fromEnv;
  const name=process.platform==='win32'?'mviewer.exe':'mviewer';
  const local=path.join(root,'vendor','mviewer',name);
  if(fs.existsSync(local))return local;
  return name;
}

export async function mviewerInfo(){
  const bin=mviewerBinary();
  const explicit=bin!=='mviewer'&&bin!=='mviewer.exe';
  if(explicit&&!fs.existsSync(bin))return {available:false,version:null,bin,needFetch:true};
  try{
    const out=await new Promise((resolve,reject)=>execFile(bin,['--version'],{timeout:20000,windowsHide:true},(e,so)=>e?reject(Object.assign(Error(String(e.message||'')),{code:e.code})):resolve(String(so||''))));
    const m=out.match(/(\d+\.\d+\.\d+)/);
    return {available:true,version:m?m[1]:null,bin,needFetch:false};
  }catch(e){
    const missing=e&&e.code==='ENOENT';
    return {available:!missing,version:null,bin,needFetch:missing&&!explicit};
  }
}

/** Run the mviewer CLI: .mview -> glTF or GLB written into outDir. */
export function convertMview(mviewFile,outDir,{format='glb',log=()=>{}}={}){
  const bin=mviewerBinary();
  return new Promise((resolve,reject)=>{
    // windowsHide：后台服务没有控制台，不加这个标志 mviewer 会自己弹一个新的黑框。
    execFile(bin,[mviewFile,outDir,'--format',format],{timeout:600000,maxBuffer:32*1024*1024,windowsHide:true},(err,stdout,stderr)=>{
      const out=`${stdout||''}\n${stderr||''}`.trim();
      log(out.slice(-800));
      if(err){
        if(err.code==='ENOENT')reject(Error('未找到 mviewer 可执行文件。请先运行 npm run fetch:mviewer（或设置 SFX_MVIEWER 指向 mviewer）。'));
        else reject(Error((out.match(/Error:[^\n]*/)||['mviewer 转换失败'])[0].slice(0,500)));
        return;
      }
      if(!/wrote (GLB|glTF) scene/i.test(out))reject(Error('mviewer 未输出场景（文件可能不是有效的 .mview）'));
      resolve({outDir});
    });
  });
}

const fmtMB=n=>n==null?'未知':`${(n/1048576).toFixed(n>=10485760?0:1)} MB`;

/** Filesystem-safe stem for an ArtStation export name; shared with the image pipeline so both
 *  pipelines name the same artwork the same way. */
export function artstationStem(name){
  const forbidden=['<','>',':','"','/','\\','|','?','*'];
  let stem='';
  for(const ch of String(name||'artstation-model')){
    const code=ch.codePointAt(0);
    stem+=forbidden.includes(ch)||code<32?'_':ch;
  }
  return stem.replace(/[. ]+$/,'').slice(0,80)||'artstation-model';
}

function urlHash(url){
  let h1=0xdeadbeef,h2=0x41c6ce57;
  for(let i=0;i<String(url).length;i++){
    const ch=String(url).charCodeAt(i);
    h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677);
  }
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (h2>>>0).toString(16).padStart(8,'0').slice(0,8)+(h1>>>0).toString(16).padStart(8,'0').slice(0,4);
}

/** Collect mviewer output files + info.json into flat entries (`name` uses `/` separators). */
export async function artstationEntries({outDir,meta,format,uid}){
  const names=await fsp.readdir(outDir);
  const entries=[];
  const used=new Set();
  for(const name of names.sort()){
    const p=path.join(outDir,name);
    const st=await fsp.stat(p);
    if(!st.isFile()||used.has(name))continue;
    used.add(name);
    entries.push({name,data:await fsp.readFile(p)});
  }
  // `uid` is required: the shared archive verifier checks provenance by matching
  // info.json.uid against the job's uid, exactly like the Sketchfab exporter does.
  // The job's uid wins; re-deriving it here would let any URL-normalisation difference
  // between the resolver and this writer fail verification on every save.
  const info={uid:uid||artstationUid(artstationHash(meta.artworkUrl)),platform:'artstation',title:meta.title||null,author:meta.author||null,url:meta.artworkUrl,embedUrl:meta.embedUrl||null,source:meta.mviewUrl,format,exportedAt:new Date().toISOString(),tool:`sketchfab-exporter ArtStation / mviewer ${MVIEWER_VERSION}`,note:'由 ArtStation 作品内嵌的 Marmoset Viewer 场景（.mview）转换而来。请遵守原作品许可。'};
  entries.push({name:'info.json',data:Buffer.from(JSON.stringify(info,null,2),'utf8')});
  return {zipName:`${artstationStem(meta.title)}-${urlHash(meta.mviewUrl)}.zip`,entries};
}

/** Historical name: existing callers and tests read the entry list off this. */
export async function buildArtstationZip(options){return artstationEntries(options);}

// Saving, dedupe naming, persistence, queueing and verification all live in DownloadManager;
// this module only produces a verified-shape ZIP into the staging path it is handed.

/**
 * Write the finished export into the staging path DownloadManager owns: one ZIP file, or loose
 * files in a directory when folder delivery was asked for. Both shapes carry the same entries, so
 * the verifier and the "FBX + ZIP" packing step downstream stay delivery-agnostic.
 */
export async function writeArtstationDeliverable({outDir,meta,format,uid,output,deliver='zip',signal,progress=()=>{}}={}){
 const {zipName,entries}=await artstationEntries({outDir,meta,format,uid});
 const written=await writeEntriesDeliverable({entries,output,deliver,signal,progress,message:'Marmoset 场景已转换'});
 return {zipName,...written};
}

/**
 * Worker body for one ArtStation job: artwork URL -> .mview -> GLB -> deliverable written to `output`.
 * Mirrors the Sketchfab runner contract so DownloadManager can queue, verify, save, retry and cancel
 * both platforms through a single code path: `deliver==='zip'` writes one archive to the file path
 * `output`, and `deliver==='folder'` writes loose files into the directory `output` (the same shape
 * the Sketchfab pipeline returns for folder output, and what the FBX step needs to work from).
 */
export async function runArtstationJob({uid,url,output,format='glb',deliver='zip',workRoot,open=openPublic},{signal,progress=()=>{}}={}){
  signal?.throwIfAborted();
  await fsp.mkdir(deliver==='folder'?output:path.dirname(output),{recursive:true});
  progress({stage:'starting',message:'正在识别作品中的 Marmoset 场景…'});
  const meta=await resolveArtstationModel(url,{open,signal});
  signal?.throwIfAborted();
  progress({stage:'converting',message:`已识别《${meta.title||'未命名作品'}》· 场景文件 ${fmtMB(meta.size)}，开始下载…`});
  // mkdtemp needs its parent to exist; DownloadManager hands us a per-attempt scratch root.
  await fsp.mkdir(workRoot||os.tmpdir(),{recursive:true});
  const work=await fsp.mkdtemp(path.join(workRoot||os.tmpdir(),'sfx-as-'));
  try{
    const mviewFile=path.join(work,'scene.mview');
    const startedAt=Date.now();
    await downloadMview(meta.mviewUrl,mviewFile,{open,signal,onProgress:p=>progress({
      stage:'converting',
      message:`正在下载 Marmoset 场景 ${fmtMB(p.bytes)}${p.total?` / ${fmtMB(p.total)}`:''}`,
      bytesWritten:p.bytes,totalBytes:p.total||null,
      transferRate:Math.round(p.bytes/Math.max(.001,(Date.now()-startedAt)/1000)),
    })});
    signal?.throwIfAborted();
    progress({stage:'converting',message:'正在用 mviewer 转换 glTF/GLB…'});
    const outDir=path.join(work,format==='glb'?'glb':'gltf');
    await convertMview(mviewFile,outDir,{format,log:message=>progress({stage:'converting',message})});
    signal?.throwIfAborted();
    progress({stage:'converting',message:deliver==='folder'?'正在写出导出文件夹…':'正在打包 ZIP…'});
    // Write into the staging path DownloadManager owns; it verifies, then commits with dedupe naming.
    const written=await writeArtstationDeliverable({outDir,meta,format,uid,output,deliver,signal,progress});
    return {...written,title:meta.title,author:meta.author,thumbnail:meta.thumbnail};
  }finally{
    await fsp.rm(work,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
  }
}
