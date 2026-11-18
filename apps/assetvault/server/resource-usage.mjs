import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const desktopName=name=>/^(arvimo|assetvault|sketchfab-exporter)(?:[-_].*)?\.exe$/i.test(name);

export function selectAppProcesses(rows,pid){
 const byId=new Map(rows.map(row=>[Number(row.pid),row]));
 let root=Number(pid),ancestor=byId.get(root);
 // 只提升到明确的桌面宿主，不把开发终端、IDE或其它应用纳入统计。
 for(let i=0;i<5&&ancestor;i++){
  ancestor=byId.get(Number(ancestor.ppid));
  if(ancestor&&desktopName(ancestor.name)){root=Number(ancestor.pid);break;}
 }
 const selected=new Set([root]);
 let changed=true;
 while(changed){changed=false;for(const row of rows)if(!selected.has(Number(row.pid))&&selected.has(Number(row.ppid))){selected.add(Number(row.pid));changed=true;}}
 return rows.filter(row=>selected.has(Number(row.pid)));
}

export function processGroup(row,backendPid){
 if(Number(row.pid)===Number(backendPid))return '后台服务';
 if(desktopName(row.name))return '主程序';
 const cmd=row.command||'';
 if(/--type=gpu-process\b/.test(cmd))return '图形加速';
 if(/--type=renderer\b/.test(cmd))return '界面';
 if(/msedgewebview2|chrome|msedge|chromium/i.test(row.name))return '浏览器与预览';
 if(/blender|ffmpeg|assimp|python|curl|7z|usd|substance/i.test(row.name))return '下载与转换';
 if(/node/i.test(row.name))return '辅助服务';
 return '其它子进程';
}

async function readWindows(){
 // ponytail: 直接使用系统进程计数器，不新增常驻服务或依赖；命令行只用于分类，绝不返回客户端。
 const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ArvimoMemory {
 [StructLayout(LayoutKind.Sequential)] public struct Counters {
  public uint cb, faults;
  public UIntPtr peakWS, ws, peakPaged, paged, peakNonPaged, nonPaged, pagefile, peakPagefile, commit, privateWS, sharedCommit;
 }
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint rights,bool inherit,int pid);
 [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr h,ref Counters c,uint size);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static ulong[] Read(int pid) {
  IntPtr h=OpenProcess(0x1000,false,pid); if(h==IntPtr.Zero)return null;
  try {var c=new Counters();c.cb=(uint)Marshal.SizeOf(c);
   if(!GetProcessMemoryInfo(h,ref c,c.cb))return null;
   return new ulong[]{c.privateWS.ToUInt64(),c.commit.ToUInt64()};
  } finally {CloseHandle(h);}
 }
}
'@
@(Get-CimInstance Win32_Process | ForEach-Object {
 $c=[ArvimoMemory]::Read($_.ProcessId);
 [pscustomobject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;name=$_.Name;started=$_.CreationDate.ToUniversalTime().Ticks.ToString();memory=[double]$_.WorkingSetSize;privateWorkingSet=$(if($null -eq $c){$null}else{[double]$c[0]});privateCommit=$(if($null -eq $c){$null}else{[double]$c[1]});cpu=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000;command=$_.CommandLine}
}) | ConvertTo-Json -Compress`;
 const {stdout}=await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:12000,maxBuffer:16*1024*1024});
 const rows=JSON.parse(stdout.replace(/^\uFEFF/,''));
 return Array.isArray(rows)?rows:[rows];
}

export function createResourceUsage({readProcesses=process.platform==='win32'?readWindows:null,pid=process.pid,now=()=>Date.now(),system=os}={}){
 let previous=new Map(),lastAt=0,inFlight=null,cached=null;
 async function sample(){
  let rows,partial=false;
  if(readProcesses)rows=selectAppProcesses(await readProcesses(),pid);
  else{rows=[{pid,name:'node',memory:process.memoryUsage().rss,cpu:Object.values(process.cpuUsage()).reduce((a,b)=>a+b,0)/1e6,started:String(process.pid)}];partial=true;}
  // 采样器本身不列入工具模块统计。
  rows=rows.filter(row=>!/^(?:powershell|conhost)(?:\.exe)?$/i.test(row.name));
  const at=now(),elapsed=(at-lastAt)/1000;
  const groups=new Map(),next=new Map();
  let totalMemory=0,totalCpu=0,pendingCpu=0;
  for(const row of rows){
   const key=`${row.pid}:${row.started}`,old=previous.get(key),seconds=Number(row.cpu);
   const cpu=Number.isFinite(old)&&elapsed>0&&elapsed<30&&Number.isFinite(seconds)?Math.max(0,(seconds-old)/elapsed*100):null;
   next.set(key,seconds);
   const memory=Math.max(0,Number(row.memory)||0),label=processGroup(row,pid);
   const group=groups.get(label)||{label,processes:0,memory:0,privateWorkingSet:0,privateCommit:0,cpu:0,cpuPending:0};
   group.processes++;group.memory+=memory;
   // Missing/denied counters must remain unknown, never look like zero usage.
   for(const field of ['privateWorkingSet','privateCommit']){
    const value=row[field];
    group[field]=group[field]!==null&&Number.isFinite(value)&&value>=0?group[field]+value:null;
   }
   if(cpu===null){group.cpuPending++;pendingCpu++;}else{group.cpu+=cpu;totalCpu+=cpu;}
   totalMemory+=memory;groups.set(label,group);
  }
  previous=next;lastAt=at;
  const total=system.totalmem(),available=system.freemem(),cores=system.availableParallelism?.()||system.cpus().length||1;
  const list=[...groups.values()];
  const sum=field=>list.some(group=>group[field]===null)?null:list.reduce((total,group)=>total+group[field],0);
  // Keep app/memory as legacy working-set fields for existing diagnostic consumers.
  return {at,partial,scope:rows.some(row=>desktopName(row.name))?'desktop':'backend',platform:process.platform,cores,memory:{app:totalMemory,workingSet:totalMemory,privateWorkingSet:sum('privateWorkingSet'),privateCommit:sum('privateCommit'),total,available,used:Math.max(0,total-available)},cpu:{percent:totalCpu,pending:pendingCpu},processes:rows.length,groups:list.sort((a,b)=>(b.privateWorkingSet??b.memory)-(a.privateWorkingSet??a.memory))};
 }
 return {sample(){
  if(inFlight)return inFlight;
  if(cached&&now()-cached.at<1500)return Promise.resolve(cached);
  inFlight=sample().then(data=>(cached=data)).finally(()=>{inFlight=null;});return inFlight;
 }};
}
