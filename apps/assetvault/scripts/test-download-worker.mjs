// Live lifecycle test. Uses only the public CC Attribution Cube by artworkguide.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {fork} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {DownloadManager} from '../server/downloads.mjs';import {createLibraryServer} from '../server/library.mjs';
const base=path.resolve(process.env.SFX_TEST_OUTPUT||await fs.mkdtemp(path.join(os.tmpdir(),'sfx-worker-live-')));
const config={dataDir:path.join(base,'state'),defaultFolder:path.join(base,'downloads')};
const wait=async(fn,timeout=35000)=>{const until=Date.now()+timeout;while(!await fn()){if(Date.now()>until)throw Error('Lifecycle test timeout');await new Promise(r=>setTimeout(r,100));}};
if(process.argv.includes('--child')){
 const m=await new DownloadManager(config).init();const server=createLibraryServer({downloads:m,cacheDir:path.join(base,'http-cache')});await new Promise(r=>server.listen(0,'127.0.0.1',r));m.start(`http://127.0.0.1:${server.address().port}`);
 await m.configure({retryLimit:0});const id=m.enqueue({authorized:true,models:[{uid:'48b8725fd63a4562abc181cf09b1333a',name:'Cube',author:'artworkguide',license:'CC Attribution'}]}).added[0];
 process.on('message',message=>{if(message==='cancel')m.action(id,'cancel');});
 await wait(()=>m.jobs[0].stage==='converting');const j=m.jobs[0];const profile=path.join(m.dataDir,'workers',`${id}-${j.attempts}`);const port=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];process.send({type:'ready',id,profile,port});
 await wait(()=>j.state==='cancelled'&&m.workers.size===0);process.send({type:'cancelled',job:j});await m.close();server.closeAllConnections();server.close();process.disconnect();
}else{
 await fs.mkdir(base,{recursive:true});const checks={};let child;
 const check=(name,value)=>{checks[name]=!!value;console.log(value?'PASS':'FAIL',name);if(!value)throw Error(name);};
 const start=async suffix=>{
  child=fork(fileURLToPath(import.meta.url),['--child'],{execArgv:[],env:{...process.env,SFX_TEST_OUTPUT:path.join(base,suffix)},stdio:['ignore','ignore','inherit','ipc']});
  return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Child startup timed out')),35000);child.once('error',reject);child.once('exit',code=>{if(code)reject(Error('Child failed '+code));});child.on('message',m=>{if(m.type==='ready'){clearTimeout(timer);resolve(m);}});});
 };
 const closed=async port=>{try{await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)});return false;}catch{return true;}};
 try{
  let ready=await start('cancel');const cancelled=new Promise(r=>child.on('message',m=>{if(m.type==='cancelled')r(m.job);}));const exited=new Promise(r=>child.once('exit',r));child.send('cancel');const job=await cancelled;
  check('cancel kills a real isolated conversion, not only a fixture',job.state==='cancelled'&&!job.filePath);await wait(()=>closed(ready.port));check('cancel closes owned browser CDP endpoint',true);await exited;
  check('cancel cleans its isolated browser profile',!await fs.stat(ready.profile).catch(()=>null));
  ready=await start('crash');const killed=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await killed;
  await wait(()=>closed(ready.port));check('hard-killed service disconnect cleans isolated browser',true);
  const m=await new DownloadManager({dataDir:path.join(base,'crash','state'),defaultFolder:path.join(base,'crash','downloads')}).init();try{check('stale lock recovers after actual service process death',true);check('restart cleans known interrupted scratch profile',!await fs.stat(ready.profile).catch(()=>null));check('interrupted conversion survives restart, never marked successful',m.jobs[0].state==='interrupted'&&!m.jobs[0].filePath);}finally{await m.close();}
 }finally{if(child?.exitCode===null)child.kill('SIGKILL');await fs.writeFile(path.join(base,'lifecycle-results.json'),JSON.stringify({checks},null,2));console.log('Artifacts:',base);}
}
