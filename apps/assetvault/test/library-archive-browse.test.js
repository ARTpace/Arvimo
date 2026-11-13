import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listArchiveEntries, extractArchiveEntry} from '../server/archive.mjs';

/** 手搓一个 stored（method 0）ZIP：local header + data + central directory + EOCD。 */
function makeZip(entries){
 const locals=[];
 const central=[];
 let offset=0;
 for(const {name,data} of entries){
  const nameBytes=Buffer.from(name,'utf8');
  const body=Buffer.from(data);
  const crc=crc32(body);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);
  local.writeUInt16LE(20,4);
  local.writeUInt16LE(0x0800,6);
  local.writeUInt16LE(0,8);
  local.writeUInt32LE(crc,14);
  local.writeUInt32LE(body.length,18);
  local.writeUInt32LE(body.length,22);
  local.writeUInt16LE(nameBytes.length,26);
  local.writeUInt16LE(0,28);
  const head=Buffer.concat([local,nameBytes]);
  locals.push(head,body);
  const dir=Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50,0);
  dir.writeUInt16LE(20,4);
  dir.writeUInt16LE(20,6);
  dir.writeUInt16LE(0x0800,8);
  dir.writeUInt16LE(0,10);
  dir.writeUInt32LE(crc,16);
  dir.writeUInt32LE(body.length,20);
  dir.writeUInt32LE(body.length,24);
  dir.writeUInt16LE(nameBytes.length,28);
  dir.writeUInt32LE(offset,42);
  central.push(Buffer.concat([dir,nameBytes]));
  offset+=head.length+body.length;
 }
 const cd=Buffer.concat(central);
 const end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);
 end.writeUInt16LE(entries.length,8);
 end.writeUInt16LE(entries.length,10);
 end.writeUInt32LE(cd.length,12);
 end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,cd,end]);
}

const table=new Uint32Array(256);
for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
function crc32(bytes){let crc=0xffffffff;for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}

async function withZip(entries,run){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'av-zip-'));
 const file=path.join(dir,'sample.zip');
 fs.writeFileSync(file,makeZip(entries));
 try{return await run(file);}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
}

const SAMPLE=[
 {name:'textures/a.png',data:Buffer.from('fake-png-bytes')},
 {name:'readme.txt',data:Buffer.from('hello zip')},
 {name:'models/b.glb',data:Buffer.alloc(8,1)},
];

test('列条目：目录项不进列表，大小与层级对得上',async()=>{
 await withZip([...SAMPLE,{name:'textures/',data:Buffer.alloc(0)}],async file=>{
  const result=await listArchiveEntries(file);
  assert.deepEqual(result.entries.map(entry=>entry.name).sort(),['models/b.glb','readme.txt','textures/a.png']);
  const png=result.entries.find(entry=>entry.name==='textures/a.png');
  assert.equal(png.size,Buffer.byteLength('fake-png-bytes'));
  assert.equal(png.depth,1);
  assert.equal(result.total,Buffer.byteLength('fake-png-bytes')+Buffer.byteLength('hello zip')+8);
  assert.equal(result.truncated,false);
 });
});

test('limit 生效并标记 truncated',async()=>{
 await withZip(SAMPLE,async file=>{
  const result=await listArchiveEntries(file,{limit:2});
  assert.equal(result.entries.length,2);
  assert.equal(result.truncated,true);
 });
});

test('解出单个条目，内容与写入一致',async()=>{
 await withZip(SAMPLE,async file=>{
  const entry=await extractArchiveEntry(file,'readme.txt');
  assert.equal(entry.bytes.toString(),'hello zip');
 });
});

test('不存在的条目与超大条目都拒绝',async()=>{
 await withZip(SAMPLE,async file=>{
  await assert.rejects(()=>extractArchiveEntry(file,'nope.txt'),/没有这个条目/);
  await assert.rejects(()=>extractArchiveEntry(file,'readme.txt',{maxBytes:3}),/太大/);
 });
});

test('不是 ZIP 的文件报明确错误',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'av-zip-'));
 const file=path.join(dir,'broken.zip');
 fs.writeFileSync(file,'this is definitely not a zip archive at all');
 try{
  await assert.rejects(()=>listArchiveEntries(file),/ZIP 目录缺失|不是有效的 ZIP/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
