import {createSearchExpansion,createSearchTranslation} from './search-translation.js';

/** Reuse the existing synonym/translation endpoints; one request per submitted phrase. */
export function createRelatedSearch({expand=createSearchExpansion(),translate=createSearchTranslation()}={}){
 const cache=new Map();
 return function related(query){
  query=query.trim();
  if(!query||/^https?:\/\//i.test(query))return Promise.resolve({terms:[],reason:''});
  const key=query.toLocaleLowerCase();if(cache.has(key))return cache.get(key);
  const task=(async()=>{
   const chinese=/\p{Script=Han}/u.test(query);
   const result=chinese?await translate(query,{expand:true}):await expand(query);
   const terms=[...new Set([...(chinese&&result.english?[result.english]:[]),...(result.expansions||[])].filter(term=>typeof term==='string').map(term=>term.trim()).filter(term=>term&&term.length<=80&&!/^https?:/i.test(term)&&term.toLocaleLowerCase()!==key).map(term=>term.toLocaleLowerCase()))].slice(0,6);
   if(!terms.length)cache.delete(key);
   return {terms,reason:terms.length?'':result.reason||'暂未找到相近词，可以换个关键词试试'};
  })().catch(()=>{cache.delete(key);return {terms:[],reason:'暂时无法获取相近词，请稍后重试'};});
  if(cache.size>=100)cache.delete(cache.keys().next().value);
  cache.set(key,task);return task;
 };
}
