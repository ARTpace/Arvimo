import path from 'node:path';
import {spawn} from 'node:child_process';

/** Explorer parses /select itself: quote the path, not the entire switch + path. */
export function fileManagerCommand(target,{isDir=false,platform=process.platform}={}) {
 if(typeof target!=='string'||!target||target.includes('\0'))throw Error('打开文件夹的路径无效');
 if(platform==='win32'){
  if(target.includes('"'))throw Error('打开文件夹的路径含有非法引号');
  const normalized=path.win32.normalize(target);
  return {app:'explorer.exe',args:isDir?[normalized]:[`/select,"${normalized}"`],options:{windowsHide:false,windowsVerbatimArguments:!isDir,stdio:'ignore'}};
 }
 return platform==='darwin'
  ?{app:'open',args:isDir?[target]:['-R',target],options:{stdio:'ignore'}}
  :{app:'xdg-open',args:[isDir?target:path.dirname(target)],options:{stdio:'ignore'}};
}
/** Await process creation so launch failures reach the caller; Explorer may exit nonzero on success. */
export async function revealInFileManager(target,{isDir=false,platform=process.platform,spawnImpl=spawn}={}) {
 const {app,args,options}=fileManagerCommand(target,{isDir,platform});
 await new Promise((resolve,reject)=>{
  let child;
  try{child=spawnImpl(app,args,options);}catch(error){reject(Error(`无法启动系统文件管理器：${error.message}`));return;}
  child.once('error',error=>reject(Error(`无法启动系统文件管理器：${error.message}`)));
  child.once('spawn',()=>{child.unref();resolve();});
 });
 return true;
}
