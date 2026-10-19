import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DownloadManager,ARTSTATION_BATCH} from '../server/downloads.mjs';
import {buildArtstationZip} from '../server/artstation.mjs';
import {zipEntries} from '../server/zip-writer.mjs';
import {artstationUid} from '../server/artstation-project.mjs';
import {verifyArchive} from '../server/archive.mjs';

const ARTWORK='https://www.artstation.com/artwork/lEVE8J';
const UID=artstationUid('lEVE8J');
const ZIP_OPTIONS={output:'zip',format:'glb'};

function minimalGlb(){
  const json=JSON.stringify({asset:{version:'2.0'},meshes:[{name:'scene',primitives:[{attributes:{POSITION:0}}]}],accessors:[{count:3}],buffers:[{byteLength:0}]});
  const jsonBuf=Buffer.from(json,'utf8');
  const pad=(4-(jsonBuf.length%4))%4;
  const total=12+8+jsonBuf.length+pad;
  const out=Buffer.alloc(total,0x20);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(total,8);
  out.writeUInt32LE(jsonBuf.length+pad,12);out.writeUInt32LE(0x4e4f534a,16);
  jsonBuf.copy(out,20);
  return out;
}
/** Stands in for runArtstationJob's contract: ZIP with scene.glb + info.json written to `output`. */
function artArchive({uid=UID,glb=true}={}){
  return zipEntries([
    {name:'scene.glb',data:glb?minimalGlb():Buffer.from('not a glb','utf8')},
    {name:'info.json',data:Buffer.from(JSON.stringify({uid,platform:'artstation',author:'test',source:'https://cdnb.artstation.com/x.mview'}),'utf8')},
  ]);
}
const model=(extra={})=>({uid:UID,name:'Deployable Ballistic Shield',author:'datawind',thumbnail:null,license:'ArtStation 作品 · 需确认授权',artworkUrl:ARTWORK,artId:'lEVE8J',...extra});
const waitState=async(m,id,states,ms=8000)=>{
  const end=Date.now()+ms;
  while(Date.now()<end){const j=m.snapshot().jobs.find(x=>x.id===id);if(j&&states.includes(j.state))return j;await new Promise(r=>setTimeout(r,25));}
  throw Error('任务未在预期时间内到达状态：'+states.join('/'));
};
async function manager({artRunner,runner,dataDir}={}){
  const root=dataDir||await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-art-jobs-'));
  const m=await new DownloadManager({
    dataDir:root,
    defaultFolder:path.join(root,'downloads'),
    artRunner:artRunner||(async(job,{progress}={})=>{progress?.({stage:'converting',message:'正在用 mviewer 转换 glTF/GLB…'});progress?.({stage:'transferring',message:'正在写入本机暂存文件',bytesWritten:64,totalBytes:64,transferRate:64});await fsp.writeFile(job.output,artArchive());return {zipName:'art-lEVE8J.zip'};}),
    runner:runner||(async()=>{throw Error('Sketchfab 执行器不该被 ArtStation 任务调用');}),
    browser:()=>undefined,
    autoStart:false,
  }).init();
  m.start('http://127.0.0.1:1');
  return {m,root};
}

