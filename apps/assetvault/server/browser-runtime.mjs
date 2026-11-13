// 浏览器运行时：Sketchfab 模型转换（export-worker）与 ArtStation 页面读取（artstation）
// 都需要一个真实的 Chromium 在后台渲染网页。
//
// 为什么不再打进安装包：chrome-headless-shell 解压后 236MB，占了安装包体积的九成，
// 但只有真正执行「转换 / 抓取」时才用得上。改成安装后按需下载：
//   - 安装包从 107MB 回到 ~40MB（首装更快、下载更容易留存）；
//   - 走国内镜像（淘宝 npmmirror），国内不用翻墙也能稳定下到。
//
// 版本策略：**锁死一个稳定版**而不是跟随最新。chrome-for-testing 的 Dev/Canary 改动频繁，
// 无头渲染的行为差异会直接影响转换成功率，所以这里固定一个在 Stable 通道挑出的版本；
// 需要别的版本时用 SFX_CHROME_VERSION 覆盖，无需改代码。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

/** 锁定的稳定版：chrome-for-testing Stable 通道 155 分支（已实测可跑通转换）。 */
export const CHROME_VERSION=process.env.SFX_CHROME_VERSION||'155.0.8059.79';

const ZIP_NAME='chrome-headless-shell-win64.zip';
/** 解压后压缩包内的顶层目录名（随平台变化，见 platformInfo）。 */
const JOB_TTL=30*60*1000;
const DOWNLOAD_TIMEOUT_MS=20*60*1000;
/** 下载中断后每个镜像各试一次；全失败才报错。 */
const MIRROR_ATTEMPTS=2;

/** 平台目录名与可执行文件名。安装包只发 Windows，但本地跑 server 时也要能用。 */
function platformInfo(){
 if(process.platform==='win32')return {tag:'win64',inner:'chrome-headless-shell-win64',exe:'chrome-headless-shell.exe'};
 if(process.platform==='darwin')return {tag:process.arch==='arm64'?'mac-arm64':'mac-x64',inner:process.arch==='arm64'?'chrome-headless-shell-mac-arm64':'chrome-headless-shell-mac-x64',exe:'chrome-headless-shell'};
 return {tag:'linux64',inner:'chrome-headless-shell-linux64',exe:'chrome-headless-shell'};
}

/** chrome-for-testing 的下载源。国内镜像排第一，官方源作兜底。 */
function mirrors(){
 const v=CHROME_VERSION,tag=platformInfo().tag;
 const list=[];
 const custom=process.env.SFX_CHROME_MIRROR;
 // 自定义前缀：给企业内网 / 自建镜像留的口子，格式与 chrome-for-testing 目录结构一致。
 if(custom)list.push(`${custom.replace(/\/+$/,'')}/${v}/${tag}/${ZIP_NAME}`);
 list.push(`https://registry.npmmirror.com/-/binary/chrome-for-testing/${v}/${tag}/${ZIP_NAME}`);
 list.push(`https://storage.googleapis.com/chrome-for-testing-public/${v}/${tag}/${ZIP_NAME}`);
 return list;
}

/** 浏览器装在哪里。Tauri 应用由 main.rs 传 SFX_BROWSER_INSTALL_DIR（应用数据目录）；
 *  命令行直接跑 server/library.mjs 时落到工程内的 vendor/browser，和 vendor 里其他
 *  「按需下载」的二进制（curl-impersonate / mviewer）保持一致，不污染系统目录。 */
export function browserInstallRoot(){
 const custom=process.env.SFX_BROWSER_INSTALL_DIR;
 if(custom)return path.resolve(custom);
 return path.join(root,'vendor','browser');
}

/** 安装完成后的可执行文件路径。headless shell 缺失时上层会回退系统 Edge/Chrome。 */
export function browserExePath(){
 const info=platformInfo();
 return path.join(browserInstallRoot(),info.inner,info.exe);
}

function installedExe(){
 const exe=browserExePath();
 try{return fs.statSync(exe).isFile()?exe:null;}catch{return null;}
}

