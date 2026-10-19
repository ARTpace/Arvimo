import fsp from 'node:fs/promises';
import path from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {crc32} from './archive.mjs';

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
