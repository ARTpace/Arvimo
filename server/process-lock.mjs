import {execFileSync} from 'node:child_process';

export function processIdentity(){return {pid:process.pid,startedAt:Math.round(Date.now()-process.uptime()*1000),executable:process.execPath};}

export function canReplaceOwner(owner,actual){
 return Number.isSafeInteger(owner?.pid)&&owner.pid>0&&owner.pid!==process.pid&&!!owner.startedAt&&!!owner.executable&&actual?.isLibrary===true&&!!actual.startedAt&&!!actual.executable&&matchesWindowsOwner(owner,actual);
}

// Desktop takeover is explicit; never terminate arbitrary Node processes or trust a PID alone.
export function replaceLibraryOwner(owner){
 if(process.platform!=='win32'||!Number.isSafeInteger(owner?.pid)||owner.pid<=0)return false;
 try{
  const script=`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.pid}'; if($null -eq $p){'null'}else{@{executable=$p.ExecutablePath;startedAt=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();isLibrary=($p.Name -match '^node.*\\.exe$' -and $p.CommandLine -match 'library\\.mjs')}|ConvertTo-Json -Compress}`;
  const actual=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000}).trim());
  if(!canReplaceOwner(owner,actual))return false;
  const stop=`$p=Get-Process -Id ${owner.pid} -ErrorAction Stop; if([Math]::Abs(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()-${actual.startedAt}) -lt 1000){Stop-Process -InputObject $p -Force -ErrorAction Stop; $p.WaitForExit(5000) | Out-Null}else{exit 1}`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',stop],{windowsHide:true,timeout:7000});
  return !lockOwnerAlive(owner);
 }catch{return false;}
}

export function matchesWindowsOwner(owner,actual){
 if(!actual)return false;
 // Old releases stored only a PID: accept it only if Windows still sees a library service.
 if(!owner.startedAt||!owner.executable)return actual.isLibrary===true;
 if(!actual.executable||!actual.startedAt)return true; // Cannot inspect a protected process: preserve its lock.
 return owner.executable.toLowerCase()===actual.executable.toLowerCase()&&Math.abs(owner.startedAt-actual.startedAt)<1000;
}

export function lockOwnerAlive(owner){
 if(!Number.isSafeInteger(owner?.pid)||owner.pid<=0)throw Error('下载记录目录锁无效，请检查 manager.lock');
 if(owner.pid===process.pid)return owner.startedAt?matchesWindowsOwner(owner,processIdentity()):false;
 if(process.platform==='win32'){
  try{
   // CIM excludes exited processes whose kernel handles are still open; kill(pid, 0) does not.
   const script=`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.pid}'; if($null -eq $p){'null'}else{@{executable=$p.ExecutablePath;startedAt=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();isLibrary=($p.Name -match '^node.*\\.exe$' -and $p.CommandLine -match 'library\\.mjs')}|ConvertTo-Json -Compress}`;
   const actual=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000}).trim());
   return matchesWindowsOwner(owner,actual);
  }catch{return true;} // Inspection failure must not permit concurrent writers.
 }
 try{process.kill(owner.pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}
