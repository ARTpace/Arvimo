import {icon} from './icon-set.js';
import {mergeAutoTags} from './auto-tags.js';
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
/** 客观标签（画板 / 平台分类 / 话题 / 来源）虚拟派生，不写入 state：
 *  历史资产无需回填或重新收藏也能立即显示，改配置即可全库撤销（同 Hydrus 的 parent 展开）。 */
export function tagsFor(state,model){return mergeAutoTags(mergeTags(model.tags||[],state.aiTags?.[model.uid]||[],state.userTags?.[model.uid]||[]),model);}
export function addAITags(state,model,incoming){
 const original=mergeTags(model.tags||[]),before=mergeTags(state.aiTags?.[model.uid]||[]);
 const originalKeys=new Set(original.map(tag=>tag.toLocaleLowerCase()));
 const next=mergeTags(before,incoming).filter(tag=>!originalKeys.has(tag.toLocaleLowerCase()));
 state.aiTags??={};state.aiTags[model.uid]=next;
 const previous=new Set(before.map(tag=>tag.toLocaleLowerCase()));
 return next.filter(tag=>!previous.has(tag.toLocaleLowerCase())).length;
}
export function clearAITags(state,uid){if(state.aiTags)delete state.aiTags[uid];}
/** 「我的标签」：用户手打的层，与平台标签、AI 标签三层并排，可增删、可跨资产管理。 */
export function userTagsFor(state,model){return mergeTags(state.userTags?.[model.uid]||[]);}
export function addUserTag(state,model,incoming){
 const before=userTagsFor(state,model);
 const next=mergeTags(before,incoming);
 state.userTags={...state.userTags,[model.uid]:next};
 return next.length-before.length;
}
export function removeUserTag(state,model,tag){
 const before=userTagsFor(state,model),key=String(tag||'').trim().toLocaleLowerCase();
 const next=before.filter(t=>t.toLocaleLowerCase()!==key);
 state.userTags={...state.userTags,[model.uid]:next};
 return before.length-next.length;
}
/** 标签管理面板数据源：跨资产统计「我的标签」。千级数据全量重算，不起索引。 */
export function listUserTags(state){
 const counts=new Map();
 for(const model of state.models||[])for(const tag of userTagsFor(state,model)){
  const key=tag.toLocaleLowerCase(),entry=counts.get(key)||{name:tag,count:0};
  entry.count++;counts.set(key,entry);
 }
 return [...counts.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh'));
}
function rewriteUserTags(state,rewrite){
 const next={};
 for(const [uid,tags] of Object.entries(state.userTags||{})){
  const mapped=mergeTags(tags.map(rewrite).filter(Boolean));
  if(mapped.length)next[uid]=mapped;
 }
 state.userTags=next;
}
/** 重命名＝跨资产改写；目标名已存在时自然合并（mergeTags 去重）。返回受影响资产数。 */
export function renameUserTag(state,from,to){
 const source=String(from||'').trim(),target=String(to||'').trim();
 if(!source||!target||source.toLocaleLowerCase()===target.toLocaleLowerCase())return 0;
 const before=listUserTags(state).find(t=>t.name.toLocaleLowerCase()===source.toLocaleLowerCase())?.count||0;
 if(!before)return 0;
 rewriteUserTags(state,tag=>tag.toLocaleLowerCase()===source.toLocaleLowerCase()?target:tag);
 return before;
}
export const mergeUserTag=(state,from,to)=>renameUserTag(state,from,to);
export function deleteUserTag(state,tag){
 const key=String(tag||'').trim().toLocaleLowerCase();if(!key)return 0;
 const before=listUserTags(state).find(t=>t.name.toLocaleLowerCase()===key)?.count||0;
 if(!before)return 0;
 rewriteUserTags(state,t=>t.toLocaleLowerCase()===key?null:t);
 return before;
}
/** 标签面板：平台 / AI / 我的三层并排。平台只读；AI 带 ✦；我的可点 × 删。
 *  紧凑合并不分节标题（既定设计），层的差异只用 chip 样式表达。 */
export function tagPanel(state,model,esc){
 const meta=state.userMeta?.[model.uid]||{rating:0,note:''};
 const platform=mergeTags(model.tags||[]);
 const platformKeys=new Set(platform.map(tag=>tag.toLocaleLowerCase()));
 const ai=mergeTags(state.aiTags?.[model.uid]||[]).filter(tag=>!platformKeys.has(tag.toLocaleLowerCase()));
 const user=userTagsFor(state,model);
 const chip=(tag,kind)=>`<button type="button" class="tag-chip ${kind}" data-tag="${esc(tag)}">${kind==='ai'?icon('sparkle'):''}${esc(tag)}${kind==='mine'?`<span class="tag-x" data-remove-tag="${esc(tag)}" title="移除这个标签" aria-label="移除标签 ${esc(tag)}">×</span>`:''}</button>`;
 const stars=[1,2,3,4,5].map(n=>`<button type="button" class="star${n<=meta.rating?' on':''}" data-rate="${n}" data-uid="${esc(model.uid)}" title="${n} 星" aria-label="${n} 星">${icon('star')}</button>`).join('');
 return `<section class="asset-tags" data-asset-tags="${esc(model.uid)}"><div class="tag-list">${platform.map(t=>chip(t,'src')).join('')}${ai.map(t=>chip(t,'ai')).join('')}${user.map(t=>chip(t,'mine')).join('')}<button type="button" class="secondary ai-tag-button" data-action="ai-tags" data-uid="${esc(model.uid)}" title="补充 AI 标签并自动保存，保留原有标签">${icon('sparkle')} AI标签</button></div><div class="tag-add-row"><input type="text" class="tag-add-input" data-user-tag-input="${esc(model.uid)}" placeholder="添加我的标签，回车确认" maxlength="40" autocomplete="off"><button type="button" class="secondary" data-action="add-user-tag" data-uid="${esc(model.uid)}">添加</button></div><div class="asset-rate-row"><span class="rate-label">我的评分</span><span class="rate-stars">${stars}</span>${meta.rating?`<button type="button" class="text-button rate-clear" data-rate="0" data-uid="${esc(model.uid)}">清除</button>`:''}</div><textarea class="asset-note" data-note-for="${esc(model.uid)}" rows="2" maxlength="2000" placeholder="记一句：用在哪、要注意什么…">${esc(meta.note)}</textarea></section>`;
}
