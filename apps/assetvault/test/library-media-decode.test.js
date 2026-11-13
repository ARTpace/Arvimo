import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {decodeTiff} from '../src/library/tiff-decode.js';
import {decodePsd} from '../src/library/psd-decode.js';
import {transcodePlan,ffmpegArgs,BROWSER_VIDEO_EXT,findFfmpeg,probeMedia} from '../server/video-transcode.mjs';

// ---- 构造器：测试自己造 TIFF / PSD，不往仓库里塞二进制 ----

function writeTiff({width,height,samples=3,bits=8,photometric=2,pixels,compression=1,predictor=1,extraTags=[]}){
 const bps=bits/8;
 const raw=pixels;
 const strip=compression===32773?packBitsEncode(raw):raw;
 const bitsValues=new Array(samples).fill(bits);
 const tags=[
  [256,4,[width]],
  [257,4,[height]],
  [258,3,bitsValues],
  [259,3,[compression]],
  [262,3,[photometric]],
  [273,4,[0]],           // strip offset，稍后回填
  [277,3,[samples]],
  [278,4,[height]],
  [279,4,[strip.length]],
  [284,3,[1]],
  [317,3,[predictor]],
  ...extraTags,
 ].sort((a,b)=>a[0]-b[0]);

 const typeSize={3:2,4:4};
 const ifdOffset=8+strip.length+(strip.length%2);
 // 先把超过 4 字节的值（比如 BitsPerSample 数组）排到 IFD 之后
 let overflow=ifdOffset+2+tags.length*12+4;
 const overflows=[];
 const entries=tags.map(([tag,type,values])=>{
  const size=typeSize[type];
  const total=size*values.length;
  if(total<=4){
   const buf=Buffer.alloc(4);
   values.forEach((value,index)=>type===3?buf.writeUInt16LE(value,index*2):buf.writeUInt32LE(value,index*4));
   return {tag,type,count:values.length,value:buf};
  }
  const buf=Buffer.alloc(total);
  values.forEach((value,index)=>type===3?buf.writeUInt16LE(value,index*2):buf.writeUInt32LE(value,index*4));
  overflows.push({offset:overflow,buf});
  overflow+=total;
  const entry={tag,type,count:values.length,value:Buffer.alloc(4)};
  entry.value.writeUInt32LE(overflows[overflows.length-1].offset,0);
  return entry;
 });
 // strip offset 指向 8
 for(const entry of entries)if(entry.tag===273)entry.value.writeUInt32LE(8,0);

 const head=Buffer.alloc(8);
 head.write('II',0,'latin1');
 head.writeUInt16LE(42,2);
 head.writeUInt32LE(ifdOffset,4);

 const ifd=Buffer.alloc(2+entries.length*12+4);
 ifd.writeUInt16LE(entries.length,0);
 entries.forEach((entry,index)=>{
  const at=2+index*12;
  ifd.writeUInt16LE(entry.tag,at);
  ifd.writeUInt16LE(entry.type,at+2);
  ifd.writeUInt32LE(entry.count,at+4);
  entry.value.copy(ifd,at+8);
 });
 ifd.writeUInt32LE(0,2+entries.length*12);

 const parts=[head,strip];
 if(strip.length%2)parts.push(Buffer.alloc(1));
 parts.push(ifd);
 for(const item of overflows)parts.push(item.buf);
 return Buffer.concat(parts);
}

function packBitsEncode(input){
 const out=[];
 let i=0;
 while(i<input.length){
  let run=1;
  while(i+run<input.length&&input[i+run]===input[i]&&run<128)run+=1;
  if(run>=3){
   out.push(256-(run-1),input[i]);
   i+=run;
   continue;
  }
  const start=i;
  while(i<input.length&&i-start<128&&!(i+2<input.length&&input[i]===input[i+1]&&input[i+1]===input[i+2]))i+=1;
  if(i===start)i+=1;
  const length=i-start;
  out.push(length-1,...input.subarray(start,i));
 }
 return Buffer.from(out);
}

