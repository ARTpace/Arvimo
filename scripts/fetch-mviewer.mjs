import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createWriteStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const VERSION=process.env.MVIEWER_VERSION||'2.1.2';
const platform=process.platform==='win32'?'windows-x64':process.platform==='linux'&&process.arch==='x64'?'linux-x64':process.platform==='darwin'?(process.arch==='arm64'?'macos-arm64':'macos-x64'):null;
if(!platform)throw Error('仅支持 Windows x64 / Linux x64 / macOS 平台');
const isWin=process.platform==='win32';
const url=`https://github.com/majimboo/mviewer/releases/download/v${VERSION}/mviewer-v${VERSION}-${platform}.${isWin?'zip':'tar.gz'}`;
const dir=path.join(root,'vendor','mviewer');
const targetName=isWin?'mviewer.exe':'mviewer';
const target=path.join(dir,targetName);
if(fs.existsSync(target)){console.log(`已存在：${target}\n如需更新请先删除该文件，或设置 MVIEWER_VERSION 指定其他版本。`);process.exit(0);}
console.log(`下载 mviewer v${VERSION}（${platform}）…`);
console.log(url);
const res=await fetch(url,{redirect:'follow'});
if(!res.ok)throw Error(`下载失败：HTTP ${res.status}`);
await fsp.mkdir(dir,{recursive:true});
const tmp=path.join(dir,`.dl-${process.pid}-${Date.now()}`);
const ws=createWriteStream(tmp);
try{
  for await(const chunk of res.body)ws.write(chunk);
  await new Promise((r,j)=>{ws.end();ws.on('finish',r);ws.on('error',j);});
}catch(e){await fsp.unlink(tmp).catch(()=>{});throw Error(`下载中断：${e.message}`);}
const tmpDir=path.join(os.tmpdir(),`mviewer-${process.pid}`);
await fsp.mkdir(tmpDir,{recursive:true});
try{
  if(isWin){
    await new Promise((resolve,reject)=>execFile('powershell',['-NoProfile','-Command',`Expand-Archive -Path "${tmp}" -DestinationPath "${tmpDir}" -Force`],{timeout:180000},e=>e?reject(e):resolve()));
  }else{
    await new Promise((resolve,reject)=>execFile('tar',['-xzf',tmp,'-C',tmpDir],{timeout:180000},e=>e?reject(e):resolve()));
  }
  const found=[];
  const walk=p=>{for(const n of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,n);if(n.isDirectory())walk(f);else if(n.name===targetName)found.push(f);}};
  walk(tmpDir);
  if(!found.length)throw Error('压缩包中未找到 mviewer 可执行文件');
  await fsp.copyFile(found[0],target);
  if(!isWin)await fsp.chmod(target,0o755);
  console.log(`完成：${target}`);
  console.log('注意：majimboo/mviewer 仓库未附带 LICENSE 文件；请自行评估其许可后再分发本工具。');
}catch(e){
  throw Error(`安装失败：${e.message}`);
}finally{
  await fsp.unlink(tmp).catch(()=>{});
  await fsp.rm(tmpDir,{recursive:true,force:true}).catch(()=>{});
}
