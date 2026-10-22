// Poly Haven sidebar: asset type (models / materials) plus official categories.
// Changing either control restarts the Poly Haven feed. Categories reload when the type changes
// because the two catalogs do not share a category list.
import {fetchCategories,fillOptions} from './category-options.js';

export function createPolyhavenUI({$,esc,toast,requestFeed}){
 const ui={categories:null};
 async function loadCategories(){
  const type=$('#polyhaven-type').value;
  const kind=type==='textures'||type==='hdris'?type:'models';
  try{
   const rows=await fetchCategories(`/api/polyhaven/categories?type=${kind}`);
   ui.categories=rows;
   fillOptions($,'#polyhaven-category',rows,'全部分类',esc);
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
