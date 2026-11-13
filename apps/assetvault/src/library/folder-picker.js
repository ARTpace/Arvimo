/** ponytail: one read-only picker shared by setup, settings and downloads. */
export function createFolderPicker({icon,esc}){
 let dialog=null,resolveSelection=null,controller=null,revision=0,current=null;
 let address,entries,status,confirm,up;
 function close(value=null){
  revision++;controller?.abort();dialog.close();
  const resolve=resolveSelection;resolveSelection=null;resolve?.(value);
 }
 async function navigate(folder,initial=false){
  const owner=++revision;
  controller?.abort();controller=new AbortController();
  confirm.disabled=true;up.disabled=true;entries.setAttribute('aria-busy','true');
  status.textContent='正在读取文件夹…';entries.replaceChildren();
  try{
   const response=await fetch('/api/downloads/browse-folders',{method:'POST',cache:'no-store',signal:controller.signal,
    headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify({folder,initial})});
   const data=await response.json();
   if(!response.ok)throw Error(data.error||'读取文件夹失败');
   if(owner!==revision)return;
   current=data;address.value=data.folder;
   up.disabled=data.parent===null;confirm.disabled=!data.selectable;
   entries.innerHTML=data.directories.map(item=>`<button type="button" class="folder-picker-entry" data-folder="${esc(item.path)}">${icon('folder')}<span>${esc(item.name)}</span>${icon('chevron-right')}</button>`).join('');
   status.textContent=data.truncated?'仅显示前 2000 个文件夹，可输入完整路径前往。':!data.folder?'请选择磁盘，然后进入资产保存文件夹。':!data.selectable?'请选择磁盘内的文件夹，不支持直接保存到磁盘根目录。':data.directories.length?'点击文件夹进入，确认后将选中当前所在目录。':'此文件夹下没有子文件夹，可以直接选择当前目录。';
  }catch(e){
   if(owner!==revision)return;
   current=null;status.textContent='无法打开：'+String(e.message||e)+'。可输入其他路径或返回磁盘列表。';
  }finally{if(owner===revision)entries.setAttribute('aria-busy','false');}
 }
 function setup(){
  dialog=document.createElement('dialog');dialog.className='folder-picker-dialog';dialog.setAttribute('aria-labelledby','folder-picker-title');
  dialog.innerHTML=`<div class="dialog-header"><span id="folder-picker-title">${icon('folder')}选择资产文件夹</span><button type="button" class="icon-button" data-folder-cancel aria-label="关闭文件夹选择">${icon('close')}</button></div>
   <div class="dialog-body folder-picker-body"><div class="folder-picker-toolbar"><button type="button" class="secondary" data-folder-disks>磁盘</button><button type="button" class="icon-button" data-folder-up aria-label="上一级" title="上一级">${icon('arrow-left')}</button><input type="text" spellcheck="false" aria-label="文件夹完整路径" placeholder="输入完整路径，按回车前往"><button type="button" class="secondary" data-folder-go>前往</button></div>
   <p class="folder-picker-status" role="status" aria-live="polite"></p><div class="folder-picker-entries" aria-label="子文件夹"></div>
   <footer><button type="button" class="secondary" data-folder-cancel>取消</button><button type="button" class="primary" data-folder-confirm disabled>选择此文件夹</button></footer></div>`;
  document.body.append(dialog);
  address=dialog.querySelector('input');entries=dialog.querySelector('.folder-picker-entries');status=dialog.querySelector('[role="status"]');
  confirm=dialog.querySelector('[data-folder-confirm]');up=dialog.querySelector('[data-folder-up]');
  dialog.querySelectorAll('[data-folder-cancel]').forEach(button=>button.onclick=()=>close());
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',()=>{if(resolveSelection)close();});
  dialog.querySelector('[data-folder-disks]').onclick=()=>navigate('');
  up.onclick=()=>{if(current)navigate(current.parent);};
  dialog.querySelector('[data-folder-go]').onclick=()=>navigate(address.value.trim());
  address.oninput=()=>{confirm.disabled=true;};
  address.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();navigate(address.value.trim());}};
  entries.onclick=event=>{const button=event.target.closest('[data-folder]');if(button)navigate(button.dataset.folder);};
  confirm.onclick=()=>{if(!confirm.disabled&&current?.selectable)close(current.folder);};
 }
 return function pickFolder(initial=''){
  if(resolveSelection)return Promise.resolve(null);
  if(!dialog)setup();
  const result=new Promise(resolve=>{resolveSelection=resolve;});
  dialog.showModal();navigate(initial,true);return result;
 };
}
