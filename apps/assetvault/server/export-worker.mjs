import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile,fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isWorkerEntry} from './worker-entry.mjs';
export function browserPath(){return [process.env.SFX_BROWSER,process.env.SELF_TEST_BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe',process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe'),'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
/** Folder output writes page-supplied entry names to disk, so refuse anything that could escape it. */
function safeRelativePath(name){
 const parts=String(name||'').split('/');
 if(!parts.length||parts.some(p=>!p||p==='.'||p==='..')||/[:\\\x00]/.test(name)||name.startsWith('/'))throw Error('后台返回了不安全的条目名：'+name);
 return parts;
}
export async function browserExport({uid,options,baseUrl,profile,output,networkToken},{signal,progress=()=>{}}={}){
 const executable=browserPath();if(!executable)throw Error('未找到 Chrome/Edge；安装浏览器或设置 SFX_BROWSER 后重试');
 await fsp.mkdir(profile,{recursive:true});await fsp.mkdir(path.dirname(output),{recursive:true});
 const browser=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-sync','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--use-angle=swiftshader','--enable-unsafe-swiftshader','about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
 let stderr='',ws,send,file,spawnError;const pending=new Map();let sequence=0;
 browser.on('error',e=>{spawnError=e;failPending(e);});
 browser.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-2000);});
 const failPending=e=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();};
 const abort=()=>failPending(signal.reason||new Error('任务已取消'));signal?.addEventListener('abort',abort,{once:true});
 try{
  progress({stage:'starting',message:'正在启动独立后台转换器'});let port;const end=Date.now()+25000;
  while(!port){signal?.throwIfAborted();if(spawnError)throw spawnError;if(browser.exitCode!==null)throw Error('后台浏览器启动失败：'+stderr.slice(-600));if(Date.now()>end)throw Error('后台浏览器启动超时');try{port=(await fsp.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];if(!/^\d+$/.test(port))port=null;}catch{}if(!port)await pause(100);}
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal})).json();const page=pages.find(p=>p.type==='page');if(!page)throw Error('后台浏览器未创建转换页面');
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{const finish=e=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);e?reject(e):resolve();};const stop=()=>finish(signal.reason||Error('任务已取消'));const timer=setTimeout(()=>finish(Error('后台连接超时')),10000);ws.onopen=()=>finish();ws.onerror=()=>finish(Error('后台连接失败'));signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();});signal?.throwIfAborted();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Runtime.bindingCalled'&&m.params.name==='__sfxLog')progress({stage:'converting',message:String(m.params.payload).slice(0,1200)});};
  ws.onclose=()=>failPending(Error('后台浏览器意外关闭'));ws.onerror=()=>failPending(Error('后台浏览器连接错误'));
  send=(method,params={},timeout=30000)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('后台转换器响应超时'));},timeout);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression,timeout)=>{signal?.throwIfAborted();const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},timeout);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text||'后台转换异常');return r.result?.value;};
  if(networkToken){await send('Network.enable');await send('Network.setExtraHTTPHeaders',{headers:{'X-SFX-Transfer':networkToken}});}
  await send('Page.enable');await send('Runtime.enable');await send('Runtime.addBinding',{name:'__sfxLog'});
  let loadTimer,stopLoad;const loaded=new Promise((resolve,reject)=>{loadTimer=setTimeout(()=>reject(Error('后台页面加载超时')),25000);stopLoad=()=>reject(signal.reason||Error('任务已取消'));signal?.addEventListener('abort',stopLoad,{once:true});ws.addEventListener('message',e=>{if(JSON.parse(e.data).method==='Page.loadEventFired')resolve();},{once:false});});
  try{await Promise.all([send('Page.navigate',{url:baseUrl+'/worker.html'}),loaded]);}finally{clearTimeout(loadTimer);signal?.removeEventListener('abort',stopLoad);}
  // The page keeps the result in its own memory; the worker pulls it back in chunks. Both
  // delivery modes go through one `__chunk(index, …)` reader, so this side never needs to
  // know whether it is copying a single ZIP or a folder of loose files.
  const meta=await evaluate(`(async()=>{const engine=await import('/engine.js');const r=window.__result=await engine.exportModel(${JSON.stringify('https://sketchfab.com/models/'+uid)},${JSON.stringify({...options,devMode:false})},message=>window.__sfxLog(String(message)),new AbortController().signal);const parts=r.files&&r.files.length?r.files.map(f=>({name:String(f.name),size:f.data?f.data.length:0})):null;window.__chunk=(index,offset,length)=>{const data=parts?window.__result.files[index].data:window.__result.zip;const slice=data.subarray(offset,offset+length);let s='';for(let i=0;i<slice.length;i+=8192)s+=String.fromCharCode(...slice.subarray(i,i+8192));return btoa(s);};return {bytes:r.bytes||(r.zip?r.zip.byteLength:0),zipName:r.zipName,fileCount:r.fileCount,hasGlb:r.hasGlb,folder:!r.zip,parts};})()`,30*60*1000);
  if(!meta?.hasGlb||!Number.isSafeInteger(meta.bytes)||meta.bytes<=0||meta.bytes>2*1024**3)throw Error('模型转换没有生成有效 GLB，或超过 2GB 限制');
  const begin=Date.now();let written=0;
  const report=message=>progress({stage:'transferring',message,bytesWritten:written,totalBytes:meta.bytes,transferRate:Math.round(written/Math.max(.001,(Date.now()-begin)/1000))});
  const pull=async(index,offset,length)=>{const encoded=await evaluate(`window.__chunk(${index},${offset},${length})`);const chunk=Buffer.from(encoded,'base64');if(chunk.length!==length)throw Error('后台文件传输不完整');return chunk;};
  const sink=async(handle,index,size,label)=>{for(let offset=0;offset<size;offset+=384*1024){const length=Math.min(384*1024,size-offset);const chunk=await pull(index,offset,length);let at=0;while(at<chunk.length){const r=await handle.write(chunk,at,chunk.length-at);at+=r.bytesWritten;}written+=chunk.length;report(label);}await handle.sync();};
  if(meta.folder){
   await fsp.mkdir(output,{recursive:true});
   for(let i=0;i<meta.parts.length;i++){
    const part=meta.parts[i];const relative=safeRelativePath(part.name);const destination=path.join(output,...relative);
    await fsp.mkdir(path.dirname(destination),{recursive:true});
    const handle=await fsp.open(destination,'wx');
    try{await sink(handle,i,part.size,`正在写入 ${relative.join('/')}（${i+1}/${meta.parts.length}）`);}finally{await handle.close();}
   }
  }else{
   file=await fsp.open(output,'wx');
   await sink(file,0,meta.bytes,'模型已打包，正在写入本机暂存文件');await file.close();file=null;
  }
  signal?.throwIfAborted();return meta;
 }finally{
  signal?.removeEventListener('abort',abort);await file?.close().catch(()=>{});
  if(send&&ws?.readyState===1)await Promise.race([send('Browser.close',{},2000).catch(()=>{}),pause(2100)]);ws?.close();failPending(Error('转换器已结束'));
  if(browser.pid&&browser.exitCode===null){if(process.platform==='win32')await new Promise(r=>execFile('taskkill.exe',['/PID',String(browser.pid),'/T','/F'],{windowsHide:true},()=>r()));else browser.kill('SIGKILL');}
  await fsp.rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150}).catch(()=>{});
 }
}
/** Parent process owns queue state; child IPC disconnect kills its own isolated browser. */
export function runExportWorker(job,{signal,progress}){
 return new Promise((resolve,reject)=>{
  const child=fork(fileURLToPath(import.meta.url),['--worker'],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,execArgv:[],detached:process.platform!=='win32'});let settled=false,stderr='',killTimer;
  child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-1500);});
  const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(killTimer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>{if(child.connected)child.send({type:'cancel'});killTimer=setTimeout(()=>{if(process.platform==='win32')execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}done(signal.reason||Error('任务已取消'));},10000);};
  child.on('message',m=>{if(m.type==='progress')progress(m.value);else if(m.type==='done')done(null,m.value);else if(m.type==='error'){const err=Error(m.message);if(m.stack)err.stack=m.stack;done(err);}});
  child.on('error',e=>done(e));child.on('exit',code=>done(Error('后台转换进程结束：'+code+' '+stderr.slice(-500))));
  signal?.addEventListener('abort',abort,{once:true});child.send({type:'start',job});if(signal?.aborted)abort();
 });
}
if(isWorkerEntry(import.meta.url)){
 const controller=new AbortController();let started=false;
 process.on('disconnect',()=>controller.abort(Error('本地服务已关闭')));
 process.on('message',async m=>{if(m.type==='cancel'){controller.abort(Error('任务已取消'));return;}if(m.type!=='start'||started)return;started=true;
  try{const value=await browserExport(m.job,{signal:controller.signal,progress:value=>{if(process.connected)process.send({type:'progress',value});}});if(process.connected)process.send({type:'done',value});}
  // The stack is forwarded too: without it the parent could only show the bare fs/wasm message,
  // which turns a one-line bug into an afternoon of guessing.
  catch(e){if(process.connected)process.send({type:'error',message:e.message,stack:e.stack});}
  finally{if(process.connected)process.disconnect();}
 });
}
