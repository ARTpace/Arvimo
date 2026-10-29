// ponytail: 原始压缩资源存浏览器磁盘缓存；内存只保留最近 24 MB，不转码、不降低画质。
export function createPreviewCache(fetchResource,{storage=globalThis.caches,maxMemoryBytes=24*1024*1024,maxDiskBytes=512*1024*1024,maxEntries=96,now=Date.now}={}){
 const memory=new Map(),pending=new Map();
 let memoryBytes=0,writes=Promise.resolve();
 const maxAge=7*24*60*60*1000;
 async function disk(){try{return await storage?.open('assetvault-preview-v1');}catch{return null;}}
 function remember(key,blob){
  if(memory.has(key)){memoryBytes-=memory.get(key).size;memory.delete(key);}
  if(blob.size>maxMemoryBytes)return;
  memory.set(key,blob);memoryBytes+=blob.size;
  while(memoryBytes>maxMemoryBytes||memory.size>maxEntries){
   const oldest=memory.keys().next().value;
   memoryBytes-=memory.get(oldest).size;memory.delete(oldest);
  }
 }
 function persist(cache,key,blob){
  // 写盘不挡首帧；串行维护容量，避免并行贴图写入互相淘汰。
  writes=writes.catch(()=>{}).then(async()=>{
   if(blob.size>maxDiskBytes)return;
   const entries=[];let total=0;
   for(const request of await cache.keys()){
    const response=await cache.match(request);
    const size=Number(response?.headers.get('x-assetvault-size'))||0;
    const saved=Number(response?.headers.get('x-assetvault-saved'))||0;
    if(request.url===key||now()-saved>maxAge){await cache.delete(request);continue;}
    total+=size;entries.push({request,size,saved});
   }
   entries.sort((a,b)=>a.saved-b.saved);
   while(entries.length&&(total+blob.size>maxDiskBytes||entries.length>=maxEntries)){
    const entry=entries.shift();await cache.delete(entry.request);total-=entry.size;
   }
   await cache.put(key,new Response(blob,{headers:{'x-assetvault-size':String(blob.size),'x-assetvault-saved':String(now())}}));
  }).catch(()=>{}); // 磁盘满、隐私模式或缓存不可用时仍然正常预览。
 }
 async function load(key){
  const cache=await disk();
  if(cache){
   try{
    await writes;
    const response=await cache.match(key);
    if(response&&now()-Number(response.headers.get('x-assetvault-saved'))<=maxAge){
     const blob=await response.blob();remember(key,blob);return blob;
    }
   }catch{}
  }
  const response=await fetchResource(key);
  if(!response.ok)throw Error(`代理请求失败 HTTP ${response.status}`);
  const blob=await response.blob();
  remember(key,blob);
  if(cache)persist(cache,key,blob);
  return blob;
 }
 return {
  get(key){
   if(memory.has(key)){
    const blob=memory.get(key);memory.delete(key);memory.set(key,blob);return Promise.resolve(blob);
   }
   if(!pending.has(key))pending.set(key,load(key).finally(()=>pending.delete(key)));
   return pending.get(key);
  },
  clearMemory(){memory.clear();memoryBytes=0;},
  // 用于退出前等待写盘及验证持久化，不要求正常预览等待。
  flush:()=>writes,
 };
}
