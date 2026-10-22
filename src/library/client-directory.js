// Directory handles are scoped to this browser/origin; the host never receives the destination.
async function directoryStore(value){
 if(!globalThis.indexedDB)return null;
 const db=await new Promise((resolve,reject)=>{
  const request=indexedDB.open('assetvault-client-directory',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('directory');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
 });
 try{return await new Promise((resolve,reject)=>{
  const transaction=db.transaction('directory',value?'readwrite':'readonly'),store=transaction.objectStore('directory');
  const request=value?store.put(value,'selected'):store.get('selected');let result;
  request.onsuccess=()=>{result=request.result;};
  transaction.oncomplete=()=>resolve(result);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
 });}finally{db.close();}
}

export function createClientDirectory({picker=globalThis.showDirectoryPicker,secure=globalThis.isSecureContext,store=directoryStore}={}){
 let directory=null;
 return {
  supported:!!secure&&typeof picker==='function',
  get name(){return directory?.name||'';},
  async restore(){if(secure&&picker)directory=await store();},
  async choose(){
   if(!secure||!picker)throw Error('当前连接不能直接选择本地文件夹，请在浏览器下载设置中指定保存目录');
   const selected=await picker({id:'assetvault-downloads',mode:'readwrite'});
   // Keep the chosen directory usable even if this browser cannot persist handles.
   directory=selected;try{await store(selected);}catch{}
   return directory.name;
  },
  async save(blob,filename){
   if(!directory)return false;
   if(await directory.queryPermission({mode:'readwrite'})!=='granted')throw Error('本地目录需要重新授权，请点击保存目录旁的“更改”');
   const safeName=filename.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
   if(!safeName||safeName==='.'||safeName==='..')throw Error('资产文件名无效');
   let name=safeName;
   try{await directory.getFileHandle(name);name=safeName.replace(/\.zip$/i,'')+'-'+Date.now()+'.zip';}catch(error){if(error.name!=='NotFoundError')throw error;}
   const handle=await directory.getFileHandle(name,{create:true}),writable=await handle.createWritable();
   await blob.stream().pipeTo(writable);return true;
  }
 };
}
