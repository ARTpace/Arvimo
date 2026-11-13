import fs from 'node:fs';
import {resolveUserPaths} from '../server/data-dir.mjs';
import path from 'node:path';
import {spawn,execFile,execFileSync} from 'node:child_process';
import {libraryOwnerPorts,replaceLibraryOwner} from '../server/process-lock.mjs';
import {serverIsCurrent} from '../server/capabilities.mjs';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// 让开发模式与编译后的安装包共用同一份「数据与下载目录」。
// 安装包由 Tauri 把 SFX_DATA_DIR / SFX_DOWNLOAD_DIR 指到
// %APPDATA%\AssetVault\{data,downloads}；旧 com.assetvault.desktop 路径兼容；
// 这里在没显式设置时补上同样的
// 位置，避免「开发版看得见、安装版看不见」的资产分叉。
// 注意：两边不能同时运行（tasks.json 由 manager.lock 互斥，同时起会有一方报锁冲突）。
const userPaths=resolveUserPaths();
process.env.SFX_DATA_DIR=userPaths.dataDir;
process.env.SFX_DOWNLOAD_DIR=userPaths.downloadDir;
// 这里一旦把 SFX_DATA_DIR 显式写进环境，子进程会认为「数据目录是人为指定的」，
// 从而把账号目录算成 <dataDir>/accounts —— 切库就又把账号弄丢了。
// 所以必须把账号目录一并钉死（它是库外共享的，不随切库变化）。
process.env.SFX_ACCOUNTS_DIR=userPaths.accountsDir;

