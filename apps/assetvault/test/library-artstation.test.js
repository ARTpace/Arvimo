import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipEntries,writeZip} from '../server/zip-writer.mjs';
import {verifyArchive} from '../server/archive.mjs';
import {isArtstationHost,normalizeArtstationUrl,extractEmbedIds,extractMview,looksLikeChallenge} from '../server/artstation.mjs';
import {artstationHash,fetchProjectAssets,readStreamText} from '../server/artstation-project.mjs';
import {resolveProxy} from '../server/public-http.mjs';


function minimalGlb(){
  const json=JSON.stringify({asset:{version:'2.0'},meshes:[{name:'test',primitives:[{attributes:{POSITION:0}}]}],accessors:[{count:3}],buffers:[{byteLength:0}]});
  const jsonBuf=Buffer.from(json,'utf8');
  const pad=(4-(jsonBuf.length%4))%4;
  const total=12+8+jsonBuf.length+pad;
  const out=Buffer.alloc(total,0x20);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(total,8);
  out.writeUInt32LE(jsonBuf.length+pad,12);out.writeUInt32LE(0x4e4f534a,16);
  jsonBuf.copy(out,20);
  return out;
}

test('zip-writer: roundtrip passes the strict archive verifier',async()=>{
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-zip-'));
  try{
    const zipPath=path.join(tmp,'test.zip');
    const big=Buffer.alloc(40000,7);
    await writeZip(zipPath,[
      {name:'a.txt',data:Buffer.from('hello artstation','utf8')},
      {name:'sub/b.bin',data:big},
      {name:'info.json',data:Buffer.from(JSON.stringify({platform:'artstation',author:'test'}))},
      {name:'model.glb',data:minimalGlb()}
    ]);
    const buf=await fsp.readFile(zipPath);
    assert.equal(buf.readUInt32LE(buf.length-22),0x06054b50);
    assert.equal(buf.readUInt16LE(buf.length-12),4);
    const result=await verifyArchive(zipPath,{});
    assert.ok(result);
  }finally{await fsp.rm(tmp,{recursive:true,force:true});}
});

test('zip-writer: rejects unsafe or duplicate entry names',()=>{
  assert.throws(()=>zipEntries([{name:'../evil',data:'x'}]),/不安全/);
  assert.throws(()=>zipEntries([{name:'a/b',data:'x'},{name:'a/b',data:'y'}]),/重名/);
  assert.throws(()=>zipEntries([]),/至少需要/);
});

test('artstation: extract embed ids and mview scene from html',()=>{
  const page='<html><head><title>ArtStation - Deployable Ballistic Shield</title></head><body><a href="https://www.artstation.com/embed/100627939">3D</a></body></html>';
  assert.deepEqual(extractEmbedIds(page),['100627939']);
  const embed='<head><title>Deployable Ballistic Shield</title></head><script src="https://cdna.artstation.com/marmoset/marmoset.js"></script><script>var opts={};opts.thumbnailURL="https://cdnb.artstation.com/p/assets/marmosets/images/100/627/939/medium/x.jpg?123";var v=marmoset.embed( "https://cdnb.artstation.com/p/assets/marmosets/attachments/100/627/939/original/75b453e3d484c569.mview?1783521030", opts );</script>';
  const m=extractMview(embed);
  assert.equal(m.mviewUrl,'https://cdnb.artstation.com/p/assets/marmosets/attachments/100/627/939/original/75b453e3d484c569.mview?1783521030');
  assert.ok(m.thumbnail&&m.thumbnail.includes('cdnb.artstation.com'));
  assert.equal(m.title,'Deployable Ballistic Shield');
});

test('artstation: host + url normalization rules',()=>{
  assert.ok(isArtstationHost('artstation.com'));
  assert.ok(isArtstationHost('www.artstation.com'));
  assert.ok(isArtstationHost('cdnb.artstation.com'));
  assert.ok(!isArtstationHost('evil-artstation.com'));
  assert.ok(!isArtstationHost('sketchfab.com'));
  const u=normalizeArtstationUrl('https://www.artstation.com/artwork/lEVE8J');
  assert.equal(u.pathname,'/artwork/lEVE8J');
  assert.throws(()=>normalizeArtstationUrl('https://sketchfab.com/3d-models/x-abc'),/ArtStation/);
  assert.throws(()=>normalizeArtstationUrl('https://www.artstation.com/profile/foo'),/作品页/);
  assert.throws(()=>normalizeArtstationUrl('https://www.artstation.com:8443/artwork/x'),/端口/);
  assert.throws(()=>normalizeArtstationUrl('https://127.0.0.1/artwork/x'));
});

