// 视频转封装：浏览器认的容器（mp4/webm/m4v/ogv）直接走文件流，其余的（mov/avi/wmv/mkv）
// 交给 ffmpeg 边转边发。
//
// 策略是「能拷就拷」：容器换了、编码没换时 `-c copy` 是把码流重新打包，速度接近拷贝；
// 只有编码本身也不被浏览器接受（hevc / prores / wmv3 / mpeg2…）才真正重编码。
// 判断依据是 ffprobe，不是扩展名——.mov 里装 h264 的比装 prores 的多得多，
// 按扩展名一刀切会让本来能秒开的东西去跑一遍 libx264。
import {FORMATS} from '../src/library/format-registry.js';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
let cached;

/** 找 ffmpeg：先看环境变量，再看随包带的 vendor 目录，最后交给 PATH。结果缓存，探测只做一次。 */
export function findFfmpeg(){
 if(cached!==undefined)return cached;
 cached=null;
 const exe=process.platform==='win32'?'ffmpeg.exe':'ffmpeg';
 const bundled=path.join(HERE,'..','vendor','ffmpeg','bin',exe);
 const candidates=[process.env.SFX_FFMPEG,bundled,exe];
 for(const candidate of candidates){
  if(!candidate)continue;
  if(candidate!==exe&&!existsSync(candidate))continue;
  try{
   const result=spawnSync(candidate,['-version'],{windowsHide:true,timeout:8000,stdio:'ignore'});
   if(result.status===0){cached=candidate;break;}
  }catch{}
 }
 return cached;
}

function ffprobeFor(ffmpeg){
 const name=process.platform==='win32'?'ffprobe.exe':'ffprobe';
 if(!path.isAbsolute(ffmpeg))return name;
 const beside=path.join(path.dirname(ffmpeg),name);
 return existsSync(beside)?beside:name;
}

/** 读出首个视频流与首个音频流的编码信息；读不到就返回 null（交给调用方按「未知」处理）。 */
export function probeMedia(ffmpeg,file){
 const result=spawnSync(ffprobeFor(ffmpeg),['-v','error','-show_entries','stream=codec_type,codec_name,pix_fmt','-of','json',file],{windowsHide:true,timeout:15000,encoding:'utf8',maxBuffer:1<<20});
 if(result.status!==0||!result.stdout)return null;
 try{
  const streams=JSON.parse(result.stdout).streams||[];
  return {
   video:streams.find(stream=>stream.codec_type==='video')||null,
   audio:streams.find(stream=>stream.codec_type==='audio')||null,
  };
 }catch{return null;}
}

// 浏览器原生能解的编码。h264 是唯一所有主流浏览器都认的；vp8/vp9 在 webm 里认，
// 但放进 mp4 又不认了，所以统一按输出容器 mp4 来判。
const SAFE_VIDEO=new Set(['h264']);
const SAFE_PIX_FMT=new Set(['yuv420p','yuvj420p','yuv422p','yuv444p','nv12']);
const SAFE_AUDIO=new Set(['aac','mp3']);

/**
 * 决定是直接拷流还是重编码。
 * 没有音轨时不该因为「音频编码不认识」去做一次全片重编码——那样纯属白烧 CPU。
 */
export function transcodePlan(probe){
 if(!probe||!probe.video)return {copy:false,reason:'no-video'};
 const video=probe.video;
 const audio=probe.audio;
 const videoOk=SAFE_VIDEO.has(video.codec_name)&&(!video.pix_fmt||SAFE_PIX_FMT.has(video.pix_fmt));
 const audioOk=!audio||SAFE_AUDIO.has(audio.codec_name);
 if(videoOk&&audioOk)return {copy:true};
 return {copy:false,videoCodec:video.codec_name||null,audioCodec:audio?.codec_name||null};
}

export function ffmpegArgs(file,plan){
 const args=['-hide_banner','-loglevel','error','-nostdin','-i',file];
 if(plan.copy)args.push('-c','copy');
 else args.push('-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k');
 // fMP4：不落临时文件、不等收尾就能边生成边播。代价是拿不到 Content-Length，
 // 进度条只能在已缓冲范围内拖——对预览来说这个取舍是划算的。
 args.push('-movflags','frag_keyframe+empty_moov+default_base_moof','-f','mp4','pipe:1');
 return args;
}

/**
 * 把转好的 mp4 流式写进响应。
 * 关键顺序：先等 ffmpeg 真的吐出第一块数据，再写 200 头——否则 ffmpeg 立刻失败时，
 * 前端收到的会是一个「200 但空」的视频，比明确报错难排查得多。
 */
export function streamMp4({res,file,ffmpeg,plan}){
 return new Promise(resolve=>{
  const child=spawn(ffmpeg,ffmpegArgs(file,plan),{windowsHide:true});
  let started=false;
  let settled=false;
  let stderr='';
  const finish=(status,message)=>{
   if(settled)return;
   settled=true;
   clearTimeout(timer);
   try{child.kill();}catch{}
   if(!res.headersSent){
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
   }
   if(!res.writableEnded)res.end(message?JSON.stringify({error:message}):undefined);
   resolve();
  };
  const timer=setTimeout(()=>{if(!started)finish(504,'ffmpeg 20 秒没有输出数据');},20000);

  child.stdout.once('data',first=>{
   // 先暂停：从 once('data') 到 pipe 接管之间流是 flowing 状态，不暂停会丢掉后续块。
   child.stdout.pause();
   started=true;
   clearTimeout(timer);
   res.writeHead(200,{
    'Content-Type':'video/mp4',
    'Cache-Control':'no-store',
    'X-Sfx-Transcode':plan.copy?'remux':'reencode',
   });
   res.write(first);
   child.stdout.pipe(res);
   child.stdout.resume();
  });
  child.stderr.on('data',chunk=>{if(stderr.length<4000)stderr+=chunk.toString();});
  child.on('error',error=>finish(500,`启动 ffmpeg 失败：${error.message}`));
  child.on('close',()=>{
   if(!started){
    const last=stderr.split('\n').map(line=>line.trim()).filter(Boolean).slice(-1)[0];
    finish(500,`ffmpeg 没能输出视频${last?`：${last}`:''}`);
    return;
   }
   if(settled)return;
   settled=true;
   clearTimeout(timer);
   if(!res.writableEnded)res.end();
   resolve();
  });
  res.on('close',()=>{
   if(settled)return;
   settled=true;
   clearTimeout(timer);
   try{child.kill();}catch{}
   resolve();
  });
 });
}

/** 浏览器自己就能播的容器：从格式注册表 preview:'video-native' 派生，不再手写第二份清单。
 *  编码不一定认（mp4 里装 hevc 很常见），所以前端失败时还会回退一次。 */
const NATIVE_VIDEO_EXTS=Object.values(FORMATS).filter(item=>item.preview==='video-native').map(item=>item.ext);
export const BROWSER_VIDEO_EXT=new RegExp(`\\.(${NATIVE_VIDEO_EXTS.join('|')})$`,'i');
