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
 const platform=mergeTags(model.tags||[]),originalKeys=new Set(platform.map(t=>t.toLocaleLowerCase()));
 const ai=mergeTags(state.aiTags?.[model.uid]||[]).filter(t=>!originalKeys.has(t.toLocaleLowerCase()));
 const group=(title,tags,empty)=>`<div class="asset-tag-group"><small>${title}</small><div class="tag-list">${tags.length?tags.map(t=>`<button type="button" data-tag="${esc(t)}">${esc(t)}</button>`).join(''):`<span class="muted">${empty}</span>`}</div></div>`;
 return `<section class="asset-tags" data-asset-tags="${esc(model.uid)}">${group('平台标签',platform,'平台暂无标签')}${group('AI 标签 · 保存在本机',ai,'尚未生成 AI 标签')}<button type="button" class="secondary" data-action="ai-tags" data-uid="${esc(model.uid)}">${ai.length?'继续补充 AI 标签':'AI 整理标签'}</button></section>`;
}
