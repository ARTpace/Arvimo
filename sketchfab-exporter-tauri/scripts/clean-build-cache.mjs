// ponytail: fixed generated folders only; never clean user data or dependency downloads.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const apply=process.argv.includes('--apply');
const deep=process.argv.includes('--deep');
for(const arg of process.argv.slice(2))if(!['--apply','--deep'].includes(arg))throw Error(`Unknown option: ${arg}`);
// Keep release dependencies for fast rebuilds unless the user explicitly requests deep cleanup.
const targets=['debug','installer-ui',...(deep?['release/build','release/deps','release/.fingerprint','release/incremental']:[])];
const target=path.join(root,'src-tauri','target');

async function sizeOf(dir){
 let bytes=0;
 for(const entry of await fs.readdir(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);
  if(entry.isSymbolicLink())throw Error(`Linked entry; cleanup cancelled: ${file}`);
  if(entry.isDirectory())bytes+=await sizeOf(file);
  else if(entry.isFile())bytes+=(await fs.stat(file)).size;
 }
 return bytes;
}

// Validate every ancestor before scanning/deleting; reject junctions and external targets.
async function inspect(relative){
 const file=path.join(target,relative);
 let current=root;
 for(const part of path.relative(root,file).split(path.sep)){
  current=path.join(current,part);
  let stat;try{stat=await fs.lstat(current);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(stat.isSymbolicLink()||!stat.isDirectory())throw Error(`Not a plain generated directory: ${current}`);
  if(await fs.realpath(current)!==current)throw Error(`Redirected directory; cleanup cancelled: ${current}`);
 }
 return {file,bytes:await sizeOf(file)};
}

if(apply){
 if(process.platform==='win32'){
  const processes=execFileSync('tasklist',['/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true});
  if(/^"(?:cargo|rustc|assetvault|assetvault-setup)\.exe"/im.test(processes))throw Error('Rust build or AssetVault is running; close it before cleanup.');
 }
 // A complete current release must exist before removing any build cache.
 const {version}=JSON.parse(await fs.readFile(path.join(root,'src-tauri','tauri.conf.json'),'utf8'));
 const installer=`AssetVault_${version}_x64-setup.exe`;
 const release=path.join(root,'dist');
 const manifest=JSON.parse(await fs.readFile(path.join(release,'latest.json'),'utf8'));
 const signature=(await fs.readFile(path.join(release,installer+'.sig'),'utf8')).trim();
 const platform=manifest.platforms?.['windows-x86_64'];
 if(manifest.version!==version||!signature||platform?.signature!==signature||!platform?.url?.endsWith('/'+installer))throw Error('Current release manifest/signature missing or inconsistent; cleanup cancelled.');
 const handle=await fs.open(path.join(release,installer),'r');
 try{const magic=Buffer.alloc(2);await handle.read(magic,0,2,0);if(magic.toString()!=='MZ')throw Error('Current installer is invalid; cleanup cancelled.');}finally{await handle.close();}
}
// Preflight all candidates before the first mutation.
const candidates=[];
for(const relative of targets){const item=await inspect(relative);if(item)candidates.push(item);}
let bytes=0;
for(const {file,bytes:count} of candidates){
 if(apply){await inspect(path.relative(target,file));await fs.rm(file,{recursive:true,force:true,maxRetries:2,retryDelay:150});}
 bytes+=count;
 console.log(`${apply?'Removed':'Would remove'}: ${file} (${(count/1024**3).toFixed(3)} GiB)`);
}
console.log(`${apply?'Reclaimed':'Preview'}: ${(bytes/1024**3).toFixed(3)} GiB. Final installers, source and user data preserved.`);
