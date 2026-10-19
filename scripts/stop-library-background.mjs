import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pidPath=path.join(root,'.assetvault','library-server.pid');
const port=Number(process.env.SFX_PORT||4178);
function psJson(command){
 if(process.platform!=='win32')return null;
 try{return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',command],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}
}
function pidsOnPort(){
 const raw=psJson(`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ConvertTo-Json -Compress`);
 if(!raw)return [];
 try{const data=JSON.parse(raw);return Array.isArray(data)?data.map(Number):[Number(data)];}catch{return [];}
}
function projectServerPids(){
 const marker=root.replace(/'/g,"''");
 const raw=psJson(`Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -like '*server/library.mjs*' -or $_.CommandLine -like '*npm run library*') -and $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress`);
 if(!raw)return [];
 try{const data=JSON.parse(raw);return Array.isArray(data)?data.map(Number):[Number(data)];}catch{return [];}
}
const pidFilePid=fs.existsSync(pidPath)?Number(fs.readFileSync(pidPath,'utf8').trim()):0;
const pids=[pidFilePid,...pidsOnPort(),...projectServerPids()].filter(Boolean);
const unique=[...new Set(pids)].filter(pid=>pid!==process.pid);
if(!unique.length){
 console.log('没有发现正在运行的 AssetVault 后台服务。');
 fs.rmSync(pidPath,{force:true});
 process.exit(0);
}
for(const pid of unique){
 try{
  if(process.platform==='win32')execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'inherit'});
  else process.kill(pid,'SIGTERM');
 }catch(e){console.log(`PID ${pid} 停止失败或已退出：${e.message}`);}
}
fs.rmSync(pidPath,{force:true});
console.log('AssetVault 后台服务已停止。');
