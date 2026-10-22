// ambientCG client: category sidebar + preview resolution helper.
//
// The categories are official facets served once per session (`/api/ambientcg/categories` — the
// server cuts them to materials and sorts by asset count). The download resolution is *not* here:
// it lives on each card's download button (card-view.js) because it is a per-asset choice, and the
// queue reads it off the model object when the task is enqueued.
import {esc} from './html-esc.js';
import {fetchCategories,fillOptions} from './category-options.js';

export function createAmbientcgUI({$,toast,requestFeed}){
 const ui={categories:null};
 async function loadCategories(){
  const type=$('#ambientcg-type').value;
  try{
   const rows=await fetchCategories(`/api/ambientcg/categories?type=${encodeURIComponent(type)}`);
   // 类型切换会重入：回来时类型已经不是发起时那个，就别把旧清单盖上去。
   if(type!==$('#ambientcg-type').value)return;
   ui.categories=rows;
   fillOptions($,'#ambientcg-category',rows,'全部分类',esc);
  }catch(e){toast(`ambientCG 分类加载失败，仍可按关键词搜索：${e.message}`);}
 }
 /** 搜索请求：关键词 + 侧栏分类。 */
 function read(){return {q:$('#asset-query').value.trim().slice(0,200),category:$('#ambientcg-category').value,type:$('#ambientcg-type').value};}
 function start(){return requestFeed('ambientcg',read());}
 function resetFilters(){$('#ambientcg-type').value='material';$('#ambientcg-category').value='';void loadCategories();return start();}
 function setup(){
  $('#ambientcg-category').onchange=()=>start();
  $('#ambientcg-type').onchange=()=>{$('#ambientcg-category').value='';void loadCategories();void start();};
  void loadCategories();
 }
 return Object.assign(ui,{setup,read,start,resetFilters,loadCategories});
}
