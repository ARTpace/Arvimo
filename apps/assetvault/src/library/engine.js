import { downloadModel } from '../../vendor/upstream-src/lib/pipeline.js';
const nativeFetch=globalThis.fetch.bind(globalThis);
let activeSignal=null,installed=false;
function installProxy(){
  if(installed)return;installed=true;
  globalThis.fetch=async(input,init={})=>{
    const value=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    const url=new URL(value,location.href);
    if(url.origin===location.origin||['blob:','data:'].includes(url.protocol))return nativeFetch(input,init);
    if(url.protocol!=='https:'||!/^(?:[a-z0-9-]+\.)*sketchfab\.com$/i.test(url.hostname))throw new Error('导出引擎请求了未允许的外部域名');
    if((init.method||'GET').toUpperCase()!=='GET')throw new Error('导出代理仅支持读取模型资源');
    const response=await nativeFetch(`/api/proxy?url=${encodeURIComponent(url.href)}`,{headers:{'X-SFX-Local':'1'},signal:activeSignal||init.signal});
    return response;
  };
}
/** Same browser pipeline as the userscript; no vendor modifications or invented downloads. */
export async function exportModel(url,options,onLog,signal){
  if(activeSignal)throw new Error('已有导出任务正在运行');
  installProxy();activeSignal=signal;
  try {
    signal?.throwIfAborted();
    globalThis.__sfxFastZipBytes=options.fastZip?1048576:0;
    globalThis.__sfxPngOnly=options.pngOnly!==false;
    const result=await downloadModel(url,message=>{onLog(String(message));},options);
    signal?.throwIfAborted();
    if(!result.hasGlb)throw new Error('转换未生成 GLB，未将不完整的结果标为下载成功。请查看任务日志。');
    return result;
  }finally{activeSignal=null;}
}
