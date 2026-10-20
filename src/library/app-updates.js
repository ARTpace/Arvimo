export function createAppUpdates({hasActiveTasks=()=>false}={}){
 const card=document.createElement('div');card.className='settings-card';
 card.innerHTML='<h3 class="settings-section-title">软件更新</h3><p data-version>读取当前版本…</p><button type="button" data-open>检查与安装更新</button><label style="display:flex;gap:8px;margin-top:20px"><input type="checkbox" data-auto>自动检查更新并在后台下载</label>';
 const dialog=document.createElement('dialog');dialog.className='app-update-dialog';
 dialog.innerHTML='<header><h2>软件更新</h2><button type="button" data-dismiss aria-label="关闭更新窗口">×</button></header><p data-version></p><p data-status role="status" aria-live="polite"></p><progress hidden></progress><pre data-notes></pre><footer><button type="button" data-check>检查更新</button><button type="button" data-install hidden>更新并重启</button></footer>';
 document.body.append(dialog);
 const $=s=>dialog.querySelector(s),status=$('[data-status]'),check=$('[data-check]'),action=$('[data-install]'),progress=$('progress'),auto=card.querySelector('[data-auto]');
 const sidebar=document.querySelector('#sidebar-update'),versionNode=document.querySelector('#app-version');
 const api=window.__TAURI__,preference='assetvault:auto-update-check';
 let phase='idle',busy=false,version='',installAfterDownload=false;
 try{auto.checked=localStorage.getItem(preference)!=='false';}catch{auto.checked=true;}
 auto.onchange=()=>{try{localStorage.setItem(preference,String(auto.checked));}catch{}};
 function open(){if(!dialog.open)dialog.showModal();}
 function sync(){
  const available=['available','downloading','ready'].includes(phase);
  if(sidebar){sidebar.classList.toggle('has-update',available);sidebar.classList.toggle('checking',phase==='checking');sidebar.textContent=available?'↑':'↻';sidebar.title=available?`发现新版本 ${version}，点击更新`:'检查更新';sidebar.setAttribute('aria-label',sidebar.title);}
  check.disabled=busy||phase==='downloading';action.hidden=!available;action.disabled=busy||phase==='downloading';
  action.textContent=phase==='ready'?'安装并重启':phase==='downloading'?'正在下载…':'更新并重启';
 }
 $('[data-dismiss]').onclick=()=>dialog.close();
 if(!api?.core?.invoke){
  if(versionNode)versionNode.textContent='网页版';card.querySelector('[data-version]').textContent='浏览器模式';
  status.textContent='请在 AssetVault 桌面版中检查和安装更新。';check.disabled=action.disabled=auto.disabled=true;
  card.querySelector('[data-open]').onclick=open;if(sidebar)sidebar.onclick=open;
  return {card,open,start(){}};
 }
 const invoke=api.core.invoke;
 api.app.getVersion().then(v=>{
  if(versionNode)versionNode.textContent=`v${v}`;
  for(const node of [card.querySelector('[data-version]'),$('[data-version]')])node.textContent=`当前版本 ${v}`;
 }).catch(()=>{if(versionNode)versionNode.textContent='版本读取失败';});
 const exit=document.createElement('button');exit.type='button';exit.className='secondary';exit.textContent='退出应用';
 exit.onclick=async()=>{if(hasActiveTasks()&&!confirm('仍有下载或导出任务，退出会中断这些任务。确定退出应用？'))return;try{await invoke('quit_app');}catch(error){open();status.textContent=`退出失败：${String(error)}`;}};card.append(exit);
 async function install(){
  if(hasActiveTasks()){status.textContent='仍有下载或导出任务，请完成或暂停后再更新。';return;}
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
 async function checkUpdate(background=false){
  if(busy||phase==='downloading'||phase==='ready')return;
  busy=true;phase='checking';sync();status.textContent='正在检查更新…';let available=false;
  try{
   const result=await invoke('check_app_update');version=result.version||'';$('[data-notes]').textContent=result.notes||'';
   if(!result.available){phase='current';status.textContent='当前已是最新版本';return;}
   available=true;phase=result.ready?'ready':'available';status.textContent=phase==='ready'?`${version} 已就绪，确认后安装并重启。`:`发现新版本 ${version}，确认后更新并重启。`;open();
  }catch(error){phase='error';status.textContent=background?'暂时无法检查更新，可点击侧栏图标重试。':`检查失败：${String(error)}`;}
  finally{busy=false;sync();}
  if(available&&auto.checked&&phase!=='ready')await download();
 }
 action.onclick=async()=>{
  if(busy||phase==='downloading')return;
  if(hasActiveTasks()){status.textContent='仍有下载或导出任务，请完成或暂停后再更新。';return;}
  if(phase==='ready')return install();
  if(phase==='available'){installAfterDownload=true;await download();}
 };
 check.onclick=()=>checkUpdate();
 function manualOpen(){open();if(['idle','current','error'].includes(phase))checkUpdate();}
 card.querySelector('[data-open]').onclick=manualOpen;if(sidebar)sidebar.onclick=manualOpen;
 api.event.listen('assetvault:update-progress',({payload})=>{if(payload.total){progress.max=payload.total;progress.value=payload.received;if(phase==='downloading')status.textContent=`正在下载 ${version} · ${Math.min(100,Math.floor(payload.received/payload.total*100))}%`;}}).catch(()=>{});
 return {card,open:manualOpen,start(){setTimeout(()=>{if(auto.checked)checkUpdate(true);},15000);setInterval(()=>{if(auto.checked)checkUpdate(true);},6*60*60*1000);}};
}
