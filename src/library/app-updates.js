/**
 * Desktop-only signed updater.
 *
 * 检查到新版本后自动在后台下载并通过签名验证，界面上只留一个「立即更新」：
 * 点一下就停掉 sidecar、拉起 NSIS 安装器并退出（安装器负责重新启动）。
 * 浏览器模式沿用同一张设置卡，但只读。
 */
export function createAppUpdates({hasActiveTasks=()=>false}={}){
 const card=document.createElement('div');card.className='settings-card';
 card.innerHTML='<h3 class="settings-section-title">软件更新</h3><p data-version>读取当前版本…</p><p data-status role="status" aria-live="polite"></p><progress data-progress hidden style="width:100%"></progress><pre data-notes style="white-space:pre-wrap;font:inherit;max-height:220px;overflow:auto"></pre><div style="display:flex;gap:12px"><button type="button" data-check>检查更新</button><button type="button" data-action hidden>立即更新</button></div><label style="display:flex;gap:8px;margin-top:20px"><input type="checkbox" data-auto>自动检查更新并在后台下载</label>';
 const $=s=>card.querySelector(s),status=$('[data-status]'),check=$('[data-check]'),action=$('[data-action]'),progress=$('[data-progress]'),auto=$('[data-auto]');
 const api=window.__TAURI__;
 let phase='idle',busy=false;
 const preference='assetvault:auto-update-check';
 try{auto.checked=localStorage.getItem(preference)!=='false';}catch{auto.checked=true;}
 auto.onchange=()=>{try{localStorage.setItem(preference,String(auto.checked));}catch{}};
 if(!api?.core?.invoke){$('[data-version]').textContent='浏览器模式';status.textContent='请在 AssetVault 桌面版中检查和安装更新。';check.disabled=auto.disabled=true;return {card,start(){}};}
 const invoke=api.core.invoke;
 const exit=document.createElement('button');exit.type='button';exit.className='secondary';exit.textContent='退出应用';
 const lifecycle=document.createElement('p');lifecycle.className='compact-note';lifecycle.textContent='关闭窗口会收起到系统托盘；彻底退出请点击下方按钮。';
 exit.onclick=async()=>{
  if(hasActiveTasks()&&!confirm('仍有下载或导出任务，退出会中断这些任务。确定退出应用？'))return;
  try{await invoke('quit_app');}catch(error){status.textContent=`退出失败：${String(error)}`;}
 };
 card.append(lifecycle,exit);
 api.app.getVersion().then(v=>{$('[data-version]').textContent=`当前版本 ${v}`;}).catch(()=>{$('[data-version]').textContent='AssetVault 桌面版';});
 function lock(value){busy=value;check.disabled=value;action.disabled=value||phase==='downloading';}
 function renderAction(version){
  const ready=phase==='ready';
  action.hidden=!(ready||phase==='available');
  // 下载失败才降级成「重试下载」；后台自动下载进行中显示不可点的「正在下载…」。
  action.textContent=ready?'立即更新':phase==='available'?'重试下载':'正在下载…';
  action.disabled=busy||phase==='downloading';
  if(ready)status.textContent=`新版本 ${version} 已下载并通过签名验证，点击「立即更新」即可安装。`;
 }
 /**
  * 后台自动下载：静默进行，失败只把按钮降级成「重试下载」，不打断用户。
  */
 async function autoDownload(version){
  if(busy||phase==='ready'||phase==='downloading')return;
  phase='downloading';progress.hidden=false;progress.removeAttribute('value');renderAction(version);
  status.textContent=version?`正在后台下载新版本 ${version}…`:'正在下载更新…';
  try{
   await invoke('download_app_update');
   phase='ready';renderAction(version);
  }catch(error){
   phase='available';renderAction(version);
   status.textContent=`下载失败：${String(error)}。可点击「重试下载」。`;
  }finally{progress.hidden=true;lock(false);}
 }
 async function checkUpdate(background=false){
  if(busy||phase==='ready'||phase==='downloading')return;
  lock(true);status.textContent='正在检查更新…';
  let version='',notes='';
  try{
   const result=await invoke('check_app_update');
   version=result.version||'';notes=result.notes||'';
   $('[data-notes]').textContent=notes;
   if(!result.available){phase='current';action.hidden=true;status.textContent='当前已是最新版本';return;}
   if(result.ready){phase='ready';renderAction(version);return;}
   phase='available';renderAction(version);
   status.textContent=`发现新版本 ${version}`;
   if(background){
    const banner=document.createElement('div');banner.className='app-update-banner';banner.setAttribute('role','status');
    const text=document.createElement('span');text.textContent=`AssetVault ${version} 已发布`;
    const open=document.createElement('button');open.textContent='查看更新';open.onclick=()=>{window.dispatchEvent(new Event('assetvault:open-updates'));banner.remove();};
    const close=document.createElement('button');close.textContent='稍后';close.onclick=()=>banner.remove();banner.append(text,open,close);document.querySelector('.app-update-banner')?.remove();document.body.append(banner);
   }
  }catch(error){
   status.textContent=background?'暂时无法检查更新，可稍后手动重试。':`检查失败：${String(error)}`;
   return;
  }finally{lock(false);}
  // 检查完成、锁已放开，再开始后台下载。
  await autoDownload(version);
 }
 check.onclick=()=>checkUpdate();
 action.onclick=async()=>{
  if(busy)return;
  if(phase==='ready'){
   if(hasActiveTasks()){status.textContent='仍有下载或导出任务，请完成或暂停后再更新。';return;}
   if(!confirm('将退出 AssetVault 并安装更新。请先保存 Blender 等软件中的工作。'))return;
   lock(true);status.textContent='正在启动更新安装器…';
   try{await invoke('install_app_update');}catch(error){status.textContent=`安装失败：${String(error)}`;lock(false);}return;
  }
  if(phase!=='available')return;
  // 手动重试下载：只在自动下载失败后可达。
  await autoDownload('');
 };
 api.event.listen('assetvault:update-progress',({payload})=>{if(payload.total){progress.max=payload.total;progress.value=payload.received;const pct=Math.min(100,Math.floor(payload.received/payload.total*100));if(phase==='downloading')status.textContent=`正在下载更新 ${pct}%`;} }).catch(()=>{});
 return {card,start(){setTimeout(()=>{if(auto.checked)checkUpdate(true);},15000);setInterval(()=>{if(auto.checked)checkUpdate(true);},6*60*60*1000);}};
}