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

export function bindLocalSearch({$,state,renderGrid,parse,delay=450}){
 const KIND_LABEL={models:'3D 模型',textures:'材质',hdris:'HDRI / 天空盒',images:'图片 / Alpha',packs:'资源包'};
 let timer,version=0;
 const hint=text=>{const el=$('#local-translation');el.textContent=text;el.title=text;el.hidden=!text;};
 function reset(){clearTimeout(timer);version++;state.searchEnglish='';hint('');}
 $('#model-search').oninput=event=>{
  reset();state.search=event.target.value;state.selected.clear();renderGrid();
  const query=state.search.trim(),token=version;
  if(event.isComposing||!query){if(!query)$('#local-kind').value='';return;}
  hint('等待解析…');
  timer=setTimeout(async()=>{
   hint('正在解析…');const result=await parse(query);
   if(token!==version||state.search.trim()!==query)return;
   state.search=result.search||query;
   state.searchEnglish=result.english.join(' ');
   if(result.kind)$('#local-kind').value=result.kind;
   const parts=[];
   if(result.kind)parts.push(`类型=${KIND_LABEL[result.kind]||result.kind}`);
   if(result.search)parts.push(`主题=${result.search}`);
   if(result.english.length)parts.push(`附加=${result.english.join(' / ')}`);
   hint(parts.length?`AI 解析：${parts.join('，')}`:(result.reason||'使用原词搜索'));
   renderGrid();
  },delay);
 };
 return {reset};
}

export function createSearchExpansion({fetchImpl=fetch}={}){
 const pending=new Map();
 return async function expand(query){
  if(!/[a-z]/i.test(query)||/^https?:\/\//i.test(query))return {query,expansions:[],expanded:false};
  if(pending.has(query))return pending.get(query);
  const task=(async()=>{
   try{
    const response=await fetchImpl('/api/ai/expand',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({query}),signal:AbortSignal.timeout(35000)});
    if(!response.ok)throw Error();const data=await response.json();
    if(data.expanded===true&&Array.isArray(data.expansions))return data;
    return {query,expansions:[],expanded:false,reason:data.reason||''};
   }catch{return {query,expansions:[],expanded:false,reason:'AI 扩词不可用，仅用原词搜索'};}
   finally{pending.delete(query);}
  })();
  pending.set(query,task);return task;
 };
}

export function createLocalQueryParser({fetchImpl=fetch}={}){
 const pending=new Map();
 return async function parse(query){
  if(!query.trim())return {query,kind:'',search:'',english:[],parsed:false};
  if(pending.has(query))return pending.get(query);
  const task=(async()=>{
   try{
    const response=await fetchImpl('/api/ai/parse-local',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({query}),signal:AbortSignal.timeout(35000)});
    if(!response.ok)throw Error();const data=await response.json();
    if(data.parsed===true)return data;
    return {query,kind:'',search:'',english:[],parsed:false,reason:data.reason||'使用原词搜索'};
   }catch{return {query,kind:'',search:'',english:[],parsed:false,reason:'AI 解析不可用，使用原词搜索'};}
   finally{pending.delete(query);}
  })();
  pending.set(query,task);return task;
 };
}

export function createThemeBrainstorm({fetchImpl=fetch}={}){
 return async function brainstorm(theme){
  if(!theme.trim())return {theme,terms:[],brainstormed:false};
  try{
   const response=await fetchImpl('/api/ai/brainstorm',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({query:theme}),signal:AbortSignal.timeout(35000)});
   if(!response.ok)throw Error();const data=await response.json();
   if(data.brainstormed===true&&Array.isArray(data.terms))return data;
   return {theme,terms:[],brainstormed:false,reason:data.reason||''};
  }catch{return {theme,terms:[],brainstormed:false,reason:'AI 主题拆解不可用'};}
 };
}
