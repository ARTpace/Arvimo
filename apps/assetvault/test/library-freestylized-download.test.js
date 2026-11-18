import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {downloadFreestylizedFile,runFreestylizedJob} from '../server/freestylized.mjs';
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arvimo-download-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,dest:path.join(dir,'pack.zip')};}
const response=(body,headers={},status=200)=>({status,headers,stream:Readable.from([Buffer.from(body)])});
test('download reports real bytes and completes job metadata',async t=>{
 const {dir}=await fixture(t);const updates=[];
 const open=async url=>url.includes('freestylized.com')?response('<a href="https://pub-abc.r2.dev/Textures/2k/wood.zip">file</a>'):response('PK12345',{'content-length':'7','content-type':'application/zip'});
 await runFreestylizedJob({uid:'a'.repeat(32),output:dir,assetId:'wood_11',assetType:'textures',options:{resolution:'2K'}},{open,progress:p=>updates.push(p)});
 assert.equal(updates.at(-1).bytesWritten,7);assert.equal(updates.at(-1).totalBytes,7);
 assert.equal(JSON.parse(await fs.readFile(path.join(dir,'info.json'),'utf8')).files[0].bytes,7);
});
test('interrupted stream resumes at written byte offset',async t=>{
 const {dest}=await fixture(t);let calls=0;
 const open=async(url,options)=>{
  calls++;
  if(calls===1)return {status:200,headers:{'content-length':'6'},stream:Readable.from((async function*(){yield Buffer.from('abc');throw Error('connection reset');})())};
  assert.equal(options.headers.Range,'bytes=3-');
  return response('def',{'content-range':'bytes 3-5/6','content-length':'3'},206);
 };
 await downloadFreestylizedFile('https://example.com/a',dest,{open});
 assert.equal(await fs.readFile(dest,'utf8'),'abcdef');assert.equal(calls,2);
});
test('server ignores Range: restart without duplicating bytes',async t=>{
 const {dest}=await fixture(t);let calls=0;
 await downloadFreestylizedFile('https://example.com/a',dest,{open:async()=>++calls===1?response('abc',{'content-length':'6'}):response('abcdef',{'content-length':'6'})});
 assert.equal(await fs.readFile(dest,'utf8'),'abcdef');assert.equal(calls,2);
});
test('incomplete files fail after bounded retries; HTML fails immediately',async t=>{
 const {dest}=await fixture(t);let calls=0;
 await assert.rejects(downloadFreestylizedFile('https://example.com/a',dest,{open:async()=>{calls++;return response('ab',{'content-length':'6'});}}),/不完整/);
 assert.equal(calls,3);
 calls=0;
 await assert.rejects(downloadFreestylizedFile('https://example.com/a',dest,{open:async()=>{calls++;return response('login',{'content-type':'text/html'});}}),/网页/);
 assert.equal(calls,1);
});
test('cancellation stops retry and closes the stream',async t=>{
 const {dest}=await fixture(t);const controller=new AbortController();let calls=0;
 await assert.rejects(downloadFreestylizedFile('https://example.com/a',dest,{signal:controller.signal,open:async()=>{calls++;controller.abort(Error('cancelled'));return response('abc');}}),/cancelled/);
 assert.equal(calls,1);
});
