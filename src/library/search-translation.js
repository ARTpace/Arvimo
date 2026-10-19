export function createSearchTranslation({fetchImpl=fetch}={}){
 const pending=new Map();
 return async function translate(query){
  if(!/\p{Script=Han}/u.test(query)||/^https?:\/\//i.test(query))return {query,english:'',translated:false};
  if(pending.has(query))return pending.get(query);
  const task=(async()=>{
   try{
    const response=await fetchImpl('/api/ai/translate',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({query}),signal:AbortSignal.timeout(35000)});
    if(!response.ok)throw Error();const data=await response.json();
    if(data.translated===true&&typeof data.english==='string'&&data.english.trim())return data;
    return {query,english:'',translated:false,reason:data.reason||'使用原词搜索'};
   }catch{return {query,english:'',translated:false,reason:'AI 翻译不可用，使用原词搜索'};}
   finally{pending.delete(query);}
  })();
  pending.set(query,task);return task;
 };
}

export function bindLocalSearch({$,state,renderGrid,translate,delay=450}){
 let timer,version=0;
 const hint=text=>{const el=$('#local-translation');el.textContent=text;el.title=text;el.hidden=!text;};
 function reset(){clearTimeout(timer);version++;state.searchEnglish='';hint('');}
 $('#model-search').oninput=event=>{
  reset();state.search=event.target.value;state.selected.clear();renderGrid();
  const query=state.search.trim(),token=version;
  if(event.isComposing||!query||! /\p{Script=Han}/u.test(query))return;
  hint('等待翻译…');
  timer=setTimeout(async()=>{
   hint('正在翻译…');const result=await translate(query);
   if(token!==version||state.search.trim()!==query)return;
   state.searchEnglish=result.translated?result.english:'';
   hint(result.translated?`同时匹配：${result.english}`:result.reason);renderGrid();
  },delay);
 };
 return {reset};
}
