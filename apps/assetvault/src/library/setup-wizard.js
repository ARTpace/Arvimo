/**
 * 首次运行的「依赖准备」弹窗：只确认资产保存位置和后台浏览器。
 * 点「进入工作台」只是记下用户已经看过；「以后再说」延后七天。
 * Blender 与桥接保留在设置页的独立入口，不占首次准备的篇幅。
 */
import {MARK,progressMarkup} from './install-panel.js';

const ROUTE='/api/setup';
const POLL_MS=300;
const INSTALL_TIMEOUT_MS=30*60*1000;
const BADGE={ready:'已就绪',degraded:'可凑合',missing:'待安装',blocked:'待安装'};
const TONE={ready:'ok',degraded:'warn',missing:'warn',blocked:'warn'};

async function request(route='',body){
 const get=body===undefined;
 const response=await fetch(ROUTE+route,{method:get?'GET':'POST',cache:'no-store',
  headers:{'X-SFX-Local':'1',...(get?{}:{'Content-Type':'application/json'})},
  ...(get?{}:{body:JSON.stringify(body||{})})});
 const data=await response.json().catch(()=>null);
 if(!response.ok)throw Error((data&&data.error)||'依赖接口请求失败');
 return data||{};
}

/** 安装任务两条路（浏览器 / 桥接）返回的形状一致，进度就共用这一份渲染。 */
async function pollJob(route,jobId){
 const response=await fetch(`${route}?id=${encodeURIComponent(jobId)}`,{cache:'no-store',headers:{'X-SFX-Local':'1'}});
 const data=await response.json().catch(()=>null);
 if(!response.ok)throw Error((data&&data.error)||'读取安装进度失败');
 return data||{};
}

