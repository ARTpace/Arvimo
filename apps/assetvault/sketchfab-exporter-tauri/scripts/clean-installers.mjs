// Only remove generated AssetVault installers after the current installer exists.
// 安装包统一存放于桌面工程 dist/ 根目录（2026-10-20 用户要求）：最终安装器、更新载荷与
// 签名都在这里，旧版本的 setup/update/sig 一并清扫；bundle 目录里的引擎副本由
// prepare-release 在留档后删除，这里只兜底扫它。
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await fs.readFile(path.join(root,'src-tauri','tauri.conf.json'),'utf8'));
const bundle=path.join(root,'src-tauri','target','release','bundle','nsis');
const dist=path.join(root,'dist');
const name=`AssetVault_${config.version}_x64`;
const keep=path.join(dist,`${name}-setup.exe`);
const engine=path.join(bundle,`${name}-setup.exe`);
const stat=await fs.stat(keep);
if(!stat.isFile()||stat.size===0)throw Error('Current installer is missing or empty; old installers were preserved.');
const handle=await fs.open(keep,'r');
try{const header=Buffer.alloc(2);await handle.read(header,0,2,0);if(header.toString()!=='MZ')throw Error('Invalid current installer; cleanup cancelled.');}finally{await handle.close();}
let bytes=0,count=0;
for(const dir of [bundle,dist]){
 let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
 for(const entry of entries){
  // 覆盖三类产物：最终安装器 setup、更新载荷 update、更新签名 sig。
  if(!entry.isFile()||!/^AssetVault_.+_x64-(?:setup|update)(?:-[a-z0-9-]+)?\.exe(?:\.sig)?$/i.test(entry.name))continue;
  const candidate=path.resolve(dir,entry.name);
  if(path.dirname(candidate)!==dir)throw Error('Installer path escaped its output folder.');
  // 当前版本的 setup / update / sig 是发布资产，不清；引擎副本正常情况下已被
  // prepare-release 删掉，这里兜底跳过，避免误删本次构建的中间产物。
  const current=[`${name}-setup.exe`,`${name}-setup.exe.sig`];
  if(candidate===keep||candidate===engine||current.includes(entry.name))continue;
  const old=await fs.stat(candidate);
  if(process.argv.includes('--apply'))await fs.unlink(candidate);
  console.log(`${process.argv.includes('--apply')?'Removed':'Would remove'}: ${candidate}`);
  bytes+=old.size;count++;
 }
}
console.log(`${process.argv.includes('--apply')?'Cleaned':'Preview'}: ${count} old installers, ${(bytes/1024/1024).toFixed(1)} MiB`);
console.log(`Latest installer: ${keep}`);
