// Only remove generated AssetVault installers after the current installer exists.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await fs.readFile(path.join(root,'src-tauri','tauri.conf.json'),'utf8'));
const bundle=path.join(root,'src-tauri','target','release','bundle','nsis');
const keep=path.join(root,'dist',`AssetVault_${config.version}_x64-setup.exe`);
const engine=path.join(bundle,`AssetVault_${config.version}_x64-setup.exe`);
const stat=await fs.stat(keep);
if(!stat.isFile()||stat.size===0)throw Error('Current installer is missing or empty; old installers were preserved.');
const handle=await fs.open(keep,'r');
try{const header=Buffer.alloc(2);await handle.read(header,0,2,0);if(header.toString()!=='MZ')throw Error('Invalid current installer; cleanup cancelled.');}finally{await handle.close();}
let bytes=0,count=0;
for(const dir of [bundle,path.join(root,'dist')]){
 let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
 for(const entry of entries){
  if(!entry.isFile()||!/^AssetVault_.+_x64-setup(?:-[a-z0-9-]+)?\.exe$/i.test(entry.name))continue;
  const candidate=path.resolve(dir,entry.name);
  if(path.dirname(candidate)!==dir)throw Error('Installer path escaped its output folder.');
  if(candidate===keep||candidate===engine)continue;
  const old=await fs.stat(candidate);
  if(process.argv.includes('--apply'))await fs.unlink(candidate);
  console.log(`${process.argv.includes('--apply')?'Removed':'Would remove'}: ${candidate}`);
  bytes+=old.size;count++;
 }
}
console.log(`${process.argv.includes('--apply')?'Cleaned':'Preview'}: ${count} old installers, ${(bytes/1024/1024).toFixed(1)} MiB`);
console.log(`Latest installer: ${keep}`);
