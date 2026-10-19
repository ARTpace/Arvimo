import {esc} from './html-esc.js';

export function createKenneyUI({$,toast,requestFeed}){
 function read(){
  return {q:$('#asset-query').value.trim().slice(0,200),category:$('#kenney-category').value,series:$('#kenney-series').value};
 }
 function start(){return requestFeed('kenney',read());}
 async function load(){
  try{
   const r=await fetch('/api/kenney/categories',{cache:'no-store',headers:{'X-SFX-Local':'1'}});
   const data=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(data.error||`Kenney 分类请求失败 HTTP ${r.status}`);
   const fill=(id,rows,blank)=>{
    const keep=$(id).dataset.keep||$(id).value;
    $(id).innerHTML=[`<option value="">${blank}</option>`,...(rows||[]).map(row=>`<option value="${esc(row.value)}">${esc(row.label)}${row.count?` · ${row.count}`:''}</option>`)].join('');
    if([...$(id).options].some(option=>option.value===keep))$(id).value=keep;
    delete $(id).dataset.keep;
   };
   fill('#kenney-category',data.categories,'全部类型');
   fill('#kenney-series',data.series,'全部系列');
  }catch(e){toast(`Kenney 分类加载失败，仍可按名称搜索：${e.message}`);}
 }
 function setup(){
  $('#kenney-category').onchange=()=>start();
  $('#kenney-series').onchange=()=>start();
  void load();
 }
 return {setup,read,start};
}