test('artstation: ArtStation hits become ordinary download tasks in the shared queue',async()=>{
  const {m,root}=await manager();
  try{
    const created=await m.enqueue({kind:'artstation',models:[model()],options:ZIP_OPTIONS,authorized:true},{folder:m.settings.folder});
    assert.equal(created.added.length,1);
    const queued=m.snapshot().jobs[0];
    assert.equal(queued.kind,'artstation');
    assert.equal(queued.url,ARTWORK);
    assert.equal(queued.uid,UID);
    const saved=await waitState(m,created.added[0],['saved','failed']);
    assert.equal(saved.state,'saved',saved.message);
    assert.ok(saved.filePath.endsWith('.zip'));
    assert.ok(await fsp.stat(saved.filePath).then(s=>s.isFile()));
    assert.match(saved.verification.sha256,/^[a-f0-9]{64}$/);
  }finally{await m.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('artstation: the shared verifier still checks provenance, so a mismatched uid fails',async()=>{
  const {m,root}=await manager({artRunner:async(job,{progress}={})=>{progress?.({stage:'converting',message:'x'});await fsp.writeFile(job.output,artArchive({uid:'0'.repeat(32)}));return {zipName:'bad.zip'};}});
  try{
    const created=await m.enqueue({kind:'artstation',models:[model()],options:ZIP_OPTIONS,authorized:true});
    const job=await waitState(m,created.added[0],['saved','failed']);
    assert.equal(job.state,'failed');
    assert.match(job.message,/来源信息不匹配/);
  }finally{await m.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('artstation: a ZIP without a usable GLB is never marked saved',async()=>{
  const {m,root}=await manager({artRunner:async(job,{progress}={})=>{progress?.({stage:'converting',message:'x'});await fsp.writeFile(job.output,artArchive({glb:false}));return {zipName:'nogb.zip'};}});
  try{
    const created=await m.enqueue({kind:'artstation',models:[model()],options:ZIP_OPTIONS,authorized:true});
    const job=await waitState(m,created.added[0],['saved','failed']);
    assert.equal(job.state,'failed');
  }finally{await m.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('artstation: folder delivery commits a directory and tells the runner to emit loose files',async()=>{
  const told=[];
  const {m,root}=await manager({artRunner:async(job,{progress}={})=>{
    progress?.({stage:'converting',message:'正在写出导出文件夹…'});
    told.push(job.deliver);
    if(job.deliver==='folder'){
      // The manager hands `output` as a directory in this mode; writing loose files is the contract.
      await fsp.mkdir(path.join(job.output,'textures'),{recursive:true});
      await fsp.writeFile(path.join(job.output,'scene.glb'),minimalGlb());
      await fsp.writeFile(path.join(job.output,'textures','albedo.png'),Buffer.from('PNG FIXTURE'));
      await fsp.writeFile(path.join(job.output,'info.json'),Buffer.from(JSON.stringify({uid:UID,platform:'artstation',author:'test',source:'https://cdnb.artstation.com/x.mview'})));
      return {zipName:'art-lEVE8J.zip',folder:true};
    }
    await fsp.writeFile(job.output,artArchive());
    return {zipName:'art-lEVE8J.zip'};
  }});
  try{
    const created=await m.enqueue({kind:'artstation',models:[model()],options:{output:'folder',format:'glb'},authorized:true},{folder:m.settings.folder});
    const job=await waitState(m,created.added[0],['saved','failed']);
    assert.equal(job.state,'saved',job.message);
    assert.equal(job.options.output,'folder');
    assert.deepEqual(told,['folder']);
    assert.equal((await fsp.stat(job.filePath)).isDirectory(),true);
    assert.equal(job.verification.folder,true);
    assert.equal(await fsp.stat(path.join(job.filePath,'textures','albedo.png')).then(s=>s.isFile()),true);
    // "所在文件夹" keeps working for a folder export: file() resolves the directory for reveal.
    assert.equal(m.file(job.id).path,job.filePath);
  }finally{await m.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('artstation: retry, hold, cancel and reveal are the same affordances as Sketchfab',async()=>{
  let attempts=0;
  const {m,root}=await manager({artRunner:async(job,{progress}={})=>{
    attempts++;
    if(attempts===1)throw Error('mviewer 转换失败：fixture');
    progress?.({stage:'converting',message:'第二次尝试'});
    await fsp.writeFile(job.output,artArchive());
    return {zipName:'retry.zip'};
  }});
  try{
    const created=await m.enqueue({kind:'artstation',models:[model()],options:ZIP_OPTIONS,authorized:true});
    const failed=await waitState(m,created.added[0],['failed']);
    assert.equal(failed.state,'failed');
    m.action(failed.id,'retry');
    const requeued=m.snapshot().jobs.find(j=>j.id===failed.id);
    assert.ok(['queued','running','transferring'].includes(requeued.state),requeued.state);
    const saved=await waitState(m,created.added[0],['saved','failed']);
    assert.equal(saved.state,'saved');
    assert.equal(saved.attempts,2);
    assert.equal(m.file(saved.id).path,saved.filePath);
    // Cancelling a finished job is refused, and removing the record never deletes the file.
    assert.throws(()=>m.action(saved.id,'cancel'),/已结束/);
    m.action(saved.id,'remove');
    assert.equal(m.snapshot().jobs.length,0);
    assert.ok(await fsp.stat(saved.filePath).then(s=>s.isFile()));

    // Pause first so the second hit stays queued: hold/resume only apply before a job starts.
    await m.configure({paused:true});
    const held=await m.enqueue({kind:'artstation',models:[model({uid:artstationUid('AAAA11'),artworkUrl:'https://www.artstation.com/artwork/AAAA11'})],options:ZIP_OPTIONS,authorized:true});
    m.action(held.added[0],'hold');
    assert.equal(m.snapshot().jobs.find(j=>j.id===held.added[0]).state,'held');
    m.action(held.added[0],'cancel');
    assert.equal(m.snapshot().jobs.find(j=>j.id===held.added[0]).state,'cancelled');
  }finally{await m.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('artstation: batch size, artwork url and kind are validated before anything is queued',async()=>{
  const {m,root}=await manager();
  try{
    const many=Array.from({length:ARTSTATION_BATCH+1},(_,i)=>model({uid:artstationUid('A'+String(i).padStart(5,'0')),artworkUrl:`https://www.artstation.com/artwork/A${String(i).padStart(5,'0')}`}));
    await assert.rejects(()=>m.enqueue({kind:'artstation',models:many,options:ZIP_OPTIONS,authorized:true}),/每批最多添加 20/);
    await assert.rejects(()=>m.enqueue({kind:'artstation',models:[model({artworkUrl:'https://evil.example/artwork/x'})],options:ZIP_OPTIONS,authorized:true}),/地址无效/);
    await assert.rejects(()=>m.enqueue({kind:'artstation',models:[model({uid:'nope'})],options:ZIP_OPTIONS,authorized:true}),/模型 ID 无效/);
    await assert.rejects(()=>m.enqueue({kind:'twinmotion',models:[model()],options:ZIP_OPTIONS,authorized:true}),/不支持的任务类型/);
    await assert.rejects(()=>m.enqueue({kind:'artstation',models:[model()],options:ZIP_OPTIONS}),/授权/);
    // Control: a valid batch of exactly the cap is accepted.
    const exact=Array.from({length:ARTSTATION_BATCH},(_,i)=>model({uid:artstationUid('B'+String(i).padStart(5,'0')),artworkUrl:`https://www.artstation.com/artwork/B${String(i).padStart(5,'0')}`}));
    assert.equal((await m.enqueue({kind:'artstation',models:exact,options:ZIP_OPTIONS,authorized:true})).added.length,ARTSTATION_BATCH);
  }finally{await m.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('artstation: the queue pause and persistence treat both platforms identically',async()=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-art-persist-'));
  let runs=0;
  const runner=async(job)=>{runs++;await fsp.writeFile(job.output,artArchive());return {zipName:'p.zip'};};
  try{
    const first=await new DownloadManager({dataDir:root,defaultFolder:path.join(root,'downloads'),artRunner:runner,runner,verify:verifyArchive,browser:()=>undefined,autoStart:false}).init();
    await first.configure({paused:true});
    first.start('http://127.0.0.1:1');
    const created=await first.enqueue({kind:'artstation',models:[model()],options:ZIP_OPTIONS,authorized:true});
    await new Promise(r=>setTimeout(r,120));
    assert.equal(runs,0,'暂停队列时必须连 ArtStation 任务也不启动');
    assert.equal(first.snapshot().jobs[0].state,'queued');
    await first.close();

    // A restart must not lose the ArtStation task, its artwork URL or its kind.
    const second=await new DownloadManager({dataDir:root,defaultFolder:path.join(root,'downloads'),artRunner:runner,runner,verify:verifyArchive,browser:()=>undefined,autoStart:false}).init();
    const restored=second.snapshot().jobs.find(j=>j.id===created.added[0]);
    assert.equal(restored.kind,'artstation');
    assert.equal(restored.url,ARTWORK);
    second.start('http://127.0.0.1:1');
    await second.configure({paused:false});
    const saved=await waitState(second,created.added[0],['saved','failed']);
    assert.equal(saved.state,'saved');
    await second.close();
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('artstation: kind defaults to sketchfab so existing clients keep working',async()=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-kind-'));
  const sketchfabUid='b'.repeat(32);
  try{
    const m=await new DownloadManager({dataDir:root,defaultFolder:path.join(root,'downloads'),runner:async(job)=>{await fsp.writeFile(job.output,artArchive({uid:sketchfabUid}));return {zipName:'s.zip'};},verify:verifyArchive,browser:()=>undefined,autoStart:false}).init();
    m.start('http://127.0.0.1:1');
    const created=await m.enqueue({models:[{uid:sketchfabUid,name:'Legacy',downloadable:true}],options:ZIP_OPTIONS,authorized:true});
    assert.equal(m.snapshot().jobs[0].kind,'sketchfab');
    assert.equal(m.snapshot().jobs[0].url,`https://sketchfab.com/models/${sketchfabUid}`);
    assert.equal((await waitState(m,created.added[0],['saved','failed'])).state,'saved');
    await m.close();
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('artstation: the runner is handed the job uid so the archive it writes can prove provenance',async()=>{
  const seen=[];
  const {m,root}=await manager({artRunner:async(job,{progress}={})=>{
    seen.push(job.uid);
    progress?.({stage:'converting',message:'正在用 mviewer 转换 glTF/GLB…'});
    // Echo the uid the way runArtstationJob does into info.json; if the queue forgot to pass it,
    // the archive would carry a different (or missing) uid and the shared verifier would refuse it.
    await fsp.writeFile(job.output,artArchive({uid:job.uid}));
    return {zipName:'echo.zip'};
  }});
  try{
    const created=await m.enqueue({kind:'artstation',models:[model()],options:ZIP_OPTIONS,authorized:true});
    const saved=await waitState(m,created.added[0],['saved','failed']);
    assert.deepEqual(seen,[UID]);
    assert.equal(saved.state,'saved',saved.message);
  }finally{await m.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('artstation: the ZIP writer stamps the job uid and falls back to the artwork URL',async()=>{
  const outDir=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-art-zip-'));
  try{
    await fsp.writeFile(path.join(outDir,'scene.glb'),minimalGlb());
    const meta={artworkUrl:ARTWORK,mviewUrl:'https://cdnb.artstation.com/x.mview',title:'Shield',author:'datawind',embedUrl:'https://www.artstation.com/embed/1'};
    const read=entries=>JSON.parse(entries.find(e=>e.name==='info.json').data.toString('utf8'));
    // A job uid always wins: the queue and the writer must not derive identity twice.
    assert.equal(read((await buildArtstationZip({outDir,meta,format:'glb',uid:UID})).entries).uid,UID);
    const other='c'.repeat(32);
    assert.equal(read((await buildArtstationZip({outDir,meta,format:'glb',uid:other})).entries).uid,other);
    // Without a job uid (direct call) the artwork URL still yields the same stable id.
    assert.equal(read((await buildArtstationZip({outDir,meta,format:'glb'})).entries).uid,UID);
  }finally{await fsp.rm(outDir,{recursive:true,force:true});}
});
