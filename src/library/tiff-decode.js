// TIFF 解码：只做「看得到图」这一件事——读第一页 IFD、取 strip、解压、合成 RGBA。
//
// 为什么要自己解：Chrome 至今不认 image/tiff，`<img>` 直接空白；three 也没有 TIFFLoader。
// 覆盖范围按真实素材取：未压缩 / LZW / PackBits / Deflate 四种压缩，8bit 与 16bit 两种深度，
// 灰阶 / RGB / 调色板 / CMYK 四种色彩，chunky 与 planar 两种排布，外加水平差分预测。
// JPEG-in-TIFF、CCITT 传真压缩不做——那两类基本只出现在扫描件里，遇到就明确报错，
// 不要静默画成错色（错色比不显示更难判断）。
//
// 输出是 RGBA 字节，故意不碰 canvas：解码器要能在 Node 里被测试覆盖。

const TYPE_SIZE={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8};
/** 超过这个像素量就不解了：一张 80MP 的十六位图光原始样本就 640MB，浏览器标签会直接崩。 */
const MAX_PIXELS=80_000_000;

const TAG={
 width:256,height:257,bits:258,compression:259,photometric:262,
 stripOffsets:273,samples:277,rowsPerStrip:278,stripBytes:279,planar:284,
 predictor:317,colorMap:320,tileWidth:322,tileLength:323,tileOffsets:324,tileBytes:325,
 extraSamples:338,sampleFormat:339,
};

function readNumbers(view,le,offset,type,count){
 const out=new Array(count);
 const size=TYPE_SIZE[type]||1;
 for(let i=0;i<count;i+=1){
  const at=offset+i*size;
  switch(type){
   case 1:case 2:case 6:case 7:out[i]=view.getUint8(at);break;
   case 3:out[i]=view.getUint16(at,le);break;
   case 4:out[i]=view.getUint32(at,le);break;
   case 5:out[i]=view.getUint32(at,le)/(view.getUint32(at+4,le)||1);break;
   case 8:out[i]=view.getInt16(at,le);break;
   case 9:out[i]=view.getInt32(at,le);break;
   case 10:out[i]=view.getInt32(at,le)/(view.getInt32(at+4,le)||1);break;
   case 11:out[i]=view.getFloat32(at,le);break;
   case 12:out[i]=view.getFloat64(at,le);break;
   default:out[i]=0;
  }
 }
 return out;
}

function readIFD(view,le,offset,limit){
 if(offset+2>limit)return null;
 const count=view.getUint16(offset,le);
 const tags=new Map();
 for(let i=0;i<count;i+=1){
  const base=offset+2+i*12;
  if(base+12>limit)break;
  const tag=view.getUint16(base,le);
  const type=view.getUint16(base+2,le);
  const n=view.getUint32(base+4,le);
  const size=TYPE_SIZE[type]||1;
  const total=size*n;
  // 值不超过 4 字节时直接内联在条目里，否则那 4 字节是偏移。
  const valueAt=total<=4?base+8:view.getUint32(base+8,le);
  if(valueAt+total>limit||n>0x100000)continue;
  tags.set(tag,{type,count:n,values:readNumbers(view,le,valueAt,type,n)});
 }
 return tags;
}

const first=(tags,id,fallback)=>{const entry=tags.get(id);return entry&&entry.values.length?entry.values[0]:fallback;};

