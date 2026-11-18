import {askText,askConfirm} from './ask-dialog.js';
import {invalidateTagFacets} from './filter-panel-tags.js';
import {invalidateFacetVocab} from './tag-facet-map.js';

export function createTagManagementUi({esc}){
 let dialog,busy=false,q='',offset=0,data,editing=null,rejectionData,rejectionOffset=0,rulesData;
 const api=async(action,input={})=>{
  const response=await fetch('/api/library/file-organize/action',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({action,...input})});
  const result=await response.json();if(!response.ok)throw Error(result.error||`HTTP ${response.status}`);if(action==='terms-write'){invalidateTagFacets();invalidateFacetVocab();}return result;
 };
 const status=value=>{dialog.querySelector('[data-status]').textContent=value;};
 async function run(fn){if(busy)return;busy=true;dialog.querySelector('[data-body]').inert=true;try{await fn();}catch(error){status(error.message);}finally{busy=false;dialog.querySelector('[data-body]').inert=false;}}
 function editor(){
  const node=dialog.querySelector('[data-editor]'),term=editing;
  node.innerHTML=`<h3>${term?'编辑自定义标签':'新建自定义标签'}</h3><form data-term-form class="tm-form">
    <label>名称 <input name="value" maxlength="200" required value="${esc(term?.value||'')}"></label>
    <label>父级标签 <input name="parentValue" list="tm-parents" placeholder="留空为顶级；输入完整标签名" value="${esc(term?.parent||'')}"></label>
    <datalist id="tm-parents">${data.terms.filter(item=>!item.retired&&item.id!==term?.id).map(item=>`<option value="${esc(item.value)}"></option>`).join('')}</datalist>
    <fieldset><legend>分类维度（可多选）</legend>${Object.entries(data.facets).map(([key,label])=>`<label><input type="checkbox" name="facet" value="${esc(key)}" ${term?.facets?.includes(key)?'checked':''}>${esc(label)}</label>`).join('')}</fieldset>
    ${term?`<label>别名 <input name="aliases" placeholder="多个别名用逗号分隔；已有别名兼容保留" value="${esc(term.aliases.join(', '))}"></label>`:''}
    <div class="fo-toolbar"><button type="submit">${term?'保存标签':'创建标签'}</button>${term?'<button type="button" data-new>新建另一个标签</button>':''}</div>
    <p class="compact-note">父级和分类维度只影响标签检索，不创建目录或移动原件。改名保留旧名称为别名。内置标签由版本维护，自定义标签可挂到内置标签下面。</p></form>`;
 }
 async function refresh(){
  data=await api('terms-list',{q,offset,limit:100});
  dialog.querySelector('[data-list]').innerHTML=`<div class="fo-toolbar"><input data-query value="${esc(q)}" placeholder="搜索标签名称" aria-label="搜索标签名称"><button type="button" data-search>搜索</button><button type="button" data-new>新建标签</button><button type="button" data-refresh>刷新</button></div>
    <div>${data.terms.map(term=>`<div class="fo-record"><span><strong>${esc(term.value)}</strong><small>${term.seedKey?'内置':'自定义'}${term.retired?' · 已停用':''}${term.parent?' · 父级：'+esc(term.parent):''} · ${term.count} 个资产 · ${term.facets.map(facet=>esc(data.facets[facet]||facet)).join('、')}</small></span>${term.seedKey?'':`<button type="button" data-edit="${term.id}">编辑</button><button type="button" data-retire="${term.id}">${term.retired?'恢复':'停用'}</button><button type="button" data-merge="${term.id}">合并到…</button>`}</div>`).join('')||'<p>没有匹配的标签</p>'}</div>
    <div class="fo-toolbar"><button type="button" data-page="${Math.max(0,offset-100)}" ${offset===0?'disabled':''}>上一页</button><span>${offset+data.terms.length} / ${data.total}</span><button type="button" data-page="${offset+100}" ${offset+100>=data.total?'disabled':''}>下一页</button></div>`;
  dialog.querySelectorAll('[data-merge]').forEach(button=>{
   const split=document.createElement('button');split.type='button';split.dataset.split=button.dataset.merge;split.textContent='拆分子分类';button.after(split);
  });
  editor();
  await refreshRejections();
  await refreshRules();
 }
 async function refreshRules(){
  rulesData=await api('rules-list');
  dialog.querySelector('[data-rules]').innerHTML=`<h3>自动细分规则 · 版本 ${rulesData.version}</h3><p class="compact-note">当资产已关联父分类，且已有标签精确匹配条件时，补充指定子分类。命中多个不同目标则留待细分，不删除旧归属。保存后在“标签升级与补标 → 规则细分分类”启动任务。</p><form data-rule-form class="tm-form"><label>父分类标准名 <input name="source" required maxlength="200"></label><label>子分类标准名 <input name="target" required maxlength="200"></label><label>匹配已有标签 <input name="match" required maxlength="200"></label><button type="submit">添加细分规则</button></form>${rulesData.rules.map(rule=>`<div class="fo-record"><span>${esc(rule.source)} + ${esc(rule.match_norm)} → ${esc(rule.target)}</span><button type="button" data-rule-remove="${esc(rule.rule_id)}">删除规则</button></div>`).join('')||'<p>暂无细分规则</p>'}`;
 }
 async function refreshRejections(){
  rejectionData=await api('terms-rejections',{offset:rejectionOffset,limit:100});
  dialog.querySelector('[data-rejections]').innerHTML=`<h3>自动标签排除记录</h3><p class="compact-note">撤销排除后允许下次补标重新判断，不会立即添加标签。手动标签不受影响。</p>${rejectionData.items.map((item,index)=>`<div class="fo-record"><span><strong>${esc(item.value)}</strong><small>${esc(item.name||item.uid)} · ${esc(item.uid)}</small></span><button type="button" data-unreject="${index}">撤销排除</button></div>`).join('')||'<p>暂无排除记录</p>'}<div class="fo-toolbar"><button type="button" data-rejection-page="${Math.max(0,rejectionOffset-100)}" ${rejectionOffset===0?'disabled':''}>上一页</button><span>${rejectionOffset+rejectionData.items.length} / ${rejectionData.total}</span><button type="button" data-rejection-page="${rejectionOffset+100}" ${rejectionOffset+100>=rejectionData.total?'disabled':''}>下一页</button></div>`;
 }
 function ensure(){
  if(dialog)return;
  dialog=document.createElement('dialog');dialog.className='av-file-organizer';
  dialog.innerHTML='<div class="dialog-header"><span>标签分类管理</span><button type="button" class="icon-button" data-close aria-label="关闭">×</button></div><div class="fo-content" data-body><section data-editor></section><section data-list></section></div><p class="fo-status" data-status role="status"></p>';
  document.body.appendChild(dialog);
  const exclusions=document.createElement('section');exclusions.dataset.rejections='';dialog.querySelector('[data-body]').appendChild(exclusions);
  const rules=document.createElement('section');rules.dataset.rules='';dialog.querySelector('[data-body]').appendChild(rules);
  dialog.addEventListener('submit',event=>{
   if(event.target.matches('[data-rule-form]')){
    event.preventDefault();const form=new FormData(event.target);
    run(async()=>{await api('rules-write',{change:{action:'create',source:form.get('source'),target:form.get('target'),match:form.get('match')}});await refreshRules();status('规则已保存，请启动规则细分补标。');});return;
   }
   if(!event.target.matches('[data-term-form]'))return;event.preventDefault();
   const form=new FormData(event.target),change={action:editing?'save':'create',value:form.get('value'),parentValue:form.get('parentValue'),facets:form.getAll('facet'),
    ...(editing?{id:editing.id,rev:editing.rev,aliases:String(form.get('aliases')||'').split(/[,，]/).map(value=>value.trim()).filter(Boolean)}:{})};
   run(async()=>{await api('terms-write',{change});editing=null;await refresh();status('标签已保存，源文件未改变。');});
  });
  dialog.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('[data-query]')){event.preventDefault();dialog.querySelector('[data-search]').click();}});
  dialog.addEventListener('click',event=>{
   const button=event.target.closest('button');if(!button||button.type==='submit')return;
   if(button.hasAttribute('data-close')){dialog.close();return;}
   run(async()=>{
    if(button.hasAttribute('data-new')){editing=null;editor();dialog.querySelector('[name=value]').focus();return;}
    if(button.hasAttribute('data-search')){q=dialog.querySelector('[data-query]').value;offset=0;await refresh();return;}
    if(button.hasAttribute('data-page')){offset=Number(button.dataset.page);await refresh();return;}
    if(button.hasAttribute('data-refresh')){await refresh();status('列表已刷新');return;}
    if(button.hasAttribute('data-rule-remove')){
     const rule=rulesData.rules.find(item=>item.rule_id===button.dataset.ruleRemove);if(!rule)return;
     await api('rules-write',{change:{action:'remove',id:rule.rule_id,rev:rule.rev}});await refreshRules();status('规则已删除，现有资产标签保留。');return;
    }
    if(button.hasAttribute('data-rejection-page')){rejectionOffset=Number(button.dataset.rejectionPage);await refreshRejections();return;}
    if(button.hasAttribute('data-unreject')){
     const item=rejectionData.items[Number(button.dataset.unreject)];await api('terms-restore-rejection',item);await refreshRejections();status('已撤销排除，可通过“标签升级与补标”重新补标。');return;
    }
    const id=Number(button.dataset.edit||button.dataset.retire||button.dataset.merge||button.dataset.split),term=data.terms.find(item=>item.id===id);if(!term)return;
    if(button.hasAttribute('data-split')){
     const value=await askText({title:'拆分子分类',message:`在“${term.value}”下创建子分类，输入 2–20 个名称，用逗号分隔。原资产归属保留，待人工细分，不自动分配。`});if(!value)return;
     await api('terms-write',{change:{action:'split',id,rev:term.rev,values:value.split(/[,，]/).map(item=>item.trim()).filter(Boolean)}});editing=null;await refresh();status('子分类已创建，原关联保留待细分，源文件未改变。');return;
    }
    if(button.hasAttribute('data-edit')){editing=term;editor();dialog.querySelector('[name=value]').focus();return;}
    if(button.hasAttribute('data-retire')){await api('terms-write',{change:{action:term.retired?'restore':'retire',id,rev:term.rev}});editing=null;await refresh();status('已更新状态；已有标签关联和历史检索保留。');return;}
    if(button.hasAttribute('data-merge')){
     const targetValue=await askText({title:'合并自定义标签',message:`将“${term.value}”合并到哪个现有标签？请输入完整名称。来源、已有资产关联和人工排除会保留。`});if(!targetValue)return;
     if(!await askConfirm({title:'确认合并标签',message:`${term.value} → ${targetValue}\n合并会修改此标签的全部关联，无法直接撤销；不会移动源文件。`}))return;
     await api('terms-write',{change:{action:'merge',id,rev:term.rev,targetValue}});editing=null;await refresh();status('标签已合并，旧名称仍可作为别名检索。');
    }
   });
  });
 }
 return {async open(){ensure();if(!dialog.open)dialog.showModal();await run(async()=>{await refresh();status('');});}};
}
