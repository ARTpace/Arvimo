import {readFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {platformModules,PICTURE_SITES} from '../src/library/platforms.js';

/**
 * 唯一的字符串型配置：Pixabay 视频要官方免费 API key。
 * 其余平台都是「开关」布尔值，校验逻辑保持严格 —— 只有这里点名放行字符串，
 * 免得一个手滑的字段把开关表写坏。
 */
const STRING_KEYS = Object.freeze(['pixabayKey']);

export function createPlatformSettings(file){
 // 图站和 3D 平台共用一份设置：默认全开，关掉即禁止解析与整站下载。
 const defaults={...Object.fromEntries([...platformModules(),...Object.values(PICTURE_SITES)].map(p=>[p.id,true])),pixabayKey:''};
 let settings={...defaults};
 try{
  const saved=JSON.parse(readFileSync(file,'utf8'));
  for(const id of Object.keys(defaults)){
   if(STRING_KEYS.includes(id)){if(typeof saved[id]==='string')settings[id]=saved[id];}
   else if(typeof saved[id]==='boolean')settings[id]=saved[id];
  }
 }
 catch(error){if(error.code!=='ENOENT')throw error;}
 const valid=(id,value)=>STRING_KEYS.includes(id)?typeof value==='string'&&value.length<=200:typeof value==='boolean';
 let saving=Promise.resolve();
 return {
  // 对外只暴露「有没有填」：key 明文不出本机服务端，前端也只需要知道该不该再提示。
  get:()=>{const {pixabayKey,...flags}=settings;return {...flags,pixabayKeySet:!!pixabayKey};},
  /** 解析时内部取用，不走 HTTP 返回体。 */
  pixabayKey:()=>String(settings.pixabayKey||''),
  enabled:id=>settings[id]!==false,
  save(input){
   if(!input||typeof input!=='object'||Array.isArray(input))throw Error('平台配置无效');
   for(const id of Object.keys(input))if(!Object.hasOwn(defaults,id)||!valid(id,input[id]))throw Error('平台配置无效');
   const task=saving.then(async()=>{const next={...settings,...input};await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(next,null,2));await fs.rename(file+'.tmp',file);settings=next;return {...settings};});
   saving=task.catch(()=>{});return task;
  }
 };
}

export function platformForPath(pathname){
 if(pathname==='/api/search'||pathname==='/api/scan')return 'sketchfab';
 return /^\/api\/(simready|artstation|polyhaven|ambientcg|polypizza|kenney|freestylized|polyfork|uiverse|fab)(?:\/|$)/.exec(pathname)?.[1];
}
