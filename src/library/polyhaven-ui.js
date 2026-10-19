// Poly Haven sidebar: asset type (models / materials) plus official categories.
// Changing either control restarts the Poly Haven feed. Categories reload when the type changes
// because the two catalogs do not share a category list.
import {esc} from './html-esc.js';

export function createPolyhavenUI({$,toast,requestFeed}){
 const ui={categories:null};
 async function loadCategories(){
  const type=$('#polyhaven-type').value;
  const kind=type==='textures'||type==='hdris'?type:'models';
  try{
   const r=await fetch(`/api/polyhaven/categories?type=${kind}`,{cache:'no-store',headers:{'X-SFX-Local':'1'}});
   const data=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(data.error||`Poly Haven 分类请求失败 HTTP ${r.status}`);
   ui.categories=Array.isArray(data.categories)?data.categories:[];
   const keep=$('#polyhaven-category').dataset.keep||$('#polyhaven-category').value;
   $('#polyhaven-category').innerHTML=['<option value="">全部分类</option>',...ui.categories.map(c=>`<option value="${esc(c.value)}">${esc(c.label)}${c.count?` · ${c.count}`:''}</option>`)].join('');
   if([...$('#polyhaven-category').options].some(o=>o.value===keep))$('#polyhaven-category').value=keep;
   else $('#polyhaven-category').value='';
   delete $('#polyhaven-category').dataset.keep;
  }catch(e){toast(`Poly Haven 分类加载失败，仍可按关键词搜索：${e.message}`);}
 }
 function read(){
  return {
   q:$('#asset-query').value.trim().slice(0,200),
   type:$('#polyhaven-type').value==='textures'?'textures':$('#polyhaven-type').value==='hdris'?'hdris':'models',
   category:$('#polyhaven-category').value,
  };
 }
 function start(){return requestFeed('polyhaven',read());}
 function setup(){
  $('#polyhaven-type').onchange=async()=>{$('#polyhaven-category').value='';await loadCategories();return start();};
  $('#polyhaven-category').onchange=()=>start();
  void loadCategories();
 }
 return Object.assign(ui,{setup,read,start,loadCategories});
}
