// ponytail: AI 标签按资产 UID 单独保存，搜索结果刷新不会覆盖平台标签或本地补充。
export function mergeTags(...groups){
 const seen=new Set(),tags=[];
 for(const value of groups.flat()){
  if(typeof value!=='string')continue;
  const tag=value.trim(),key=tag.toLocaleLowerCase();
  if(tag&&!seen.has(key)){seen.add(key);tags.push(tag);}
 }
 return tags;
}
export function tagsFor(state,model){return mergeTags(model.tags||[],state.aiTags?.[model.uid]||[]);}
export function addAITags(state,model,incoming){
 const original=mergeTags(model.tags||[]),before=mergeTags(state.aiTags?.[model.uid]||[]);
 const originalKeys=new Set(original.map(tag=>tag.toLocaleLowerCase()));
 const next=mergeTags(before,incoming).filter(tag=>!originalKeys.has(tag.toLocaleLowerCase()));
 state.aiTags??={};state.aiTags[model.uid]=next;
 const previous=new Set(before.map(tag=>tag.toLocaleLowerCase()));
 return next.filter(tag=>!previous.has(tag.toLocaleLowerCase())).length;
}
export function tagPanel(state,model,esc){
 const tags=tagsFor(state,model);
 return `<section class="asset-tags" data-asset-tags="${esc(model.uid)}"><div class="tag-list">${tags.map(t=>`<button type="button" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}<button type="button" class="secondary ai-tag-button" data-action="ai-tags" data-uid="${esc(model.uid)}" title="补充 AI 标签并自动保存，保留原有标签">✦ AI标签</button></div></section>`;
}
