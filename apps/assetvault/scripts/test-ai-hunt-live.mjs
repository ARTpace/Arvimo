// Visible-browser acceptance server. Uses a disposable library, never the user's assets.
// Run explicitly: node scripts/test-ai-hunt-live.mjs
// AI requests happen only when the tester clicks the corresponding UI controls.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveUserPaths} from '../server/data-dir.mjs';

const source=path.join(resolveUserPaths().dataDir,'ai-settings.json');
const config=await fs.readFile(source);
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'arvimo-hunt-live-'));
for(const [key,dir] of Object.entries({SFX_DATA_DIR:'data',SFX_ARCHIVE_DIR:'assets',SFX_DOWNLOAD_DIR:'downloads',SFX_ACCOUNTS_DIR:'accounts'})){
 process.env[key]=path.join(temporary,dir);await fs.mkdir(process.env[key],{recursive:true});
}
const secret=path.join(process.env.SFX_DATA_DIR,'ai-settings.json');
await fs.writeFile(secret,config,{mode:0o600});
const {createLibraryServer}=await import('../server/library.mjs');
const server=createLibraryServer({cacheDir:path.join(temporary,'cache'),archiveRoot:process.env.SFX_ARCHIVE_DIR,collect:false,backup:false,auth:null});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,temporary,isolated:true}));
let closing=false;
async function stop(){
 if(closing)return;closing=true;
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await fs.rm(secret,{force:true});
 console.log('Stopped isolated acceptance server; AI credentials removed.');
 process.exit(0);
}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
