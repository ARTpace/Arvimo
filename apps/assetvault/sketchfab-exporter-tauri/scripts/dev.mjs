// Source-backed desktop development: rebuild web assets, never an installer.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {sourceStamp,needsBuild} from './dev-cache.mjs';
const startedAt=Date.now();
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const library=path.resolve(desktop,'..');
const canvas=path.resolve(library,'../artflow');
const env={...process.env,PATH:path.join(os.homedir(),'.cargo/bin')+path.delimiter+process.env.PATH};
const bootState=path.join(os.tmpdir(),`arvimo-dev-start-${process.pid}.json`);
const restartFile=path.join(os.tmpdir(),`arvimo-dev-restart-${process.pid}`);
env.ARVIMO_DEV_RESTART_FILE=restartFile;
const bootStatus=(message,done=false)=>fs.writeFileSync(bootState,JSON.stringify({message,done}));
bootStatus('正在准备开发环境…');
let bootWindow;
if(process.platform==='win32'){
 bootWindow=spawn(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(desktop,'scripts/dev-splash.ps1'),'-StateFile',bootState,'-ImagePath',path.join(library,'src/library/mascot.png')],{windowsHide:true,stdio:'ignore'});
 bootWindow.on('error',error=>console.error('Startup window:',error.message));
}
const clients=new Set();
const server=http.createServer((request,response)=>{
 if(request.url!=='/events'){response.writeHead(404);response.end();return;}
 response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Access-Control-Allow-Origin':'*'});
 console.log(`[dev] loading window connected after ${Date.now()-startedAt}ms`);
 bootStatus('',true);
 response.write(': connected\n\n');clients.add(response);
 request.on('close',()=>clients.delete(response));
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
env.ARVIMO_DEV_RELOAD_PORT=String(server.address().port);
const reload=()=>{for(const client of clients)client.write('data: reload\n\n');};
const run=(script,args,cwd)=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[script,...args],{cwd,env,stdio:'inherit',windowsHide:true});
 child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Build failed (${code}): ${script}`)));
});
const stateFile=path.resolve(library,'../../_local/desktop-dev/build-cache.json');
let cache={};try{cache=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{}
const saveCache=()=>{fs.mkdirSync(path.dirname(stateFile),{recursive:true});fs.writeFileSync(stateFile,JSON.stringify(cache));};
const canvasStamp=()=>sourceStamp([canvas]);
const libraryStamp=()=>sourceStamp([path.join(library,'src'),path.join(library,'scripts'),path.join(library,'package.json'),path.join(library,'package-lock.json')]);
const canvasOutputs=[path.join(canvas,'dist/index.html')];
const libraryOutputs=[path.join(library,'dist/library/index.html'),path.join(library,'dist/library/app.js'),path.join(library,'dist/library/artflow/index.html')];
let rebuilding=false,pending=false,canvasDirty=false,timer;
async function rebuild(){
 if(rebuilding){pending=true;return;}
 rebuilding=true;
 try{
  do{
   pending=false;
   const canvasBefore=canvasStamp();
   if(canvasDirty||needsBuild(canvasBefore,cache.canvas,canvasOutputs)){bootStatus('正在准备画布资源…');canvasDirty=false;await run(path.join(canvas,'node_modules/vite/bin/vite.js'),['build'],canvas);}
   cache.canvas=canvasBefore.key;
   const libraryBefore=libraryStamp();
   if(needsBuild(libraryBefore,cache.library,libraryOutputs)||cache.copiedCanvas!==cache.canvas){
    bootStatus('正在准备资产库界面…');
    await run(path.join(library,'scripts/build-library.mjs'),[],library);
   }
   cache.library=libraryBefore.key;cache.copiedCanvas=cache.canvas;saveCache();
  }while(pending);
  reload();
 }finally{rebuilding=false;}
}
const watchers=[];
function watch(dir,isCanvas=false){
 watchers.push(fs.watch(dir,{recursive:true},(_event,file)=>{
  const rel=String(file||'').replaceAll('\\','/');
  if(/(^|\/)(node_modules|dist|\.git|target|\.cache)(\/|$)/.test(rel)||! /\.(?:[cm]?[jt]sx?|html|css|json|svg|png)$/.test(rel))return;
  if(isCanvas)canvasDirty=true;
  clearTimeout(timer);timer=setTimeout(()=>rebuild().catch(console.error),350);
 }));
}
try{
 await rebuild();
 watch(path.join(library,'src/library'));watch(canvas,true);
 watchers.push(fs.watch(path.join(desktop,'src-tauri/src/desktop-chrome.js'),reload));
 bootStatus('正在打开开发版…');
 // The debug executable embeds the CLI's dev-server URL (including waiting.html).
 // Always keep that server alive; Cargo already reuses unchanged native builds.
 console.log('[dev] starting Tauri development server (incremental native build)');
 do{
 fs.rmSync(restartFile,{force:true});
 const app=spawn(process.execPath,[path.join(desktop,'node_modules/@tauri-apps/cli/tauri.js'),'dev','--no-watch','--config','src-tauri/tauri.dev.conf.json'],{cwd:desktop,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 app.stdout.on('data',chunk=>{process.stdout.write(chunk);if(chunk.toString().includes('ASSETVAULT_READY_PORT=')){console.log(`[dev] backend ready after ${Date.now()-startedAt}ms`);}});
 app.stderr.pipe(process.stderr);
 await new Promise((resolve,reject)=>{app.once('error',reject);app.once('exit',code=>code===0?resolve():reject(Error(`Desktop exited (${code})`)));});
 }while(fs.existsSync(restartFile));
}finally{
 fs.rmSync(restartFile,{force:true});
 bootStatus('',true);
 bootWindow?.once('exit',()=>{try{fs.unlinkSync(bootState);}catch{}});
 clearTimeout(timer);for(const watcher of watchers)watcher.close();
 for(const client of clients)client.end();server.close();
}
