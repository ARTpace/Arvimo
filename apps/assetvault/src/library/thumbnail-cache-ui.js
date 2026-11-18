export function createThumbnailCacheUi({esc}) {
  let dialog,busy=false;
  const api=async(action,input={})=>{
    const response=await fetch('/api/library/file-organize/action',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({action,...input})});
    const data=await response.json();if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);return data;
  };
  const gb=bytes=>(bytes/1024**3).toFixed(2);
  async function render() {
    const data=await api('cache-stats');
    dialog.querySelector('[data-cache-body]').innerHTML=`<p>${data.count} 张缩略图，占用 ${gb(data.bytes)} GB / 预算 ${gb(data.limit)} GB</p><p class="compact-note">列表统一 384 px，优先 WebP 质量 78；移动改名复用缓存。清理后按需重建，不修改源文件和标签。</p><label>预算（GB） <input type="number" data-budget value="${data.limit/1024**3}" min="0.0625" max="100" step="0.5"></label><button type="button" data-cache-action="cache-budget">保存预算</button><p><button type="button" data-cache-action="cache-prune">清理过期版本</button> <button type="button" data-cache-action="cache-trim">按预算清理</button> <button type="button" data-cache-action="cache-clear">清空缩略图</button></p><p class="compact-note">过期清理核验已入库且已定位的在线源文件；离线、未知身份及旧格式缓存由预算淘汰处理，不依据缓存访问时间猜测版本。</p><p class="compact-note">${esc(data.dir)}</p>`;
  }
  async function run(action) {
    if(busy)return;busy=true;dialog.querySelector('[data-cache-body]').inert=true;
    const status=dialog.querySelector('[data-cache-status]');status.textContent='正在处理…';
    try{status.textContent=await action()||'已完成';}catch(error){status.textContent=error.message;}
    finally{busy=false;dialog.querySelector('[data-cache-body]').inert=false;}
  }
  return {async open(){
    if(!dialog){
      dialog=document.createElement('dialog');dialog.className='av-file-organizer';
      dialog.innerHTML='<div class="dialog-header"><span>缩略图缓存</span><button type="button" class="icon-button" data-cache-close aria-label="关闭">×</button></div><div class="fo-content" data-cache-body></div><p class="fo-status" data-cache-status role="status"></p>';
      document.body.appendChild(dialog);
      dialog.addEventListener('click',event=>{
        const button=event.target.closest('button');if(!button)return;
        if(button.hasAttribute('data-cache-close')){dialog.close();return;}
        const action=button.dataset.cacheAction;if(!action)return;
        run(async()=>{const result=await api(action,action==='cache-budget'?{bytes:Math.round(Number(dialog.querySelector('[data-budget]').value)*1024**3)}:{});await render();return action==='cache-prune'?`已清理 ${result.removed} 个过期版本，释放 ${(result.removedBytes/1024**2).toFixed(1)} MB；核验 ${result.checkedSources} 个在线源，跳过 ${result.skippedSources} 个不可核验源。`:undefined;});
      });
    }
    if(!dialog.open)dialog.showModal();await run(render);
  }};
}
