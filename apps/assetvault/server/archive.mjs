import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {createInflateRaw} from 'node:zlib';
import {createHash} from 'node:crypto';
const MAX=2*1024**3;
/** Staged entry name of one image inside an image bundle: a direct child of `images/`, never nested. */
const IMAGE_ENTRY=/^images\/[^/]+$/;
/** Same positional rule for a material bundle's PBR maps: a direct child of `textures/`. */
const TEXTURE_ENTRY=/^textures\/[^/]+$/;
const table=Uint32Array.from({length:256},(_,n)=>{for(let j=0;j<8;j++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes,crc=0xffffffff){for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);return crc>>>0;}
async function read(handle,length,position){const b=Buffer.alloc(length);const {bytesRead}=await handle.read(b,0,length,position);if(bytesRead!==length)throw Error('ZIP 数据截断');return b;}
/**
 * Validate a GLB header and its JSON chunk, and report what the asset contains.
 * Shared with the folder verifier so both delivery modes accept exactly the same
 * models: the header layout and the "has a real mesh" rule must not drift apart.
 */
export function inspectGlb(data,name,size){
 if(data.length<20||data.readUInt32LE(0)!==0x46546c67||data.readUInt32LE(4)!==2||data.readUInt32LE(8)!==size||data.readUInt32LE(16)!==0x4e4f534a||data.readUInt32LE(12)+20>data.length)throw Error('GLB 头或 JSON 结构无效');
 const gltf=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString());
 if(gltf.asset?.version!=='2.0'||!gltf.meshes?.some(m=>m.primitives?.some(p=>Number.isInteger(p.attributes?.POSITION)&&gltf.accessors?.[p.attributes.POSITION]?.count>0)))throw Error('GLB 没有有效网格');
 return {name,bytes:size,meshes:gltf.meshes.length,animations:gltf.animations?.length||0,images:gltf.images?.length||0};
}
/** Canonical file extension per sniffable image container. */
export const IMAGE_EXTENSIONS=Object.freeze({jpeg:'jpg',png:'png',gif:'gif',webp:'webp',avif:'avif',bmp:'bmp',tiff:'tif'});
/** Bytes needed to tell any of the supported containers apart. */
export const IMAGE_PREFIX_BYTES=64;
/** Sniff an image container from its leading bytes, or null.
 *  Shared with the image pipeline so the writer names a file by the very rule this verifier
 *  accepts it by — a renaming bug can then never produce a bundle that verifies but is mislabelled
 *  (or one that is correctly labelled but rejected). */
export function imageFormat(data){
 const head=Buffer.isBuffer(data)?data:Buffer.from(data||'');
 const at=(from,to)=>head.subarray(from,to).toString('latin1');
 if(head.length>=3&&head[0]===0xff&&head[1]===0xd8&&head[2]===0xff)return 'jpeg';
 if(head.length>=8&&head.readUInt32BE(0)===0x89504e47&&head.readUInt32BE(4)===0x0d0a1a0a)return 'png';
 if(head.length>=6&&at(0,4)==='GIF8')return 'gif';
 if(head.length>=12&&at(0,4)==='RIFF'&&at(8,12)==='WEBP')return 'webp';
 if(head.length>=12&&at(4,8)==='ftyp'&&['avif','avis','heic','heix','mif1'].includes(at(8,12)))return 'avif';
 if(head.length>=2&&head[0]===0x42&&head[1]===0x4d)return 'bmp';
 if(head.length>=4&&(head.readUInt32BE(0)===0x49492a00||head.readUInt32BE(0)===0x4d4d002a))return 'tiff';
 return null;
}
export function inspectImage(data,name,size){
 const format=imageFormat(data);
 if(!format)throw Error(`不是可识别的图片：${name}`);
 return {name,bytes:size,format,extension:IMAGE_EXTENSIONS[format]};
}
/** The `images` list an image bundle's info.json declares, validated. Provenance for an image
 *  bundle is the declaration itself, so a bundle whose manifest is absent or malformed has no
 *  provenance at all and must be rejected before any file is trusted. */
