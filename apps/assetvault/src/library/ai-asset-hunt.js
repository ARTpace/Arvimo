import {visualTagSrc} from './image-src.js';
import {showActionCard} from './action-card.js';

const KEY='av:asset-hunt:v1';
const kinds=[['','全部'],['models','模型'],['textures','材质'],['hdris','HDRI'],['images','图片'],['packs','资源包'],['uielement','UI 元素'],['documents','文档'],['videos','视频'],['audio','音频']];
async function ai(path,input){
 const response=await fetch(`/api/ai/${path}`,{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(path==='rank-sheet'?130000:40000)});
 const data=await response.json();if(!response.ok)throw Error(data.error||'AI 请求失败');return data;
}

/** Fixed batches retain failed image slots; only preview images are fetched, never original packages. */
export async function contactSheet(items,{document:doc=document,fetchImpl=fetch,bitmap=createImageBitmap}={}){
 if(!items.length||items.length>16)throw Error('每张拼图需要 1–16 项');
 const canvas=doc.createElement('canvas');canvas.width=2048;canvas.height=2048;
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('当前环境不支持拼图');
 ctx.fillStyle='#141414';ctx.fillRect(0,0,2048,2048);
 const valid=new Set();let next=0;
 await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
  while(next<items.length){
   const index=next++,item=items[index],x=index%4*512,y=Math.floor(index/4)*512;
   let image;
   try{
    if(!item.thumbnail)throw Error('无封面');
    const response=await fetchImpl(visualTagSrc(item.thumbnail),{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('封面加载失败');
    image=await bitmap(await response.blob());if(!image.width||!image.height)throw Error('无效封面');
    const scale=Math.min(488/image.width,440/image.height);
    const w=image.width*scale,h=image.height*scale;
    ctx.drawImage(image,x+(512-w)/2,y+60+(440-h)/2,w,h);valid.add(index+1);
   }catch{ctx.fillStyle='#777';ctx.font='22px sans-serif';ctx.fillText('无可用封面',x+170,y+270);}
   finally{image?.close();}
   ctx.fillStyle='#000';ctx.fillRect(x+4,y+4,100,52);ctx.fillStyle='#fff';ctx.font='bold 44px sans-serif';ctx.fillText(String(index+1),x+16,y+46);
  }
 }));
 let sheet=canvas.toDataURL('image/jpeg',.82);
 if(sheet.length>5.8*1024*1024)sheet=canvas.toDataURL('image/jpeg',.7);
 if(sheet.length>5.8*1024*1024)throw Error('拼图过大，请减少候选数量');
 return {sheet,valid};
}

