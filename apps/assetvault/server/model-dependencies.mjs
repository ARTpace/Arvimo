import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkedOrganizePath} from './file-organize-preflight.mjs';
import {modelResourceRel} from '../src/library/model-resource-path.js';

const parsed=new Map();
const stamp=stat=>`${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
async function readManifest(file,stat){
 if(/\.glb$/i.test(file)){
  const handle=await fs.open(file,'r');
  try{
   const header=Buffer.alloc(20),read=await handle.read(header,0,20,0);
   if(read.bytesRead<4||header.toString('ascii',0,4)!=='glTF')return null; // 兼容旧回传缓存；无有效 GLB 头则不宣称解析依赖。
   if(read.bytesRead!==20||header.readUInt32LE(4)!==2||BigInt(header.readUInt32LE(8))!==stat.size||header.readUInt32LE(16)!==0x4e4f534a)throw Error('GLB 头或 JSON 块无效');
   const length=header.readUInt32LE(12);if(length>8*1024*1024||BigInt(length)+20n>stat.size)throw Error('GLB JSON 清单超过限制或被截断');
   const json=Buffer.alloc(length),chunk=await handle.read(json,0,length,20);if(chunk.bytesRead!==length)throw Error('GLB JSON 块被截断');
   return JSON.parse(json.toString('utf8'));
  }finally{await handle.close();}
 }
 if(stat.size>8n*1024n*1024n)throw Error('glTF 依赖清单超过 8 MB，暂不缓存封面');
 return JSON.parse(await fs.readFile(file,'utf8'));
}

/** 解析 glTF / GLB JSON 块的 buffers/images 外部引用；不遍历目录、不读取贴图内容。 */
export async function thumbSourceStat(file,{root=path.dirname(file)}={}){
 const stat=await fs.stat(file,{bigint:true});
 if(!stat.isFile()||! /\.(gltf|glb)$/i.test(file))return stat;
 const rel=path.relative(root,file).split(path.sep).join('/');
 await checkedOrganizePath(root,rel);
 const cacheId=path.resolve(file)+'|'+stamp(stat);let uris=parsed.get(cacheId);
 if(!uris){
  const data=await readManifest(file,stat);if(data===null)return stat;
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('glTF 依赖清单无效');
  const refs=[];
  for(const section of ['buffers','images']){
   if(data[section]!==undefined&&!Array.isArray(data[section]))throw Error('glTF 依赖列表无效');
   for(const item of data[section]||[]){
    if(item?.uri===undefined)continue;
    if(typeof item.uri!=='string')throw Error('glTF 依赖 URI 无效');
    if(/^data:/i.test(item.uri))continue;refs.push(item.uri);
    if(refs.length>128)throw Error('glTF 外部依赖超过 128 项，暂不缓存封面');
   }
  }
  uris=[...new Set(refs)].sort();
  if(stamp(await fs.stat(file,{bigint:true}))!==stamp(stat))throw Error('读取 glTF 清单期间源文件变化');
  // ponytail: 只缓存已解析 URI（最多 256 份）；每次仍核验依赖版本，不永久缓存贴图 stat。
  parsed.set(cacheId,uris);if(parsed.size>256)parsed.delete(parsed.keys().next().value);
 }
 const version=createHash('sha256').update('gltf-dependencies-v1');
 for(const uri of uris){
  const dependencyRel=modelResourceRel(rel,uri);version.update('\0'+uri+'\0');
  try{
   const dependency=await checkedOrganizePath(root,dependencyRel),info=await fs.lstat(dependency,{bigint:true});
   if(!info.isFile()||info.isSymbolicLink())throw Error('glTF 依赖必须为普通文件');
   version.update(stamp(info));
  }catch(error){if(error.code==='ENOENT')version.update('missing');else throw error;}
 }
 stat.dependencyVersion=version.digest('hex');return stat;
}