/** TIFF LZW 编码器：编码器的切宽条件是 free_ent > maxcode，比解码器晚一个码——这个差一码正是格式本身的约定。 */
function lzwEncode(input){
 const out=[];
 let bitBuf=0;
 let bitCount=0;
 let codeWidth=9;
 const emit=code=>{
  bitBuf=(bitBuf<<codeWidth)|code;
  bitCount+=codeWidth;
  while(bitCount>=8){
   out.push((bitBuf>>(bitCount-8))&255);
   bitCount-=8;
  }
  bitBuf&=(1<<bitCount)-1;
 };
 let dict=new Map();
 let next=258;
 const resetDict=()=>{dict=new Map();next=258;codeWidth=9;};
 emit(256);
 resetDict();
 let prefix=-1;
 for(const byte of input){
  if(prefix<0){prefix=byte;continue;}
  const key=prefix*256+byte;
  if(dict.has(key)){prefix=dict.get(key);continue;}
  emit(prefix);
  if(next<4096){
   dict.set(key,next);
   next+=1;
   if(next>(1<<codeWidth)-1&&codeWidth<12)codeWidth+=1;
  }else{
   emit(256);
   resetDict();
  }
  prefix=byte;
 }
 if(prefix>=0)emit(prefix);
 emit(257);
 if(bitCount>0)out.push((bitBuf<<(8-bitCount))&255);
 return Buffer.from(out);
}

const gradient=(width,height)=>{
 const px=new Uint8Array(width*height*3);
 for(let y=0;y<height;y+=1){
  for(let x=0;x<width;x+=1){
   const at=(y*width+x)*3;
   px[at]=(x*255)/(width-1)||0;
   px[at+1]=(y*255)/(height-1)||0;
   px[at+2]=(x*7+y*13)%256;
  }
 }
 return px;
};

const rgbaToRgb=({width,height,data})=>{
 const out=new Uint8Array(width*height*3);
 for(let i=0;i<width*height;i+=1){
  out[i*3]=data[i*4];out[i*3+1]=data[i*4+1];out[i*3+2]=data[i*4+2];
 }
 return out;
};

// ---- TIFF ----

test('未压缩 TIFF 逐像素还原',async()=>{
 const width=13,height=7;
 const pixels=gradient(width,height);
 const file=writeTiff({width,height,pixels});
 const decoded=await decodeTiff(file);
 assert.equal(decoded.width,width);
 assert.equal(decoded.height,height);
 assert.deepEqual([...rgbaToRgb(decoded)],[...pixels]);
});

test('PackBits TIFF 逐像素还原',async()=>{
 const width=21,height=9;
 const pixels=gradient(width,height);
 // 掺一段大色块，让 PackBits 真的有游程可压
 for(let x=0;x<width;x+=1)for(let c=0;c<3;c+=1)pixels[(3*width+x)*3+c]=90;
 const file=writeTiff({width,height,pixels,compression:32773});
 const decoded=await decodeTiff(file);
 assert.deepEqual([...rgbaToRgb(decoded)],[...pixels]);
});

test('LZW TIFF 要跨过 9→10 位那一次切宽',async()=>{
 // 40×30×3 = 3600 字节，码数远超 511：位宽切换时机写错会从这里开始整段错位。
 const width=40,height=30;
 const pixels=gradient(width,height);
 const strip=lzwEncode(pixels);
 assert.ok(pixels.length>1600,`样本太小，触不到切宽：${pixels.length}`);
 const tags=[
  [256,4,[width]],[257,4,[height]],[258,3,[8,8,8]],[259,3,[5]],[262,3,[2]],
  [273,4,[8]],[277,3,[3]],[278,4,[height]],[279,4,[strip.length]],[284,3,[1]],
 ].sort((a,b)=>a[0]-b[0]);
 const ifdOffset=8+strip.length+(strip.length%2);
 let overflow=ifdOffset+2+tags.length*12+4;
 const overflows=[];
 const entries=tags.map(([tag,type,values])=>{
  const total=type===3?2*values.length:4*values.length;
  if(total<=4){
   const buf=Buffer.alloc(4);
   values.forEach((value,index)=>type===3?buf.writeUInt16LE(value,index*2):buf.writeUInt32LE(value,index*4));
   return {tag,type,count:values.length,value:buf};
  }
  const buf=Buffer.alloc(total);
  values.forEach((value,index)=>type===3?buf.writeUInt16LE(value,index*2):buf.writeUInt32LE(value,index*4));
  overflows.push({offset:overflow,buf});overflow+=total;
  const entry={tag,type,count:values.length,value:Buffer.alloc(4)};
  entry.value.writeUInt32LE(overflows[overflows.length-1].offset,0);
  return entry;
 });
 const head=Buffer.alloc(8);
 head.write('II',0,'latin1');head.writeUInt16LE(42,2);head.writeUInt32LE(ifdOffset,4);
 const ifd=Buffer.alloc(2+entries.length*12+4);
 ifd.writeUInt16LE(entries.length,0);
 entries.forEach((entry,index)=>{
  const at=2+index*12;
  ifd.writeUInt16LE(entry.tag,at);ifd.writeUInt16LE(entry.type,at+2);
  ifd.writeUInt32LE(entry.count,at+4);entry.value.copy(ifd,at+8);
 });
 ifd.writeUInt32LE(0,2+entries.length*12);
 const parts=[head,strip];
 if(strip.length%2)parts.push(Buffer.alloc(1));
 parts.push(ifd);
 for(const item of overflows)parts.push(item.buf);
 const decoded=await decodeTiff(Buffer.concat(parts));
 assert.deepEqual([...rgbaToRgb(decoded)],[...pixels]);
});

