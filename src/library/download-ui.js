import {ACTIVE,WAITING,TERMINAL} from './download-progress.js';
import {createTaskCard} from './download-card.js';
// Only Sketchfab conversion drives a headless browser; ArtStation runs the mviewer CLI, so a
// missing browser must not be reported as a problem for an ArtStation-only queue.
const needsBrowser=j=>j.kind==='sketchfab'&&!TERMINAL.has(j.state);
/** The fields the queue actually needs, nothing more. Every one of them has a consumer server-side:
 *  `assetId` is what Poly Haven / ambientCG jobs are keyed by (missing it = "资产 ID 缺失"),
 *  `hasMarmoset` picks the ArtStation runner (missing it = a 2D artwork sent to the Marmoset
 *  converter), `platform` tells picture jobs which source their pictures live on. The whitelist
 *  exists to keep accidental card baggage (feeds, caches, DOM handles) out of the POST body —
 *  extend it deliberately when the queue learns a new field. */
export const modelPayload=({uid,name,author,license,thumbnail,downloadable,artworkUrl,artId,platform,assetId,assetType,hasMarmoset})=>({uid,name,author,license,thumbnail,downloadable,artworkUrl,artId,platform,assetId,assetType,hasMarmoset});
export function createDownloadUI({$,icon,esc,toast,legacy,requestLegacy,onUpdate,isVisible}){
 const ui={jobs:[],settings:null,connected:false,filter:'all',selected:new Set(),revision:-1,timer:null,pending:false};
 const card=createTaskCard({esc,icon});
 async function api(route='',body){const get=body===undefined;const r=await fetch('/api/downloads'+route,{method:get?'GET':'POST',cache:'no-store',headers:{'X-SFX-Local':'1',...(get&&ui.etag?{'If-None-Match':ui.etag}:{}),...(get?{}:{'Content-Type':'application/json'})},...(get?{}:{body:JSON.stringify(body)})});if(r.status===304)return null;const data=await r.json();if(!r.ok)throw Error(data.error||'下载服务请求失败');if(get)ui.etag=r.headers.get('ETag');return data;}
 function promptForFolder(){
  const status=ui.folderStatus;if(!status||status.ok)return;
  const key=`${status.folder||ui.settings?.folder||''}:${status.code||''}`;if(ui.pathPromptedFor===key)return;ui.pathPromptedFor=key;
  const dialog=$('#download-path-dialog');if(!dialog)return;
  $('#download-path-input').value=ui.settings?.folder||status.folder||'';$('#download-path-error').textContent=status.message||'默认下载路径无法访问，请重新设置。';
  if(dialog.open)return;
  setTimeout(()=>{try{dialog.showModal();$('#download-path-input').focus();}catch{}},0);
 }
 function accept(data){const signature=data.jobs.map(j=>j.id+':'+j.state+':'+j.fileExists).join('|');const changed=signature!==ui.signature;ui.signature=signature;ui.jobs=data.jobs;ui.settings=data.settings;ui.defaultFolder=data.defaultFolder;ui.folderStatus=data.folderStatus||{ok:true};if(ui.folderStatus.ok)ui.pathPromptedFor='';ui.connected=true;ui.browserAvailable=data.browserAvailable;ui.blenderAvailable=data.fbxAvailable;const pathWarning=ui.folderStatus&&!ui.folderStatus.ok?ui.folderStatus.message:'';ui.warning=data.storageError||data.warning||pathWarning||(!data.browserAvailable&&data.jobs.some(needsBrowser)?'未找到后台 Chrome/Edge，Sketchfab 模型转换需要浏览器；ArtStation 转换不受影响。':'');ui.lastWarning=ui.warning;ui.selected=new Set([...ui.selected].filter(id=>ui.jobs.some(j=>j.id===id)));onUpdate(changed);if(isVisible())render();promptForFolder();}
 async function refresh(){if(ui.pending)return;ui.pending=true;try{const data=await api();if(data)accept(data);else{const disconnected=!ui.connected;ui.connected=true;ui.warning=ui.lastWarning||'';if(isVisible()&&(disconnected||ui.jobs.some(j=>ACTIVE.has(j.state))))render();}}catch(e){ui.connected=false;ui.warning='后台服务未连接：'+e.message;if(isVisible())render();}finally{ui.pending=false;}}
 function visible(){return ui.jobs.filter(j=>ui.filter==='all'||ui.filter==='active'&&ACTIVE.has(j.state)||ui.filter==='waiting'&&WAITING.has(j.state)||ui.filter==='saved'&&j.state==='saved'||ui.filter==='failed'&&['failed','interrupted'].includes(j.state)||ui.filter==='cancelled'&&j.state==='cancelled');}
 function renderHeader(){
  $('#task-count').textContent=ui.jobs.length;$('#download-service').innerHTML=`<span class="live-dot"></span>${ui.connected?'后台服务在线 · 关页仍可下载':'等待连接后台服务'}`;
  $('#download-warning').hidden=!ui.warning;$('#download-warning').textContent=ui.warning||'';
  $('#download-folder').textContent=ui.settings?.folder||'正在读取保存目录…';
  // 队列说明原本占一整行，简化后收进暂停键的 title：鼠标停上去就有，不占版面。
  const pause=$('#queue-pause');
  pause.textContent=ui.settings?.paused?'继续排队':'暂停队列';
  pause.title=ui.settings?.paused?'队列已暂停：不会开始新任务，正在执行的任务仍继续。':`最多 ${ui.settings?.concurrency||1} 个任务同时执行 · 关闭本地服务会中断任务`;
  pause.disabled=!ui.connected;
  // 各状态计数并进筛选页签，替掉原先四张统计卡：分组切换时顺手能看到有多少，且不挤占任务列表。
  const groups={all:ui.jobs.length,active:ui.jobs.filter(j=>ACTIVE.has(j.state)).length,waiting:ui.jobs.filter(j=>WAITING.has(j.state)).length,saved:ui.jobs.filter(j=>j.state==='saved').length,failed:ui.jobs.filter(j=>['failed','interrupted'].includes(j.state)).length,cancelled:ui.jobs.filter(j=>j.state==='cancelled').length};
  document.querySelectorAll('[data-task-filter]').forEach(b=>{
   b.classList.toggle('active',b.dataset.taskFilter===ui.filter);
   let count=b.querySelector('.tab-count');
   if(!count){count=document.createElement('b');count.className='tab-count';b.append(count);}
   count.textContent=groups[b.dataset.taskFilter]??0;
  });
 }
 function renderList(){
  // The list is rebuilt every refresh, so which disclosures are open is read back from the DOM
  // and keyed by card position ("details:id"), never by class alone.
  const open=new Set([...document.querySelectorAll('.task details[open]')].map(d=>d.dataset.kind+':'+d.dataset.id));
  const rows=visible();
  $('#tasks').innerHTML=rows.length?[...rows].reverse().map(t=>card(t,{selected:ui.selected.has(t.id),openDetails:open.has('details:'+t.id),openLog:open.has('log:'+t.id)})).join(''):'<div class="tasks-empty">'+icon('download')+'<h3>这个分组暂时没有任务</h3><p>在发现资产或模型库中点击下载，任务会由后台处理。</p></div>';
  $('#task-batch-count').textContent=ui.selected.size;$('#task-batch').hidden=!ui.selected.size;
  $('#legacy-tasks').hidden=!legacy().length;$('#legacy-list').innerHTML=legacy().slice(-30).reverse().map(t=>`<div><span>${esc(t.name)} <small>旧版记录 · 本地文件位置未核实</small></span><button data-legacy-download="${esc(t.uid)}">重新加入后台下载</button></div>`).join('');
 }
 function render(){renderHeader();renderList();}
 async function action(action,id){try{
  if(action==='log'){const t=ui.jobs.find(t=>t.id===id);const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify({...t,logs:undefined},null,2)+'\n\n'+t.logs.join('\n')],{type:'text/plain;charset=utf-8'}));a.href=url;a.download=`assetvault-${t.uid.slice(0,8)}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);return;}
  if(action==='reveal'){await api(`/tasks/${id}/reveal`,{});return;}
  await api(`/tasks/${id}/action`,{action});await refresh();
 }catch(e){toast(e.message);}}
 async function batch(action,ids=[...ui.selected]){if(!ids.length)return;try{const result=await api('/actions',{action,ids});accept(result);ui.selected.clear();render();toast(result.errors.length?`${result.errors.length} 个任务不适用此操作，其余已处理`:'任务操作已完成');}catch(e){toast(e.message);}}
 async function reveal(id){if(!id)throw Error('缺少任务编号');await api(`/tasks/${id}/reveal`,{});}
 /** 手动把已保存的文件送进 Blender：服务端会重新检查文件还在不在，不存在就报错。 */
 async function sendToBlender(id){if(!id)throw Error('缺少任务编号');accept(await api(`/tasks/${id}/send-blender`,{}));}
 async function pickFolder(initial){const data=await api('/pick-folder',{folder:initial||ui.settings?.folder||ui.defaultFolder||''});return data?.cancelled?null:data.folder;}
 async function chooseFolder(input,error){const button=$('#browse-download-path');if(button)button.disabled=true;if(error)error.textContent='';try{const folder=await pickFolder(input.value.trim());if(folder)input.value=folder;}catch(e){if(error)error.textContent=e.message;toast(e.message);}finally{if(button)button.disabled=false;}}
 function setup(){
  $('#tasks').addEventListener('click',e=>{
   const button=e.target.closest('[data-task-disclosure]');if(!button)return;
   const detail=button.closest('.task').querySelector(`details[data-kind="${button.dataset.taskDisclosure}"]`);
   detail.open=!detail.open;button.setAttribute('aria-expanded',String(detail.open));
  });
  document.addEventListener('click',e=>{const filter=e.target.closest('[data-task-filter]');if(filter){ui.filter=filter.dataset.taskFilter;render();}const button=e.target.closest('[data-dm-action]');if(button)action(button.dataset.dmAction,button.dataset.id);const batchButton=e.target.closest('[data-task-batch]');if(batchButton)batch(batchButton.dataset.taskBatch);const old=e.target.closest('[data-legacy-download]');if(old)requestLegacy(old.dataset.legacyDownload);});
  $('#tasks').addEventListener('change',e=>{const id=e.target.dataset.jobSelect;if(id){e.target.checked?ui.selected.add(id):ui.selected.delete(id);render();}});
  $('#task-select-visible').onclick=()=>{for(const t of visible())ui.selected.add(t.id);render();};$('#task-deselect').onclick=()=>{ui.selected.clear();render();};
  $('#queue-pause').onclick=async()=>{try{accept(await api('/settings',{paused:!ui.settings.paused}));}catch(e){toast(e.message);}};
  $('#change-download-folder').onclick=()=>{$('#download-path-input').value=ui.settings?.folder||'';$('#download-path-error').textContent='';$('#download-path-dialog').showModal();};
  $('#save-download-path').onclick=async()=>{const button=$('#save-download-path');button.disabled=true;$('#download-path-error').textContent='';try{await saveSettings({folder:$('#download-path-input').value.trim()});$('#download-path-dialog').close();toast('默认保存路径已更新，新任务将使用此目录');}catch(e){$('#download-path-error').textContent=e.message;}finally{button.disabled=false;}};
  $('#browse-download-path').onclick=()=>chooseFolder($('#download-path-input'),$('#download-path-error'));
  $('#download-refresh').onclick=refresh;$('#open-download-folder').onclick=async()=>{try{await api('/reveal',{});}catch(e){toast(e.message);}};
  $('#clear-tasks').onclick=()=>{if(confirm('清除已结束的后台任务记录？不会删除磁盘文件。'))batch('remove',ui.jobs.filter(t=>TERMINAL.has(t.state)).map(t=>t.id));};
  refresh();ui.timer=setInterval(refresh,750);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
 }
  // `platform` rides along for picture jobs: the queue stores it so a restored job still asks the
  // right source where its pictures live, instead of guessing from the URL shape.
  async function enqueue(models,options,force,folder,kind='sketchfab',extra={}){const result=await api('/tasks',{kind,models:models.map(modelPayload),options,authorized:true,force,folder,...extra});await refresh();return result;}
 async function saveSettings(values){accept(await api('/settings',values));}
 return Object.assign(ui,{render,refresh,setup,enqueue,saveSettings,pickFolder,reveal,sendToBlender,activeCount:()=>ui.jobs.filter(j=>ACTIVE.has(j.state)||WAITING.has(j.state)).length});
}
