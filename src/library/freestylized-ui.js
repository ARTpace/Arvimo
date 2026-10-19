export function createFreestylizedUI({$,esc,toast,requestFeed}){
 function read(){return {q:$('#asset-query').value.trim().slice(0,200),type:$('#freestylized-type').value||'models',category:$('#freestylized-category').value};}
 function start(){return requestFeed('freestylized',read());}
 async function loadCategories(){
  const type=$('#freestylized-type').value||'models';
  const keep=$('#freestylized-category').dataset.keep||$('#freestylized-category').value;
  try{
   const r=await fetch(`/api/freestylized/categories?type=${encodeURIComponent(type)}`,{cache:'no-store',headers:{'X-SFX-Local':'1'}});
   const data=await r.json();
   if(!r.ok)throw Error(data.error||'分类加载失败');
   const rows=data.categories||[];
   $('#freestylized-category').innerHTML=['<option value="">全部分类</option>',...rows.map(c=>`<option value="${esc(c.value)}">${esc(c.label)}${c.count?` · ${c.count}`:''}</option>`)].join('');
   if([...$('#freestylized-category').options].some(o=>o.value===keep))$('#freestylized-category').value=keep;
   else $('#freestylized-category').value='';
  }catch(e){toast(e.message||'FreeStylized 分类加载失败');}
  delete $('#freestylized-category').dataset.keep;
 }
 function setup(){
  $('#freestylized-type').onchange=()=>{loadCategories().then(start);};
  $('#freestylized-category').onchange=()=>start();
  loadCategories();
 }
 return {read,setup};
}
