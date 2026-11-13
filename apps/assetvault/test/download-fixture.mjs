import fsp from 'node:fs/promises';
import path from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {crc32} from '../server/archive.mjs';
export const FIXTURE_UID='0123456789abcdef0123456789abcdef';
export function zipEntries(entries,{compress=false}={}){let offset=0;const bodies=[],directory=[];for(const [name,value] of entries){const data=Buffer.isBuffer(value)?value:Buffer.from(value),packed=compress?deflateRawSync(data):data,n=Buffer.from(name),crc=(crc32(data)^0xffffffff)>>>0;const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(compress?8:0,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);bodies.push(local,n,packed);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(compress?8:0,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);directory.push(central,n);offset+=local.length+n.length+packed.length;}const cd=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...bodies,cd,end]);}
/** A minimal but valid glTF 2.0 binary carrying one triangle-less mesh and a POSITION accessor. */
export function fixtureGlb(){const json=JSON.stringify({asset:{version:'2.0'},buffers:[{byteLength:36}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0});const padded=Buffer.from(json+' '.repeat((4-json.length%4)%4));const glb=Buffer.alloc(20+padded.length+8+36);glb.writeUInt32LE(0x46546c67);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(padded.length,12);glb.writeUInt32LE(0x4e4f534a,16);padded.copy(glb,20);glb.writeUInt32LE(36,20+padded.length);glb.writeUInt32LE(0x004e4942,24+padded.length);glb.writeFloatLE(1,28+padded.length+12);glb.writeFloatLE(1,28+padded.length+28);return glb;}
export const fixtureInfo=uid=>({uid,author:'TEST FIXTURE',source_url:'https://sketchfab.com/models/'+uid});
/** A genuinely valid RGBA PNG (signature, IHDR, one IDAT, IEND — real CRCs, real deflate
 *  stream). The image-bundle verifier sniffs containers rather than decoding them, but a fixture
 *  that only *looks* like a PNG would not prove the writer picks the right extension.
 *  `width`/`height` exist so a caller can produce a *non-square* image: the gallery lays covers out
 *  at their own aspect ratio, and a 1×1 fixture cannot tell a correct ratio from a transposed one. */
export function fixturePng(width=1,height=1){
 const chunk=(type,data)=>{
  const out=Buffer.alloc(12+data.length);
  out.writeUInt32BE(data.length,0);
  out.write(type,4,'latin1');
  data.copy(out,8);
  out.writeUInt32BE((crc32(Buffer.concat([Buffer.from(type,'latin1'),data]))^0xffffffff)>>>0,8+data.length);
  return out;
 };
 const ihdr=Buffer.alloc(13);
 ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
 // 每行 = 1 字节过滤器 + 4 字节 RGBA/像素，全零即「不滤、全透明黑」。
 const raw=Buffer.alloc(height*(1+width*4));
 return Buffer.concat([
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  chunk('IHDR',ihdr),
  chunk('IDAT',deflateRawSync(raw)),
  chunk('IEND',Buffer.alloc(0)),
 ]);
}
export function fixtureZip(uid=FIXTURE_UID,options={}){
 return zipEntries([['fixture.glb',fixtureGlb()],['info.json',JSON.stringify(fixtureInfo(uid))],['README.txt','SYNTHETIC TEST ASSET; not a real platform export.']],options);
}
/**
 * The folder-output shape of the same fixture: a GLB, one loose texture and the provenance file.
 * `files` says which entries to write, so a test can drop info.json or a glb to check rejection.
 * `glb` overrides the model bytes when a test needs a richer scene than the bare triangle.
 */
export async function writeFixtureFolder(dir,{uid=FIXTURE_UID,files=['model.glb','textures/albedo.png','info.json'],glb}={}){
 await fsp.mkdir(dir,{recursive:true});
 for(const name of files){
  const target=path.join(dir,...name.split('/'));
  await fsp.mkdir(path.dirname(target),{recursive:true});
  const data=name.endsWith('.glb')?(glb||fixtureGlb()):name==='info.json'?Buffer.from(JSON.stringify(fixtureInfo(uid))):Buffer.from('PNG FIXTURE');
  await fsp.writeFile(target,data);
 }
 return dir;
}
