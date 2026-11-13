// Keep three.js off the startup path; callers retain the existing preview interface.
export function createLazyPreview({loadModule=()=>import('./gltf-preview.js'),onError=()=>{}}={}){
 let preview,pending,epoch=0;
 const ensure=()=>pending??=(loadModule().then(module=>preview=module.createGltfPreview()).catch(error=>{pending=null;throw error;}));
 const api={
  close(){epoch++;preview?.close();},
  resize(){preview?.resize();},
  canPreview:()=>true,
  polyforkLive:()=>preview?.polyforkLive()||false,
  setPolyforkColors:values=>preview?.setPolyforkColors(values),
  bakePolyfork:(...args)=>preview?.bakePolyfork(...args)??false,
  async fetchPolyforkParams(...args){return (await ensure()).fetchPolyforkParams(...args);},
 };
 for(const method of ['loadSimready','load','loadFreestylized','loadSubstance','loadLocalModel','loadLocalEnvironment','loadPolyfork']){
  api[method]=async(...args)=>{
   const token=++epoch;
   try{
    const ready=await ensure();
    if(token!==epoch)return false;
    return await ready[method](...args);
   }catch(error){if(token===epoch)onError(error);return false;}
  };
 }
 return api;
}
