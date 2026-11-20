import {ACTIVE,WAITING,TERMINAL} from './download-progress.js';
import {captureDownloadFlight} from './download-flight.js';
import {createTaskCard} from './download-card.js';
import {createFolderPicker} from './folder-picker.js';
import {createBrowserDelivery,fetchBrowserAsset} from './browser-delivery.js';
import {createClientDirectory} from './client-directory.js';
import {isLanVisitor} from './visitor-mode.js';
import {askConfirm} from './ask-dialog.js';
// Only Sketchfab conversion drives a headless browser; ArtStation runs the mviewer CLI, so a
// missing browser must not be reported as a problem for an ArtStation-only queue.
const needsBrowser=j=>j.kind==='sketchfab'&&!TERMINAL.has(j.state);
/** The fields the queue actually needs, nothing more. Every one of them has a consumer server-side:
 *  `assetId` is what Poly Haven / ambientCG jobs are keyed by (missing it = "资产 ID 缺失"),
 *  `hasMarmoset` picks the ArtStation runner (missing it = a 2D artwork sent to the Marmoset
 *  converter), `platform` tells picture jobs which source their pictures live on. The whitelist
 *  exists to keep accidental card baggage (feeds, caches, DOM handles) out of the POST body —
 *  extend it deliberately when the queue learns a new field. */
