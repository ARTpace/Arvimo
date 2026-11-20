import {inspectImage} from './archive.mjs';

export function inspectMedia(prefix,type,name,bytes){
 if(type==='image')return inspectImage(prefix,name,bytes);
 if(type==='audio'){
  if(bytes>=12&&prefix.toString('ascii',4,8)==='ftyp')return {format:'m4a',bytes};
  if(bytes>=4&&prefix.toString('ascii',0,4)==='fLaC')return {format:'flac',bytes};
  if(bytes>=12&&prefix.toString('ascii',0,4)==='RIFF'&&prefix.toString('ascii',8,12)==='WAVE')return {format:'wav',bytes};
  if(bytes>=4&&prefix.toString('ascii',0,4)==='OggS')return {format:'ogg',bytes};
  if(bytes>=3&&prefix.toString('ascii',0,3)==='ID3')return {format:'mp3',bytes};
  if(bytes>=4&&prefix[0]===255&&(prefix[1]&0xe0)===0xe0&&(prefix[1]&6)!==0&&(prefix[2]&0xf0)!==0xf0&&(prefix[2]&0xf0)!==0)return {format:'mp3',bytes};
  if(bytes>=7&&prefix[0]===255&&(prefix[1]&0xf6)===0xf0)return {format:'aac',bytes};
  throw Error('音频响应不是有效的音频文件（可能是登录页或错误页面）');
 }
 if(type!=='video')throw Error('不支持的媒体类型');
 if(bytes>=12&&prefix.toString('ascii',4,8)==='ftyp')return {format:'mp4',bytes};
 if(bytes>=4&&prefix.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return {format:'webm',bytes};
 throw Error('视频响应不是有效的 MP4/WebM（可能是登录页或错误页面）');
}