function dirSize(dir){
 let total=0;
 const walk=current=>{
  let entries;
  try{entries=fs.readdirSync(current,{withFileTypes:true});}catch{return;}
  for(const entry of entries){
   const full=path.join(current,entry.name);
   if(entry.isDirectory())walk(full);
   else{try{total+=fs.statSync(full).size;}catch{}}
  }
 };
 walk(dir);
 return total;
}

/** 系统自带的 Chrome / Edge：没下载随包浏览器时的回退。
 *  它「能用」但不可控 —— 可能被杀软拦下命令行启动，所以只作兜底，并如实报给界面。 */
const SYSTEM_BROWSERS=[
 {name:'Microsoft Edge',path:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'},
 {name:'Microsoft Edge',path:'C:/Program Files/Microsoft/Edge/Application/msedge.exe'},
 {name:'Google Chrome',path:'C:/Program Files/Google/Chrome/Application/chrome.exe'},
 {name:'Google Chrome',path:process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe'):null},
 {name:'Chromium',path:'/usr/bin/chromium'},
 {name:'Google Chrome',path:'/usr/bin/google-chrome'},
];

/** 本机有没有可以顶一下的系统浏览器。和 export-worker 的 browserPath() 同一批路径。 */
export function systemBrowser(){
 const hit=SYSTEM_BROWSERS.find(b=>b.path&&fs.existsSync(b.path));
 return hit?{found:true,name:hit.name,path:hit.path}:{found:false,name:null,path:null};
}

/** 面板状态：装没装、装在哪、多大、用的哪个源、系统有没有可回退的浏览器。 */
export function browserStatus(){
 const exe=installedExe();
 const info=platformInfo();
 return {
  ok:true,
  version:CHROME_VERSION,
  pinned:!process.env.SFX_CHROME_VERSION,
  platform:info.tag,
  installed:!!exe,
  path:exe||browserExePath(),
  root:browserInstallRoot(),
  // 只在已安装时统计体积：没装时整棵目录扫一遍毫无意义。
  bytes:exe?dirSize(path.join(browserInstallRoot(),info.inner)):0,
  mirrors:mirrors().map(url=>({url,host:new URL(url).host,primary:url.includes('npmmirror.com')})),
  // 没下载随包浏览器时，界面据此区分「系统那个还能顶一下」和「真的什么都用不了」。
  system:systemBrowser(),
  tip:'Sketchfab 模型转换与 ArtStation 页面读取需要它；没装时会回落到系统 Chrome/Edge。',
 };
}

/* ── 安装任务 ───────────────────────────────────────────────────────────────
   和「Blender 连接」的安装一致：起任务立刻返回 id，界面按 id 轮询读进度。
   每一步都对应后端真实动作，失败时把原因原样带回去，而不是只弹个转瞬即逝的提示。 */
const STEPS=[
 {key:'download',label:'下载浏览器压缩包',weight:72},
 {key:'extract',label:'解压到数据目录',weight:23},
 {key:'verify',label:'校验可执行文件',weight:5},
];
const jobs=new Map();
const MB=n=>(n/1048576).toFixed(1);

export function browserInstallJob(id){return jobs.get(String(id||''))||null;}

/** 起一个下载任务，立刻返回 id；调用方轮询 browserInstallJob 读进度。 */
export function startBrowserInstallJob(){
 for(const [id,job] of jobs)if(Date.now()-(job.endedAt||job.startedAt)>JOB_TTL)jobs.delete(id);
 const job={
  id:randomUUID(),
  state:'running',
  percent:0,
  message:`正在下载浏览器运行时（chrome-headless-shell ${CHROME_VERSION}）…`,
  error:null,
  steps:STEPS.map(s=>({...s,state:'pending',detail:null,current:0,total:0})),
  status:null,
  startedAt:Date.now(),
  endedAt:null,
 };
 jobs.set(job.id,job);
 runInstall(job).catch(error=>finish(job,'failed',String(error?.message||error)));
 return job.id;
}

function stepPercent(job){
 if(job.state!=='running')return 100;
 let percent=0;
 for(const step of job.steps){
  if(step.state==='done'||step.state==='error')percent+=step.weight;
  // 下载阶段用真实字节比例；解压/校验的耗时未知，只给一点前导值，免得进度条死卡在 0。
  else if(step.state==='active')percent+=step.weight*(step.total?Math.min(1,step.current/step.total):0.2);
 }
 return Math.max(1,Math.min(99,Math.round(percent)));
}

function finish(job,state,error){
 job.state=state;
 job.error=state==='ok'?null:(error||job.error||'未知错误');
 job.endedAt=Date.now();
 job.percent=stepPercent(job);
 job.status=browserStatus();
 if(state==='ok')job.message=`浏览器运行时已就绪（chrome-headless-shell ${CHROME_VERSION}）`;
 else job.message=job.message||'浏览器运行时下载失败';
}

/** 读取 ZIP 中央目录并逐条产出 {name, data}。只支持 Store/Deflate，
 *  带盘符或 .. 的路径直接跳过（防路径穿越）。 */
function* zipEntries(buf){
 let eocd=-1;
 for(let i=buf.length-22;i>=0&&i>=buf.length-65557;i--)if(buf.readUInt32LE(i)===0x06054b50){eocd=i;break;}
 if(eocd<0)throw Error('压缩包无效：找不到目录结尾');
 const count=buf.readUInt16LE(eocd+10);
 let p=buf.readUInt32LE(eocd+16);
 for(let n=0;n<count;n++){
  if(p+46>buf.length||buf.readUInt32LE(p)!==0x02014b50)throw Error('压缩包目录损坏');
  const method=buf.readUInt16LE(p+10),packed=buf.readUInt32LE(p+20),nl=buf.readUInt16LE(p+28),el=buf.readUInt16LE(p+30),cl=buf.readUInt16LE(p+32),offset=buf.readUInt32LE(p+42);
  const name=buf.subarray(p+46,p+46+nl).toString('utf8');
  p+=46+nl+el+cl;
  if(/[\\:\0]/.test(name)||name.split('/').some(v=>v==='..'))continue;
  const start=offset+30+buf.readUInt16LE(offset+26)+buf.readUInt16LE(offset+28);
  const raw=buf.subarray(start,start+packed);
  yield {name,data:method===8?zlib.inflateRawSync(raw):Buffer.from(raw)};
 }
}

/** 下载压缩包：逐个镜像尝试，流式写入并回报字节进度。 */
async function downloadZip(job,step){
 const tmpDir=path.join(browserInstallRoot(),'.tmp');
 await fsp.mkdir(tmpDir,{recursive:true});
 const target=path.join(tmpDir,`${ZIP_NAME}.part`);
 const urls=mirrors();
 const errors=[];
 for(let attempt=0;attempt<MIRROR_ATTEMPTS;attempt++){
  for(const url of urls){
   const host=new URL(url).host;
   step.detail=`连接 ${host}…`;
   try{
    const response=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)});
    if(!response.ok)throw Error(`HTTP ${response.status}`);
    const total=Number(response.headers.get('content-length'))||0;
    step.total=total;
    step.current=0;
    const stream=fs.createWriteStream(target);
    try{
      for await(const chunk of response.body){
      step.current+=chunk.length;
      // total 可能缺失（分块传输），这时至少把已下载量显示出来。
      step.detail=total?`${MB(step.current)} / ${MB(total)} MB`:`已下载 ${MB(step.current)} MB`;
      // 下载是本任务最长的一段，必须边下边推百分比，否则界面会一直停在 0%。
      job.percent=stepPercent(job);
      if(!stream.write(chunk))await new Promise(resolve=>stream.once('drain',resolve));
     }
    }finally{
     await new Promise(resolve=>stream.end(resolve));
    }
    const size=(await fsp.stat(target)).size;
    if(size<1024*1024)throw Error(`下载内容不完整（仅 ${MB(size)} MB）`);
    step.detail=`已下载 ${MB(size)} MB · 来自 ${host}`;
    return target;
   }catch(error){
    errors.push(`${host}：${error?.message||error}`);
    await fsp.rm(target,{force:true}).catch(()=>{});
   }
  }
 }
 throw Error(`所有下载源都失败了（${errors.join('；')}）`);
}

