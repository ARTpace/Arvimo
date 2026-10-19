/** Desktop-only signed updater. Browser mode keeps the same settings page read-only. */
export function createAppUpdates({hasActiveTasks=()=>false}={}){
 const card=document.createElement('div');card.className='settings-card';
 card.innerHTML='<h3 class="settings-section-title">软件更新</h3><p data-version>读取当前版本…</p><p data-status role="status" aria-live="polite"></p><progress data-progress hidden style="width:100%"></progress><pre data-notes style="white-space:pre-wrap;font:inherit;max-height:220px;overflow:auto"></pre><div style="display:flex;gap:12px"><button type="button" data-check>检查更新</button><button type="button" data-action hidden>下载更新</button></div><label style="display:flex;gap:8px;margin-top:20px"><input type="checkbox" data-auto>自动检查更新并提示</label>';
 const $=s=>card.querySelector(s),status=$('[data-status]'),check=$('[data-check]'),action=$('[data-action]'),progress=$('[data-progress]'),auto=$('[data-auto]');
 const api=window.__TAURI__;
 let phase='idle',busy=false;
 const preference='assetvault:auto-update-check';
 try{auto.checked=localStorage.getItem(preference)!=='false';}catch{auto.checked=true;}
 auto.onchange=()=>{try{localStorage.setItem(preference,String(auto.checked));}catch{}};
 if(!api?.core?.invoke){$('[data-version]').textContent='浏览器模式';status.textContent='请在 AssetVault 桌面版中检查和安装更新。';check.disabled=auto.disabled=true;return {card,start(){}};}
 const invoke=api.core.invoke;
 api.app.getVersion().then(v=>{$('[data-version]').textContent=`当前版本 ${v}`;}).catch(()=>{$('[data-version]').textContent='AssetVault 桌面版';});
 function lock(value){busy=value;check.disabled=value;action.disabled=value;}
 async function checkUpdate(background=false){
  if(busy||phase==='ready')return;
  lock(true);status.textContent='正在检查更新…';
  try{
   const result=await invoke('check_app_update');
   phase=result.available?(result.ready?'ready':'available'):'current';
   status.textContent=result.available?`发现新版本 ${result.version}${result.ready?'，已下载，可重启更新':''}`:'当前已是最新版本';
   $('[data-notes]').textContent=result.notes||'';action.hidden=!result.available;action.textContent=result.ready?'重启并更新':'下载更新';
   if(background&&result.available){
    const banner=document.createElement('div');banner.className='app-update-banner';banner.setAttribute('role','status');
    const text=document.createElement('span');text.textContent=`AssetVault ${result.version} 已发布`;
    const open=document.createElement('button');open.textContent='查看更新';open.onclick=()=>{window.dispatchEvent(new Event('assetvault:open-updates'));banner.remove();};
    const close=document.createElement('button');close.textContent='稍后';close.onclick=()=>banner.remove();banner.append(text,open,close);document.querySelector('.app-update-banner')?.remove();document.body.append(banner);
   }
  }catch(error){status.textContent=background?'暂时无法检查更新，可稍后手动重试。':`检查失败：${String(error)}`;}
  finally{lock(false);}
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
  lock(true);phase='downloading';progress.hidden=false;progress.removeAttribute('value');status.textContent='正在下载并验证更新…';
  try{await invoke('download_app_update');phase='ready';status.textContent='更新已下载并通过签名验证，点击重启并更新。';action.textContent='重启并更新';}
  catch(error){phase='available';status.textContent=`下载失败：${String(error)}，可重试。`;}
  finally{progress.hidden=true;lock(false);}
 };
 api.event.listen('assetvault:update-progress',({payload})=>{if(payload.total){progress.max=payload.total;progress.value=payload.received;status.textContent=`正在下载更新 ${Math.min(100,Math.floor(payload.received/payload.total*100))}%`;} }).catch(()=>{});
 return {card,start(){setTimeout(()=>{if(auto.checked)checkUpdate(true);},15000);setInterval(()=>{if(auto.checked)checkUpdate(true);},6*60*60*1000);}};
}
