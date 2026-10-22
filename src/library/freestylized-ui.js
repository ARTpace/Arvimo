import {fetchCategories,fillOptions} from './category-options.js';

export function createFreestylizedUI({$,esc,toast,requestFeed}){
 function read(){return {q:$('#asset-query').value.trim().slice(0,200),type:$('#freestylized-type').value||'models',category:$('#freestylized-category').value};}
 function start(){return requestFeed('freestylized',read());}
 async function loadCategories(){
  const type=$('#freestylized-type').value||'models';
  try{
   const rows=await fetchCategories(`/api/freestylized/categories?type=${encodeURIComponent(type)}`);
   fillOptions($,'#freestylized-category',rows,'全部分类',esc);
  }catch(e){toast(e.message||'FreeStylized 分类加载失败');}
 }
 function setup(){
  $('#freestylized-type').onchange=()=>{loadCategories().then(start);};
  $('#freestylized-category').onchange=()=>start();
  loadCategories();
 }
 return {read,setup};
}
