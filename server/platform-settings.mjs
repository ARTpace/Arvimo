import {readFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {platformModules,PICTURE_SITES} from '../src/library/platforms.js';

export function createPlatformSettings(file){
 // 图站和 3D 平台共用一份设置：默认全开，关掉即禁止解析与整站下载。
 const defaults=Object.fromEntries([...platformModules(),...Object.values(PICTURE_SITES)].map(p=>[p.id,true]));
 let settings={...defaults};
 try{const saved=JSON.parse(readFileSync(file,'utf8'));for(const id of Object.keys(defaults))if(typeof saved[id]==='boolean')settings[id]=saved[id];}
 catch(error){if(error.code!=='ENOENT')throw error;}
 let saving=Promise.resolve();
 return {
  get:()=>({...settings}),
  enabled:id=>settings[id]!==false,
  save(input){
   if(!input||typeof input!=='object'||Array.isArray(input))throw Error('平台配置无效');
   for(const id of Object.keys(input))if(!Object.hasOwn(defaults,id)||typeof input[id]!=='boolean')throw Error('平台配置无效');
   const task=saving.then(async()=>{const next={...settings,...input};await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(next,null,2));await fs.rename(file+'.tmp',file);settings=next;return {...settings};});
   saving=task.catch(()=>{});return task;
  }
 };
}

export function platformForPath(pathname){
 if(pathname==='/api/search'||pathname==='/api/scan')return 'sketchfab';
 return /^\/api\/(artstation|polyhaven|ambientcg|polypizza|kenney|freestylized)(?:\/|$)/.exec(pathname)?.[1];
}
