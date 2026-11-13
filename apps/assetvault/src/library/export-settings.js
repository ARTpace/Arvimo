/** Software tabs keep all path inputs mounted so switching never loses unsaved edits. */
export function exportSettingsHtml(targets,{esc,icon,active='blender'}){
 const tabs=targets.map(t=>`<button type="button" role="tab" id="software-tab-${t.id}" aria-controls="software-panel-${t.id}" aria-selected="${t.id===active}" tabindex="${t.id===active?0:-1}" data-software-tab="${t.id}" class="software-tab${t.id===active?' active':''}">${icon(t.icon||'cube')}<span>${esc(t.label)}</span><small>${t.kind==='bridge'?'场景连接':t.connected?'已连接':t.softwareInstalled?'检测到软件':'待检测 / 配置'}</small></button>`).join('');
 const panels=targets.map(t=>{
  const versions=[...new Set((t.installations||[]).map(item=>item.version?.replace(/_[a-f0-9]+$/i,'')).filter(Boolean))].join(' / ');
  const detected=t.softwareInstalled||t.connected;
  const summary=`${t.detectionPending?'待检测':detected?'已检测到':'未检测到'} ${esc(t.label)}${versions?' · '+esc(versions):''}`;
  let content='';
  if(t.kind==='dcc'){
   const software=summary;
   const script=t.installed?'接收脚本已安装':'接收脚本未安装';
   content=`<div class="software-state bridge-status" data-tone="${detected?'ok':'warn'}"><span class="bridge-dot ${detected?'ok':'warn'}"></span><div class="bridge-copy"><strong>${software}</strong><small>${esc(script)} · ${t.connected?'已连接当前场景':t.installed?'启动或重启软件后连接':'安装后重启软件一次'}</small></div></div>
    <p class="compact-note">${t.profiles?.length?`找到 ${t.profiles.length} 个用户配置，自动安装到对应启动目录，无需手动复制。`:t.softwareInstalled&&['maya','houdini'].includes(t.id)?'自动创建对应版本的用户配置并安装接收脚本。':'首次使用请先启动软件一次，生成用户配置后重新检测。非标准安装位置可能无法自动识别。'}</p>
    <div class="software-actions"><button class="secondary" type="button" data-software-refresh>重新检测</button><button class="primary" type="button" data-dcc-install="${t.id}" ${t.profiles?.length||t.softwareInstalled&&['maya','houdini'].includes(t.id)?'':'disabled'}>${t.installed?'更新接收脚本':'自动安装接收脚本'}</button></div>`;
  }else if(t.kind==='dir')content=`<div class="software-state"><div><strong>${t.softwareInstalled?'已检测到软件':'未检测到软件安装'}</strong><p>将已下载文件交付到项目目录${t.id==='unity'?'，自动配置现有材质与预制体导入脚本':'；不会自动导入当前场景'}。</p></div></div><div class="path-control"><input type="text" aria-label="${esc(t.label)} 项目目录" data-export-path="${t.id}" spellcheck="false" placeholder="项目根目录" value="${esc(t.path||'')}"><button class="secondary" type="button" data-export-browse="${t.id}">${icon('folder')}选择项目</button></div><div class="software-actions"><button class="secondary" type="button" data-software-refresh>重新检测</button></div>`;
  if(t.kind==='dir')content=content.replace(/<div class="software-state">[\s\S]*?<\/div><\/div>/,`<div class="software-state bridge-status" data-tone="${detected?'ok':'warn'}"><span class="bridge-dot ${detected?'ok':'warn'}"></span><div class="bridge-copy"><strong>${summary}</strong><small>将已下载文件交付到项目目录${t.id==='unity'?'，自动配置材质与预制体导入脚本':'；不会自动导入当前场景'}。</small></div></div>`);
  if(t.kind!=='bridge'&&t.installations?.length)content+=`<details class="software-paths"><summary>查看安装路径</summary>${t.installations.map(item=>`<div class="software-installation"><span>${esc(item.executable)}</span></div>`).join('')}</details>`;
  return `<section role="tabpanel" id="software-panel-${t.id}" aria-labelledby="software-tab-${t.id}" data-software-panel="${t.id}" ${t.id===active?'':'hidden'}>${content}</section>`;
 }).join('');
 return `<div class="software-tabs" role="tablist" aria-label="选择软件">${tabs}</div><div class="software-panels">${panels}</div>`;
}

export function selectSoftwareTab(root,id,{focus=false}={}){
 const tabs=[...root.querySelectorAll('[data-software-tab]')];
 if(!tabs.some(tab=>tab.dataset.softwareTab===id))return;
 for(const tab of tabs){const active=tab.dataset.softwareTab===id;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;if(active&&focus)tab.focus();}
 for(const panel of root.querySelectorAll('[data-software-panel]'))panel.hidden=panel.dataset.softwarePanel!==id;
}
