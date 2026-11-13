// One-shot native imports. The DCC runs its own importer on its main thread;
// a successful file copy is never reported as a successful scene import.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {constants} from 'node:fs';
import {resolveDccImport} from './blender-import.mjs';
import {chineseError} from '../src/library/error-message.js';
import {detectSoftware} from './software-detection.mjs';

export const DCC_TARGETS=['maya','3dsmax','houdini','c4d'];
const source=path.join(path.dirname(fileURLToPath(import.meta.url)),'dcc-receiver.py');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const queueDir=(dataDir,target)=>path.join(dataDir,'dcc-import',target);

async function children(dir){try{return await fs.readdir(dir,{withFileTypes:true});}catch{return [];}}
export async function dccProfiles(target,{home=os.homedir(),appData=process.env.APPDATA||path.join(home,'AppData','Roaming'),localAppData=process.env.LOCALAPPDATA||path.join(home,'AppData','Local')}={}){
 const documents=[path.join(home,'Documents'),...(process.env.OneDrive?[path.join(process.env.OneDrive,'Documents')]:[])];
 const found=[];
 for(const docs of documents){
  if(target==='maya')for(const e of await children(path.join(docs,'maya')))if(e.isDirectory()&&/^20\d\d$/.test(e.name)&&Number(e.name)>=2022)found.push(path.join(docs,'maya',e.name));
  if(target==='houdini')for(const e of await children(docs))if((e.isDirectory()||e.isSymbolicLink())&&/^houdini\d+\.\d+$/.test(e.name))found.push(path.join(docs,e.name));
 }
 if(target==='3dsmax')for(const base of new Set([appData,localAppData]))for(const e of await children(path.join(base,'Autodesk','3dsMax')))if(e.isDirectory())for(const lang of await children(path.join(base,'Autodesk','3dsMax',e.name)))if(lang.isDirectory()&&/^[A-Z]{3}$/i.test(lang.name))found.push(path.join(base,'Autodesk','3dsMax',e.name,lang.name));
 if(target==='c4d')for(const e of await children(path.join(appData,'Maxon')))if(e.isDirectory()&&/Cinema.?4D/i.test(e.name))found.push(path.join(appData,'Maxon',e.name));
 return [...new Set(await Promise.all(found.map(p=>fs.realpath(p))))];
}

