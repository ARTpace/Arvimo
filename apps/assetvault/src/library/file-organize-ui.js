import {askConfirm,askText} from './ask-dialog.js';

export function createFileOrganizeUi({esc,toast,onOrganized}) {
  let dialog,folder='',rel='',data=null,busy=false,offset=0;
  const api=async(action,input={})=>{
    const response=await fetch('/api/library/file-organize/action',{method:'POST',cache:'no-store',
      headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({action,folder,...input})});
    const result=await response.json();if(!response.ok)throw Error(result.error||`HTTP ${response.status}`);return result;
  };
  const status=message=>{const node=dialog.querySelector('[data-status]');node.textContent=message;node.setAttribute('role','status');};
  function setBusy(value){busy=value;dialog.querySelector('[data-content]').inert=value;}
  async function run(action){if(busy)return;setBusy(true);try{await action();}catch(error){status(error.message);toast?.(error.message);}finally{setBusy(false);}}
  async function refresh() {
    data=await api('list',{rel,offset,limit:300});
    const history=(await api('history')).filter(item=>item.root===folder);
    const parts=rel.split('/').filter(Boolean);
    dialog.querySelector('[data-content]').innerHTML=`
      <div class="fo-root">${esc(folder)}</div>
      <div class="fo-toolbar"><label><input type="checkbox" data-permission ${data.writable?'checked':''}>允许整理源文件</label><button type="button" data-refresh>刷新目录</button><button type="button" data-recover>重试恢复</button></div>
      <p class="compact-note">移动和改名会修改本地原件。仅限同一根目录内、已入库的文件和完整目录；依赖型素材请整包移动。</p>
      <nav class="fo-breadcrumb"><button type="button" data-open="">根目录</button>${parts.map((part,index)=>`<span>/</span><button type="button" data-open="${esc(parts.slice(0,index+1).join('/'))}">${esc(part)}</button>`).join('')}</nav>
      ${data.pending.length?`<p class="fo-error">有 ${data.pending.length} 项未恢复任务，新的整理操作已暂停。可点击“重试恢复”，冲突原因见下方记录。</p>`:''}
      <div class="fo-entries">${data.entries.length?data.entries.map(item=>`<div class="fo-entry" draggable="${data.writable&&!item.linked&&!busy}" data-rel="${esc(item.rel)}" data-directory="${item.directory}">
        ${item.directory&&!item.linked?`<button type="button" class="fo-name" data-open="${esc(item.rel)}">📁 ${esc(item.name)}</button>`:`<span class="fo-name">${item.linked?'↗':'▧'} ${esc(item.name)}</span>`}
        <small>${item.linked?'链接，禁止整理':item.directory?'文件夹':item.managed?'已入库':'尚未入库'}</small>
        <button type="button" data-rename="${esc(item.rel)}" ${!data.writable||item.linked?'disabled':''}>改名</button>
        <button type="button" data-move="${esc(item.rel)}" ${!data.writable||item.linked?'disabled':''}>移动到…</button>
      </div>`).join(''):'<p class="compact-note">此目录为空</p>'}</div>
      <div class="fo-toolbar"><button type="button" data-page="${Math.max(0,offset-300)}" ${offset===0?'disabled':''}>上一页</button><span>${data.total?offset+1:0}–${offset+data.entries.length} / ${data.total}</span><button type="button" data-page="${offset+300}" ${offset+300>=data.total?'disabled':''}>下一页</button><span class="compact-note">可把文件或目录直接拖到目标文件夹或上方路径。</span></div>
      <details open class="fo-history"><summary>最近整理记录</summary>${history.length?history.map(item=>`<div class="fo-record"><span>${esc(item.from)} → ${esc(item.to)}<small>${esc(({'completed':'已完成','undone':'已撤销','cancelled':'已取消','prepared':'处理中','recovery-required':'待恢复'})[item.state]||item.state)}${item.error?' · '+esc(item.error):''}</small></span>${item.state==='completed'?`<button type="button" data-undo="${esc(item.id)}">撤销</button>`:''}</div>`).join(''):'<p class="compact-note">暂无整理记录</p>'}</details>`;
  }
  async function changed(result){await onOrganized?.(result);await refresh();status(`已完成：${result.from} → ${result.to}，同步 ${result.affected} 个资产。`);}
  async function move(from,to) {
    status('正在检查源文件身份和素材依赖…');
    const preview=await api('preview',{from,to});
    let acceptReferenceRisk=false;
    if(preview.warnings?.length) {
      acceptReferenceRisk=await askConfirm({title:'工程引用风险',message:preview.warnings.join('\n')+'\n仍然移动这个完整目录？'});
      if(!acceptReferenceRisk){status('已取消');return;}
    }
    status(`正在移动 ${preview.files} 个文件并同步定位，请稍候…`);
    await changed(await api('move',{from,to,acceptReferenceRisk}));
  }
  function ensure() {
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.className='av-file-organizer';
    dialog.innerHTML='<div class="dialog-header"><span>整理真实文件夹</span><button type="button" class="icon-button" data-close aria-label="关闭">×</button></div><div data-content class="fo-content"></div><p data-status class="fo-status"></p>';
    document.body.appendChild(dialog);
    dialog.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.hasAttribute('data-close')){dialog.close();return;}
      run(async()=>{
        if(button.hasAttribute('data-open')){rel=button.dataset.open;offset=0;await refresh();return;}
        if(button.hasAttribute('data-page')){offset=Number(button.dataset.page);await refresh();return;}
        if(button.hasAttribute('data-refresh')){await refresh();status('目录已刷新');return;}
        if(button.hasAttribute('data-recover')){
          const result=await api('recover');
          for(const item of result.results||[])if(item.changes)await onOrganized?.(item);
          await refresh();status(result.pending.length?`仍有 ${result.pending.length} 项冲突，源文件未被覆盖。`:'恢复检查完成');return;
        }
        if(button.hasAttribute('data-undo')){status('正在验证并撤销…');await changed(await api('undo',{operationId:button.dataset.undo}));return;}
        if(button.hasAttribute('data-rename')) {
          const from=button.dataset.rename,parts=from.split('/');
          const name=await askText({title:'改名',value:parts.at(-1),message:'只修改名称，保留所在目录。'});
          if(name===null||name===parts.at(-1))return;
          if(!name||/[\\/]/.test(name))throw Error('请输入一个名称，不包含路径分隔符');
          parts[parts.length-1]=name;await move(from,parts.join('/'));return;
        }
        if(button.hasAttribute('data-move')) {
          const from=button.dataset.move;
          const target=await askText({title:'移动到文件夹',message:'输入此根目录内的目标相对文件夹，留空表示根目录；目标目录必须已存在。',value:rel});
          if(target===null)return;
          await move(from,(target?target.replace(/\\/g,'/').replace(/\/$/,'')+'/':'')+from.split('/').at(-1));
        }
      });
    });
    dialog.addEventListener('change',event=>{
      if(!event.target.matches('[data-permission]'))return;
      const enabled=event.target.checked;
      run(async()=>{
        if(enabled&&!await askConfirm({title:'允许整理源文件',message:`${folder}\n启用后，移动和改名会直接修改此目录的原文件。启用前会自动备份资产数据库；原件仍需纳入你自己的文件备份。`})){await refresh();return;}
        status(enabled?'正在备份数据库并启用权限…':'正在停用整理权限…');await api('permission',{writable:enabled});await refresh();status(enabled?'已允许整理源文件':'已恢复为只读');
      });
    });
    dialog.addEventListener('dragstart',event=>{
      const row=event.target.closest('.fo-entry');if(!row||busy||!data.writable||row.draggable===false){event.preventDefault();return;}
      event.dataTransfer.setData('application/x-arvimo-file-rel',row.dataset.rel);event.dataTransfer.effectAllowed='move';
    });
    const dropTarget=event=>event.target.closest('[data-open]')||event.target.closest('.fo-entry[data-directory="true"]');
    dialog.addEventListener('dragover',event=>{if(!busy&&data?.writable&&dropTarget(event)&&Array.from(event.dataTransfer.types).includes('application/x-arvimo-file-rel')){event.preventDefault();event.dataTransfer.dropEffect='move';}});
    dialog.addEventListener('drop',event=>{
      const target=dropTarget(event),from=event.dataTransfer.getData('application/x-arvimo-file-rel');if(!target||!from)return;
      event.preventDefault();const to=target.hasAttribute('data-open')?target.dataset.open:target.dataset.rel;
      run(()=>move(from,(to?to+'/':'')+from.split('/').at(-1)));
    });
  }
  return {async open(root){ensure();if(busy)return;folder=root;rel='';offset=0;if(!dialog.open)dialog.showModal();await run(async()=>{status('正在读取目录…');await refresh();status('');});}};
}
