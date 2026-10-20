import {tagsFor} from './asset-tags.js';
import {feedEndpoint} from './platforms.js';
import {esc} from './html-esc.js';

const words=value=>String(value||'').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
const generic=new Set(['3d','2d','model','models','asset','assets','free','download','pbr','texture','textures','textured','lowpoly','low','poly','highpoly','high','polygon','photorealistic','realistic','stylized','game','gameready','ready','render','rigged','animated','animation','blender','maya','fbx','obj','模型','低模','高模','免费','写实','风格化']);
const meaningful=value=>words(value).filter(word=>(word.length>2||/\p{Script=Han}/u.test(word))&&!generic.has(word));
const meaningfulTags=(state,model)=>[...new Set(tagsFor(state,model).map(tag=>String(tag).trim().toLocaleLowerCase()).filter(tag=>meaningful(tag).length))];
const type=model=>model.assetType||model.kind||'models';
export function rankSimilar(model,candidates,state,limit=12){
 const tags=new Set(meaningfulTags(state,model)),title=new Set(meaningful(model.name));
 const seen=new Set([model.uid]);
 return candidates.filter(m=>{
  if(!m?.uid||seen.has(m.uid))return false;seen.add(m.uid);return true;
 }).map(m=>{
  const shared=meaningfulTags(state,m).filter(t=>tags.has(t)).length;
  const names=[...new Set(meaningful(m.name))].filter(w=>title.has(w)).length;
  const sameType=type(m)===type(model);
  return {model:m,score:shared||names?shared*10+names*6+(sameType?1:0):0,reason:shared?'相似标签':'相关主题'};
 }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,limit);
}
export function similarRequest(model,state){
 const tags=meaningfulTags(state,model),title=new Set(meaningful(model.name));
 const q=tags.find(tag=>meaningful(tag).some(word=>title.has(word)))||tags[0]||[...title].slice(0,2).join(' ');
 const platform=model.platform||'sketchfab';
 const mode=platform==='sketchfab'?'search':platform==='artstation'?'art':platform;
 const payload={q,sort:'relevance'};
 if(['polyhaven','freestylized'].includes(platform))payload.type=model.assetType||'models';
 if(platform==='artstation')payload.assetType='marmoset';
 return {endpoint:feedEndpoint(mode),payload};
}

// ponytail: 每次预览最多补查同平台一页，缓存只保留最近 200 项，不写入资产库或搜索列表。
export function createSimilarAssets({dialog,state,candidates,imageUrl,onPreview,fetchImpl=fetch}){
 const section=document.createElement('section');section.className='similar-assets';section.hidden=true;
 section.setAttribute('aria-label','相似资产');dialog.append(section);
 const models=new Map();let controller,revision=0;
 function remember(rows){for(const model of rows){models.set(model.uid,model);if(models.size>200)models.delete(models.keys().next().value);}}
 function render(model,rows,message=''){
  const items=rankSimilar(model,rows,state);remember(items.map(item=>item.model));
  section.hidden=!items.length&&!message;
  section.innerHTML=items.length?`<div class="similar-assets-list">${items.map(({model:m,reason})=>`<button type="button" class="similar-asset" data-similar-uid="${esc(m.uid)}" aria-label="${esc(m.name)} · ${reason}">${m.thumbnail?`<img src="${esc(imageUrl(m))}" alt="" loading="lazy">`:'<span class="similar-placeholder">◇</span>'}<span class="similar-asset-info"><span>${esc(m.name)}</span><small>${reason}</small></span></button>`).join('')}</div>`:`<span class="similar-status" role="status">${esc(message)}</span>`;
 }
 async function show(model){
  controller?.abort();const token=++revision;controller=new AbortController();const signal=controller.signal;
  if(!model||!dialog.open){section.hidden=true;return;}
  const local=candidates();render(model,local,'正在查找更多相似资产…');
  try{
   const {endpoint,payload}=similarRequest(model,state);
   if(!payload.q){render(model,local);return;}
   const response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify(payload),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
   if(!response.ok)throw Error('推荐暂不可用');
   const data=await response.json();
   if(signal.aborted||token!==revision||!dialog.open)return;
   render(model,[...local,...(data.models||[])]);
  }catch{
   if(signal.aborted||token!==revision||!dialog.open)return;
   render(model,local,'在线推荐暂不可用');
  }
 }
 section.addEventListener('wheel',event=>{
  const list=event.target.closest('.similar-assets-list');
  if(!list||event.ctrlKey||Math.abs(event.deltaX)>=Math.abs(event.deltaY)||list.scrollWidth<=list.clientWidth)return;
  const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?list.clientWidth:1);
  list.scrollLeft=Math.max(0,Math.min(list.scrollWidth-list.clientWidth,list.scrollLeft+delta));
  event.preventDefault();
 },{passive:false});
 section.addEventListener('click',event=>{
  const button=event.target.closest('[data-similar-uid]');if(button)onPreview(button.dataset.similarUid);
 });
 dialog.addEventListener('close',()=>{if(!dialog.open){revision++;controller?.abort();section.hidden=true;}});
 return {show,find:uid=>models.get(uid)};
}