async function updateStartup(script,start){
 await fs.mkdir(path.dirname(script),{recursive:true});
 let old='';try{old=await fs.readFile(script,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 const block=`# AssetVault import receiver: begin\n${start}# AssetVault import receiver: end`;
 const updated=old.includes('# AssetVault import receiver: begin')?old.replace(/# AssetVault import receiver: begin[\s\S]*?# AssetVault import receiver: end/,block):old+'\n'+block+'\n';
 if(old&&!old.includes('# AssetVault import receiver: begin'))await fs.copyFile(script,script+'.assetvault-backup',constants.COPYFILE_EXCL).catch(error=>{if(error.code!=='EEXIST')throw error;});
 await fs.writeFile(script,updated,'utf8');
}

export async function dccStatus(dataDir,target,options){
 const dir=queueDir(dataDir,target),sessions=[];
 for(const e of await children(dir))if(/^status-\d+\.json$/.test(e.name)){
  try{const s=JSON.parse(await fs.readFile(path.join(dir,e.name),'utf8'));if(s.target===target&&Date.now()-s.at<10000)sessions.push(s);}catch{}
 }
 let installed=false;
 try{installed=JSON.parse(await fs.readFile(path.join(dir,'installed.json'),'utf8')).profiles.length>0;}catch{}
 return {installed,connected:sessions.length>0,sessions,profiles:await dccProfiles(target,options),...await detectSoftware(target,{...options,dataDir})};
}

/** Install only into detected profiles; never overwrite another plugin or user startup script. */
export async function installDcc(dataDir,target,options){
 if(!DCC_TARGETS.includes(target))throw Error('不支持的软件');
 const progress=options?.onProgress||(()=>{});
 progress({percent:5,message:'正在检测软件与用户配置…'});
 let profiles=await dccProfiles(target,options);
 if(['maya','houdini'].includes(target)){
  const software=await detectSoftware(target,options),home=options?.home||os.homedir();
  for(const installation of software.installations){
   const version=target==='maya'?installation.executable.match(/maya\s*(20\d\d)/i)?.[1]:installation.executable.match(/houdini[ -]*(\d+\.\d+)/i)?.[1];
   if(!version||target==='maya'&&Number(version)<2022)continue;
   const profile=target==='maya'?path.join(home,'Documents','maya',version):path.join(home,'Documents','houdini'+version);
   await fs.mkdir(profile,{recursive:true});const resolved=await fs.realpath(profile);if(!profiles.includes(resolved))profiles.push(resolved);
  }
 }
 if(!profiles.length)throw Error('没有找到该软件的用户配置目录，请先启动一次软件后重试');
 progress({percent:25,message:'正在复制接收脚本…'});
 const dir=queueDir(dataDir,target);await fs.mkdir(dir,{recursive:true});
 const receiver=path.join(dir,'assetvault_receiver.py');await fs.copyFile(source,receiver);
 const start=`import runpy\nrunpy.run_path(${JSON.stringify(receiver.replaceAll('\\','/'))}, init_globals={'ASSETVAULT_TARGET': ${JSON.stringify(target)}, 'ASSETVAULT_QUEUE': ${JSON.stringify(dir.replaceAll('\\','/'))}})\n`;
 for(const profile of profiles){
  progress({percent:30+Math.round(profiles.indexOf(profile)/profiles.length*60),message:`正在配置启动脚本（${profiles.indexOf(profile)+1}/${profiles.length}）…`});
  if(target==='maya'){
   await updateStartup(path.join(profile,'scripts','userSetup.py'),start);
  }else if(target==='3dsmax'){
   const script=path.join(profile,'scripts','startup','AssetVault.ms');await fs.mkdir(path.dirname(script),{recursive:true});
   const bootstrap=path.join(dir,'startup.py');await fs.writeFile(bootstrap,start,'utf8');
   await fs.writeFile(script,`python.ExecuteFile @"${bootstrap.replaceAll('"','""')}"\n`,'utf8');
  }else if(target==='houdini'){
   // Extend the user's startup, rather than shadowing other packages' 456.py with a new HOUDINI_PATH.
   for(const name of ['123.py','456.py'])await updateStartup(path.join(profile,'scripts',name),start);
  }else{
   const plugin=path.join(profile,'plugins','AssetVault');await fs.mkdir(plugin,{recursive:true});
   await fs.writeFile(path.join(plugin,'assetvault.pyp'),'# coding: utf-8\n'+start,'utf8');
  }
 }
 progress({percent:95,message:'正在保存安装记录…'});
 await fs.writeFile(path.join(dir,'installed.json'),JSON.stringify({profiles}),'utf8');
 progress({percent:100,message:'安装完成，请重启对应软件'});
 return {ok:true,profiles,note:'接收脚本已安装，请重启对应软件一次；之后点击导出即可导入当前场景。'};
}

export async function sendDcc({dataDir,target,job,timeout=120000}){
 const status=await dccStatus(dataDir,target);
 if(!status.connected)throw Error(status.installed?'软件未连接，请启动或重启软件，等待接收脚本加载后重试':'请先在设置中为该软件安装导入接收脚本');
 if(status.sessions.length!==1)throw Error('检测到多个软件窗口，请只保留一个已连接的实例后重试');
 const {file}=resolveDccImport(job.filePath);
 const id=randomUUID(),dir=queueDir(dataDir,target),request=path.join(dir,id+'.request.json'),response=path.join(dir,id+'.response.json');
 const expiresAt=Date.now()+timeout;
 await fs.writeFile(request+'.part',JSON.stringify({id,target,session:status.sessions[0].pid,file,name:job.name||'AssetVault',expiresAt}),'utf8');
 await fs.rename(request+'.part',request);
 try{
  while(Date.now()<expiresAt){
   let result;try{result=JSON.parse(await fs.readFile(response,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
   if(result){if(!result.ok)throw Error('软件导入失败：'+chineseError(result.error||'请查看软件中的脚本日志',{fallback:true}));return {ok:true,target,mode:'model',detail:result.detail,file,note:'资产已导入当前场景'};}
   await delay(200);
  }
  throw Error('等待软件导入结果超时，请检查软件是否弹出了对话框；不要重复点击，以免重复导入');
 }finally{
  await fs.unlink(request).catch(()=>{});await fs.unlink(response).catch(()=>{});
 }
}