export function declaredImages(info){
  const list=info&&Array.isArray(info.images)?info.images:null;
  if(!list||!list.length)throw Error('info.json 没有登记作品图片');
  return list.map(item=>{
   const file=item&&typeof item.file==='string'?item.file:'';
   if(!file.startsWith('images/')||file.includes('..')||file.includes('\\')||file.includes('\0'))throw Error(`info.json 里的图片路径无效：${file||'(空)'}`);
   return {...item,file};
  });
}
/** The `textures` list a material bundle's info.json declares, validated the same way: the
 *  declaration IS the provenance, so it must exist and every path must stay inside `textures/`. */
const SBSAR_MAGIC=Buffer.from('377abcaf271c','hex');
/** ambientCG 的 .sbsar 是 7z 容器。校验只看文件头，避免把任意字节当成 Substance 归档收下。 */
export function assertSbsar(prefix,name){
 if(!prefix||prefix.length<SBSAR_MAGIC.length||!prefix.subarray(0,SBSAR_MAGIC.length).equals(SBSAR_MAGIC))throw Error(`不是 Substance 归档（.sbsar）：${name||'(空)'}`);
}
export function isSbsarMaterial(info){return !!(info&&info.kind==='material'&&String(info.format||'').toUpperCase()==='SBSAR');}
export function declaredSbsar(info){
 const file=info&&typeof info.substanceFile==='string'?info.substanceFile:'';
 if(!/^[^/\\:*?"<>|\x00]+\.sbsar$/i.test(file))throw Error(`info.json 里的 Substance 文件无效：${file||'(空)'}`);
 return file;
}
export function declaredTextures(info){
  const list=info&&Array.isArray(info.textures)?info.textures:null;
  if(!list||!list.length)throw Error('info.json 没有登记材质贴图');
  return list.map(item=>{
   const file=item&&typeof item.file==='string'?item.file:'';
   if(!file.startsWith('textures/')||file.includes('..')||file.includes('\\')||file.includes('\0'))throw Error(`info.json 里的贴图路径无效：${file||'(空)'}`);
   return {...item,file};
  });
}
/** Validate every entry's size and CRC; inspect GLB JSON and provenance without extracting files. */
export async function verifyArchive(file,{uid,signal}={}){
 const handle=await fsp.open(file,'r');let result;
 try{
  const size=(await handle.stat()).size;if(size<22||size>MAX)throw Error('ZIP 大小无效或超过 2GB 限制');
  const tail=await read(handle,Math.min(size,65557),Math.max(0,size-65557));let end=-1;
  for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
  if(end<0)throw Error('ZIP 目录缺失');
  const count=tail.readUInt16LE(end+10),cdSize=tail.readUInt32LE(end+12),cdOffset=tail.readUInt32LE(end+16);
  if(tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6)||tail.readUInt16LE(end+8)!==count||!count||count>10000||cdSize>8*1024**2||cdOffset+cdSize>size-tail.length+end)throw Error('不支持此 ZIP 结构');
  const directory=await read(handle,cdSize,cdOffset);const names=new Set();let p=0,total=0,info=null,glbs=[],warning=false;const regions=[],imageEntries=[],textureEntries=[],sbsarEntries=[];
  for(let n=0;n<count;n++){
   signal?.throwIfAborted();if(p+46>directory.length||directory.readUInt32LE(p)!==0x02014b50)throw Error('ZIP 目录损坏');
   const flags=directory.readUInt16LE(p+8),method=directory.readUInt16LE(p+10),crc=directory.readUInt32LE(p+16),packed=directory.readUInt32LE(p+20),length=directory.readUInt32LE(p+24),nl=directory.readUInt16LE(p+28),el=directory.readUInt16LE(p+30),cl=directory.readUInt16LE(p+32),offset=directory.readUInt32LE(p+42);
   const name=directory.subarray(p+46,p+46+nl).toString('utf8');p+=46+nl+el+cl;
   if(p>directory.length)throw Error('ZIP 目录损坏');
   if(!name||/[\\\x00:]/.test(name)||name.startsWith('/')||name.split('/').some(v=>v==='..'))throw Error(`ZIP 条目路径不安全：${name||'(空)'}`);
   if(names.has(name))throw Error(`ZIP 内有重名条目：${name}`);
   if(flags&1)throw Error(`ZIP 条目已加密：${name}`);
   if(![0,8].includes(method))throw Error(`ZIP 压缩方式不受支持：${name} (method ${method})`);
   names.add(name);total+=length;if(total>MAX||offset+30>cdOffset)throw Error('ZIP 解压大小超过限制');
   const local=await read(handle,30,offset);if(local.readUInt32LE(0)!==0x04034b50||local.readUInt16LE(8)!==method||local.readUInt16LE(6)!==flags)throw Error('ZIP 本地头损坏');
   const localName=await read(handle,local.readUInt16LE(26),offset+30);if(localName.toString('utf8')!==name)throw Error('ZIP 文件名不一致');
   const start=offset+30+local.readUInt16LE(26)+local.readUInt16LE(28);if(start+packed>cdOffset)throw Error('ZIP 内容越界');
   if(!(flags&8)&&(local.readUInt32LE(14)!==crc||local.readUInt32LE(18)!==packed||local.readUInt32LE(22)!==length))throw Error('ZIP 本地头大小或 CRC 不一致');regions.push([offset,start+packed]);
   const source=packed?fs.createReadStream(file,{start,end:start+packed-1,signal}):null;
   // Empty stored entries need no stream (Node does not accept end=-1).
   let bytes=0,sum=0xffffffff,parts=[],prefixBytes=0;
   const keep=name.endsWith('.glb')?32*1024**2:name==='info.json'?1024*1024:IMAGE_ENTRY.test(name)||TEXTURE_ENTRY.test(name)?IMAGE_PREFIX_BYTES:/\.sbsar$/i.test(name)?16:0;
   if(packed){const stream=method===8?source.pipe(createInflateRaw()):source;source.on('error',e=>stream.destroy(e));
    try{for await(const chunk of stream){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>length||bytes>MAX)throw Error('ZIP 解压长度异常');sum=crc32(chunk,sum);if(prefixBytes<keep){const part=chunk.subarray(0,keep-prefixBytes);parts.push(part);prefixBytes+=part.length;}}}finally{source.destroy();stream.destroy();}
   }
   if(bytes!==length||((sum^0xffffffff)>>>0)!==crc)throw Error(`ZIP 校验失败：${name}`);
   const data=Buffer.concat(parts);
   if(name==='info.json'){if(length>1024*1024)throw Error('模型说明过大');info=JSON.parse(data.toString());}
   if(name==='MISSING_BLIT.txt')warning=true;
   if(name.endsWith('.glb')){
    glbs.push(inspectGlb(data,name,length));
   }
   // Only the leading bytes are kept for these, so they are sniffed after info.json has been read:
   // a model bundle is allowed to carry an unrelated `images/` folder without being reinterpreted,
   // and a material bundle keeps its maps under `textures/` for the same reason.
   if(IMAGE_ENTRY.test(name))imageEntries.push({name,prefix:data,size:length});
   if(TEXTURE_ENTRY.test(name))textureEntries.push({name,prefix:data,size:length});
   if(/\.sbsar$/i.test(name))sbsarEntries.push({name,prefix:data,size:length});
  }
  regions.sort((a,b)=>a[0]-b[0]);for(let i=1;i<regions.length;i++)if(regions[i][0]<regions[i-1][1])throw Error('ZIP 条目内容重叠');
  if(p!==directory.length)throw Error('ZIP 目录长度不一致');
  if(!info||uid&&info.uid!==uid)throw Error('缺少有效 GLB 或模型来源信息不匹配');
  let images=null,textures=null;
  if(info.kind==='images'){
   // An image bundle declares its own payload. The declaration and the archive have to agree in
   // both directions: a missing file means a truncated transfer, an unlisted file means content
   // nobody vouched for — either way the "did the payload change?" answer stops being trustworthy.
   const declared=declaredImages(info);
   for(const item of declared)if(!names.has(item.file))throw Error(`ZIP 内缺少已登记的作品图片：${item.file}`);
   for(const entry of imageEntries)if(!declared.some(item=>item.file===entry.name))throw Error(`ZIP 内有未登记的作品图片：${entry.name}`);
   images=imageEntries.map(e=>inspectImage(e.prefix,e.name,e.size));
   if(!images.length)throw Error('ZIP 内没有作品图片');
  }else if(isSbsarMaterial(info)){
   const file=declaredSbsar(info);
   const entry=sbsarEntries.find(e=>e.name===file);
   if(!entry)throw Error(`ZIP 内缺少已登记的 Substance 文件：${file}`);
   assertSbsar(entry.prefix,file);
   textures=[];
  }else if(info.kind==='material'){
   // A material bundle follows the same two-direction rule for its PBR maps: every declared
   // texture present, every present texture declared, each one a real image container.
   const declared=declaredTextures(info);
   for(const item of declared)if(!names.has(item.file))throw Error(`ZIP 内缺少已登记的材质贴图：${item.file}`);
   for(const entry of textureEntries)if(!declared.some(item=>item.file===entry.name))throw Error(`ZIP 内有未登记的材质贴图：${entry.name}`);
   textures=textureEntries.map(e=>inspectImage(e.prefix,e.name,e.size));
   if(!textures.length)throw Error('ZIP 内没有材质贴图');
  }else if(info.kind==='hdri'||info.kind==='pack'){
   const declared=Array.isArray(info.files)?info.files:[];
   if(!declared.length)throw Error('ZIP 内没有登记的文件');
   for(const item of declared)if(!names.has(item.file))throw Error(`ZIP 内缺少已登记的文件：${item.file}`);
  }else if(info.platform==='civitai'){
   const declared=Array.isArray(info.files)?info.files:[];
   if(!declared.length||![...names].some(name=>/\.(safetensors|ckpt|gguf|pt|pth|bin|onnx|zip)$/i.test(name)))throw Error('ZIP 内没有 Civitai 模型文件');
   for(const item of declared)if(!names.has(item.file))throw Error(`ZIP 内缺少已登记的 Civitai 模型文件：${item.file}`);
  }else if(info.platform==='polyhaven'){
   if(![...names].some(name=>/\.(?:fbx|gltf|glb|blend|usdc|usd)$/i.test(name)))throw Error('ZIP 内没有 Poly Haven 的模型文件');
   for(const item of info.files||[])if(!names.has(item.file))throw Error(`ZIP 内缺少 Poly Haven 文件：${item.file}`);
  }else if(!glbs.length)throw Error('缺少有效 GLB 或模型来源信息不匹配');
  result={bytes:size,entries:count,glbs,images,textures,warning,info,author:String(info.author||''),source:String(info.source_url||'')};
 }finally{await handle.close();}
 const digest=createHash('sha256');for await(const chunk of fs.createReadStream(file,{signal}))digest.update(chunk);
 return {...result,sha256:digest.digest('hex'),verifiedAt:Date.now()};
}

