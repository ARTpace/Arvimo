// Disk cache for thumbnails and JSON responses. A refresh or a server restart should not
// have to pull the same cover or category list from the network again.
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function createResponseCache(dir){
 const root=path.resolve(dir);
 const fileOf=(kind,key)=>path.join(root,kind,createHash('sha256').update(String(key)).digest('hex'));
 async function read(kind,key,maxAgeMs){
  const file=fileOf(kind,key);
  try{
   const stat=await fs.stat(file);
   if(Date.now()-stat.mtimeMs>maxAgeMs)return null;
   return await fs.readFile(file);
  }catch{return null;}
 }
 async function write(kind,key,bytes){
  const file=fileOf(kind,key);
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp=`${file}.part`;
  await fs.writeFile(tmp,bytes);
  await fs.rename(tmp,file);
 }
 return {
  async image(key,maxAgeMs){
   const packed=await read('images',key,maxAgeMs);
   if(!packed||packed.length<2)return null;
   const length=packed[0];
   if(packed.length<1+length)return null;
   return {mime:packed.subarray(1,1+length).toString('utf8'),bytes:packed.subarray(1+length)};
  },
  async saveImage(key,bytes,mime='image/jpeg'){
   const head=Buffer.from(String(mime).slice(0,80));
   await write('images',key,Buffer.concat([Buffer.from([head.length]),head,bytes]));
  },
  async json(key,maxAgeMs){
   const bytes=await read('json',key,maxAgeMs);
   if(!bytes)return null;
   try{return JSON.parse(bytes.toString('utf8'));}catch{return null;}
  },
  async saveJson(key,value){await write('json',key,Buffer.from(JSON.stringify(value)));},
 };
}