test('artstation: cloudflare challenge detection',()=>{
  assert.ok(looksLikeChallenge('<html><script>window._cf_chl_opt={};</script></html>'));
  assert.ok(looksLikeChallenge('<title>Just a moment...</title>'));
  assert.ok(!looksLikeChallenge('<html><title>ArtStation - Test Artwork</title><body>content</body></html>'));
});

test('artstation-project: hash extraction from artwork urls',()=>{
  assert.equal(artstationHash('https://www.artstation.com/artwork/lEVE8J'),'lEVE8J');
  assert.equal(artstationHash('https://www.artstation.com/artwork/lEVE8J/'),'lEVE8J');
  assert.equal(artstationHash('https://www.artstation.com/profile/foo'),null);
});

test('artstation-project: pulls the marmoset embed id from the project JSON',async()=>{
  const json={title:'Deployable Ballistic Shield',user:{username:'datawind'},assets:[
    {asset_type:'image',player_embedded:'<iframe src="https://www.artstation.com/embed/1"></iframe>'},
    {asset_type:'marmoset',player_embedded:'<iframe src="https://www.artstation.com/embed/100627939" frameborder="0"></iframe>'},
    {asset_type:'marmoset',player_embedded:'<iframe src="https://www.artstation.com/embed/100627939"></iframe>'}
  ]};
  const seen=[];
  const fakeOpen=async(url,opts)=>{seen.push([url,opts.artstation]);return{status:200,headers:{},stream:(async function*(){yield Buffer.from(JSON.stringify(json),'utf8');})()};};
  const r=await fetchProjectAssets('https://www.artstation.com/artwork/lEVE8J',{open:fakeOpen});
  assert.deepEqual(r,{ids:['100627939'],title:'Deployable Ballistic Shield',author:'datawind',platformCategories:[]});
  assert.equal(seen[0][0],'https://www.artstation.com/projects/lEVE8J.json');
  assert.equal(seen[0][1],true);
});

test('artstation-project: non-2xx or non-json yields null',async()=>{
  const notOk=async()=>({status:404,headers:{},stream:(async function*(){})()});
  assert.equal(await fetchProjectAssets('https://www.artstation.com/artwork/lEVE8J',{open:notOk}),null);
  const notJson=async()=>({status:200,headers:{},stream:(async function*(){yield Buffer.from('<html>nope</html>');})()});
  assert.equal(await fetchProjectAssets('https://www.artstation.com/artwork/lEVE8J',{open:notJson}),null);
});

test('artstation-project: readStreamText stops at the byte limit',async()=>{
  const stream=(async function*(){for(let i=0;i<100;i++)yield Buffer.alloc(1024,0x61);})();
  const text=await readStreamText({stream},4096);
  assert.equal(text.length,4096);
});

test('public-http: resolveProxy reads env and honours none/off',()=>{
  const p=resolveProxy({SFX_NO_SYSTEM_PROXY:'1',SFX_PROXY:'http://127.0.0.1:7890'});
  assert.equal(p.hostname,'127.0.0.1');
  assert.equal(p.port,'7890');
  assert.equal(resolveProxy({SFX_NO_SYSTEM_PROXY:'1',HTTPS_PROXY:'none'}),null);
  assert.equal(resolveProxy({SFX_NO_SYSTEM_PROXY:'1',HTTP_PROXY:'   '}),null);
  assert.equal(resolveProxy({SFX_NO_SYSTEM_PROXY:'1'}),null);
  // SFX_PROXY 是显式开关：写 none/off 必须强制直连，不能回落到 HTTPS_PROXY。
  assert.equal(resolveProxy({SFX_PROXY:'none',HTTPS_PROXY:'http://127.0.0.1:7201'}),null);
  assert.equal(resolveProxy({SFX_PROXY:'off',HTTP_PROXY:'http://127.0.0.1:7201'}),null);
  assert.equal(resolveProxy({SFX_PROXY:'  ',HTTPS_PROXY:'http://127.0.0.1:7201'}).port,'7201');
});