/** TIFF 的 LZW 是大端对齐的变长码，与桌面 LZW/GIF 的位序不同，不能复用。 */
function lzwDecode(src,hint){
 let out=new Uint8Array(hint>0?hint:Math.max(1024,src.length*3));
 let outLen=0;
 const grow=need=>{
  if(outLen+need<=out.length)return;
  let size=out.length;
  while(size<outLen+need)size*=2;
  const next=new Uint8Array(size);
  next.set(out.subarray(0,outLen));
  out=next;
 };
 let bitPos=0;
 let codeWidth=9;
 let dict=[];
 let next=258;
 let prev=null;
 const reset=()=>{
  dict=new Array(4096);
  for(let i=0;i<256;i+=1)dict[i]=[i];
  next=258;codeWidth=9;prev=null;
 };
 reset();
 const readCode=()=>{
  if(bitPos+codeWidth>src.length*8)return -1;
  let code=0;
  for(let i=0;i<codeWidth;i+=1){
   const bp=bitPos+i;
   code=(code<<1)|((src[bp>>3]>>(7-(bp&7)))&1);
  }
  bitPos+=codeWidth;
  return code;
 };
 while(true){
  const code=readCode();
  if(code<0||code===257)break;
  if(code===256){reset();continue;}
  let entry=dict[code];
  if(!entry){
   // 唯一的合法例外：编码器刚添加的条目还没进字典，此时用「上一串 + 上一串首字节」。
   if(!prev||code!==next)break;
   entry=prev.concat(prev[0]);
  }
  grow(entry.length);
  for(let i=0;i<entry.length;i+=1)out[outLen+i]=entry[i];
  outLen+=entry.length;
  if(prev){
   if(next<4096)dict[next++]=prev.concat(entry[0]);
   // 位宽要「提前一个码」切换：解码器的字典永远比编码器少一条（首个码生成不了新条目），
   // 严格按 next > maxcode 切会让第 512 个条目之后整段错位。实测延迟量必须为 -1，
   // 三种写法只有这一种能完整解出 PIL/GIMP/Photoshop 存的 LZW。
   if(next>(1<<codeWidth)-2&&codeWidth<12)codeWidth+=1;
  }
  prev=entry;
 }
 return out.subarray(0,outLen);
}

function packBitsDecode(src,hint){
 let out=new Uint8Array(hint>0?hint:Math.max(1024,src.length*2));
 let outLen=0;
 const grow=need=>{
  if(outLen+need<=out.length)return;
  let size=out.length;
  while(size<outLen+need)size*=2;
  const next=new Uint8Array(size);
  next.set(out.subarray(0,outLen));
  out=next;
 };
 let i=0;
 while(i<src.length){
  const n=(src[i]<<24)>>24;
  i+=1;
  if(n>=0){
   const take=n+1;
   grow(take);
   for(let k=0;k<take&&i<src.length;k+=1)out[outLen++]=src[i++];
  }else if(n!==-128){
   const value=src[i++];
   grow(1-n);
   for(let k=0;k<1-n;k+=1)out[outLen++]=value;
  }
 }
 return out.subarray(0,outLen);
}

/** Deflate 走浏览器原生的解压流：不额外打一份 inflate 实现进包里。 */
async function inflateBytes(bytes,zlib){
 const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream(zlib?'deflate':'deflate-raw'));
 return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompress(bytes,compression,hint){
 switch(compression){
  case 1:return bytes;
  case 5:return lzwDecode(bytes,hint);
  case 8:case 32946:{
   try{return await inflateBytes(bytes,true);}
   catch{return inflateBytes(bytes,false);}
  }
  case 32773:return packBitsDecode(bytes,hint);
  case 2:case 3:case 4:case 6:case 7:
   throw Error('这张 TIFF 用了 CCITT 传真压缩（扫描件常见），暂时只有专用软件能解');
  default:
   throw Error(`不认识的 TIFF 压缩方式 ${compression}`);
 }
}

/** 水平差分预测：每个样本存的是「和同一行前一个同通道样本的差」。 */
function undoPredictor(data,width,height,samples,bits,planar,le){
 const bps=bits/8;
 const planeRowBytes=width*bps;
 const rows=planar===2?samples*height:height;
 const rowBytes=planar===2?planeRowBytes:samples*planeRowBytes;
 const stride=(planar===2?1:samples)*bps;
 for(let r=0;r<rows;r+=1){
  const base=r*rowBytes;
  for(let i=base+stride;i<base+rowBytes;i+=bps){
   const prev=i-stride;
   if(bits===8){data[i]=(data[i]+data[prev])&255;continue;}
   const a=le?(data[i]|(data[i+1]<<8)):((data[i]<<8)|data[i+1]);
   const b=le?(data[prev]|(data[prev+1]<<8)):((data[prev]<<8)|data[prev+1]);
   const sum=(a+b)&0xffff;
   if(le){data[i]=sum&255;data[i+1]=sum>>8;}else{data[i]=sum>>8;data[i+1]=sum&255;}
  }
 }
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray,pages:number}>}
 */