test('16 位灰阶 TIFF 取高字节，WhiteIsZero 要反相',async()=>{
 const width=6,height=4;
 const samples=new Uint8Array(width*height*2);
 for(let i=0;i<width*height;i+=1){
  const value=i*3000;
  // 构造器写的是 II（小端）文件，16 位样本必须低字节在前，否则解出来是字节互换的结果。
  samples[i*2]=value&255;
  samples[i*2+1]=value>>8;
 }
 const normal=await decodeTiff(writeTiff({width,height,samples:1,bits:16,photometric:1,pixels:samples}));
 assert.equal(normal.data[0],0);
 assert.equal(normal.data[4],Math.min(255,(3000>>8)));
 // WhiteIsZero：0 表示白，画成黑就是反色，扫描件最容易踩这个。
 const inverted=await decodeTiff(writeTiff({width,height,samples:1,bits:16,photometric:0,pixels:samples}));
 assert.equal(inverted.data[0],255);
});

test('不是 TIFF / 缺尺寸时报错而不是画出一团黑',async()=>{
 await assert.rejects(()=>decodeTiff(Buffer.from('not a tiff at all')),/不是 TIFF/);
 await assert.rejects(()=>decodeTiff(new Uint8Array([0x49,0x49,0x2a,0x00,0x08,0x00,0x00,0x00])),/目录|尺寸/);
});

// ---- PSD ----

function writePsd({width,height,planes,depth=8,colorMode=3,compression=0}){
 const header=Buffer.alloc(26);
 header.write('8BPS',0,'latin1');
 header.writeUInt16BE(1,4);
 header.writeUInt16BE(planes.length,12);
 header.writeUInt32BE(height,14);
 header.writeUInt32BE(width,18);
 header.writeUInt16BE(depth,22);
 header.writeUInt16BE(colorMode,24);
 const zero=Buffer.alloc(4);
 if(compression===0){
  const body=Buffer.concat([Buffer.from([0,0]),...planes.map(plane=>Buffer.from(plane))]);
  return Buffer.concat([header,zero,zero,zero,body]);
 }
 const rows=[];
 const counts=[];
 for(const plane of planes){
  for(let y=0;y<height;y+=1){
   const row=packBitsEncode(plane.subarray(y*width,(y+1)*width));
   rows.push(row);
   counts.push(row.length);
  }
 }
 const countBuf=Buffer.alloc(counts.length*2);
 counts.forEach((value,index)=>countBuf.writeUInt16BE(value,index*2));
 return Buffer.concat([header,zero,zero,zero,Buffer.from([0,1]),countBuf,...rows]);
}

test('PSD 合并图像：RAW 与 RLE 都要还原成同一张图',()=>{
 const width=11,height=5;
 const count=width*height;
 const r=new Uint8Array(count),g=new Uint8Array(count),b=new Uint8Array(count);
 for(let i=0;i<count;i+=1){r[i]=(i*7)%256;g[i]=(i*3)%256;b[i]=(255-i)%256;}
 for(const compression of [0,1]){
  const decoded=decodePsd(writePsd({width,height,planes:[r,g,b],compression}));
  assert.equal(decoded.width,width);
  assert.equal(decoded.height,height);
  for(let i=0;i<count;i+=1){
   assert.equal(decoded.data[i*4],r[i],`R @${i}`);
   assert.equal(decoded.data[i*4+1],g[i],`G @${i}`);
   assert.equal(decoded.data[i*4+2],b[i],`B @${i}`);
   assert.equal(decoded.data[i*4+3],255);
  }
 }
});

