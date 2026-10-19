// Forked ArtStation worker.
//
// One child process per job, mirroring export-worker.mjs: a crashing or cancelled conversion can
// never take the local service down, and killing the child takes the mviewer process tree with it.
import {execFile,fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runArtstationJob} from './artstation.mjs';
import {runArtstationImageJob} from './artstation-image.mjs';
import {isWorkerEntry} from './worker-entry.mjs';

/**
 * Which pipeline a job needs. Artworks without an embedded Marmoset scene have no `.mview` to
 * convert, so they get the image pipeline instead; the marker rides on the job itself
 * (see modelSnapshot in downloads.mjs) so a queue restored after a restart never has to re-ask the
 * network what an artwork contains before it can pick up where it left off.
 */
export function artstationRunnerFor(job){
 return job&&job.hasMarmoset===false?runArtstationImageJob:runArtstationJob;
}

export function runArtstationWorker(job,{signal,progress}){
 return new Promise((resolve,reject)=>{
  const child=fork(fileURLToPath(import.meta.url),['--worker'],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,execArgv:[],detached:process.platform!=='win32'});
  let settled=false,stderr='',killTimer;
  child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-1500);});
  const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(killTimer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>{if(child.connected)child.send({type:'cancel'});killTimer=setTimeout(()=>{if(process.platform==='win32')execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}done(signal.reason||Error('任务已取消'));},10000);};
  child.on('message',m=>{if(m.type==='progress')progress(m.value);else if(m.type==='done')done(null,m.value);else if(m.type==='error'){const err=Error(m.message);if(m.stack)err.stack=m.stack;done(err);}});
  child.on('error',e=>done(e));child.on('exit',code=>done(Error('ArtStation 转换进程结束：'+code+' '+stderr.slice(-500))));
  signal?.addEventListener('abort',abort,{once:true});child.send({type:'start',job});if(signal?.aborted)abort();
 });
}
if(isWorkerEntry(import.meta.url)){
 const controller=new AbortController();let started=false;
 process.on('disconnect',()=>controller.abort(Error('本地服务已关闭')));
 process.on('message',async m=>{if(m.type==='cancel'){controller.abort(Error('任务已取消'));return;}if(m.type!=='start'||started)return;started=true;
  try{const value=await artstationRunnerFor(m.job)(m.job,{signal:controller.signal,progress:value=>{if(process.connected)process.send({type:'progress',value});}});if(process.connected)process.send({type:'done',value});}
  catch(e){if(process.connected)process.send({type:'error',message:e.message,stack:e.stack});}
  finally{if(process.connected)process.disconnect();}
 });
}
