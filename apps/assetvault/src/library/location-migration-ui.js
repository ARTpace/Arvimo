export function createLocationMigrationUi({esc,onChanged}){
 let dialog,folder='',offset=0,data,busy=false,controller;
 const labels={'ready':'可校验迁移','path-conflict':'同路径多个身份，需人工处理','invalid-path':'路径无效','invalid-legacy-location':'旧定位字段异常，需人工处理','missing-sha256':'缺少旧 SHA256，不能安全认领'};
 const status=value=>{dialog.querySelector('[data-status]').textContent=value;};
 async function api(action,input={},signal){
  const response=await fetch('/api/library/file-organize/action',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({action,folder,...input}),signal});
  const result=await response.json();if(!response.ok)throw Error(result.error||`HTTP ${response.status}`);return result;
 }
 async function run(fn){if(busy)return;busy=true;dialog.querySelector('[data-body]').inert=true;try{await fn();}catch(error){status(error.name==='AbortError'?'已请求停止；已提交项目保留，请重新检查剩余记录。':error.message);}finally{busy=false;dialog.querySelector('[data-body]').inert=false;controller=null;}}
 async function refresh(){
  data=await api('identity-inspect',{offset,limit:100});
  dialog.querySelector('[data-body]').innerHTML=`<p>${esc(folder)}</p><p class="compact-note">仅迁移已入库、只有旧文件路径的资产：核对旧 SHA256，沿用原 UID，不搬文件。收藏、标签和合集保持。执行前自动备份数据库。未入库扫描卡片不在此列表。</p><div class="fo-toolbar"><button type="button" data-refresh>重新检查</button><button type="button" data-migrate ${data.truncated||!data.items.some(item=>item.code==='ready')?'disabled':''}>迁移本页前 20 个可用项</button></div><p>扫描 ${data.scanned} 条记录；待处理 ${data.total} 项，可校验 ${data.ready} 项。${data.truncated?'审计超过 5 万记录上限，结果不完整，禁止迁移。':''}</p>${data.items.map(item=>`<div class="fo-record"><span><strong>${esc(item.name)}</strong><small>${esc(item.rel)} · ${esc(item.uid)}</small></span><span>${esc(labels[item.code]||item.code)}</span></div>`).join('')||'<p>本页没有待迁移记录</p>'}<div class="fo-toolbar"><button type="button" data-page="${Math.max(0,offset-100)}" ${offset===0?'disabled':''}>上一页</button><span>${offset+data.items.length} / ${data.total}</span><button type="button" data-page="${offset+100}" ${offset+100>=data.total?'disabled':''}>下一页</button></div>`;
 }
 function ensure(){
  if(dialog)return;dialog=document.createElement('dialog');dialog.className='av-file-organizer';
  dialog.innerHTML='<div class="dialog-header"><span>旧路径迁移</span><button type="button" class="icon-button" data-close aria-label="关闭">×</button></div><div class="fo-content" data-body></div><div class="fo-toolbar"><button type="button" data-stop>停止迁移</button></div><p class="fo-status" data-status role="status"></p>';
  document.body.appendChild(dialog);
  const auditButton=document.createElement('button');auditButton.type='button';auditButton.dataset.audit='';auditButton.textContent='全库关联审计';dialog.querySelector('[data-stop]').before(auditButton);
  const auditView=document.createElement('section');auditView.dataset.auditView='';dialog.querySelector('[data-status]').before(auditView);
  dialog.addEventListener('cancel',()=>controller?.abort());
  dialog.addEventListener('click',event=>{
   const button=event.target.closest('button');if(!button)return;
   if(button.hasAttribute('data-close')){controller?.abort();dialog.close();return;}
   if(button.hasAttribute('data-stop')){controller?.abort();return;}
   run(async()=>{
    if(button.hasAttribute('data-audit')){
     const report=await api('identity-audit');dialog.querySelector('[data-audit-view]').textContent=`未知关联 ${report.total} 项（最多显示 100 项）；旧快照重复身份 ${report.duplicateSnapshotUids.length} 组；异常资产载荷 ${report.malformed.length} 项。\n${report.items.map(item=>`${item.kind}：${item.uid}`).join('\n')}\n${report.notes.join('\n')}`;status('只读审计完成，原数据保留。');return;
    }
    if(button.hasAttribute('data-page')){offset=Number(button.dataset.page);await refresh();return;}
    if(button.hasAttribute('data-refresh')){await refresh();status('检查完成；未修改文件和分类。');return;}
    if(button.hasAttribute('data-migrate')){
     const uids=data.items.filter(item=>item.code==='ready').slice(0,20).map(item=>item.uid);controller=new AbortController();
     status('正在备份数据库并逐项核对 SHA256，大文件可能耗时较长，可停止…');
     const result=await api('identity-migrate',{uids},controller.signal);offset=0;await refresh();
     if(result.results.some(item=>item.ok))await onChanged?.();
     status(`成功 ${result.results.filter(item=>item.ok).length} 项；失败 ${result.results.filter(item=>!item.ok).length} 项。${result.results.filter(item=>!item.ok).map(item=>`${item.uid}：${item.error}`).join('\n')}`);
    }
   });
  });
 }
 return {async open(root){ensure();if(busy)return;folder=root;offset=0;if(!dialog.open)dialog.showModal();await run(async()=>{status('正在分页核查旧记录与路径冲突…');await refresh();status('');});}};
}