/** 把暂存目录搬到正式目录。
 *  Windows 上 rename 一个刚写完 100+MB 的目录经常被 EPERM 拒（杀软还握着文件句柄，
 *  或父目录被占用），跨卷时则是 EXDEV。两条路都退到逐文件拷贝，避免「下完了却算没装」。 */
async function moveDir(from,to){
 try{await fsp.rename(from,to);return;}
 catch(error){
  // 退避一下再试一次：多数 EPERM 只是句柄还没放开的短暂窗口。
  await new Promise(resolve=>setTimeout(resolve,400));
  try{await fsp.rename(from,to);return;}
  catch(again){await fsp.cp(from,to,{recursive:true});}
 }
}
async function extractZip(job,step,zipPath){
 const info=platformInfo();
 const installRoot=browserInstallRoot();
 const tmpRoot=path.join(installRoot,'.tmp',`extract-${process.pid}-${Date.now()}`);
 await fsp.mkdir(tmpRoot,{recursive:true});
 try{
  const buf=await fsp.readFile(zipPath);
  step.detail='正在展开文件…';
  let written=0;
  for(const {name,data} of zipEntries(buf)){
   if(!name)continue;
   const dest=path.resolve(tmpRoot,name);
   if(!dest.startsWith(path.resolve(tmpRoot)))continue;
   if(name.endsWith('/')){await fsp.mkdir(dest,{recursive:true});continue;}
   await fsp.mkdir(path.dirname(dest),{recursive:true});
   await fsp.writeFile(dest,data);
   written++;
   if(written%64===0)step.detail=`已展开 ${written} 个文件…`;
  }
  step.detail=`已展开 ${written} 个文件`;
  const staged=path.join(tmpRoot,info.inner);
  if(!fs.existsSync(staged))throw Error('压缩包里没有找到浏览器目录');
  const finalDir=path.join(installRoot,info.inner);
  // 覆盖升级：先把旧目录挪开再改名，避免出现「一半新一半旧」的安装。
  const backup=path.join(installRoot,`.old-${Date.now()}`);
  if(fs.existsSync(finalDir)){
   // 覆盖升级：先把旧目录挪开再搬新的，避免出现「一半新一半旧」的安装。
   // 挪不动（同样可能是 EPERM）就直接删掉旧的，反正内容马上会被完整覆盖。
   try{await fsp.rename(finalDir,backup);}
   catch{await fsp.rm(finalDir,{recursive:true,force:true}).catch(()=>{});}
  }
  await moveDir(staged,finalDir);
  await fsp.rm(backup,{recursive:true,force:true}).catch(()=>{});
  if(process.platform!=='win32')await fsp.chmod(browserExePath(),0o755).catch(()=>{});
 }finally{
  await fsp.rm(tmpRoot,{recursive:true,force:true}).catch(()=>{});
  await fsp.rm(zipPath,{force:true}).catch(()=>{});
 }
}

async function runInstall(job){
 const [download,extract,verify]=job.steps;
 try{
  download.state='active';
  const zipPath=await downloadZip(job,download);
  download.state='done';
  job.percent=stepPercent(job);

  extract.state='active';
  await extractZip(job,extract,zipPath);
  extract.state='done';
  job.percent=stepPercent(job);

  verify.state='active';
  const exe=installedExe();
  if(!exe)throw Error('解压完成但没有找到可执行文件，请重试下载');
  verify.detail=exe;
  verify.state='done';
  finish(job,'ok');
 }catch(error){
  for(const step of job.steps)if(step.state==='active'){step.state='error';step.detail=String(error?.message||error);}
  finish(job,'failed',String(error?.message||error));
 }
}
