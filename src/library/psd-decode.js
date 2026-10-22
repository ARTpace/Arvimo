// PSD 解码：只取「合并图像」（composite），也就是 Photoshop 里看起来的那一张。
//
// 不解图层、不解智能对象——那是 psd.js 那种库的活儿，为了预览不值得。合并图像的数据就在
// 文件尾部的 image data 段里，平面排列（先所有红、再所有绿…），压缩只有 RAW 与 RLE 两种，
// 解出来直接就是成品画面。PSB（大文档）格式的偏移量是 8 字节，这里一并认。
//
// 输出 RGBA 字节，不碰 canvas：解码器要能在 Node 里被测试覆盖。

const MAX_PIXELS=80_000_000;

const readU16=(b,p)=>(b[p]<<8)|b[p+1];
const readU32=(b,p)=>((b[p]<<24)|(b[p+1]<<16)|(b[p+2]<<8)|b[p+3])>>>0;

function packBitsRow(src,start,len,out,outOffset,rowLen){
 let i=start;
 const end=start+len;
 let o=outOffset;
 while(i<end&&o<outOffset+rowLen){
  const n=(src[i]<<24)>>24;
  i+=1;
  if(n>=0){
   for(let k=0;k<=n&&i<end&&o<outOffset+rowLen;k+=1)out[o++]=src[i++];
  }else if(n!==-128){
   const value=src[i++];
   for(let k=0;k<1-n&&o<outOffset+rowLen;k+=1)out[o++]=value;
  }
 }
 return o-outOffset;
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{width:number,height:number,data:Uint8ClampedArray,layers:boolean,bitDepth:number}}
 */
export function decodePsd(input){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
 if(bytes.length<26)throw Error('文件太小，不是 PSD');
 const signature=String.fromCharCode(bytes[0],bytes[1],bytes[2],bytes[3]);
 if(signature!=='8BPS')throw Error('不是 PSD 文件（缺 8BPS 标记）');
 const psb=readU16(bytes,4)===2;

 const channels=readU16(bytes,12);
 const height=readU32(bytes,14);
 const width=readU32(bytes,18);
 const depth=readU16(bytes,22);
 const colorMode=readU16(bytes,24);
 if(!width||!height)throw Error('PSD 缺少尺寸信息');
 if(width*height>MAX_PIXELS)throw Error(`图太大（${width}×${height}），超过预览上限`);
 if(depth!==8&&depth!==16)throw Error(`暂不支持 ${depth} 位的 PSD`);
 if(channels<1||channels>56)throw Error(`PSD 通道数异常（${channels}）`);

 let at=26;
 const colorLen=readU32(bytes,at);at+=4;
 const colorData=bytes.subarray(at,Math.min(at+colorLen,bytes.length));at+=colorLen;
 if(at+4>bytes.length)throw Error('PSD 结构不完整');
 const resourceLen=readU32(bytes,at);at+=4+resourceLen;
 if(at+4>bytes.length)throw Error('PSD 结构不完整');
 const layerLen=readU32(bytes,at);at+=4+layerLen;
 if(at+2>bytes.length)throw Error('PSD 结构不完整');
 const compression=readU16(bytes,at);at+=2;
 const hasLayers=layerLen>0;

 const planeSize=width*height;
 const planes=[];
 const bytesPerSample=depth/8;
 const rowBytes=width*bytesPerSample;

 const planeBytes=planeSize*bytesPerSample;
 if(compression===0){
  const need=planeBytes*channels;
  if(bytes.length-at<need)throw Error('PSD 图像数据不完整，文件可能被截断');
  for(let c=0;c<channels;c+=1){
   const from=at+c*planeBytes;
   planes.push(bytes.subarray(from,from+planeBytes));
  }
 }else if(compression===1){
  const rowCounts=new Array(channels*height);
  let cursor=at;
  for(let i=0;i<rowCounts.length;i+=1){
   if(cursor+2>bytes.length)throw Error('PSD 行长度表被截断');
   rowCounts[i]=readU16(bytes,cursor);cursor+=2;
  }
  for(let c=0;c<channels;c+=1){
   const plane=new Uint8Array(planeBytes);
   for(let y=0;y<height;y+=1){
    const rowLen=rowCounts[c*height+y];
    if(rowLen===0xffff)continue;
    // RLE 一行解出来是 rowBytes：16 位时一行宽 2×width 字节，步长要按字节算。
    packBitsRow(bytes,cursor,rowLen,plane,y*rowBytes,rowBytes);
    cursor+=rowLen;
    if(cursor>bytes.length)throw Error('PSD 图像数据不完整，文件可能被截断');
   }
   planes.push(plane);
  }
 }else{
  throw Error(`不认识的 PSD 压缩方式 ${compression}`);
 }

 // 16 位只保留高字节：预览不需要 16 位精度，但需要正确的明暗关系。
 // 先整体降位一次再进合成循环——在像素循环里调降位函数会重复分配整张图。
 const down=plane=>{
  if(!plane)return null;
  if(bytesPerSample===1)return plane;
  const out=new Uint8Array(planeSize);
  for(let i=0;i<planeSize;i+=1)out[i]=plane[i*2];
  return out;
 };
 const get=idx=>down(planes[idx]);

 const out=new Uint8ClampedArray(planeSize*4);
 const alphaChannel=colorMode===3?(channels>=4?3:-1):((colorMode===1||colorMode===7)&&channels>=2?1:-1);
 const alphaPlane=alphaChannel>=0?get(alphaChannel):null;
 const alphaAt=i=>alphaPlane?alphaPlane[i]:255;

 if(colorMode===3){
  const r=get(0),g=get(1),b=get(2);
  for(let i=0;i<planeSize;i+=1){
   out[i*4]=r[i];out[i*4+1]=g[i];out[i*4+2]=b[i];out[i*4+3]=alphaAt(i);
  }
 }else if(colorMode===1||colorMode===7||colorMode===8){
  const gray=get(0);
  for(let i=0;i<planeSize;i+=1){
   out[i*4]=gray[i];out[i*4+1]=gray[i];out[i*4+2]=gray[i];out[i*4+3]=alphaAt(i);
  }
 }else if(colorMode===2){
  // 索引色：调色板就是色彩模式段的前 768 字节，每色 256 项。
  if(colorData.length<768)throw Error('索引色 PSD 缺少调色板');
  const index=get(0);
  for(let i=0;i<planeSize;i+=1){
   const v=index[i];
   out[i*4]=colorData[v];out[i*4+1]=colorData[256+v];out[i*4+2]=colorData[512+v];
   out[i*4+3]=255;
  }
 }else if(colorMode===4){
  // CMYK → RGB 用最常用的近似：r = 255 - min(255, c+k)。印刷校色不做，预览够用。
  const c=get(0),m=get(1),y=get(2),k=get(3);
  for(let i=0;i<planeSize;i+=1){
   out[i*4]=255-Math.min(255,c[i]+k[i]);
   out[i*4+1]=255-Math.min(255,m[i]+k[i]);
   out[i*4+2]=255-Math.min(255,y[i]+k[i]);
   out[i*4+3]=255;
  }
 }else{
  throw Error(`暂不支持这种 PSD 色彩模式（${colorMode}）`);
 }

 return {width,height,data:out,layers:hasLayers,bitDepth:depth};
}

export function isPsdLike(name){
 return /\.psd$/i.test(String(name||''));
}