const stateDir=userPaths.dataDir;
const logPath=path.join(stateDir,'library-server.log');
const pidPath=path.join(stateDir,'library-server.pid');
let port=Number(process.env.SFX_PORT||4179);
let base=`http://127.0.0.1:${port}`;
fs.mkdirSync(stateDir,{recursive:true});

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// 启动器是「本机工具」，不是浏览器：站点上锁后 /api/downloads、/api/downloads/capabilities
// 一律 401，探活拿不到 jobs 就会误报「无法确认旧后台任务状态」而拒绝启动。
// 这里带上数据目录里的机器令牌（与 server/ai-client.mjs 同一套 x-av-token），
// 令牌读不到时（首次安装、还没生成）就只带 X-SFX-Local，行为退回上锁前。
function localHeaders(){
 const headers={'X-SFX-Local':'1'};
 // ADR-13：令牌跟着账号住在库外面；数据目录里那份是升级前的退路。
 for(const file of [path.join(userPaths.accountsDir,'auth-token'),path.join(stateDir,'auth-token')]){
  try{
   const token=fs.readFileSync(file,'utf8').trim();
   if(token){headers['x-av-token']=token;break;}
  }catch{}
 }
 return headers;
}
async function capabilities(readSaved=true){
 if(readSaved)try{
  const saved=JSON.parse(fs.readFileSync(path.join(process.env.SFX_DATA_DIR,'server-port.json'),'utf8')).port;
  if(Number.isInteger(saved)&&saved>0&&saved<=65535){port=saved;base=`http://127.0.0.1:${port}`;}
 }catch{}
 try{
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),1200);
  const res=await fetch(base+'/api/downloads/capabilities',{headers:localHeaders(),cache:'no-store',signal:controller.signal});
  clearTimeout(timeout);
  if(!res.ok)return null;
  return await res.json();
 }catch{return null;}
}
async function discoverOwner(){
 let owner;try{owner=JSON.parse(fs.readFileSync(path.join(process.env.SFX_DATA_DIR,'manager.lock'),'utf8'));}catch{return null;}
 for(const candidate of libraryOwnerPorts(owner)){
  const address=`http://127.0.0.1:${candidate}`;
  try{
   const response=await fetch(address+'/api/health',{signal:AbortSignal.timeout(1500)});
   if(response.ok&&(await response.json()).name==='assetvault-local-library'){
    port=candidate;base=address;return owner;
   }
  }catch{}
 }
 return null;
}
function psJson(command){
 if(process.platform!=='win32')return null;
 // VBS 静默启动的启动器本身没有控制台；不隐藏的话这条 PowerShell 会闪一个命令行窗口。
 try{return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',command],{encoding:'utf8',stdio:['ignore','pipe','ignore'],windowsHide:true}).trim();}catch{return null;}
}
function projectServerPids(){
 if(process.platform!=='win32')return [];
 const marker=root.replace(/'/g,"''");
 const raw=psJson(`Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^node.*\\.exe$') -and ($_.CommandLine -like '*server/library.mjs*' -or $_.CommandLine -like '*server\\library.mjs*') -and $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress`);
 if(!raw)return [];
 try{const data=JSON.parse(raw);return [...new Set((Array.isArray(data)?data:[data]).map(Number).filter(Boolean))];}catch{return [];}
}
function killPids(pids){
 const unique=[...new Set(pids.map(Number).filter(pid=>pid&&pid!==process.pid))];
 for(const pid of unique){
  try{
   if(process.platform==='win32')execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
   else process.kill(pid,'SIGTERM');
   console.log(`已停止旧后台服务 PID ${pid}`);
  }catch{}
 }
}
async function stopOldIfNeeded(){
 const owner=await discoverOwner();
 const cap=await capabilities(!owner);
 if(serverIsCurrent(cap))return true;
 if(owner){
  const response=await fetch(base+'/api/downloads',{headers:localHeaders(),signal:AbortSignal.timeout(3000)});
  const snapshot=response.ok?await response.json().catch(()=>null):null;
  if(!Array.isArray(snapshot?.jobs)){
   // 401/403 是被站点登录闸门挡住的形态：令牌没读到、或者旧服务还不认识令牌。
   // 这时别把锅甩给「安装版托盘」，直接告诉人该按哪个键。
   if(response.status===401||response.status===403)
    throw Error(`旧后台服务拒绝了启动器的自检（HTTP ${response.status}）。请先双击 Stop-Library.cmd 停掉旧后台，再重新启动。`);
   throw Error('无法确认旧后台任务状态，请从托盘完全退出安装版后重试。');
  }
  const active=new Set(['running','transferring','validating','saving','cancelling','queued','retry_wait']);
  if(snapshot.jobs.some(job=>active.has(job.state)))throw Error('旧后台有下载任务，请等待任务完成或暂停队列后，再启动开发模式。');
  if(!replaceLibraryOwner(owner))throw Error('旧后台仍占用数据目录，请从托盘完全退出安装版后重试。');
  note(`已安全替换空闲旧后台 PID ${owner.pid}（${base}）`);
  fs.rmSync(pidPath,{force:true});
 }
 // 只处理命令行确认属于本项目的后台，不能按端口或旧 PID 杀掉其他工具。
 const targets=projectServerPids();
 if(targets.length){
  console.log('检测到旧版 AssetVault 后台服务，正在重启以启用新功能…');
  killPids(targets);
  fs.rmSync(pidPath,{force:true});
  await sleep(1200);
 }
 return false;
}

/** 用默认浏览器打开一个由本机服务提供的地址。
 *  注意两点，缺一个都会变成「双击了但浏览器不打开」：
 *   1. 不能用 stdio:'ignore'，保持默认管道 —— 这正是服务端当初能打开浏览器的那套调用；
 *   2. 必须等 cmd 真的执行完再让启动器退出。一触即退时 cmd 可能还没跑完 start
 *      就随父进程一起被收掉。
 *  返回的 Promise 有 5 秒兜底，不会把启动器永久挂住。 */
function openInBrowser(url){
 if(process.platform!=='win32')return Promise.resolve();
 return new Promise(resolve=>{
  let settled=false;
  const done=line=>{if(settled)return;settled=true;note(line);resolve();};
  const timer=setTimeout(()=>done(`打开浏览器超时未确认：${url}`),5000);
  try{
   execFile('cmd.exe',['/c','start','',url],{windowsHide:true},e=>{
    clearTimeout(timer);
    done(e?`打开浏览器失败：${e.message}`:`已把启动画面交给浏览器：${url}`);
   });
  }catch(e){
   clearTimeout(timer);
   done(`打开浏览器失败：${e.message}`);
  }
 });
}

// 启动器的窗口是隐藏的，它的输出用户永远看不到，所以关键步骤单独记一份日志，
// 下次再出问题不用靠猜。
const launcherLog=path.join(stateDir,'launcher.log');
function note(line){try{fs.appendFileSync(launcherLog,`${new Date().toLocaleString()}  ${line}\n`);}catch{}}
note(`--- 启动请求（node ${process.version}） ---`);

let alreadyRunning;
try{alreadyRunning=await stopOldIfNeeded();}catch(error){note(`启动失败：${error.message}`);console.error(error.message);process.exit(1);}
if(alreadyRunning){
 console.log(`AssetVault 已在后台运行（${base}）。`);
 note('已有服务在运行，直接把启动画面交给浏览器。');
 // 服务本来就在跑，直接把启动画面推给浏览器，双击一样能看到启动动效。
 await openInBrowser(`${base}/splash.html`);
 process.exit(0);
}

fs.appendFileSync(logPath,`\n\n===== AssetVault background start ${new Date().toLocaleString()} =====\n`);
const out=fs.openSync(logPath,'a');

// 先构建（等价于 npm run library 的 prebuild:library + build:library）。
// 同步执行，输出直接写进日志文件，全程不经过 cmd.exe / npm.cmd。
for(const step of ['scripts/apply-patches.mjs','scripts/build-library.mjs']){
 try{
  execFileSync(process.execPath,[path.join(root,step)],{cwd:root,stdio:['ignore',out,out],windowsHide:true});
 }catch(e){
  note(`构建步骤失败：${step}（${e.message}），详情见 library-server.log`);process.exit(1);
 }
}

// 直接用 node 启动服务，不走 cmd / npm。
// 这里两个标志缺一不可：
//   detached     —— Windows 上必须。不带它时子进程跟着父进程的控制台一起销毁，
//                   启动器一退出（几秒内）服务就被系统带走，浏览器随后只会撞上死端口。
//                   detached 走 DETACHED_PROCESS：不继承父控制台，服务独立存活。
//   直接起 node  —— 不能经 cmd.exe。cmd 在没有控制台时会自己 AllocConsole 分配一个
//                   可见窗口，那正是之前那个关不掉的命令行窗口。
// 浏览器不在这里打开：服务此时还没有控制台，由它去调 cmd / start 有弹出窗口的风险。
// 改成启动器自己在下面轮询到端口真的在监听之后再打开，那也顺带保证了跳转不会落空。
const child=spawn(process.execPath,[path.join(root,'server','library.mjs')],{
 cwd:root,
 stdio:['ignore',out,out],
 detached:true,
 windowsHide:true,
});
fs.writeFileSync(pidPath,String(child.pid));
note(`已拉起服务进程 PID ${child.pid}`);
child.unref();
let opened=false;
for(let i=0;i<30;i++){
 const cap=await capabilities();
 if(serverIsCurrent(cap)){
  console.log(`AssetVault 已在后台启动（PID ${child.pid}）。`);
  console.log('浏览器会自动打开；关闭网页不会停止后台下载服务。');
  console.log(`日志文件：${logPath}`);
  if(!opened){
   opened=true;
   await openInBrowser(`${base}/splash.html`);
  }
  process.exit(0);
 }
 await sleep(500);
}
note(`服务在 15 秒内没有就绪（PID ${child.pid}），未打开浏览器`);
console.log(`AssetVault 已尝试在后台启动（PID ${child.pid}），但尚未确认服务就绪。`);
console.log(`如果网页打不开，请查看日志：${logPath}`);
process.exitCode=1;