export async function decodeTiff(input){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
 if(bytes.length<8)throw Error('文件太小，不是 TIFF');
 const little=bytes[0]===0x49&&bytes[1]===0x49;
 const big=bytes[0]===0x4d&&bytes[1]===0x4d;
 if(!little&&!big)throw Error('不是 TIFF 文件（缺 II/MM 标记）');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 const le=little;
 if(view.getUint16(2,le)!==42)throw Error('不是 TIFF 文件（缺 42 标记）');
 const tags=readIFD(view,le,view.getUint32(4,le),bytes.length);
 if(!tags)throw Error('TIFF 的目录读不出来，文件可能已损坏');

 const width=first(tags,TAG.width,0);
 const height=first(tags,TAG.height,0);
 if(!width||!height)throw Error('TIFF 缺少尺寸信息');
 if(width*height>MAX_PIXELS)throw Error(`图太大（${width}×${height}），超过预览上限`);

 const bits=first(tags,TAG.bits,8);
 const samples=first(tags,TAG.samples,1);
 const compression=first(tags,TAG.compression,1);
 const photometric=first(tags,TAG.photometric,2);
 const planar=first(tags,TAG.planar,1);
 const predictor=first(tags,TAG.predictor,1);
 if(bits!==8&&bits!==16)throw Error(`暂不支持 ${bits} 位色深的 TIFF`);
 if(samples<1||samples>8)throw Error(`TIFF 通道数异常（${samples}）`);
 const format=first(tags,TAG.sampleFormat,1);
 if(format!==1&&format!==2)throw Error('暂不支持浮点样本的 TIFF');

 const bps=bits/8;
 const bytesPerPixel=samples*bps;
 const rowBytes=width*bytesPerPixel;
 const expected=rowBytes*height;

 // strip 与 tile 二选一：Photoshop 存 TIFF 用 strip，扫描与卫星图常用 tile。
 const stripOffsets=tags.get(TAG.stripOffsets)?.values||[];
 const stripBytes=tags.get(TAG.stripBytes)?.values||[];
 const tileOffsets=tags.get(TAG.tileOffsets)?.values||[];
 const tileBytes=tags.get(TAG.tileBytes)?.values||[];
 const offsets=tileOffsets.length?tileOffsets:stripOffsets;
 const lengths=tileBytes.length?tileBytes:stripBytes;
 if(!offsets.length)throw Error('TIFF 没有图像数据块');

 const tiles=tileOffsets.length>0;
 const rowsPerChunk=tiles?first(tags,TAG.tileLength,height):first(tags,TAG.rowsPerStrip,height);
 const chunkRows=Math.max(1,Math.min(rowsPerChunk,height));
 const chunkBytes=tiles?rowBytes*chunkRows:rowBytes*Math.min(chunkRows,height);
 const hint=Math.max(chunkBytes,rowBytes);

 const raw=new Uint8Array(expected);
 let written=0;
 for(let i=0;i<offsets.length;i+=1){
  const offset=offsets[i];
  const length=lengths[i]||0;
  if(offset<=0||offset>=bytes.length)continue;
  const end=length>0?Math.min(offset+length,bytes.length):bytes.length;
  const chunk=bytes.subarray(offset,end);
  let plain;
  try{plain=await decompress(chunk,compression,hint);}
  catch(error){throw Error(`第 ${i+1} 个数据块解不开：${error.message}`);}
  // 多写一点没关系（最后一个 strip 可能短），但不能越界。
  const take=Math.min(plain.length,expected-written);
  raw.set(plain.subarray(0,Math.min(take,plain.length)),written);
  written+=Math.max(0,take);
  if(written>=expected)break;
 }
 if(written<expected){
  // 有些写入器把 StripByteCounts 写成 0，此时按剩余长度补齐即可，不当作损坏。
  if(written===0)throw Error('TIFF 数据块全是空的，文件可能已损坏');
 }

 if(predictor===2)undoPredictor(raw,width,height,samples,bits,planar,le);

 const planeRowBytes=width*bps;
 const sampleAt=(x,y,c)=>{
  const at=planar===2
   ?(c*height+y)*planeRowBytes+x*bps
   :y*rowBytes+(x*samples+c)*bps;
  if(bits===8)return raw[at];
  return le?(raw[at]|(raw[at+1]<<8)):((raw[at]<<8)|raw[at+1]);
 };
 const to8=bits===8?(v=>v):(v=>v>>8);

 const out=new Uint8ClampedArray(width*height*4);
 const colorMap=tags.get(TAG.colorMap)?.values||[];
 const paletteSize=1<<Math.min(bits,16);
 const hasAlpha=photometric===2?samples>=4:samples>=2&&photometric!==3;
 const extra=tags.get(TAG.extraSamples)?.values||[];
 const alphaChannel=extra.length?(samples-extra.length):(hasAlpha?samples-1:-1);

 for(let y=0;y<height;y+=1){
  for(let x=0;x<width;x+=1){
   const p=(y*width+x)*4;
   let r=0,g=0,b=0,a=255;
   if(photometric===0||photometric===1){
    const v=to8(sampleAt(x,y,0));
    // WhiteIsZero 是反的：0 表示白。直接当黑画会让扫描件整张反色。
    const gray=photometric===0?255-v:v;
    r=g=b=gray;
   }else if(photometric===2){
    r=to8(sampleAt(x,y,0));
    g=to8(sampleAt(x,y,1));
    b=to8(sampleAt(x,y,2));
   }else if(photometric===3){
    const index=Math.min(sampleAt(x,y,0),paletteSize-1);
    r=(colorMap[index]||0)>>8;
    g=(colorMap[paletteSize+index]||0)>>8;
    b=(colorMap[paletteSize*2+index]||0)>>8;
   }else if(photometric===5){
    const c=to8(sampleAt(x,y,0));
    const m=to8(sampleAt(x,y,1));
    const yy=to8(sampleAt(x,y,2));
    const k=to8(sampleAt(x,y,3));
    r=255-Math.min(255,c+k);
    g=255-Math.min(255,m+k);
    b=255-Math.min(255,yy+k);
   }else{
    throw Error(`暂不支持这种 TIFF 色彩模式（photometric=${photometric}）`);
   }
   if(alphaChannel>=0&&alphaChannel<samples)a=to8(sampleAt(x,y,alphaChannel));
   out[p]=r;out[p+1]=g;out[p+2]=b;out[p+3]=a;
  }
 }

 // 顺带数一下总页数：多页 TIFF 目前只画第一页，得让调用方能把这件事说清楚。
 let pages=1;
 let nextOffset=view.getUint32(readIFDOffset(view,le,view.getUint32(4,le)),le);
 while(nextOffset>8&&nextOffset<bytes.length&&pages<999){
  const next=readIFDOffset(view,le,nextOffset);
  if(!next)break;
  pages+=1;
  nextOffset=view.getUint32(next,le);
 }
 return {width,height,data:out,pages};
}

/** IFD 末尾那 4 字节指向下一个 IFD；读越界就返回 0。 */
function readIFDOffset(view,le,offset){
 if(offset+2>view.byteLength)return 0;
 const count=view.getUint16(offset,le);
 const at=offset+2+count*12;
 if(at+4>view.byteLength)return 0;
 return at;
}

export function isTiffLike(name){
 return /\.(tif|tiff)$/i.test(String(name||''));
}
