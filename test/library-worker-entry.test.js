// Regression tests for the forked-worker entry guard.
//
// The bug these lock down: `if(process.argv.includes('--worker'))` fires for ANY module that sees
// the flag in argv, so forking the ArtStation worker also activated export-worker's block (pulled in
// through artstation.mjs -> export-worker.mjs for `browserPath`). Two `message` handlers raced for
// the same job, the Sketchfab one won, and every ArtStation download died instantly with
// `The "path" argument must be of type string ... Received undefined`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork,execFile} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isWorkerEntry} from '../server/worker-entry.mjs';

const serverDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','server');
const moduleUrl=name=>pathToFileURL(path.join(serverDir,name)).href;

const runNode=(args,cwd)=>new Promise(resolve=>{
 execFile(process.execPath,args,{cwd,timeout:60000},(error,stdout,stderr)=>resolve({failed:!!error,stdout:String(stdout||''),stderr:String(stderr||'')}));
});

test('importing a worker module never activates its worker block, even with --worker in argv',async()=>{
 const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-worker-entry-'));
 // Stands in for any module that imports both workers - which is exactly what the ArtStation
 // worker does transitively.
 const fixture=path.join(tmp,'imports-both-workers.mjs');
 await fsp.writeFile(fixture,[
  `import ${JSON.stringify(moduleUrl('export-worker.mjs'))};`,
  `import ${JSON.stringify(moduleUrl('artstation-worker.mjs'))};`,
  `console.log('MESSAGE='+process.listenerCount('message'));`,
  `console.log('DISCONNECT='+process.listenerCount('disconnect'));`,
  '',
 ].join('\n'));
 try{
  const result=await runNode([fixture,'--worker'],tmp);
  assert.equal(result.failed,false,result.stderr);
  // Before the fix this printed MESSAGE=2 - one handler per imported worker.
  assert.match(result.stdout,/MESSAGE=0/);
  assert.match(result.stdout,/DISCONNECT=0/);
 }finally{await fsp.rm(tmp,{recursive:true,force:true});}
});

test('isWorkerEntry is true only for the module that was actually launched',async()=>{
 // The test runner owns argv[1], so neither worker may claim to be the entry point.
 assert.equal(isWorkerEntry(moduleUrl('export-worker.mjs')),false);
 assert.equal(isWorkerEntry(moduleUrl('artstation-worker.mjs')),false);
 assert.equal(isWorkerEntry(import.meta.url),true);

 const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-worker-self-'));
 const fixture=path.join(tmp,'self-check.mjs');
 await fsp.writeFile(fixture,[
  `import {isWorkerEntry} from ${JSON.stringify(moduleUrl('worker-entry.mjs'))};`,
  `console.log('SELF='+isWorkerEntry(import.meta.url));`,
  `console.log('OTHER='+isWorkerEntry(${JSON.stringify(moduleUrl('export-worker.mjs'))}));`,
  '',
 ].join('\n'));
 try{
  const result=await runNode([fixture],tmp);
  assert.equal(result.failed,false,result.stderr);
  assert.match(result.stdout,/SELF=true/);
  assert.match(result.stdout,/OTHER=false/);
 }finally{await fsp.rm(tmp,{recursive:true,force:true});}
});

test('a worker launched as the entry point still answers the start message',async()=>{
 // Positive control: the guard must not be so strict that the real worker stops responding.
 // `job` is empty on purpose - browserExport fails on its first path, long before any browser
 // is spawned, so this stays offline while still proving the worker block is live.
 const child=fork(path.join(serverDir,'export-worker.mjs'),['--worker'],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,execArgv:[]});
 try{
  const reply=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('worker did not answer the start message')),30000);
   child.once('message',m=>{clearTimeout(timer);resolve(m);});
   child.once('error',e=>{clearTimeout(timer);reject(e);});
   child.send({type:'start',job:{}});
  });
  assert.equal(reply.type,'error');
  assert.equal(typeof reply.message,'string');
  // The stack must cross the IPC boundary, otherwise the parent can only show a bare message.
  assert.match(String(reply.stack||''),/export-worker\.mjs/);
 }finally{
  if(child.connected)child.disconnect();
  child.kill('SIGKILL');
  await new Promise(r=>setTimeout(r,200));
 }
});