/** A single preview gets the full canvas; it never falls back to downloading the original asset. */
export async function singlePreview(item,{document:doc=document,fetchImpl=fetch,bitmap=createImageBitmap}={}){
 if(!item.thumbnail)throw Error('无可用封面');
 const response=await fetchImpl(visualTagSrc(item.thumbnail),{signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('封面加载失败');
 const image=await bitmap(await response.blob());
 try{
  if(!image.width||!image.height)throw Error('无效封面');
  const canvas=doc.createElement('canvas');canvas.width=1536;canvas.height=1536;
  const ctx=canvas.getContext('2d');if(!ctx)throw Error('当前环境不支持单图复核');
  ctx.fillStyle='#141414';ctx.fillRect(0,0,1536,1536);
  const scale=Math.min(1488/image.width,1440/image.height),w=image.width*scale,h=image.height*scale;
  ctx.drawImage(image,(1536-w)/2,72+(1440-h)/2,w,h);ctx.fillStyle='#fff';ctx.font='bold 44px sans-serif';ctx.fillText('1',20,50);
  const sheet=canvas.toDataURL('image/jpeg',.85);if(sheet.length>5.8*1024*1024)throw Error('单图预览过大');return sheet;
 }finally{image.close();}
}

/** A repeat uses the same board/rule/request identities, including a lost create response. */
export async function executeHunt(task,{api,sync,save=()=>{}}){
 if(!task.boardSaved){await api.saveBoard({id:task.boardId,name:task.plan.boardName});task.boardSaved=true;save();}
 if(!task.ruleSaved){await api.saveRule({id:task.ruleId,name:task.plan.boardName,boardId:task.boardId,...task.plan.rule,frequency:task.plan.rule.frequency==='daily'?'daily':'manual',dedupe:'board'});task.ruleSaved=true;save();}
 task.phase='running';save();
 const {run}=await api.runRule(task.ruleId,false,task.requestId);
 if(!run||run.status==='running'||run.status==='interrupted')return run;
 task.phase='syncing';save();await sync();
 task.phase='done';save();return run;
}

export function setupAiAssetHunt({doc=document,hub,state,esc,notify,enabledPlatform=()=>true}){
 const anchor=doc.getElementById('theme-breakdown-btn');if(!anchor)return;
 const button=doc.createElement('button');button.type='button';button.className='hunt-trigger';button.textContent='找资产';button.title='AI 找资产：保存记录并添加到画板';button.setAttribute('aria-label','AI 找资产');anchor.parentElement.after(button);
 const panel=doc.createElement('dialog');panel.className='av-action-card hunt-panel';panel.setAttribute('aria-label','AI 找资产');doc.body.append(panel);
 const api=hub.api;
 let plan=null,platforms=[],busy=false,task=null,run=null,ranked=new Map(),failedVisual=false,goal='';
 try{task=JSON.parse(sessionStorage.getItem(KEY)||'null');}catch{}
 if(task&&(!task.plan?.rule||!task.requestId||!task.boardId||!task.ruleId))task=null;
 const save=()=>{try{sessionStorage.setItem(KEY,JSON.stringify(task));}catch{notify('无法保存任务恢复信息，请保持当前窗口打开');}};
 const message=text=>{const node=panel.querySelector('[data-status]');if(node)node.textContent=text;};
 const sync=async()=>{await hub.collect.syncPending({quiet:true,strict:true});await hub.store.refresh();if(state.route==='library')await state.onRemoteRefresh?.();};
 const setBusy=value=>{busy=value;button.setAttribute('aria-busy',String(value));panel.querySelectorAll('input,select,textarea,[data-keyword],[data-start],[data-reset],[data-recover],[data-visual],[data-detail],[data-schedule],[data-remove],[data-retry-board]').forEach(el=>{el.disabled=value||!!(task&&task.phase!=='done'&&el.closest('.hunt-fields'));});};
 const show=()=>{button.focus();showActionCard(panel);panel.style.maxHeight=`calc(100vh - ${(parseFloat(panel.style.top)||12)+12}px)`;};

 function paint(){
  const locked=!!task&&task.phase!=='done';
  const boards=hub.store.list().filter(board=>!board.smart);
  panel.innerHTML=`<div class="hunt-head"><strong>找资产</strong><button type="button" data-close aria-label="关闭">×</button></div>
   <div class="hunt-fields">
   <label>画板<select data-board ${locked?'disabled':''}><option value="">新建画板</option>${boards.map(b=>`<option value="${esc(b.id)}" ${task?.boardId===b.id?'selected':''}>${esc(b.name)}</option>`).join('')}</select></label>
   <label data-name-row>名称<input data-name maxlength="40" value="${esc(plan?.boardName||task?.plan?.boardName||'')}" ${locked?'disabled':''}></label>
   <label>来源<select data-scope ${locked?'disabled':''}>${[['platform','平台'],['local','资产库'],['both','资产库 + 平台']].map(([id,label])=>`<option value="${id}" ${(plan?.rule.scope||'platform')===id?'selected':''}>${label}</option>`).join('')}</select></label>
   <label>关键词<input data-query maxlength="300" value="${esc(plan?.rule.query||task?.plan?.rule.query||'')}" ${locked?'disabled':''}></label>
   <label>扩展词<input data-queries maxlength="602" placeholder="可选，用分号分隔，最多两项" value="${esc((plan?.rule.queries||[]).join('; '))}" ${locked?'disabled':''}></label>
   ${!locked&&plan?.keywords?.length?`<div class="hunt-keywords">${plan.keywords.map(word=>`<button type="button" data-keyword="${esc(word)}">${esc(word)}</button>`).join('')}</div>`:''}
   <div class="hunt-pair"><label>类型<select data-kind ${locked?'disabled':''}>${kinds.map(([key,label])=>`<option value="${key}" ${key===(plan?.kind||task?.plan?.kind||'')?'selected':''}>${label}</option>`).join('')}</select></label><label>总数<input data-limit type="number" min="1" max="60" value="${plan?.rule.limit||task?.plan?.rule.limit||24}" ${locked?'disabled':''}></label></div>
   <div class="hunt-platforms" role="group" aria-label="搜索平台">${platforms.map(p=>`<label><input data-platform type="checkbox" value="${esc(p.id)}" ${(plan?.rule.platforms||task?.plan?.rule.platforms||[]).includes(p.id)?'checked':''} ${locked?'disabled':''}>${esc(p.label)}</label>`).join('')}</div>
   <label data-budget-row title="每轮平台搜索请求上限，不含 AI 请求">调用上限<input data-budget type="number" min="1" max="12" value="${plan?.rule.maxCalls||12}" ${locked?'disabled':''}></label>
   <label class="hunt-vision" title="仅在应用后端运行时每日收集，不自动调用视觉 AI">每日收集<span><input data-daily type="checkbox" ${task?.plan.rule.frequency==='daily'?'checked':''} ${locked?'disabled':''}><select data-hour aria-label="每日收集时间" ${locked?'disabled':''}>${Array.from({length:24},(_,i)=>`<option value="${i}" ${(plan?.rule.hour??9)===i?'selected':''}>${String(i).padStart(2,'0')}:00</option>`).join('')}</select></span></label>
   <label class="hunt-vision">视觉复核<input data-rank type="checkbox" ${task?.visual?'checked':''} ${locked?'disabled':''} title="上传缩略图拼图给已配置的视觉模型，最多 4 次请求"></label>
   </div>
   <p class="hunt-note">仅保存记录并添加到画板，不下载原文件</p>
   <p data-status role="status">${esc(plan?.degraded?plan.explain:task?'可核对并恢复上次任务':'确认条件后开始查找')}</p>
   <div class="hunt-results" data-results></div>
   <div class="hunt-actions"><button type="button" data-rules>收集规则</button><button type="button" data-reset>新需求</button>${task?'<button type="button" data-recover>核对结果</button>':''}<button type="button" class="primary" data-start>${task&&locked?'继续任务':'添加到画板'}</button><button type="button" data-open ${task?.boardId?'':'hidden'}>打开画板</button></div>`;
  panel.querySelector('[data-close]').onclick=()=>panel.close();
  panel.querySelector('[data-rules]').onclick=()=>{panel.close();hub.openCollect();};
  panel.querySelector('[data-reset]').onclick=()=>{if(busy)return;if(task&&task.phase!=='done'){message('请先核对上次任务状态，避免重复采集');return;}task=null;save();return startPlan();};
  panel.querySelector('[data-start]').onclick=submit;
  panel.querySelectorAll('[data-keyword]').forEach(el=>{el.onclick=()=>{panel.querySelector('[data-query]').value=el.dataset.keyword;};});
  panel.querySelector('[data-recover]')?.addEventListener('click',recover);
  panel.querySelector('[data-open]').onclick=()=>{panel.close();doc.getElementById('search-clear')?.click();hub.openBoard(task.boardId);};
  const board=panel.querySelector('[data-board]');board.onchange=()=>{panel.querySelector('[data-name-row]').hidden=!!board.value;};board.onchange();
  const scope=panel.querySelector('[data-scope]');scope.onchange=()=>{const local=scope.value==='local';panel.querySelector('.hunt-platforms').hidden=local;panel.querySelector('[data-budget-row]').hidden=local;};scope.onchange();
  const daily=panel.querySelector('[data-daily]');daily.onchange=()=>{panel.querySelector('[data-hour]').hidden=!daily.checked;};daily.onchange();
 }
 async function startPlan(){
  const prompt=doc.getElementById('asset-query').value.trim();
  if(!prompt||prompt.length>300){notify('请输入 1–300 字的资产需求');return;}
  goal=prompt;paint();show();message('正在理解需求…');setBusy(true);
  try{
   const [result,status]=await Promise.all([ai('hunt-plan',{prompt,scope:'platform',limit:24}),api.collectStatus()]);
   plan=result;platforms=(status.platforms||[]).filter(p=>p.searchable&&enabledPlatform(p.id));ranked.clear();run=null;paint();
  }catch(error){message(error.message);}finally{setBusy(false);}
 }
 function finish(result){
  panel.querySelectorAll('[data-visual],[data-retry-board],[data-remove],[data-schedule]').forEach(el=>el.remove());
  run=result;
  if(!run){message('未找到运行记录；可继续原任务，不会新建重复画板');return;}
  if(['running','interrupted'].includes(run.status)){
   message(run.status==='running'?'任务仍在运行，可稍后核对结果':'运行曾被中断，已保留画板。请核对板内结果后开启新需求，不自动重跑');
   if(run.status==='interrupted'){task.phase='done';save();}return;
  }
   const warning=run.warnings?.length?`；${run.warnings.join('；')}`:'';
  message(`找到 ${run.found||0} · 已入库 ${run.added||0} · 已入板 ${run.addedUids?.length||0}${warning}`);
  const start=panel.querySelector('[data-start]');start.hidden=false;start.textContent='再找一轮';
  const board=panel.querySelector('[data-board]');
  if(![...board.querySelectorAll('option')].some(option=>option.value===task.boardId)){const option=doc.createElement('option');option.value=task.boardId;option.textContent=task.plan.boardName;board.append(option);}
  board.value=task.boardId;board.onchange();
  if(task.plan.rule.frequency==='daily'){
   const schedule=doc.createElement('button');schedule.type='button';schedule.dataset.schedule='';schedule.textContent='停止每日收集';
   schedule.onclick=async()=>{setBusy(true);try{await api.saveRule({id:task.ruleId,frequency:'manual'});task.plan.rule.frequency='manual';const daily=panel.querySelector('[data-daily]');daily.checked=false;daily.onchange();save();schedule.remove();message('已停止每日收集，本次结果保留');}catch(error){message(error.message);}finally{setBusy(false);}};
   panel.querySelector('.hunt-actions').append(schedule);
  }
  if(run.board?.ok===false&&(run.candidates||[]).length){
   const retry=doc.createElement('button');retry.type='button';retry.dataset.retryBoard='';retry.textContent='重试入板';
   retry.onclick=async()=>{setBusy(true);retry.disabled=true;try{
    const uids=run.candidates.map(x=>x.uid);
    // New memberships on a retry are not an authoritative addedUids snapshot: do not enable removal.
    await api.boardItems(task.boardId,uids,'add');await sync();message('已重试入板；为保护原有成员，本次不提供自动移出建议');retry.remove();
   }catch(e){message(e.message);}finally{setBusy(false);retry.disabled=false;}};
   panel.querySelector('.hunt-actions').append(retry);
  }
  if(run.addedUids?.length){
   const rank=doc.createElement('button');rank.type='button';rank.dataset.visual='';rank.textContent='视觉复核';rank.title=`上传缩略图，最多 ${Math.ceil(run.addedUids.length/16)} 次视觉请求`;
   rank.onclick=()=>rankResults();panel.querySelector('.hunt-actions').append(rank);
  }
 }
 async function submit(){
  if(busy)return;
  if(!task||task.phase==='done'){
   const query=panel.querySelector('[data-query]').value.trim();
   const selected=[...panel.querySelectorAll('[data-platform]:checked')].map(el=>el.value);
   const name=panel.querySelector('[data-name]').value.trim();
   const boardId=panel.querySelector('[data-board]').value;
   const kind=panel.querySelector('[data-kind]').value;
   const limit=Number(panel.querySelector('[data-limit]').value);
   const scope=panel.querySelector('[data-scope]').value,maxCalls=Number(panel.querySelector('[data-budget]').value);
   const queries=panel.querySelector('[data-queries]').value.split(/[;；\n]/).map(q=>q.trim()).filter(Boolean);
   if(scope!=='local'&&selected.length>12){message('每轮最多选择 12 个平台，请减少勾选');return;}
   if(!query||(scope!=='local'&&!selected.length)||!Number.isInteger(limit)||limit<1||limit>60||(!boardId&&!name)||queries.length>2||queries.some(q=>q.length>300)||!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>12){message('请填写名称、关键词及平台；总数 1–60，调用 1–12，扩展词最多两项');return;}
   const id=crypto.randomUUID();
   const ruleId=task?.phase==='done'&&task.boardId===boardId?task.ruleId:`r-hunt-${id}`;
   task={requestId:id,goal:goal||query,boardId:boardId||`c-hunt-${id}`,ruleId,boardSaved:!!boardId,ruleSaved:false,phase:'creating',visual:panel.querySelector('[data-rank]').checked,plan:{boardName:name||hub.store.byId(boardId)?.name||query.slice(0,40),kind,rule:{query,queries,scope,maxCalls,frequency:panel.querySelector('[data-daily]').checked?'daily':'manual',hour:Number(panel.querySelector('[data-hour]').value),platforms:scope==='local'?[]:selected,limit,filters:{kinds:kind?[kind]:[]}}}};plan=task.plan;save();
  }
  paint();setBusy(true);message('正在查找…');
  try{const result=await executeHunt(task,{api,sync,save});finish(result);if(task.visual&&result?.addedUids?.length)await rankResults();}
  catch(error){message(`${error.message}；任务已保留，可点击“核对结果”或继续原任务`);paintRecovery();}
  finally{setBusy(false);}
 }
 function paintRecovery(){if(!panel.querySelector('[data-recover]')){const b=doc.createElement('button');b.type='button';b.textContent='核对结果';b.dataset.recover='';b.onclick=recover;panel.querySelector('.hunt-actions').append(b);}}
 async function recover(){
  if(busy||!task)return;setBusy(true);message('正在核对…');
  try{
   const data=await api.runs(task.ruleId,task.requestId),result=data.runs?.[0];
   if(result&&!['running','interrupted'].includes(result.status)){await sync();task.phase='done';save();}
   finish(result);
  }catch(error){message(error.message);}finally{setBusy(false);}
 }
 async function rankResults(){
  if(!run?.addedUids?.length)return;
  const token=task.requestId;setBusy(true);ranked.clear();failedVisual=false;
  const allowed=new Set(run.addedUids),items=(run.candidates||[]).filter(item=>allowed.has(item.uid));
  const list=panel.querySelector('[data-results]');list.replaceChildren();
  try{
   for(let offset=0;offset<items.length;offset+=16){
    message(`正在复核 ${Math.floor(offset/16)+1}/${Math.ceil(items.length/16)} 批`);
    const batch=items.slice(offset,offset+16),{sheet,valid}=await contactSheet(batch,{document:doc});
    if(!valid.size){failedVisual=true;continue;}
    const result=await ai('rank-sheet',{goal:`${task.goal||task.plan.rule.query}；当前关键词：${task.plan.rule.query}`.slice(0,300),sheet,count:batch.length,cols:4,rows:4});
    if(task.requestId!==token)return;
    if(result.status!=='ok'){failedVisual=true;continue;}
    for(const score of result.scores||[]){if(Number.isInteger(score.index)&&valid.has(score.index)&&batch[score.index-1])ranked.set(batch[score.index-1].uid,score);}
   }
   for(const item of items){
    const row=doc.createElement('div'),score=ranked.get(item.uid);row.className='hunt-score';
    const check=doc.createElement('input');check.type='checkbox';check.dataset.removeUid=item.uid;check.checked=!!score&&score.score<40;
    const label=doc.createElement('label');label.append(check,doc.createTextNode(`${item.name} · ${!score?'未评估':score.score>=70?'推荐':score.score>=40?'待定':'未通过'}${score?` ${score.score}`:''}`));
    const detail=doc.createElement('button');detail.type='button';detail.dataset.detail='';detail.textContent='单图精查';detail.title='仅上传这一张封面，增加一次视觉请求';
    detail.onclick=async()=>{
     if(busy)return;setBusy(true);const requestId=task.requestId;message('正在精查单张封面…');
     try{
      const sheet=await singlePreview(item,{document:doc});
      const result=await ai('rank-sheet',{goal:`${task.goal||task.plan.rule.query}；当前关键词：${task.plan.rule.query}`.slice(0,300),sheet,count:1,cols:1,rows:1});
      if(task.requestId!==requestId)return;
      const score=result.status==='ok'&&result.scores?.find(score=>score.index===1);
      if(!score){message(`单图未完成：${result.note||'无法判断'}；保留已有评分与引用`);return;}
      ranked.set(item.uid,score);check.checked=score.score<40;label.replaceChildren(check,doc.createTextNode(`${item.name} · ${score.score>=70?'推荐':score.score>=40?'待定':'未通过'} ${score.score}`));
      label.title=score.why||'';message(`单图精查 ${score.score} 分；仅手动移出勾选项`);
     }catch(error){message(`单图精查失败：${error.message}；保留引用`);}finally{setBusy(false);}
    };
    row.append(label,detail);list.append(row);
   }
   message(`已复核 ${ranked.size}/${items.length}；${failedVisual?'部分未完成，候选已保留。':''}勾选后仅移出画板引用`);
   panel.querySelector('[data-remove]')?.remove();
   const remove=doc.createElement('button');remove.type='button';remove.dataset.remove='';remove.textContent='移出勾选项';
   remove.onclick=async()=>{const uids=[...list.querySelectorAll('input:checked')].map(el=>el.dataset.removeUid).filter(uid=>allowed.has(uid));if(!uids.length)return;
    setBusy(true);try{await api.boardItems(task.boardId,uids,'remove');run.addedUids=run.addedUids.filter(uid=>!uids.includes(uid));await sync();for(const input of list.querySelectorAll('input'))if(uids.includes(input.dataset.removeUid))input.closest('.hunt-score').remove();message(`已移出 ${uids.length} 项，资产记录仍保留`);}catch(e){message(e.message);}finally{setBusy(false);}};
   panel.querySelector('.hunt-actions').append(remove);
  }catch(error){message(`未完成视觉复核：${error.message}；已保留所有候选`);}finally{setBusy(false);}
 }
 button.onclick=async()=>{
  if(busy){show();return;}
  if(task){plan=task.plan;try{const status=await api.collectStatus();platforms=(status.platforms||[]).filter(p=>p.searchable&&enabledPlatform(p.id));await hub.store.refresh();}catch{}
   paint();show();await recover();return;}
  await hub.store.refresh().catch(()=>{});return startPlan();
 };
 return {button,panel};
}
