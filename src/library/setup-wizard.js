/**
 * 首次运行的「依赖准备」弹窗。
 *
 * 工作台第一次打开时自己弹出来，把三样东西摆到用户面前：后台浏览器、Blender、
 * Blender 桥接脚本。每一项只回答「有没有 / 缺了会怎样 / 点这里能补上」，
 * 缺的东西就地一键装，Blender 因为只能从官网拿，就给入口加手动路径。
 *
 * 它不是安装校验：点「完成」只是记下「用户已经看过」，缺的依赖之后还能在设置里回来补。
 * 「以后再说」延后七天；只有真正缺失的依赖才会触发自动提醒。
 */
import {openExternal} from './open-url.js';

const ROUTE='/api/setup';
const POLL_MS=300;
const INSTALL_TIMEOUT_MS=30*60*1000;
const MARK={
  check:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  cross:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
};
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

export function createSetupWizard({$,esc,icon,toast}){
 const dialog=$('#setup-dialog'),list=$('#setup-list'),note=$('#setup-note'),
       finishButton=$('#setup-finish'),skipButton=$('#setup-skip'),
       pathInput=$('#setup-blender-path'),pathSave=$('#setup-save-blender'),
       pathHint=$('#setup-blender-hint'),recheckButton=$('#setup-recheck');
 let report=null,busyId=null,token=0;
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

 function stepMark(state){
  if(state==='done')return `<i class="bridge-step-ok">${MARK.check}</i>`;
  if(state==='error')return `<i class="bridge-step-bad">${MARK.cross}</i>`;
  if(state==='active')return '<i class="spinner"></i>';
  return '<i class="bridge-step-idle"></i>';
 }

 function renderProgress(item,job){
  const box=list?.querySelector(`[data-progress="${item.id}"]`);
  if(!box)return;
  const steps=job.steps||[];
  const percent=Math.max(2,Math.min(100,Math.round(job.percent||0)));
  const active=steps.find(s=>s.state==='active');
  const done=job.state==='ok'||job.state==='partial';
  box.hidden=false;
  box.dataset.state=job.state;
  box.innerHTML=`<div class="bridge-progress-head"><span>${done?'安装完成':job.state==='running'?'正在安装':'安装失败'}</span><b>${percent}%</b></div>`
   +`<div class="bridge-progress-track"><span class="bridge-progress-fill" style="width:${percent}%"></span></div>`
   +(job.state==='running'&&active?`<p class="bridge-progress-now"><i class="spinner"></i>${esc(active.detail||active.label)}…</p>`:'')
   +(job.state==='running'?'':`<div class="bridge-result ${job.state==='ok'?'ok':job.state==='partial'?'partial':'failed'}">`
     +`<span class="bridge-result-mark">${done?MARK.check:MARK.cross}</span><div>`
     +`<strong>${done?'装好了':'没装成'}</strong>`
     +`<small>${esc(job.message||'')}</small>`
     +(done?'':`<small class="reason">原因：${esc(job.error||job.message||'后端没有给出原因')}</small>`)
     +`</div></div>`);
 }

 function clearProgress(item){
  const box=list?.querySelector(`[data-progress="${item.id}"]`);
  if(box){box.hidden=true;box.innerHTML='';box.dataset.state='';}
 }

 function actionButton(item){
  if(busyId===item.id)return `<button class="secondary" disabled><i class="spinner"></i>正在处理…</button>`;
  if(item.action==='install'||item.action==='reinstall')return `<button class="secondary" data-setup-install="${item.id}">${icon('download')}${esc(item.actionLabel)}</button>`;
  if(item.action==='manual')return `<button class="secondary" data-setup-open="${item.id}">${icon('globe')}${esc(item.actionLabel)}</button>`;
  return '';
 }

 function render(){
  if(!list||!report)return;
  const items=report.items||[];
  list.innerHTML=items.map(item=>`<li class="setup-item" data-id="${item.id}">`
   +`<div class="bridge-status" data-tone="${TONE[item.state]||'idle'}"><span class="bridge-dot ${TONE[item.state]||'idle'}"></span>`
   +`<div class="bridge-copy"><strong>${esc(item.title)}</strong><small>${esc(item.why)}</small></div>`
   +`<span class="setup-badge ${TONE[item.state]||''}">${esc(BADGE[item.state]||'待检查')}</span></div>`
   +`<p class="setup-detail">${esc(item.detail||'')}</p>`
   +(item.id==='blender'?`<div class="setup-path"><input id="setup-blender-path" type="text" spellcheck="false" placeholder="或者直接粘贴 blender.exe 的完整路径" value="${esc(report.blenderOverride||'')}"><button class="secondary" id="setup-save-blender" type="button">${icon('check')}保存</button></div><p class="setup-hint" id="setup-blender-hint" role="status"></p>`:'')
   +`<div class="setup-item-actions">${actionButton(item)}</div>`
   +`<div class="bridge-progress" data-progress="${item.id}" hidden></div>`
   +`</li>`).join('');
  if(note)note.textContent=report.ready
   ?'三样都齐了，可以直接开始用。'
   :`还有 ${report.pending} 项没就位 —— 现在补上最省事，也可以稍后在「导出设置 → 依赖准备」里再装。`;
  if(finishButton)finishButton.innerHTML=report.ready?`${icon('check')}进入工作台`:`${icon('arrow-right')}先这样，进入工作台`;
  // 列表是重画的，输入框节点换了人，引用要跟着换，否则保存读到的是旧节点。
  bindDynamic();
 }

 function bindDynamic(){
  const input=list?.querySelector('#setup-blender-path');
  const save=list?.querySelector('#setup-save-blender');
  const hint=list?.querySelector('#setup-blender-hint');
  if(save&&input)save.onclick=async()=>{
   save.disabled=true;if(hint)hint.textContent='';
   try{
    const data=await request('',{action:'set-blender',path:input.value.trim()});
    report=data.report||report;render();
    toast(data.applied?'Blender 路径已保存':'已清除手动指定的 Blender 路径');
   }catch(e){if(hint)hint.textContent=String(e.message||e);toast(String(e.message||e));}
   finally{save.disabled=false;}
  };
 }

 async function refresh(){
  try{report=await request();render();return report;}
  catch(e){if(note)note.textContent='读不到依赖状态：'+String(e.message||e);return null;}
 }

 async function install(id){
  if(busyId)return;
  const item=(report?.items||[]).find(i=>i.id===id);
  if(!item||!item.poll)return;
  busyId=id;const owner=++token;let failed=false;render();
  try{
   const {jobId}=await request('',{action:id==='browser'?'install-browser':'install-bridge'});
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
   toast(ok
     ? (id==='browser'?'后台浏览器已就绪':'Blender 桥接脚本已安装')
     : `没装成：${(job&&(job.error||job.message))||'原因未知'}`);
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
  try{await request('',{action:'finish'});}catch(e){toast(String(e.message||e));}
  dialog?.close();
 }

 function setup(){
  if(!dialog)return;
  if(skipButton)skipButton.onclick=async()=>{
   skipButton.disabled=true;
   try{await request('',{action:'dismiss'});dialog.close();}
   catch(e){toast('暂缓提醒保存失败：'+String(e.message||e));}
   finally{skipButton.disabled=false;}
  };
  if(finishButton)finishButton.onclick=finish;
  if(recheckButton)recheckButton.onclick=()=>refresh();
  list?.addEventListener('click',e=>{
   const button=e.target.closest('[data-setup-install]');
   if(button){install(button.dataset.setupInstall);return;}
   const go=e.target.closest('[data-setup-open]');
   if(go){
    const item=(report?.items||[]).find(i=>i.id===go.dataset.setupOpen);
    const url=item?.downloadUrl;
    if(!url)return;
    // 桌面版里 window.open 不会唤起系统浏览器（见 open-url.js 的说明）。
    openExternal(url);
    toast('已用系统默认浏览器打开下载页；没反应就手动访问 blender.org/download');
   }
  });
  // Manual open remains available even during the reminder cooldown.
  refresh().then(data=>{if(data?.remind&&!dialog.open)dialog.showModal();});
 }

 return {setup,open,refresh};
}
