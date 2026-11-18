import {createGltfPreview} from './gltf-preview.js';
const dialog=document.getElementById('preview-dialog');
dialog.setAttribute('open','');
const preview=createGltfPreview();
const observer=new ResizeObserver(()=>preview.resize());
observer.observe(document.body);
window.addEventListener('message',event=>{
 if(event.source!==window.parent||event.origin!==location.origin||event.data?.type!=='assetvault:model-preview')return;
 const {url,name}=event.data;
 if(typeof url!=='string'||typeof name!=='string')return;
 const source=new URL(url,location.href);
 if(!['http:','https:','blob:','data:'].includes(source.protocol))return;
 void preview.loadLocalModel({url:source.href,name});
});
window.addEventListener('pagehide',()=>{observer.disconnect();preview.close();},{once:true});
window.parent.postMessage({type:'assetvault:model-preview-ready'},location.origin);