/** EOCD 定位：与 verifyArchive 同一套判据，只是不校验条目内容。ZIP64 直接拒绝，别装作能读。 */
async function readEndRecord(handle){
 const size=(await handle.stat()).size;
 if(size<22)throw Error('不是有效的 ZIP 文件');
 const tail=await read(handle,Math.min(size,65557),Math.max(0,size-65557));
 let end=-1;
 for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
 if(end<0)throw Error('ZIP 目录缺失');
 const count=tail.readUInt16LE(end+10),cdSize=tail.readUInt32LE(end+12),cdOffset=tail.readUInt32LE(end+16);
 if(!count)return {size,count:0,cdSize:0,cdOffset:0};
 if(count===0xffff||cdSize===0xffffffff||cdOffset===0xffffffff)throw Error('暂不支持 ZIP64 归档');
 if(cdSize>8*1024**2||cdOffset+cdSize>size)throw Error('ZIP 目录异常');
 return {size,count,cdSize,cdOffset};
}

/** 只读中央目录，列出条目（不解压、不校验 CRC）。供「ZIP 内嵌浏览」用。 */
export async function listArchiveEntries(file,{limit=600}={}){
 const handle=await fsp.open(file,'r');
 try{
  const {count,cdSize,cdOffset}=await readEndRecord(handle);
  if(!count)return {count:0,entries:[],total:0,truncated:false};
  const directory=await read(handle,cdSize,cdOffset);
  const entries=[];let p=0,total=0,files=0;
  const max=Math.max(1,Math.min(Number(limit)||600,2000));
  for(let n=0;n<count;n++){
   if(p+46>directory.length||directory.readUInt32LE(p)!==0x02014b50)throw Error('ZIP 目录损坏');
   const method=directory.readUInt16LE(p+10),packed=directory.readUInt32LE(p+20),length=directory.readUInt32LE(p+24);
   const nl=directory.readUInt16LE(p+28),el=directory.readUInt16LE(p+30),cl=directory.readUInt16LE(p+32);
   const name=directory.subarray(p+46,p+46+nl).toString('utf8');
   p+=46+nl+el+cl;
   // 目录项（以 / 结尾、大小为 0）不进列表：界面靠名字里的 / 自己缩进。
   if(name.endsWith('/'))continue;
   files++;
   total+=length;
   if(entries.length<max)entries.push({name,size:length,packed,method,depth:name.split('/').length-1});
  }
  return {count,files,entries,total,truncated:files>entries.length};
 }finally{await handle.close();}
}

