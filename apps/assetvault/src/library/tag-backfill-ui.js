export function createTagBackfillUi({esc}) {
 let dialog,busy=false,timer,watching=false,channel='taxonomy-existing-tags-v1';
 const stopRefresh=()=>{clearTimeout(timer);timer=null;};
 const modes={
  'taxonomy-existing-tags-v1':{name:'整理已有标签',hint:'同义词合并为标准名称',path:'M20 13l-7 7-10-10V3h7z M7 7h.01'},
  'taxonomy-explicit-metadata-v1':{name:'平台分类',hint:'匹配平台分类和明确元数据',path:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z'},
  'taxonomy-file-text-v1':{name:'文件信息',hint:'从名称、目录和描述匹配标签',path:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5'},
  'taxonomy-split-rules-v1':{name:'规则细分',hint:'按已配置规则补充子分类',path:'M12 3v6 M5 15v-4h14v4 M3 15h4v6H3z M10 3h4 M17 15h4v6h-4z'},
 };
 const glyph=path=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
 const api=async action=>{
  const response=await fetch('/api/library/file-organize/action',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({action,channel}),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);return data;
 };
 async function render(data){
  const state={running:'运行中',paused:'已暂停',completed:'已完成',failed:'失败'};
  const percent=value=>Math.max(0,Math.min(100,data.total?Math.round(value/data.total*100):0));
  const channels=(data.channels||[]).map(item=>{
   const mode=modes[item.id]||{name:item.label,hint:'匹配标准标签',path:modes[channel]?.path||''};
   return `<button type="button" class="lb-mode" data-label-channel="${esc(item.id)}" aria-pressed="${item.id===channel}"><span class="lb-mode-icon">${glyph(mode.path)}</span><strong>${esc(mode.name)}</strong><span class="lb-mode-hint">${esc(mode.hint)}</span><span class="lb-track" aria-hidden="true"><span style="width:${percent(item.covered)}%"></span></span><span class="lb-mode-count">${item.covered} / ${data.total}${item.job?.state==='running'?' · 运行中':''}</span></button>`;
  }).join('');
  const current=modes[channel],running=data.job?.state==='running';
  dialog.querySelector('[data-label-body]').innerHTML=`<div class="lb-modes" aria-label="选择整理方式">${channels}</div>
   <section class="lb-progress"><div class="lb-progress-heading"><strong>${esc(current?.name||'标签整理')}</strong><span class="lb-state ${running?'is-running':''}"><i></i>${esc(state[data.job?.state]||'待开始')}</span></div>
   <div class="lb-numbers"><span>${percent(data.covered)}<small>%</small></span><span>已检查 ${data.covered} / ${data.total} 个资产</span></div>
   <progress max="${data.total||1}" value="${data.covered}" aria-label="资产检查进度"></progress>
   <div class="lb-actions"><button type="button" class="lb-primary" data-label-action="labels-start" ${running||!data.total?'disabled':''}>${glyph('M8 5l11 7-11 7z')}${data.job?'继续整理':'开始整理'}</button><button type="button" data-label-action="labels-pause" ${running?'':'disabled'}>${glyph('M9 5v14 M15 5v14')}暂停</button><button type="button" class="lb-refresh" data-label-action="labels-status" title="刷新进度" aria-label="刷新进度">${glyph('M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 3 M4 15l2 3a7 7 0 0 0 12-1')}</button></div>
   ${data.job?.error?`<p class="fo-error" role="alert">${esc(data.job.error)}</p>`:''}<p class="lb-note">关闭窗口后继续运行 · 不修改人工标签和文件</p></section>
   <div class="lb-footer"><span>词表 v${data.version}</span><span>已排除 ${data.rejections} 项</span><span title="文件信息仅按词语匹配，不理解图片内容；规则细分需先在标签分类管理中配置。">本地处理 · 无 AI 费用</span></div>`;
 }
 async function run(action,background=false){
  if(busy)return;stopRefresh();busy=true;const requestedChannel=channel;
  const body=dialog.querySelector('[data-label-body]');if(!background)body.inert=true;
  try{
   const data=await api(action);
   if(!dialog.open||requestedChannel!==channel)return;
   watching=(data.channels||[{job:data.job}]).some(item=>item.job?.state==='running');
   const active=document.activeElement;
   const focus=body.contains(active)?active?.dataset:null;
   await render(data);
   if(focus?.labelChannel)body.querySelector(`[data-label-channel="${focus.labelChannel}"]`)?.focus();
   else if(focus?.labelAction)body.querySelector(`[data-label-action="${focus.labelAction}"]:not(:disabled)`)?.focus();
   dialog.querySelector('[data-label-status]').textContent='';
  }catch(error){if(dialog.open)dialog.querySelector('[data-label-status]').textContent=error.message;}
  finally{
   busy=false;body.inert=false;
   if(dialog.open){if(requestedChannel!==channel)void run('labels-status');else if(watching)timer=setTimeout(()=>run('labels-status',true),1000);}
  }
 }
 return {async open(){if(!dialog){dialog=document.createElement('dialog');dialog.className='av-file-organizer av-label-panel';dialog.innerHTML='<div class="dialog-header"><span>自动整理标签</span><button type="button" class="icon-button" data-label-close aria-label="关闭">×</button></div><div class="fo-content" data-label-body></div><p class="fo-status" data-label-status role="status"></p>';document.body.appendChild(dialog);dialog.addEventListener('close',()=>{stopRefresh();watching=false;});dialog.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.hasAttribute('data-label-close'))dialog.close();else if(button.dataset.labelChannel){channel=button.dataset.labelChannel;run('labels-status');}else if(button.dataset.labelAction)run(button.dataset.labelAction);});}if(!dialog.open)dialog.showModal();await run('labels-status');}};
}
