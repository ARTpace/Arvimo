import fsp from 'node:fs/promises';
import path from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {crc32} from './archive.mjs';
import {createReadStream} from 'node:fs';

// ponytail: classic ZIP (under 2GB input), store files in chunks instead of buffering the tree.
export async function writeZipFiles(destination,files,{signal}={}){
 const handle=await fsp.open(destination,'wx');let offset=0;const central=[];
 const write=async(buffer,position=offset)=>{let written=0;while(written<buffer.length){const result=await handle.write(buffer,written,buffer.length-written,position+written);if(!result.bytesWritten)throw Error('ZIP 写入中断');written+=result.bytesWritten;}if(position===offset)offset+=written;};
 try{
  if(files.length>65535)throw Error('ZIP 文件数量超过限制');
  for(const file of files){
   signal?.throwIfAborted();
   const name=Buffer.from(file.relative),start=offset,header=Buffer.alloc(30);
   if(name.length>65535)throw Error('ZIP 文件名过长');
   header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt16LE(name.length,26);
   await write(header);await write(name);let crc=0xffffffff,size=0;
   for await(const chunk of createReadStream(file.full,{signal})){crc=crc32(chunk,crc);size+=chunk.length;if(size>file.size)throw Error('打包期间文件发生变化');await write(chunk);}
   if(size!==file.size)throw Error('打包期间文件发生变化');
   crc=(crc^0xffffffff)>>>0;header.writeUInt32LE(crc,14);header.writeUInt32LE(size,18);header.writeUInt32LE(size,22);await write(header,start);
   const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);cd.writeUInt16LE(0x800,8);cd.writeUInt16LE(33,14);cd.writeUInt32LE(crc,16);cd.writeUInt32LE(size,20);cd.writeUInt32LE(size,24);cd.writeUInt16LE(name.length,28);cd.writeUInt32LE(start,42);central.push(cd,name);
  }
  const start=offset;for(const buffer of central)await write(buffer);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(offset-start,12);end.writeUInt32LE(start,16);await write(end);
 }finally{await handle.close();}
}

// Minimal ZIP writer (store + deflateRaw) with no external dependencies.
// Entry names use forward slashes and are flagged UTF-8 (general purpose bit 11).
// Output is verified against the same strict reader used by verifyArchive().
const dosDateTime=now=>{
  const d=new Date(now);
  return {time:(d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1),date:(((d.getFullYear()-1980)&0x7f)<<9)|((d.getMonth()+1)<<5)|d.getDate()};
};
export function zipEntries(entries,{now=Date.now()}={}){
  if(!Array.isArray(entries)||!entries.length)throw Error('ZIP 至少需要一个条目');
  const {time,date}=dosDateTime(now);
  const local=[];const central=[];const seen=new Set();let offset=0;
  for(const entry of entries){
    if(typeof entry.name!=='string'||!entry.name||entry.name.includes('\0')||entry.name.startsWith('/')||entry.name.split('/').some(v=>v==='.'||v==='..'))throw Error(`ZIP 条目路径不安全：${entry.name||'(空)'}`);
    if(seen.has(entry.name))throw Error(`ZIP 内有重名条目：${entry.name}`);
    seen.add(entry.name);
    const nameBuf=Buffer.from(entry.name,'utf8');
    const data=Buffer.isBuffer(entry.data)?entry.data:Buffer.from(entry.data??'','utf8');
    if(nameBuf.length>0xffff||data.length>0xffffffff)throw Error(`ZIP 条目过大：${entry.name}`);
    const deflated=deflateRawSync(data,{level:6});
    const useDeflate=data.length>64&&deflated.length<data.length-6;
    const payload=useDeflate?deflated:data;
    const crc=(crc32(data)^0xffffffff)>>>0;
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);
    header.writeUInt16LE(20,4);
    header.writeUInt16LE(0x0800,6);
    header.writeUInt16LE(useDeflate?8:0,8);
    header.writeUInt16LE(time,10);
    header.writeUInt16LE(date,12);
    header.writeUInt32LE(crc,14);
    header.writeUInt32LE(payload.length,18);
    header.writeUInt32LE(data.length,22);
    header.writeUInt16LE(nameBuf.length,26);
    header.writeUInt16LE(0,28);
    local.push(header,nameBuf,payload);
    const cd=Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50,0);
    cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);
    cd.writeUInt16LE(0x0800,8);
    cd.writeUInt16LE(useDeflate?8:0,10);
    cd.writeUInt16LE(time,12);cd.writeUInt16LE(date,14);
    cd.writeUInt32LE(crc,16);
    cd.writeUInt32LE(payload.length,20);
    cd.writeUInt32LE(data.length,24);
    cd.writeUInt16LE(nameBuf.length,28);
    cd.writeUInt32LE(offset,42);
    central.push(cd,nameBuf);
    offset+=30+nameBuf.length+payload.length;
  }
  const cdStart=offset;
  const cdSize=central.reduce((n,b)=>n+b.length,0);
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);
  eocd.writeUInt16LE(entries.length,8);
  eocd.writeUInt16LE(entries.length,10);
  eocd.writeUInt32LE(cdSize,12);
  eocd.writeUInt32LE(cdStart,16);
  return Buffer.concat([...local,...central,eocd]);
}
export async function writeZip(dest,entries,options={}){
  const buf=zipEntries(entries,options);
  await fsp.mkdir(path.dirname(dest),{recursive:true});
  await fsp.writeFile(dest,buf);
  return dest;
}
