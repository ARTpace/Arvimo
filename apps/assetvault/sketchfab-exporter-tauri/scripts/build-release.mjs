import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const env={...process.env};
env.PATH=path.join(os.homedir(),'.cargo','bin')+path.delimiter+env.PATH;
if(!env.TAURI_SIGNING_PRIVATE_KEY){
 const key=path.join(os.homedir(),'.codex','assetvault-signing','updater.key');
 try{await fs.access(key);env.TAURI_SIGNING_PRIVATE_KEY=key;env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD??='';}
 catch{throw Error('Set TAURI_SIGNING_PRIVATE_KEY before building a release; never generate a replacement key for an existing app.');}
}
const run=(script,args=[])=>{
 const result=spawnSync(process.execPath,[script,...args],{cwd:root,env,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
};
run(path.join(root,'node_modules/@tauri-apps/cli/tauri.js'),['build']);
run('scripts/build-custom-installer.mjs');
const {version}=JSON.parse(await fs.readFile(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
// Sign the final wrapper: first installs and in-app updates now download identical bytes.
let keyArgs=[];try{await fs.access(env.TAURI_SIGNING_PRIVATE_KEY);keyArgs=['--private-key-path',env.TAURI_SIGNING_PRIVATE_KEY];delete env.TAURI_SIGNING_PRIVATE_KEY;}catch{}
run(path.join(root,'node_modules/@tauri-apps/cli/tauri.js'),['signer','sign',...keyArgs,'--app-version',version,path.join(root,'dist',`AssetVault_${version}_x64-setup.exe`)]);
run('scripts/prepare-release.mjs');
run('scripts/clean-installers.mjs',['--apply']);
// Only after packaging, signing and preparing the release have all succeeded.
const cleanup=spawnSync(process.execPath,['scripts/clean-build-cache.mjs','--apply'],{cwd:root,env,stdio:'inherit'});
if(cleanup.error||cleanup.status!==0)console.warn('Release completed; build-cache cleanup skipped/failed. Close running builds/apps and run npm run clean:build -- --apply later.');