export const modelPayload=({uid,name,author,license,thumbnail,downloadable,artworkUrl,artId,platform,assetId,assetType,sourceType,hasMarmoset,url,tags,elementId,elementType,elementTheme,elementUsername,elementSlug,elementVersion,isTailwind,modelId,versionId,fileId,downloadUrl,civitaiFiles})=>({uid,name,author,license,thumbnail,downloadable,artworkUrl,artId,platform,assetId,assetType,sourceType,hasMarmoset,url,tags:Array.isArray(tags)?tags.slice(0,24):[],...(platform==='uiverse'?{elementId,elementType,elementTheme,elementUsername,elementSlug,elementVersion,isTailwind}:{}),...(platform==='civitai'?{modelId,versionId,fileId,downloadUrl,civitaiFiles:Array.isArray(civitaiFiles)?civitaiFiles.slice(0,30):[]}:{})});
export function createDownloadUI({$,icon,esc,toast,legacy,requestLegacy,onUpdate,isVisible}){
 const visitor=isLanVisitor(),clientDirectory=createClientDirectory();
 const ui={jobs:[],settings:null,connected:false,filter:'all',revision:-1,timer:null,pending:false};
 const card=createTaskCard({esc,icon,visitor}),cardMarkup=new WeakMap();
 const folderPicker=createFolderPicker({esc,icon});
 const directoryReady=visitor?clientDirectory.restore().catch(()=>{}):Promise.resolve();
 let browserStorage;try{browserStorage=window.localStorage;}catch{}
 async function downloadAsset(id){
  await directoryReady;
  const {blob,filename}=await fetchBrowserAsset(id);
  if(visitor&&await clientDirectory.save(blob,filename)){toast('资产已保存到本地文件夹：'+clientDirectory.name);return;}
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  toast('已交给浏览器保存；若被拦截，请允许自动下载');
 }
 const delivery=createBrowserDelivery({storage:browserStorage,forceEnabled:visitor,download:downloadAsset,onError:error=>toast('自动下载失败：'+error.message)});
 async function api(route='',body){const get=body===undefined;const r=await fetch('/api/downloads'+route,{method:get?'GET':'POST',cache:'no-store',headers:{'X-SFX-Local':'1',...(get&&ui.etag?{'If-None-Match':ui.etag}:{}),...(get?{}:{'Content-Type':'application/json'})},...(get?{}:{body:JSON.stringify(body)})});if(r.status===304)return null;const data=await r.json();if(!r.ok)throw Error(data.error||'下载服务请求失败');if(get)ui.etag=r.headers.get('ETag');return data;}
 function promptForFolder(){
  if(visitor)return;
  const status=ui.folderStatus;if(!status||status.ok)return;
  const key=`${status.folder||ui.settings?.folder||''}:${status.code||''}`;if(ui.pathPromptedFor===key)return;ui.pathPromptedFor=key;
  const dialog=$('#download-path-dialog');if(!dialog)return;
  $('#download-path-input').value=ui.settings?.folder||status.folder||'';$('#download-path-error').textContent=status.message||'默认下载路径无法访问，请重新设置。';
  if(dialog.open)return;
  setTimeout(()=>{try{dialog.showModal();$('#download-path-input').focus();}catch{}},0);
 }
 function accept(data){const signature=data.jobs.map(j=>j.id+':'+j.state+':'+j.fileExists).join('|');const changed=signature!==ui.signature;ui.signature=signature;ui.jobs=data.jobs;ui.settings=data.settings;ui.defaultFolder=data.defaultFolder;ui.folderStatus=data.folderStatus||{ok:true};if(ui.folderStatus.ok)ui.pathPromptedFor='';ui.connected=true;ui.browserAvailable=data.browserAvailable;ui.blenderAvailable=data.fbxAvailable;const pathWarning=ui.folderStatus&&!ui.folderStatus.ok?ui.folderStatus.message:'';ui.warning=data.storageError||data.warning||pathWarning||(!data.browserAvailable&&data.jobs.some(needsBrowser)?'未找到后台 Chrome/Edge，Sketchfab 模型转换需要浏览器；ArtStation 转换不受影响。':'');ui.lastWarning=ui.warning;onUpdate(changed);if(isVisible())render();promptForFolder();}
 async function refresh(){if(ui.pending)return ui.pending;ui.pending=(async()=>{try{const data=await api();if(data)accept(data);else{const disconnected=!ui.connected;ui.connected=true;ui.warning=ui.lastWarning||'';if(isVisible()){if(disconnected)renderHeader();if(ui.jobs.some(j=>ACTIVE.has(j.state)))renderList();}}}catch(e){ui.connected=false;ui.warning='后台服务未连接：'+e.message;if(isVisible())renderHeader();}finally{ui.pending=null;}})();return ui.pending;}
 function visible(){return ui.jobs.filter(j=>ui.filter==='all'||ui.filter==='active'&&ACTIVE.has(j.state)||ui.filter==='waiting'&&WAITING.has(j.state)||ui.filter==='saved'&&j.state==='saved'||ui.filter==='failed'&&['failed','interrupted'].includes(j.state)||ui.filter==='cancelled'&&j.state==='cancelled');}
 function renderHeader(){
  $('#task-count').textContent=ui.jobs.length;$('#download-service').innerHTML=`<span class="live-dot"></span>${ui.connected?'在线':'未连接'}`;
  $('#download-service').title=ui.warning||'任务在后台继续处理';
  // 队列说明原本占一整行，简化后收进暂停键的 title：鼠标停上去就有，不占版面。
  const pause=$('#queue-pause');
  pause.textContent=ui.settings?.paused?'继续全部':'暂停全部';
  pause.title=ui.settings?.paused?'继续全部任务；转换任务重新执行，图片任务沿用已有续传机制':'暂停正在执行和等待中的任务；正在提交保存的文件会完成保存';
  pause.disabled=!ui.connected||!!ui.changingPause;
  // 各状态计数并进筛选页签，替掉原先四张统计卡：分组切换时顺手能看到有多少，且不挤占任务列表。
  const groups={all:ui.jobs.length,active:ui.jobs.filter(j=>ACTIVE.has(j.state)).length,waiting:ui.jobs.filter(j=>WAITING.has(j.state)).length,saved:ui.jobs.filter(j=>j.state==='saved').length,failed:ui.jobs.filter(j=>['failed','interrupted'].includes(j.state)).length,cancelled:ui.jobs.filter(j=>j.state==='cancelled').length};
  document.querySelectorAll('[data-task-filter]').forEach(b=>{
   b.classList.toggle('active',b.dataset.taskFilter===ui.filter);
   let count=b.querySelector('.tab-count');
   if(!count){count=document.createElement('b');count.className='tab-count';b.append(count);}
   count.textContent=groups[b.dataset.taskFilter]??0;
  });
 }
 // Preserve controls, loaded images and expanded logs while updating changed text/attributes.
 function patchNode(node,next){
  if(node.isEqualNode(next))return;
  if(node.nodeType!==next.nodeType||node.nodeName!==next.nodeName){node.replaceWith(next);return;}
  if(node.nodeType!==1){node.nodeValue=next.nodeValue;return;}
  for(const attr of [...node.attributes])if(!next.hasAttribute(attr.name))node.removeAttribute(attr.name);
  for(const attr of [...next.attributes])if(node.getAttribute(attr.name)!==attr.value)node.setAttribute(attr.name,attr.value);
  if(node.nodeName==='INPUT')node.checked=next.checked;
  const children=[...node.childNodes],incoming=[...next.childNodes];
  incoming.forEach((child,i)=>{if(children[i])patchNode(children[i],child);else node.append(child);});
  for(const child of children.slice(incoming.length))child.remove();
 }
 function renderList(){
  const rows=visible();
  const list=$('#tasks'),existing=new Map([...list.querySelectorAll(':scope > [data-job]')].map(node=>[node.dataset.job,node]));
  if(!rows.length){if(!list.querySelector('.tasks-empty'))list.innerHTML='<div class="tasks-empty">'+icon('download')+'<h3>这个分组暂时没有任务</h3><p>在发现资产或模型库中点击下载，任务会由后台处理。</p></div>';}
  else{
   list.querySelector('.tasks-empty')?.remove();
   let cursor=list.firstElementChild;
   for(const t of [...rows].reverse()){
    const html=card(t);
    let node=existing.get(t.id);
    if(!node||cardMarkup.get(node)!==html){
    const template=document.createElement('template');
    template.innerHTML=html;
    const next=template.content.firstElementChild;
    if(node)patchNode(node,next);else node=next;
    cardMarkup.set(node,html);
    }
    if(node!==cursor)list.insertBefore(node,cursor);
    cursor=node.nextElementSibling;existing.delete(t.id);
   }
   for(const node of existing.values())node.remove();
  }
  $('#legacy-tasks').hidden=!legacy().length;$('#legacy-list').innerHTML=legacy().slice(-30).reverse().map(t=>`<div><span>${esc(t.name)} <small>旧版记录 · 本地文件位置未核实</small></span><button data-legacy-download="${esc(t.uid)}">重新加入后台下载</button></div>`).join('');
 }
 function render(){renderHeader();renderList();}
 async function action(action,id){try{
  if(action==='download-local'){await downloadAsset(id);return;}
  if(action==='log'){const t=ui.jobs.find(t=>t.id===id);const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify({...t,logs:undefined},null,2)+'\n\n'+t.logs.join('\n')],{type:'text/plain;charset=utf-8'}));a.href=url;a.download=`assetvault-${t.uid.slice(0,8)}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);return;}
  if(action==='convert-fbx'){accept(await api(`/tasks/${id}/convert-fbx`,{}));return;}
  if(action==='reveal'){await api(`/tasks/${id}/reveal`,{});return;}
  await api(`/tasks/${id}/action`,{action});await refresh();
 }catch(e){toast(e.message);}}
 async function batch(action,ids){if(!ids.length)return;try{const result=await api('/actions',{action,ids});accept(result);render();toast(result.errors.length?`${result.errors.length} 个任务不适用此操作，其余已处理`:'任务操作已完成');}catch(e){toast(e.message);}}
 async function reveal(id){if(!id)throw Error('缺少任务编号');await api(`/tasks/${id}/reveal`,{});}
 /** 手动把已保存的文件送进 Blender：服务端会重新检查文件还在不在，不存在就报错。 */
 async function sendToBlender(id){if(!id)throw Error('缺少任务编号');accept(await api(`/tasks/${id}/send-blender`,{}));}
 async function pickFolder(initial){if(visitor)throw Error('访客不能选择主机目录，请在下载管理中指定本机保存位置');return folderPicker(initial||ui.settings?.folder||ui.defaultFolder||'');}
 async function chooseFolder(input,error){const button=$('#browse-download-path');if(button)button.disabled=true;if(error)error.textContent='';try{const folder=await pickFolder(input.value.trim());if(folder)input.value=folder;}catch(e){if(error)error.textContent=e.message;toast(e.message);}finally{if(button)button.disabled=false;}}
 function setup(){
  if(visitor){
   directoryReady.then(()=>renderHeader());
   const dialog=$('#client-download-dialog');
   $('#client-choose-directory').hidden=!clientDirectory.supported;
   $('#client-choose-directory').onclick=async()=>{
    try{await clientDirectory.choose();renderHeader();dialog.close();toast('后续资产将自动保存到：'+clientDirectory.name);}
    catch(error){if(error.name!=='AbortError')toast(error.message);}
   };
  }
  const detailPopup=document.createElement('div');
  detailPopup.id='download-detail-popup';detailPopup.setAttribute('popover','auto');detailPopup.setAttribute('role','dialog');detailPopup.setAttribute('aria-label','下载任务详情');
  document.body.append(detailPopup);
  let detailAnchor=null;
  const placeDetail=()=>{
   if(!detailAnchor||!detailPopup.matches(':popover-open'))return;
   if(!detailAnchor.isConnected){detailPopup.hidePopover();return;}
   const rect=detailAnchor.getBoundingClientRect(),box=detailPopup.getBoundingClientRect(),gap=8,edge=12;
   const left=Math.max(edge,Math.min(rect.right-box.width,window.innerWidth-box.width-edge));
   const top=rect.bottom+gap+box.height<=window.innerHeight-edge?rect.bottom+gap:Math.max(edge,rect.top-gap-box.height);
   detailPopup.style.left=`${left}px`;detailPopup.style.top=`${top}px`;
  };
  window.addEventListener('resize',placeDetail,{passive:true});
  document.addEventListener('scroll',placeDetail,{capture:true,passive:true});
  detailPopup.addEventListener('click',e=>{if(e.target.closest('[data-close-task-detail]'))detailPopup.hidePopover();});
  $('#tasks').addEventListener('click',e=>{
   const button=e.target.closest('[data-task-disclosure]');if(!button)return;
   const task=button.closest('.task'),job=ui.jobs.find(j=>j.id===button.dataset.id);
   detailPopup.innerHTML=`<header><strong>${esc(job?.name||'任务详情')}</strong><button data-close-task-detail aria-label="关闭详情">${icon('close')}关闭</button></header>${task.querySelector('template[data-task-detail]').innerHTML}`;
   detailAnchor=button;detailPopup.showPopover();placeDetail();
  });
  document.addEventListener('click',e=>{const filter=e.target.closest('[data-task-filter]');if(filter){ui.filter=filter.dataset.taskFilter;render();}const button=e.target.closest('[data-dm-action]');if(button)action(button.dataset.dmAction,button.dataset.id);const old=e.target.closest('[data-legacy-download]');if(old)requestLegacy(old.dataset.legacyDownload);});
  $('#queue-pause').onclick=async()=>{const button=$('#queue-pause');if(button.disabled||!ui.settings)return;ui.changingPause=true;button.disabled=true;try{accept(await api('/settings',{paused:!ui.settings.paused}));}catch(e){toast(e.message);}finally{ui.changingPause=false;renderHeader();}};
  $('#save-download-path').onclick=async()=>{const button=$('#save-download-path');button.disabled=true;$('#download-path-error').textContent='';try{await saveSettings({folder:$('#download-path-input').value.trim()});$('#download-path-dialog').close();toast('默认保存路径已更新，新任务将使用此目录');}catch(e){$('#download-path-error').textContent=e.message;}finally{button.disabled=false;}};
  $('#browse-download-path').onclick=()=>chooseFolder($('#download-path-input'),$('#download-path-error'));
  $('#download-refresh').onclick=async()=>{const button=$('#download-refresh');button.disabled=true;try{await refresh();toast(ui.connected?'任务已刷新':'刷新失败，请检查后台服务');}finally{button.disabled=false;}};
  $('#clear-tasks').onclick=async()=>{if(await askConfirm({title: '清除任务记录', message: '清除已结束的后台任务记录？不会删除磁盘文件。', confirmText: '清除', danger: true}))batch('remove',ui.jobs.filter(t=>TERMINAL.has(t.state)).map(t=>t.id));};
  let pollToken=0;
  const poll=async()=>{
   const token=++pollToken;
   clearTimeout(ui.timer);
   await refresh();if(token!==pollToken)return;if(ui.connected)delivery.accept(ui.jobs);
   const active=ui.jobs.some(j=>ACTIVE.has(j.state)||['queued','retry_wait'].includes(j.state));
   // 只在「下载页」且「有活动任务」时才高频（750ms）；离开下载页或空闲都放慢：
   // 轮询本就只为刷新下载页，用户不在那页（在资产库 / 发现页）时用不着拉满频率。
   const onPage=isVisible();
   ui.timer=setTimeout(poll,document.hidden?5000:(onPage?(active?750:3000):(active?4000:8000)));
  };
  poll();document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
 }
  // `platform` rides along for picture jobs: the queue stores it so a restored job still asks the
  // right source where its pictures live, instead of guessing from the URL shape.
  async function enqueue(models,options,force,folder,kind='sketchfab',extra={}){const fly=captureDownloadFlight(models);const result=await api('/tasks',{kind,models:models.map(modelPayload),options,authorized:true,force,folder,...extra});delivery.track(result.added||[]);await refresh();delivery.accept(ui.jobs);if(result.added?.length)fly();return result;}
 async function saveSettings(values){if(visitor)throw Error('访客不能修改主机设置');accept(await api('/settings',values));}
 return Object.assign(ui,{render,refresh,setup,enqueue,saveSettings,pickFolder,reveal,sendToBlender,activeCount:()=>ui.jobs.filter(j=>ACTIVE.has(j.state)||WAITING.has(j.state)).length,saveToClient:downloadAsset});
}
