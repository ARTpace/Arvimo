import {loadLibrary,saveLibrary,collectModels} from './library-state.js';
const keys=['sfx-library-v2','sfx-discovery-v1','sfx-library-ui'];
export async function createPersistentStorage(local,request=fetch){
 const response=await request('/api/library-state',{headers:{'X-SFX-Local':'1'}});
 if(!response.ok)throw Error('无法读取持久资产库，请检查本地服务');
 const {values={},recovered=[]}=await response.json();
 const cache={};
 for(const key of keys)cache[key]=values[key]??local?.getItem(key)??null;
 let pending=Promise.resolve();
 const storage={getItem:key=>cache[key]??local?.getItem(key)??null,setItem(key,value){
  cache[key]=String(value);try{local?.setItem(key,value);}catch{}
  if(keys.includes(key))pending=pending.catch(()=>{}).then(async()=>{
   const result=await request('/api/library-state',{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify({[key]:String(value)}),keepalive:false});
   if(!result.ok)throw Error('资产库保存失败');
  }).catch(error=>{window.dispatchEvent(new CustomEvent('assetvault:storage-error',{detail:error.message}));});
 }};
 // Restore actual downloads only on first migration; later removals must stay removed.
 if(!values['sfx-library-v2']){
  const state=loadLibrary(storage);state.models=collectModels(state.models,recovered).models;
  saveLibrary(storage,state);await pending;
 }
 return storage;
}
