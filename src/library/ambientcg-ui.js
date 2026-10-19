// ambientCG client: category sidebar + preview resolution helper.
//
// The categories are official facets served once per session (`/api/ambientcg/categories` — the
// server cuts them to materials and sorts by asset count). The download resolution is *not* here:
// it lives on each card's download button (card-view.js) because it is a per-asset choice, and the
// queue reads it off the model object when the task is enqueued.
import {esc} from './html-esc.js';

export function createAmbientcgUI({$,toast,requestFeed}){
 const ui={categories:null};
 async function api(route){
  const r=await fetch(`/api/ambientcg${route}`,{cache:'no-store',headers:{'X-SFX-Local':'1'}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.error||`ambientCG 服务请求失败 HTTP ${r.status}`);
  return data;
 }
 async function loadCategories(){
  try{
   const data=await api('/categories');
   ui.categories=Array.isArray(data.categories)?data.categories:[];
   const keep=$('#ambientcg-category').dataset.keep||$('#ambientcg-category').value;
   $('#ambientcg-category').innerHTML=['<option value="">全部分类</option>',...ui.categories.map(c=>`<option value="${esc(c.value)}">${esc(c.label)}${c.count?` · ${c.count}`:''}</option>`)].join('');
   // 分类清单是静态 facets：恢复用户本次会话里已选中的那一项（还在清单里才恢复）。
   if([...$('#ambientcg-category').options].some(o=>o.value===keep))$('#ambientcg-category').value=keep;
   delete $('#ambientcg-category').dataset.keep;
  }catch(e){toast(`ambientCG 分类加载失败，仍可按关键词搜索：${e.message}`);}
 }
 /** 搜索请求：关键词 + 侧栏分类。 */
 function read(){return {q:$('#asset-query').value.trim().slice(0,200),category:$('#ambientcg-category').value};}
 function start(){return requestFeed('ambientcg',read());}
 function resetFilters(){$('#ambientcg-category').value='';return start();}
 function setup(){
  $('#ambientcg-category').onchange=()=>start();
  void loadCategories();
 }
 return Object.assign(ui,{setup,read,start,resetFilters,loadCategories});
}
