// 本地文本分析，不读取图片像素、不请求网络；一个任务复用词表前缀索引。
export const TEXT_LABEL_CHANNEL='taxonomy-file-text-v1';
const protectedFacets=new Set(['license','software','platform']);
const normalize=text=>String(text??'').normalize('NFKC').replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().replace(/[_\-\s]+/g,' ').trim();
const word=char=>!!char&&/[\p{L}\p{N}]/u.test(char)&&!/[\p{Script=Han}]/u.test(char);

export function assetTextFields(model){
 const fields=[];
 const add=(field,value)=>{if(typeof value==='string'&&value.trim())fields.push({field,text:normalize(value.slice(0,16000).replace(/https?:\/\/\S+/gi,' ').replace(/<[^>]*>/g,' '))});};
 add('name',model.name);add('title',model.title);
 // 只使用根内相对路径；不拿用户名、盘符和应用缓存根当资产内容。
 for(const field of ['sourceRel','localRel'])if(typeof model[field]==='string')for(const part of model[field].split(/[\\/]/).slice(-32))add(field,part.replace(/\.[a-z0-9]{1,12}$/i,''));
 if(!model.sourceRel&&!model.localRel&&typeof model.filePath==='string')add('fileName',model.filePath.split(/[\\/]/).at(-1)?.replace(/\.[a-z0-9]{1,12}$/i,''));
 add('description',model.description);add('summary',model.summary);
 for(const field of ['keywords','subject'])for(const value of Array.isArray(model[field])?model[field]:[model[field]])add(field,value);
 return fields;
}

export function createTextLabelMatcher({terms,aliases,facets}){
 const root=new Map(),phrases=new Map(),aliasesById=new Map();
 for(const alias of aliases){const rows=aliasesById.get(alias.term_id)||[];rows.push(alias.alias_norm);aliasesById.set(alias.term_id,rows);}
 for(const term of terms){
  if([...facets.get(term.term_id)||[]].some(facet=>protectedFacets.has(facet)))continue;
  for(const value of [term.value,...aliasesById.get(term.term_id)||[]]){
   const phrase=normalize(value);
   // 一字中文和极短英文歧义过大；未匹配不是识别失败，不强行打标。
   if(phrase.length>200||(!/[\p{Script=Han}]/u.test(phrase)&&phrase.length<3)||phrase.length<2)continue;
   const entry=phrases.get(phrase);if(entry&&entry.term_id!==term.term_id)phrases.set(phrase,{ambiguous:true});else if(!entry)phrases.set(phrase,term);
  }
 }
 for(const [phrase,term] of phrases){if(term.ambiguous)continue;let node=root;for(const char of phrase){if(!node.has(char))node.set(char,new Map());node=node.get(char);}node.term=term;}
 return model=>{
  const found=new Map();
  for(const {field,text} of assetTextFields(model)){
   const chars=Array.from(text);
   for(let start=0;start<chars.length;start++){
    let node=root,best;
    for(let end=start;end<chars.length&&end-start<200;end++){
     node=node.get(chars[end]);if(!node)break;
     if(node.term&&!(word(chars[start])&&word(chars[start-1]))&&!(word(chars[end])&&word(chars[end+1])))best={term:node.term,end};
    }
    if(best){found.set(best.term.term_id,{...best.term,evidence:{field,match:chars.slice(start,best.end+1).join('')}});start=best.end;}
   }
  }
  return [...found.values()];
 };
}
