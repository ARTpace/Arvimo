export function createSearchTranslation({fetchImpl=fetch}={}){
 const pending=new Map();
 return async function translate(query,{expand=false}={}){
  if(!/\p{Script=Han}/u.test(query)||/^https?:\/\//i.test(query))return {query,english:'',translated:false,expansions:[]};
  const key=expand?`${query}\u0000x`:query;
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
   try{
    // expand=true 让服务端把翻译和扩词合并成一次 LLM 调用，中文搜索少等一轮推理。
    const response=await fetchImpl('/api/ai/translate',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify(expand?{query,expand:true}:{query}),signal:AbortSignal.timeout(35000)});
    if(!response.ok)throw Error();const data=await response.json();
    const expansions=Array.isArray(data.expansions)?data.expansions.filter(s=>typeof s==='string'&&s.trim()).slice(0,3):[];
    if(data.translated===true&&typeof data.english==='string'&&data.english.trim())return {...data,expansions};
    return {query,english:'',translated:false,expansions:[],reason:data.reason||'使用原词搜索'};
   }catch{return {query,english:'',translated:false,expansions:[],reason:'AI 翻译不可用，使用原词搜索'};}
   finally{pending.delete(key);}
  })();
  pending.set(key,task);return task;
 };
}

export function bindLocalSearch({$,state,renderGrid,parse,delay=450,inputSelector='#model-search',enabled=()=>true,onState=()=>{}}){
 const KIND_LABEL={models:'3D 模型',textures:'材质',hdris:'HDRI / 天空盒',images:'图片 / Alpha',packs:'资源包'};
 let timer,version=0;
 const hint=text=>{const el=$('#local-translation');el.textContent=text;el.title=text;el.hidden=!text;};
 function reset(){clearTimeout(timer);version++;state.searchEnglish='';hint('');}
 function search(event){
  if(!enabled())return;
  reset();state.search=event.target.value;state.selected.clear();renderGrid();
  const query=state.search.trim(),token=version;
  if(event.isComposing||!query){if(!query)$('#local-kind').value='';onState({busy:false,ok:true});return;}
  hint('等待解析…');
  timer=setTimeout(async()=>{
   if(!enabled()||token!==version)return;
   onState({busy:true});hint('正在解析…');const result=await parse(query);
   if(token!==version||state.search.trim()!==query||!enabled())return;
   state.search=result.search||query;
   state.searchEnglish=result.english.join(' ');
   if(result.kind)$('#local-kind').value=result.kind;
   const parts=[];
   if(result.kind)parts.push(`类型=${KIND_LABEL[result.kind]||result.kind}`);
   if(result.search)parts.push(`主题=${result.search}`);
   if(result.english.length)parts.push(`附加=${result.english.join(' / ')}`);
   hint(parts.length?`AI 解析：${parts.join('，')}`:(result.reason||'使用原词搜索'));
   renderGrid();
   onState({busy:false,ok:true});
  },delay);
 }
 $(inputSelector).oninput=event=>{if(enabled())search(event);};
 return {reset,search:()=>search({target:$(inputSelector)})};
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

export function createTagSuggester({fetchImpl=fetch}={}){
 return async function suggest({name,author='',kind='',existing=[],meta=null,probe=null,image=''}){
  if(!name||!name.trim())return {name,author,kind,existing,tags:[],tagged:false,reason:'缺少资产名称'};
  // meta 是采集时抓到的来源信息（画板 / 类目 / 出处 / 话题），probe 是封面采样出的颜色与构图。
  // 两者都可能为空：为空时不进请求体，服务端提示词与旧版逐字一致。
  const extra={...(meta&&typeof meta==='object'?{meta}:{}),...(probe&&typeof probe==='object'?{probe}:{})};
  try{
   const response=await fetchImpl('/api/ai/tags',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({name,author,kind,existing,...extra,...(image?{image}:{})}),signal:AbortSignal.timeout(image?125000:35000)});
   if(!response.ok)throw Error();const data=await response.json();
   if(data.tagged===true&&Array.isArray(data.tags))return data;
   return {name,author,kind,existing,tags:[],tagged:false,reason:data.reason||'未能生成标签'};
  }catch{return {name,author,kind,existing,tags:[],tagged:false,reason:'AI 标签整理不可用'};}
 };
}