export function createSetupWizard({$,esc,icon,toast,downloads}){
 const dialog=$('#setup-dialog'),list=$('#setup-list'),note=$('#setup-note'),
       finishButton=$('#setup-finish'),skipButton=$('#setup-skip'),recheckButton=$('#setup-recheck');
 let report=null,busyId=null,token=0;
 const folderInput=$('#setup-download-folder'),folderBrowse=$('#setup-browse-folder'),
       folderSave=$('#setup-save-folder'),folderHint=$('#setup-folder-hint');
 let folderLoaded=false,folderBusy=false;
 async function loadFolder(){
  try{
   if(folderBusy)return;
   const deadline=Date.now()+3000;
   while(downloads.pending&&!downloads.settings&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
   if(!downloads.settings)await downloads.refresh();
   if(!downloads.settings?.folder)throw Error('下载服务尚未就绪，请重新检测');
   // Rechecking dependencies must not overwrite a path the user is editing.
   if(!folderBusy&&(!folderLoaded||folderInput.value===folderInput.dataset.saved)){
    folderInput.value=downloads.settings.folder;folderInput.dataset.saved=folderInput.value;
   }
   folderLoaded=true;folderInput.disabled=false;folderBrowse.disabled=false;folderSave.disabled=false;
   folderHint.textContent='新文件按类型归档，旧文件不受影响。';
  }catch(e){folderHint.textContent='读取保存位置失败：'+String(e.message||e);}
 }
 async function saveFolder(){
  if(folderBusy)return false;
  if(!folderLoaded){folderHint.textContent='请等待下载服务就绪后重新检测。';return false;}
  if(folderInput.value.trim()===folderInput.dataset.saved)return true;
  folderBusy=true;folderInput.disabled=folderBrowse.disabled=folderSave.disabled=true;
  try{
   const folder=folderInput.value.trim();
   if(!folder)throw Error('请选择资产保存文件夹');
   await downloads.saveSettings({folder});
   folderInput.value=downloads.settings.folder;folderInput.dataset.saved=folderInput.value;
   folderHint.textContent='已保存。';return true;
  }catch(e){folderHint.textContent='保存失败：'+String(e.message||e);return false;}
  finally{folderBusy=false;folderInput.disabled=folderBrowse.disabled=folderSave.disabled=false;}
 }
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

 function renderProgress(item,job){
  const box=list?.querySelector(`[data-progress="${item.id}"]`);
  if(!box)return;
  const done=job.state==='ok'||job.state==='partial';
  box.hidden=false;
  box.dataset.state=job.state;
  box.innerHTML=progressMarkup({
   job,esc,
   headTitle:done?'安装完成':job.state==='running'?'正在安装':'安装失败',
   nowLabel:active=>active.detail||active.label,
   resultHtml:`<div class="bridge-result ${job.state==='ok'?'ok':job.state==='partial'?'partial':'failed'}">`
    +`<span class="bridge-result-mark">${done?MARK.check:MARK.cross}</span><div>`
    +`<strong>${done?'装好了':'没装成'}</strong>`
    +`<small>${esc(job.message||'')}</small>`
    +(done?'':`<small class="reason">原因：${esc(job.error||job.message||'后端没有给出原因')}</small>`)
    +`</div></div>`,
  });
 }

 function clearProgress(item){
  const box=list?.querySelector(`[data-progress="${item.id}"]`);
  if(box){box.hidden=true;box.innerHTML='';box.dataset.state='';}
 }

 function actionButton(item){
  if(busyId===item.id)return `<button class="secondary" disabled><i class="spinner"></i>正在处理…</button>`;
  if(item.action==='install'||item.action==='reinstall')return `<button class="secondary" data-setup-install="${item.id}">${icon('download')}${esc(item.actionLabel)}</button>`;
  return '';
 }

 function render(){
  if(!list||!report)return;
  list.innerHTML=(report.items||[]).map(item=>`<li class="setup-item" data-id="${item.id}">`
   +`<div class="bridge-status" data-tone="${TONE[item.state]||'idle'}"><span class="bridge-dot ${TONE[item.state]||'idle'}"></span>`
   +`<div class="bridge-copy"><strong>${esc(item.title)}</strong><small>${esc(item.why)}</small></div>`
   +`<span class="setup-badge ${TONE[item.state]||''}">${esc(BADGE[item.state]||'待检查')}</span></div>`
   +`<p class="setup-detail">${esc(item.detail||'')}</p>`
   +(actionButton(item)?`<div class="setup-item-actions">${actionButton(item)}</div>`:'')
   +`<div class="bridge-progress" data-progress="${item.id}" hidden></div>`
   +`</li>`).join('');
  if(note)note.textContent=report.ready
   ?'都齐了，可以直接开始。'
   :'浏览器还没就位，可以现在装，也可以稍后在设置里补。';
  if(finishButton)finishButton.innerHTML=report.ready?`${icon('check')}进入工作台`:`${icon('arrow-right')}先这样，进入工作台`;
 }

 async function refresh(){
  await loadFolder();
  try{report=await request();render();return report;}
  catch(e){if(note)note.textContent='读不到依赖状态：'+String(e.message||e);return null;}
 }

 async function install(id){
  if(busyId)return;
  const item=(report?.items||[]).find(i=>i.id===id);
  if(!item||!item.poll)return;
  busyId=id;const owner=++token;let failed=false;render();
  try{
   const {jobId}=await request('',{action:'install-browser'});
   if(!jobId)throw Error('后端没有返回安装任务编号');
   let job=null;
   const deadline=Date.now()+INSTALL_TIMEOUT_MS;
   for(;;){
    job=await pollJob(item.poll,jobId);
    renderProgress(item,job);
    if(job.state!=='running')break;
    if(Date.now()>deadline)throw Error('安装任务超时，后端一直没给出结果');
    await sleep(POLL_MS);
   }
   const ok=job&&(job.state==='ok'||job.state==='partial');
   failed=!ok;
   await refresh();
   // 装没装成要看任务状态，不能一律报「已就绪」——否则下载失败时界面会骗人。
   toast(ok?'后台浏览器已就绪':`没装成：${(job&&(job.error||job.message))||'原因未知'}`);
  }catch(e){
   toast(String(e.message||e));
  }finally{
   busyId=null;
   // 失败时把进度条留在原地，错误原因才看得见；成功才收起来。
   if(owner===token){await refresh();if(!failed)clearProgress({id});}
  }
 }

 function open(){
  if(!dialog)return;
  refresh();
  if(!dialog.open)dialog.showModal();
 }

 async function finish(){
  finishButton.disabled=true;
  try{if(await saveFolder()){await request('',{action:'finish'});dialog?.close();}}
  catch(e){toast(String(e.message||e));}
  finally{finishButton.disabled=false;}
 }

 function setup(){
  if(!dialog)return;
  folderSave.onclick=async()=>{if(await saveFolder())toast('资产保存位置已保存');};
  folderBrowse.onclick=async()=>{
   if(folderBusy)return;
   const label=folderBrowse.innerHTML;
   folderBusy=true;folderInput.disabled=folderBrowse.disabled=folderSave.disabled=true;
   folderBrowse.innerHTML=`${icon('folder')}正在选择…`;
   folderHint.textContent='请选择文件夹。';
   try{const folder=await downloads.pickFolder(folderInput.value.trim());if(folder)folderInput.value=folder;}
   catch(e){folderHint.textContent='选择失败：'+String(e.message||e);}
   finally{folderBusy=false;folderBrowse.innerHTML=label;folderInput.disabled=folderBrowse.disabled=folderSave.disabled=false;}
  };
  if(skipButton)skipButton.onclick=async()=>{
   skipButton.disabled=true;
   try{if(await saveFolder()){await request('',{action:'dismiss'});dialog.close();}}
   catch(e){toast('暂缓提醒保存失败：'+String(e.message||e));}
   finally{skipButton.disabled=false;}
  };
  if(finishButton)finishButton.onclick=finish;
  if(recheckButton)recheckButton.onclick=()=>refresh();
  list?.addEventListener('click',e=>{
   const button=e.target.closest('[data-setup-install]');
   if(button){install(button.dataset.setupInstall);return;}
  });
  // Manual open remains available even during the reminder cooldown.
  refresh().then(data=>{if(data?.remind&&!dialog.open)dialog.showModal();});
 }

 return {setup,open,refresh};
}
