import {esc} from './html-esc.js';
import {localJson,fillOptions} from './category-options.js';

/**
 * Polyfork 的筛选 UI。
 *
 * 和其他源不同，它的分类是**固定 9 个官方 class**（道具 / 建筑 / 载具…），
 * 不随搜索变化，也拿不到计数，所以下拉只填一次、不编数字。
 * 排序只开放「面数最少」，因为官方 sort 另一个值是 latest，浏览态后端已经默认用它了。
 */
export function createPolyforkUI({enabled=()=>true,$,toast,requestFeed}){
 function read(){
  return {
   q:$('#asset-query').value.trim().slice(0,200),
   assetClass:$('#polyfork-class')?.value||'',
   sort:$('#polyfork-sort')?.value||'',
  };
 }
 function start(){return requestFeed('polyfork',read());}
 async function load(){
  if(!enabled())return;
  try{
   const data=await localJson('/api/polyfork/categories');
   fillOptions($,'#polyfork-class',data.categories||[],'全部类别',esc);
  }catch(e){toast(`Polyfork 分类加载失败，仍可按关键词搜索：${e.message}`);}
 }
 function setup(){
  const klass=$('#polyfork-class'),sort=$('#polyfork-sort');
  if(klass)klass.onchange=()=>start();
  if(sort)sort.onchange=()=>start();
  void load();
 }
 return {setup,read,start};
}