/** 解出单个条目，供预览 ZIP 里的图片/文本。上限按预览场景收窄，不做整包解压。 */
export async function extractArchiveEntry(file,name,{maxBytes=48*1024**2}={}){
 const handle=await fsp.open(file,'r');
 try{
  const {count,cdSize,cdOffset}=await readEndRecord(handle);
  if(!count)throw Error('ZIP 是空的');
  const directory=await read(handle,cdSize,cdOffset);
  const wanted=String(name||'');
  if(!wanted)throw Error('缺少条目名');
  let p=0,hit=null;
  for(let n=0;n<count;n++){
   if(p+46>directory.length||directory.readUInt32LE(p)!==0x02014b50)throw Error('ZIP 目录损坏');
   const flags=directory.readUInt16LE(p+8),method=directory.readUInt16LE(p+10),packed=directory.readUInt32LE(p+20);
   const length=directory.readUInt32LE(p+24),nl=directory.readUInt16LE(p+28),el=directory.readUInt16LE(p+30),cl=directory.readUInt16LE(p+32),offset=directory.readUInt32LE(p+42);
   const entryName=directory.subarray(p+46,p+46+nl).toString('utf8');
   p+=46+nl+el+cl;
   if(entryName!==wanted)continue;
   hit={flags,method,packed,length,offset};
   break;
  }
  if(!hit)throw Error('ZIP 里没有这个条目');
  if(hit.flags&1)throw Error('这个条目已加密，无法预览');
  if(hit.length>maxBytes)throw Error('条目太大，不适合在线预览');
  if(![0,8].includes(hit.method))throw Error(`压缩方式不受支持（method ${hit.method}）`);
  const local=await read(handle,30,hit.offset);
  if(local.readUInt32LE(0)!==0x04034b50)throw Error('ZIP 本地头损坏');
  const start=hit.offset+30+local.readUInt16LE(26)+local.readUInt16LE(28);
  if(!hit.packed)return {name:wanted,bytes:Buffer.alloc(0)};
  const source=fs.createReadStream(file,{start,end:start+hit.packed-1});
  const stream=hit.method===8?source.pipe(createInflateRaw()):source;
  source.on('error',error=>stream.destroy(error));
  const chunks=[];
  try{for await(const chunk of stream)chunks.push(chunk);}
  finally{source.destroy();stream.destroy();}
  return {name:wanted,bytes:Buffer.concat(chunks)};
 }finally{await handle.close();}
}
