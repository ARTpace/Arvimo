import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';

const executables={maya:['bin/maya.exe'], '3dsmax':['3dsmax.exe'],houdini:['bin/houdini.exe','bin/houdinifx.exe'],c4d:['Cinema 4D.exe','Cinema4D.exe'],unity:['Editor/Unity.exe'],unreal:['Engine/Binaries/Win64/UnrealEditor.exe'],godot:['Godot.exe','godot.exe']};
const matches={maya:/\bMaya\b/i,'3dsmax':/3ds\s*Max/i,houdini:/Houdini\s*\d/i,c4d:/Cinema\s*4D/i,unity:/Unity\s*\d|^20\d\d\.\d/i,unreal:/Unreal|^UE_\d/i,godot:/Godot/i};
async function directories(root){try{return (await fs.readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>path.join(root,e.name));}catch{return [];}}
let registry,registryAt=0;
function registryInstallations(){
 if(process.platform!=='win32')return Promise.resolve([]);
 if(registry&&Date.now()-registryAt>5000)registry=undefined;
 if(!registry)registryAt=Date.now();
 // A single read-only query shared by all software tabs; no full-disk scan.
 if(!registry)registry=new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$keys=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -match 'Maya|3ds Max|Houdini|Cinema.?4D|Unity|Unreal|Godot'} | Select-Object DisplayName,InstallLocation) | ConvertTo-Json -Compress"],{windowsHide:true,timeout:8000,maxBuffer:1024*1024},(error,stdout)=>{try{const rows=JSON.parse(stdout);resolve(Array.isArray(rows)?rows:[rows]);}catch{resolve([]);}}));
 return registry;
}

const detectionTasks=new Map();
export async function detectSoftware(target,options={}){
 if(!options.dataDir)return scanSoftware(target,options);
 const file=path.join(options.dataDir,'software-detection',target+'.json');
 if(!options.refresh)try{const cached=JSON.parse(await fs.readFile(file,'utf8'));if(cached.schema===1&&Date.now()-cached.at<24*60*60*1000&&Array.isArray(cached.result?.installations))return cached.result;}catch{}
 if(!detectionTasks.has(file))detectionTasks.set(file,(async()=>{
  const result=await scanSoftware(target,options);
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,JSON.stringify({schema:1,at:Date.now(),result}),'utf8');
  return result;
 })().finally(()=>detectionTasks.delete(file)));
 return detectionTasks.get(file);
}

async function scanSoftware(target,{programFiles=process.env.ProgramFiles||'C:/Program Files',extraDirectories=[],useRegistry=true}={}){
 const roots={maya:['Autodesk'],'3dsmax':['Autodesk'],houdini:['Side Effects Software'],c4d:['Maxon'],unity:['Unity/Hub/Editor'],unreal:['Epic Games'],godot:['Godot']}[target]||[];
 const candidates=[...extraDirectories];
 for(const dir of await directories(programFiles))if(matches[target]?.test(path.basename(dir)))candidates.push(dir);
 for(const relative of roots){const root=path.join(programFiles,relative);candidates.push(root,...await directories(root));}
 if(useRegistry)for(const row of await registryInstallations())if(matches[target]?.test(row?.DisplayName||'')&&row.InstallLocation)candidates.push(row.InstallLocation);
 if(target==='houdini'&&useRegistry&&process.platform==='win32'){
  const locations=await new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-ItemProperty 'HKLM:\\SOFTWARE\\Side Effects Software\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Side Effects Software\\*','HKCU:\\SOFTWARE\\Side Effects Software\\*' -ErrorAction SilentlyContinue | Where-Object {$_.PSChildName -match '^Houdini[ -]?\\d' -and $_.InstallPath} | Select-Object -ExpandProperty InstallPath) | ConvertTo-Json -Compress"],{windowsHide:true,timeout:8000},(error,stdout)=>{try{const rows=JSON.parse(stdout);resolve(Array.isArray(rows)?rows:[rows]);}catch{resolve([]);}}));
  candidates.push(...locations);
 }
 const override=process.env['ASSETVAULT_'+target.toUpperCase()+'_EXE'];
 const files=[...(override?[override]:[])];
 for(const dir of candidates)for(const relative of executables[target]||[])files.push(path.join(dir,relative));
 const installations=[];
 for(const file of new Set(files))try{if((await fs.stat(file)).isFile()){const executable=await fs.realpath(file);if(!installations.some(item=>item.executable.toLowerCase()===executable.toLowerCase()))installations.push({executable,version:file.match(/(?:20\d\d(?:\.\d+)*|(?:Houdini[ -]*|UE_)\d+(?:\.\d+)*)/i)?.[0]?.replace(/^Houdini[ -]*/i,'').trim()||''});}}catch{}
 if(process.platform==='win32'&&useRegistry&&installations.length){
  const literals=installations.map(item=>"'"+item.executable.replaceAll("'","''")+"'").join(',');
  const versions=await new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',`@(${literals}) | ForEach-Object { $v=(Get-Item -LiteralPath $_).VersionInfo; @{path=$_;version=$v.ProductVersion;fileVersion=$v.FileVersion} } | ConvertTo-Json -Compress`],{windowsHide:true,timeout:8000,maxBuffer:1024*1024},(error,stdout)=>{try{const rows=JSON.parse(stdout);resolve(Array.isArray(rows)?rows:[rows]);}catch{resolve([]);}}));
  for(const item of installations){const info=versions.find(row=>row.path===item.executable);item.version=target==='houdini'&&item.version?item.version:info?.version?.trim()||info?.fileVersion?.trim()||item.version;}
 }
 if(target==='houdini')for(let i=installations.length-1;i>=0;i--)if(installations.slice(0,i).some(item=>path.dirname(item.executable).toLowerCase()===path.dirname(installations[i].executable).toLowerCase()))installations.splice(i,1);
 return {softwareInstalled:installations.length>0,installations};
}
