import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {runMediaJob} from '../server/media-job.mjs';
import {verifyFolder} from '../server/folder-archive.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {createLibraryServer} from '../server/library.mjs';
import {recoverDownloads} from '../server/download-recovery.mjs';

const uid='a'.repeat(32),video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(24)]);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
const plan={title:'媒体 fixture',author:'author',source:'https://www.douyin.com/video/7706103790805707697',music:{title:'song'},items:[{url:'https://a.douyinpic.com/a.png',type:'image',pairId:'live:1'},{url:'https://v.douyinvod.com/error',alternates:['https://v.douyinvod.com/live.mp4'],type:'video',pairId:'live:1'}]};
const wait=async fn=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('test timeout');await new Promise(r=>setTimeout(r,10));}};
const open=async url=>{const data=url.endsWith('png')?png:url.endsWith('error')?Buffer.from('<html>login</html>'):video;return {status:200,headers:{'content-length':String(data.length)},stream:Readable.from([data])};};
test('a real queue/HTTP media job saves and verifies video + photo pairs, falls back from a 200 HTML error',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-media-'));let manager,server;
 try{
  const requests=[];manager=await new DownloadManager({dataDir:path.join(dir,'state'),defaultFolder:path.join(dir,'downloads'),browser:()=>null,blender:()=>null,mediaRunner:(job,options)=>runMediaJob(job,{...options,collect:async()=>plan,open:async(url,options)=>{requests.push({url,options});return open(url);}})}).init();
  server=createLibraryServer({downloads:manager,collect:false});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;manager.start(base);
  const r=await fetch(base+'/api/downloads/tasks',{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify({kind:'media',authorized:true,models:[{uid,platform:'douyin',name:'fixture',url:plan.source}]})});
  assert.equal(r.status,200);await wait(()=>['saved','failed'].includes(manager.jobs[0]?.state));
  const job=manager.jobs[0];assert.equal(job.state,'saved',job.message);assert.equal(job.options.output,'folder');
  const info=JSON.parse(await fs.readFile(path.join(job.filePath,'info.json'),'utf8'));
  assert.equal(info.kind,'media');assert.equal(info.files.length,2);assert.equal(path.parse(info.files[0].file).name,path.parse(info.files[1].file).name);assert.equal(info.music.title,'song');
  assert.match(requests[0].options.headers.Referer,/douyin/);assert.equal(requests.length,3);
  assert.ok((await verifyFolder(job.filePath,{uid})).sha256);
  const recovered=[];await recoverDownloads(recovered,[manager.defaultFolder]);assert.equal(recovered[0]?.kind,'media');
  await fs.writeFile(path.join(job.filePath,info.files[1].file),'broken');await assert.rejects(verifyFolder(job.filePath,{uid}),/不完整/);
 }finally{await manager?.close();server?.closeAllConnections();await new Promise(resolve=>server?server.close(resolve):resolve());await fs.rm(dir,{recursive:true,force:true});}
});
test('a 200 login/error page cannot masquerade as a video',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-media-invalid-'));
 try{await assert.rejects(runMediaJob({uid,platform:'douyin',output:dir},{collect:async()=>({...plan,items:[{url:'https://v.douyinvod.com/error',type:'video'}]}),open}),/不是有效的/);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('a cover-only preview cannot masquerade as a complete post',async()=>{
 await assert.rejects(runMediaJob({platform:'xiaohongshu'},{collect:async()=>({...plan,partial:true})}),/未取得完整媒体/);
});
