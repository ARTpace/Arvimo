import {esc} from './html-esc.js';
import {localJson,fillOptions} from './category-options.js';

export function createKenneyUI({enabled=()=>true,$,esc,toast,requestFeed}){
 function read(){
  return {q:$('#asset-query').value.trim().slice(0,200),category:$('#kenney-category').value,series:$('#kenney-series').value};
 }
 function start(){return requestFeed('kenney',read());}
 async function load(){
  if(!enabled())return;
  try{
   const data=await localJson('/api/kenney/categories');
   fillOptions($,'#kenney-category',data.categories,'全部类型',esc);
   fillOptions($,'#kenney-series',data.series,'全部系列',esc);
  }catch(e){toast(`Kenney 分类加载失败，仍可按名称搜索：${e.message}`);}
 }
 function setup(){
  $('#kenney-category').onchange=()=>start();
  $('#kenney-series').onchange=()=>start();
  void load();
 }
 return {setup,read,start};
}
