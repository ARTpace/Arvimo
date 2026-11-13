export const splitSearchTerms=query=>[...new Set(String(query||'').split(/[,，;；\n]+/).map(term=>term.trim()).filter(Boolean))];
const prefix='assetvault-multi:';
export async function fetchSearchPage(endpoint,payload,{signal,translate,fetchImpl=fetch}={}){
 const terms=splitSearchTerms(payload.q);
 const continuation=typeof payload.cursor==='string'&&payload.cursor.startsWith(prefix);
 if(!continuation&&terms.length<=1){
  const response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify(payload),signal});
  return {ok:response.ok,status:response.status,data:await response.json()};
 }
 if(terms.length>8)throw Error('一次最多搜索 8 个词，请减少关键词');
 const requests=continuation?JSON.parse(payload.cursor.slice(prefix.length)):terms.map(q=>({...payload,q}));
 const results=await Promise.all(requests.map(async request=>{
  try{
   if(request.q&&/\p{Script=Han}/u.test(request.q)&&translate){const result=await translate(request.q);signal?.throwIfAborted();if(result.translated)request={...request,q:result.english};}
   const response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify(request),signal});
   const data=await response.json();if(!response.ok)throw Error(data.error||`搜索失败 ${response.status}`);
   return {data};
  }catch(error){signal?.throwIfAborted();return {error:error.message};}
 }));
 if(results.every(result=>result.error))throw Error(results.map(result=>result.error).join('；'));
 const next=results.flatMap(({data})=>!data?[]:data.pending?.length?[{ids:data.pending}]:data.next?[{cursor:data.next}]:[]);
 return {ok:true,status:200,data:{models:results.flatMap(({data})=>data?.models||[]),next:next.length?prefix+JSON.stringify(next):null,pending:[],warnings:results.flatMap(result=>result.error?[result.error]:result.data.warnings||[])}};
}
