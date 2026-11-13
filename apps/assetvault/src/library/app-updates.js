import {icon} from './icon-set.js';
export function createAppUpdates({hasActiveTasks=()=>false,onState=()=>{}}={}){
 const card=document.createElement('div');card.className='settings-card update-card';
 // 三张卡片：主状态（版本 + 检查按钮）、自动检查开关、退出应用。
 // 这里不再放 .settings-section-title —— settings-panel 看到它就会把卡片包进可折叠的 details，
 // 而更新页只有这一张卡，多一层折叠只剩重复的「软件更新」标题（3.19.0 视觉整理）。
 card.innerHTML=[
  '<section class="update-block update-main">',
   `<span class="update-glyph">${icon('rotate')}</span>`,
   '<div class="update-meta"><strong data-version>读取当前版本…</strong><small data-hint>检查是否有新版本可以安装</small></div>',
   '<span class="update-state" data-state>待检查</span>',
   `<button type="button" class="primary" data-open>${icon('rotate')}<span>检查更新</span></button>`,
  '</section>',
  '<section class="update-block">',
   `<span class="update-option-icon">${icon('download')}</span>`,
   '<div class="update-option-text"><strong>自动检查更新</strong><small>启动后在后台静默检查，发现新版本自动下载，安装前仍会确认</small></div>',
   '<label class="update-switch" title="自动检查更新"><input type="checkbox" data-auto><span aria-hidden="true"></span></label>',
  '</section>',
  '<section class="update-block" data-quit-row hidden>',
   `<span class="update-option-icon">${icon('ban')}</span>`,
   '<div class="update-option-text"><strong>退出应用</strong><small>退出会中断正在进行的下载与导出任务</small></div>',
   '<button type="button" class="secondary" data-quit>退出</button>',
  '</section>',
 ].join('');
 const dialog=document.createElement('dialog');dialog.className='app-update-dialog';
 dialog.innerHTML='<header><h2>软件更新</h2><button type="button" data-dismiss aria-label="关闭更新窗口">×</button></header><p data-version></p><p data-status role="status" aria-live="polite"></p><progress hidden></progress><pre data-notes></pre><footer><button type="button" data-check>检查更新</button><button type="button" data-install hidden>更新并重启</button></footer>';
 document.body.append(dialog);
 const $=s=>dialog.querySelector(s),status=$('[data-status]'),check=$('[data-check]'),action=$('[data-install]'),progress=$('progress'),auto=card.querySelector('[data-auto]');
 const stateNode=card.querySelector('[data-state]'),hintNode=card.querySelector('[data-hint]'),ctaNode=card.querySelector('[data-open] span');
 const versionNode=document.querySelector('#app-version');
 const api=window.__TAURI__,preference='assetvault:auto-update-check';
 let phase='idle',busy=false,version='',installAfterDownload=false;
 try{auto.checked=localStorage.getItem(preference)!=='false';}catch{auto.checked=true;}
 auto.onchange=()=>{try{localStorage.setItem(preference,String(auto.checked));}catch{}};
 function open(){if(!dialog.open)dialog.showModal();}
 // 卡片底部那行小字：给一次「什么时候查过」的实感，否则自动检查在后台跑完用户毫无感知。
 function stampHint(){
  if(!hintNode)return;
  const now=new Date();
  hintNode.textContent=`上次检查 ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
 }
 function sync(){
  const available=['available','downloading','ready'].includes(phase);
  queueMicrotask(()=>onState({phase,version,message:status.textContent,available,disabled:busy||phase==='downloading',actionLabel:phase==='ready'?'安装并重启':'更新并重启'}));
  check.disabled=busy||phase==='downloading';action.hidden=!available;action.disabled=busy||phase==='downloading';
  action.textContent=phase==='ready'?'安装并重启':phase==='downloading'?'正在下载…':'更新并重启';
  // 卡片上的状态徽标与主按钮文案跟着 phase 走，避免卡片说「待检查」而侧栏已经在提示有新版本。
  if(stateNode){
   const view={idle:['待检查',''],checking:['检查中…','busy'],current:['已是最新','ok'],available:[`可更新 ${version}`,'new'],downloading:['下载中…','busy'],ready:['等待安装','new'],error:['检查失败','error']}[phase]||['待检查',''];
   stateNode.textContent=view[0];stateNode.className=`update-state${view[1]?` ${view[1]}`:''}`;
  }
  if(ctaNode)ctaNode.textContent=available?'查看更新':'检查更新';
 }
 $('[data-dismiss]').onclick=()=>dialog.close();
 if(!api?.core?.invoke){
  if(versionNode)versionNode.textContent='网页版';card.querySelector('[data-version]').textContent='浏览器模式';
  if(stateNode){stateNode.textContent='不可用';stateNode.className='update-state';}
  if(hintNode)hintNode.textContent='请在 AssetVault 桌面版中检查与安装更新';
  if(ctaNode)ctaNode.textContent='查看说明';
  status.textContent='请在 AssetVault 桌面版中检查和安装更新。';check.disabled=action.disabled=auto.disabled=true;
  card.querySelector('[data-open]').onclick=open;
  return {card,open,check(){onState({phase:'unavailable',message:status.textContent});},update(){},start(){}};
 }
 const invoke=api.core.invoke;
 api.app.getVersion().then(v=>{
  if(versionNode)versionNode.textContent=`v${v}`;
  for(const node of [card.querySelector('[data-version]'),$('[data-version]')])node.textContent=`当前版本 ${v}`;
 }).catch(()=>{if(versionNode)versionNode.textContent='版本读取失败';});
 const quit=card.querySelector('[data-quit]'),quitRow=card.querySelector('[data-quit-row]');
 quitRow.hidden=false;
 quit.onclick=async()=>{if(hasActiveTasks()&&!confirm('仍有下载或导出任务，退出会中断这些任务。确定退出应用？'))return;try{await invoke('quit_app');}catch(error){open();status.textContent=`退出失败：${String(error)}`;}};
 async function install(){
  if(hasActiveTasks()){status.textContent='仍有下载或导出任务，请完成或暂停后再更新。';sync();return;}
  busy=true;sync();status.textContent='正在启动安装器，应用将退出并在更新后重新打开…';
  try{await invoke('install_app_update');}catch(error){status.textContent=`安装失败：${String(error)}。可重试安装。`;busy=false;sync();}
 }
 async function download(){
  if(busy||phase==='downloading'||phase==='ready')return;
  phase='downloading';progress.hidden=false;progress.removeAttribute('value');sync();status.textContent=`正在下载 ${version}，完成后将校验签名…`;
  try{await invoke('download_app_update');phase='ready';status.textContent=`${version} 已下载并通过签名验证。`;}
  catch(error){phase='available';installAfterDownload=false;status.textContent=`下载失败：${String(error)}。点击更新可重试。`;}
  finally{progress.hidden=true;sync();}
  if(phase==='ready'&&installAfterDownload){installAfterDownload=false;await install();}
 }
 async function checkUpdate(background=false,showDialog=true){
  if(busy||phase==='downloading'||phase==='ready'){sync();return;}
  busy=true;phase='checking';sync();status.textContent='正在检查更新…';let available=false;
  try{
   const result=await invoke('check_app_update');version=result.version||'';$('[data-notes]').textContent=result.notes||'';
   if(!result.available){phase='current';status.textContent='当前已是最新版本';return;}
   available=true;phase=result.ready?'ready':'available';status.textContent=phase==='ready'?`${version} 已就绪，确认后安装并重启。`:`发现新版本 ${version}，确认后更新并重启。`;if(!background&&showDialog)open();
  }catch(error){phase='error';status.textContent=background?'暂时无法检查更新，可点击小猫重试。':`检查失败：${String(error)}`;}
  finally{busy=false;sync();stampHint();}
  if(available&&auto.checked&&phase!=='ready')await download();
 }
 action.onclick=async()=>{
  if(busy||phase==='downloading')return;
  if(hasActiveTasks()){status.textContent='仍有下载或导出任务，请完成或暂停后再更新。';sync();return;}
  if(phase==='ready')return install();
  if(phase==='available'){installAfterDownload=true;await download();}
 };
 check.onclick=()=>checkUpdate();
 function manualOpen(){open();if(['idle','current','error'].includes(phase))checkUpdate();}
 card.querySelector('[data-open]').onclick=manualOpen;
 api.event.listen('assetvault:update-progress',({payload})=>{if(payload.total){progress.max=payload.total;progress.value=payload.received;if(phase==='downloading'){status.textContent=`正在下载 ${version} · ${Math.min(100,Math.floor(payload.received/payload.total*100))}%`;sync();}}}).catch(()=>{});
 return {card,open:manualOpen,check:()=>checkUpdate(false,false),update:()=>action.onclick(),start(){setTimeout(()=>{if(auto.checked)checkUpdate(true);},15000);setInterval(()=>{if(auto.checked)checkUpdate(true);},6*60*60*1000);}};
}
