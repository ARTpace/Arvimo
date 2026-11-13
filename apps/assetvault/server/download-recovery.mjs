import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {verifyArchive} from './archive.mjs';
import {verifyFolder} from './folder-archive.mjs';

export function canonicalPath(value){
 let resolved=path.resolve(value);try{resolved=fs.realpathSync(resolved);}catch{}
 return process.platform==='win32'?resolved.toLowerCase():resolved;
}

// Scan category containers only; never follow links or descend into an asset's payload.
export async function recoverDownloads(jobs,roots,{onSkipped=()=>{},dismissed=new Set()}={}){
 const seen=new Set(jobs.filter(j=>j.filePath&&fs.existsSync(j.filePath)).map(j=>canonicalPath(j.filePath)));
 const visited=new Set();let recovered=0;
 async function scan(root,dir,depth=0){
  if(depth>3)return;
  let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const entry of entries){
   if(entry.isSymbolicLink()||entry.name.startsWith('.'))continue;
   const file=path.join(dir,entry.name),folder=entry.isDirectory();
   // 「只入库」写出的远程收藏卡只有元数据（status:'remote'），没有可恢复的下载内容：
   // 交给校验器只会以「清单里声明的图片不存在」失败，在启动日志里刷一行没用的跳过记录。
   if(folder){
    try{if(JSON.parse(fs.readFileSync(path.join(file,'info.json'),'utf8'))?.status==='remote')continue;}catch{/* 没有 info.json 或读不动：照常往下走 */}
   }
   if(folder&&!fs.existsSync(path.join(file,'info.json'))){await scan(root,file,depth+1);continue;}
   if(!folder&&!/\.zip$/i.test(entry.name)||seen.has(canonicalPath(file))||dismissed.has(canonicalPath(file)))continue;
   try{
    const verification=await (folder?verifyFolder(file):verifyArchive(file));
    const info=verification.info;if(!/^[a-f0-9]{32}$/.test(info?.uid))continue;
    const kind=info.kind==='images'?'images':info.platform||'sketchfab';
    if(!['images','sketchfab','artstation','polyhaven','ambientcg','polypizza','kenney','freestylized'].includes(kind))continue;
    const resolution=info.resolution||info.files?.map(f=>f.url?.match(/(?:\/|_)([1248])k(?:\/|_|\.)/i)?.[1]).filter(Boolean)?.[0];
    const options={output:folder?'folder':'zip'};
    if(resolution)options.resolution=/^\d$/.test(resolution)?resolution+'K':resolution.toUpperCase();
    if(['material','hdri'].includes(info.kind))options.textureFormat=String(info.format||'').toUpperCase();
    if(kind==='ambientcg'&&info.kind==='pack')options.textureFormat='JPG';
    const formats=folder?fs.readdirSync(file).filter(n=>/\.(glb|fbx)$/i.test(n)).map(n=>path.extname(n).slice(1).toLowerCase()):verification.glbs.length?['glb']:[];
    const now=Date.now();
    jobs.push({...info,kind,name:info.title||info.name||info.assetId||entry.name,id:randomUUID(),state:'saved',stage:'saved',message:'已从本地资产恢复下载记录',options,recovered:true,recoveredFormats:formats,assetType:info.assetType||(info.kind==='material'?'textures':info.kind==='hdri'?'hdris':undefined),downloadRoot:root,downloadDir:dir,filePath:file,filename:entry.name,verification:{...verification,info:undefined},createdAt:now,finishedAt:now,attempts:0,logs:[]});
    seen.add(canonicalPath(file));recovered++;
   }catch(error){onSkipped(file,error.message);/* Never mark incomplete deliveries downloaded. */}
  }
 }
 for(const root of roots){const key=canonicalPath(root);if(visited.has(key))continue;visited.add(key);await scan(root,root);}
 return recovered;
}

export function recoveredOptionsMatch(job,options){
 if(!job.recovered)return false;
 if(job.options.output!==options.output)return false;
 if(options.resolution&&job.options.resolution!==options.resolution)return false;
 if(options.textureFormat&&job.options.textureFormat!==options.textureFormat)return false;
 if(options.format&&job.recoveredFormats.length&&!job.recoveredFormats.includes(options.format))return false;
 // Historical exports do not record texture resizing or full/raw-scene choices.
 if(options.maxTextureEdge||options.packMode==='full')return false;
 return true;
}
