// ponytail: browser downloads choose the destination; no host folder setting is changed.
export function createBrowserDelivery({storage,download,defaultEnabled=false,forceEnabled=false,onError=()=>{}}){
 const key='assetvault-browser-delivery';
 let state={enabled:defaultEnabled,pending:[]};
 try{const saved=JSON.parse(storage.getItem(key));if(saved)state={enabled:saved.enabled===true,pending:Array.isArray(saved.pending)?saved.pending.filter(id=>typeof id==='string'):[]};}catch{}
 if(forceEnabled)state.enabled=true;
 const save=()=>{try{storage.setItem(key,JSON.stringify(state));}catch{}};
 let busy=false;const failed=new Set();
 return {
  get enabled(){return state.enabled;},
  setEnabled(enabled){state.enabled=forceEnabled||enabled;if(!state.enabled)state.pending=[];save();},
  track(ids){if(state.enabled){state.pending=[...new Set([...state.pending,...ids])];save();}},
  async accept(jobs){
   if(!state.enabled||busy)return;
   // One per poll; only jobs submitted by this browser are automatically retrieved.
   const job=jobs.find(job=>state.pending.includes(job.id)&&!failed.has(job.id)&&job.state==='saved'&&job.fileExists);
   if(!job)return;
   busy=true;
   try{await download(job.id);state.pending=state.pending.filter(id=>id!==job.id);save();}
   catch(error){failed.add(job.id);onError(error);}
   finally{busy=false;}
  }
 };
}

export async function fetchBrowserAsset(id,{fetch:request=globalThis.fetch}={}){
 const response=await request(`/api/downloads/tasks/${id}/file`,{credentials:'same-origin',cache:'no-store'});
 if(!response.ok||!response.headers.get('content-type')?.includes('application/zip')){
  const data=await response.json().catch(()=>({}));throw Error(data.error||`资产下载失败（HTTP ${response.status}），请检查登录状态`);
 }
 const blob=await response.blob();
 if(new DataView(await blob.slice(0,4).arrayBuffer()).getUint32(0,true)!==0x04034b50)throw Error('服务器没有返回有效 ZIP 文件');
 const encoded=/filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition')||'')?.[1];
 return {blob,filename:encoded?decodeURIComponent(encoded):'asset.zip'};
}