test('PSD 灰度带 alpha：第四通道是透明度不是颜色',()=>{
 const width=4,height=2;
 const gray=Uint8Array.from([0,40,80,120,160,200,240,255]);
 const alpha=Uint8Array.from([255,200,150,100,50,25,10,0]);
 const decoded=decodePsd(writePsd({width,height,planes:[gray,alpha],colorMode:1}));
 assert.equal(decoded.data[0],0);
 assert.equal(decoded.data[3],255);
 assert.equal(decoded.data[7*4+3],0);
});

test('PSD 缺少 8BPS 标记时报错',()=>{
 assert.throws(()=>decodePsd(Buffer.from('this is not a psd file at all')),/不是 PSD/);
});

// ---- 视频转封装决策 ----

test('能拷流就不重编码，只有编码不被浏览器接受才转',()=>{
 assert.equal(transcodePlan({video:{codec_name:'h264',pix_fmt:'yuv420p'},audio:null}).copy,true);
 assert.equal(transcodePlan({video:{codec_name:'h264',pix_fmt:'yuv420p'},audio:{codec_name:'aac'}}).copy,true);
 assert.equal(transcodePlan({video:{codec_name:'hevc',pix_fmt:'yuv420p'},audio:null}).copy,false);
 assert.equal(transcodePlan({video:{codec_name:'prores',pix_fmt:'yuv422p10le'},audio:null}).copy,false);
 // 容器换了、视频能拷，但音频是 pcm：只转音频也走重编码分支，不能硬拷
 assert.equal(transcodePlan({video:{codec_name:'h264',pix_fmt:'yuv420p'},audio:{codec_name:'pcm_s16le'}}).copy,false);
 assert.equal(transcodePlan(null).copy,false);
 assert.equal(transcodePlan({video:null}).reason,'no-video');
});

test('重编码时的参数收敛到浏览器认的 h264/yuv420p',()=>{
 const copy=ffmpegArgs('a.mkv',{copy:true}).join(' ');
 assert.match(copy,/-c copy/);
 const reencode=ffmpegArgs('a.avi',{copy:false}).join(' ');
 assert.match(reencode,/libx264/);
 assert.match(reencode,/-pix_fmt yuv420p/);
 assert.match(reencode,/-c:a aac/);
 // fMP4：不落临时文件、不用等收尾就能边生成边播
 for(const args of [copy,reencode])assert.match(args,/frag_keyframe\+empty_moov/);
 assert.equal(BROWSER_VIDEO_EXT.test('a.mp4'),true);
 assert.equal(BROWSER_VIDEO_EXT.test('a.mkv'),false);
 assert.equal(BROWSER_VIDEO_EXT.test('a.mov'),false);
});

test('ffmpeg 探测不会把「没装」当成「装了」',()=>{
 const found=findFfmpeg();
 assert.ok(found===null||typeof found==='string','findFfmpeg 只该返回路径或 null');
 if(found)assert.ok(probeMedia(found,'definitely-not-here.xyz')===null,'读不到文件时 probeMedia 要返回 null 而不是抛错');
});

test('前端与路由把新增格式接进了同一条链路',async()=>{
 const local=await fs.readFile(new URL('../src/library/local-files.js',import.meta.url),'utf8');
 assert.ok(local.includes('decodeTiff'),'图片分支缺 TIFF 解码');
 assert.ok(local.includes('decodePsd'),'图片分支缺 PSD 解码');
 assert.ok(local.includes('playUrl'),'视频分支缺转封装地址');
 assert.ok(!local.includes('需要用播放器打开或先转成 MP4'),'旧的「放不了请自己转」提示要换掉');
 const server=await fs.readFile(new URL('../server/library.mjs',import.meta.url),'utf8');
 assert.ok(server.includes("'/api/local/play'"),'缺转封装路由');
 assert.ok(server.includes('streamMp4'),'路由要真的把流转出去');
});
