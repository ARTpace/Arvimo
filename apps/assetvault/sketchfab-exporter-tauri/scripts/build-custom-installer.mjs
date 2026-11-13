// Wrap the existing Tauri NSIS installer; preserve the engine until the wrapper builds successfully.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await fs.readFile(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
const target=path.join(root,'src-tauri/target');
const engine=path.join(target,`release/bundle/nsis/Arvimo_${config.version}_x64-setup.exe`);
const output=path.join(root,'../../../dist',`Arvimo_${config.version}_x64-setup.exe`);
const work=path.join(target,'installer-ui');
await fs.mkdir(work,{recursive:true});
const payload=path.join(work,'engine.exe');
await fs.copyFile(engine,payload);
const logo=await fs.readFile(path.join(root,'../src/library/favicon.svg'),'utf8');
let html=await fs.readFile(path.join(root,'installer-preview/index.html'),'utf8');
html=html.replace('../../src/library/favicon.svg',`data:image/svg+xml;base64,${Buffer.from(logo).toString('base64')}`);
const htmlPath=path.join(work,'index.html');
await fs.writeFile(htmlPath,html);
const env={...process.env,ASSETVAULT_INSTALLER_ENGINE:payload,ASSETVAULT_INSTALLER_HTML:htmlPath};
const args=['--manifest-path',path.join(root,'src-tauri/Cargo.toml'),'--features','installer-ui','--bin','assetvault-setup'];
const command=process.argv.includes('--test')?'test':'build';
const result=spawnSync('cargo',[command,...args,...(command==='build'?['--release']:[])],{cwd:root,env,stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
if(command==='build'){
 await fs.mkdir(path.dirname(output),{recursive:true});
 await fs.copyFile(path.join(target,'release/assetvault-setup.exe'),output);
 console.log(`Custom installer: ${output}`);
}
