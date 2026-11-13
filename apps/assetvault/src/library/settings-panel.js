/** Group the existing settings controls; moving nodes preserves IDs, values and event handlers. */
import {isLanVisitor} from './visitor-mode.js';
import {setupDetailsMotion} from './disclosure-motion.js';
import {icon} from './icon-set.js';
export function createSettingsPanel({$,loadAI,updateCard,sharing,platformCard,autoSave,team,migrate,stores,desktop,appearance,sync}){
 if(isLanVisitor()){
  for(const selector of ['#settings-button','#ai-settings-button','#download-settings','#settings-dialog','#ai-dialog']){
   const node=$(selector);if(node){node.hidden=true;node.inert=true;}
  }
  return {open(){},saveNow(){}};
 }
 const dialog=$('#settings-dialog'),body=dialog.querySelector('.settings-body');
 const cards=[...body.querySelectorAll(':scope > .settings-card')];
 const exportTargets=cards.find(card=>card.querySelector('#export-targets-list'));
 const blenderCard=cards.find(card=>card.querySelector('#blender-bridge-status'));
 if(exportTargets&&blenderCard)exportTargets.append(blenderCard);
 if(exportTargets)exportTargets.querySelector('.compact-note').textContent='Maya、3ds Max、Houdini、Cinema 4D 首次使用需安装接收脚本，并重启对应软件一次。Blender 沿用现有连接；Unity、Unreal、Godot 配置项目目录。';
 const aiCard=$('#ai-dialog .settings-card');
 // 石墨台面：每个分类配一枚图标，左栏靠形状定位，不再是一列同色的字。
 const groups=[
  {id:'export',icon:'export',label:'导出内容',section:'资产管理',description:'模型格式、贴图与新任务默认参数',cards:cards.slice(0,2)},
  {id:'storage',icon:'folder',label:'保存与队列',description:'文件路径、任务并发与重试',cards:cards.slice(4,5)},
  {id:'connections',icon:'cube',label:'软件与环境',section:'服务连接',description:'切换软件，检测安装与连接状态，自动安装导入脚本',cards:exportTargets?[exportTargets,...cards.slice(3,4)]:cards.slice(2,4)},
  ...(platformCard?[{id:'platforms',icon:'globe',label:'平台模块',description:'管理在线资产来源，按需开启平台',cards:[platformCard]}]:[]),
  {id:'ai',icon:'sparkle',label:'AI 接入',description:'模型连接、中文搜索翻译与后续智能整理',cards:[aiCard]},
  ...(sharing?[{id:'sharing',icon:'share',label:'局域网共享',description:'共享访问、密码与连接地址',cards:[sharing.card]}]:[]),
  // 「导出与迁移」卡片跟着 team 页走：它同样只对主机开放，且和备份是同一件事的两个方向。
  ...(team?[{id:'team',icon:'shield',label:'协作与数据',section:'协作与数据',description:'成员角色、访问权限、资产库快照与换机迁移',cards:[team.membersCard,team.backupsCard,...(migrate?[migrate]:[]),...(stores?[stores]:[]),...(sync?[sync.card]:[])]}]:[]),
  ...(()=>{
   // 「应用」页收揽所有整机级开关：更新、开机自启。两者都只在桌面版存在，
   // 浏览器里打开资产库时这个分类整块不出现（不是灰一个开关）。
   const appCards=[...(appearance?[appearance.card]:[]),...(desktop?[desktop.card]:[]),...(updateCard?[updateCard]:[])];
   return appCards.length?[{id:'updates',icon:'refresh',label:'应用',section:'应用',description:'外观、开机启动、版本更新',cards:appCards}]:[];
  })(),
 ];
 const nav=document.createElement('nav');nav.className='settings-categories';nav.setAttribute('aria-label','设置分类');
 const content=document.createElement('div');content.className='settings-content';
 const title=document.createElement('h2');title.className='settings-page-title';
 const description=document.createElement('p');description.className='settings-page-description';
 const pages=document.createElement('div');pages.className='settings-pages';
 content.append(title,description,pages);
 for(const group of groups){
  if(group.section){const heading=document.createElement('p');heading.className='settings-category-label';heading.textContent=group.section;nav.append(heading);}
  const button=document.createElement('button');button.type='button';button.innerHTML=`${icon(group.icon)}<span>${group.label}</span>`;
  button.dataset.settingsPage=group.id;
  button.setAttribute('aria-controls',`settings-page-${group.id}`);nav.append(button);
  const page=document.createElement('section');page.id=`settings-page-${group.id}`;page.setAttribute('aria-label',group.label);page.hidden=true;
  const teamTabs=group.id==='team'?document.createElement('div'):null;
  const teamPanels=[];
  if(teamTabs){teamTabs.className='settings-team-tabs';teamTabs.setAttribute('role','tablist');teamTabs.setAttribute('aria-label','协作与数据分类');page.append(teamTabs);}
  for(const card of group.cards){
   const heading=card.querySelector('.settings-section-title');
   if(!heading){page.append(card);continue;}
   const details=document.createElement('details');details.className='settings-group';details.open=true;
   const summary=document.createElement('summary');summary.append(...heading.childNodes);heading.remove();
   details.append(summary,card);page.append(details);
  }
  if(teamTabs){
   const labels=[['成员权限','shield'],['备份恢复','save'],...(migrate?[['导入导出','export']]:[]),...(stores?[['资产库','folder']]:[]),...(sync?[['云同步','refresh']]:[])];
   const sections=[...page.children].filter(node=>node!==teamTabs);
   const selectTab=index=>{teamPanels.forEach((item,i)=>{const selected=i===index;item.panel.hidden=!selected;item.button.setAttribute('aria-selected',String(selected));item.button.tabIndex=selected?0:-1;});};
   sections.forEach((panel,index)=>{
    const [label,glyph]=labels[index]||['更多','settings'];
    const tab=document.createElement('button');tab.type='button';tab.id=`team-tab-${index}`;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',`team-panel-${index}`);tab.innerHTML=`${icon(glyph)}<span>${label}</span>`;
    panel.id=`team-panel-${index}`;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);
    tab.addEventListener('click',()=>selectTab(index));
    tab.addEventListener('keydown',event=>{const delta={ArrowRight:1,ArrowLeft:-1}[event.key];if(!delta&&event.key!=='Home'&&event.key!=='End')return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?sections.length-1:(index+delta+sections.length)%sections.length;selectTab(next);teamPanels[next].button.focus();});
    teamTabs.append(tab);teamPanels.push({panel,button:tab});
   });
   selectTab(0);
  }
  pages.append(page);group.page=page;group.button=button;
 }
 body.classList.add('settings-layout');body.replaceChildren(nav,content);
 setupDetailsMotion(body);
 /* 标题与侧栏入口统一叫「设置」：这一屏早就不只导出参数（AI、Blender、队列、导出目标都在这儿），
    「导出设置」会让人以为进错了地方。 */
 dialog.querySelector('.dialog-header > span').lastChild.textContent='设置';
 $('#settings-button').childNodes.forEach(node=>{if(node.nodeType===3)node.textContent='设置';});
 $('#ai-settings-button').remove();$('#ai-dialog').remove();
 /* 自动保存：这一屏没有保存键，改完即写盘。
    状态只占标题栏右侧一行小字——「保存中…」常驻到写入完成，「已保存」1.6 秒后自己淡出，
    失败则停在「保存失败」并把原因挂在 title 上，不挡住任何内容。 */
 const stateTag=document.createElement('span');stateTag.className='st-state';stateTag.dataset.state='idle';
 stateTag.setAttribute('role','status');stateTag.setAttribute('aria-live','polite');
 const header=dialog.querySelector('.dialog-header');
 header.insertBefore(stateTag,header.querySelector('[data-close]'));
 // 只有这几个字段由本文件负责写盘；平台开关、局域网共享、AI 密钥各有自己的保存路径。
 const AUTO_FIELDS=new Set(['backend-folder','backend-concurrency','backend-retries','pack-mode','texture-size','scan-limit']);
 let timer=0,saving=false,queued=false,fadeTimer=0;
 function setState(state,text,hold){
  clearTimeout(fadeTimer);
  stateTag.dataset.state=state;stateTag.textContent=text;stateTag.classList.add('is-on');
  if(!hold&&(state==='saved'||state==='idle'))fadeTimer=setTimeout(()=>stateTag.classList.remove('is-on'),1600);
 }
 function isAutoField(node){return !!node&&node.matches('input,select,textarea')&&(AUTO_FIELDS.has(node.id)||node.matches('[data-export-path]'));}
 async function flush(){
  clearTimeout(timer);timer=0;
  if(!autoSave)return;
  if(saving){queued=true;return;}
  saving=true;
  try{
   await autoSave();
   setState('saved','已保存');
  }catch(error){
   saving=false;queued=false;
   setState('error','保存失败',true);
   stateTag.title=error?.message||'';
   return;
  }
  saving=false;
  if(queued){queued=false;await flush();}
 }
 function schedule(delay){
  if(!autoSave)return;
  setState('saving','保存中…',true);
  clearTimeout(timer);timer=setTimeout(flush,delay);
 }
 body.addEventListener('change',event=>{if(isAutoField(event.target))schedule(0);});
 // 路径这类文本字段边打边写会把每一次按键都变成一次请求，等停手 700ms 再写。
 body.addEventListener('input',event=>{if(event.target.tagName==='INPUT'&&isAutoField(event.target))schedule(700);});
 body.addEventListener('focusout',event=>{if(timer&&isAutoField(event.target))flush();});
 // 关窗时把还没落盘的改动写完，不留一个「刚改完就关掉」的空档。
 dialog.addEventListener('close',()=>{if(timer)flush();});
 let aiLoaded=false,currentGroup=null;
 const scrollPositions=new Map();
 function select(id){
  const active=groups.find(group=>group.id===id)||groups[0];
  if(currentGroup)scrollPositions.set(currentGroup.id,content.scrollTop);
  for(const group of groups){group.page.hidden=group!==active;group.button.classList.toggle('active',group===active);group.button.setAttribute('aria-current',group===active?'page':'false');}
  // 平台页自带分组标题与计数器，再顶一行页面标题+描述就是三层重复，整块省掉。
  const compact=active.id==='platforms';
  title.textContent=active.label;description.textContent=active.description;
  title.hidden=compact;description.hidden=compact;
  content.scrollTop=scrollPositions.get(active.id)||0;currentGroup=active;
  // 切分类的过渡：内容淡入并上移 6px，替代原来的硬切。
  active.page.classList.remove('is-in');void active.page.offsetWidth;active.page.classList.add('is-in');
  if(active.id==='ai'&&!aiLoaded){aiLoaded=true;loadAI();}
  if(active.id==='sharing')sharing.load();
  if(active.id==='team')void team?.load();
 }
 nav.addEventListener('click',event=>{const button=event.target.closest('[data-settings-page]');if(button)select(button.dataset.settingsPage);});
 nav.addEventListener('keydown',event=>{
  const index=groups.findIndex(group=>group.button===event.target);if(index<0)return;
  const delta={ArrowDown:1,ArrowRight:1,ArrowUp:-1,ArrowLeft:-1}[event.key];
  if(!delta&&event.key!=='Home'&&event.key!=='End')return;
  event.preventDefault();const next=event.key==='Home'?groups[0]:event.key==='End'?groups.at(-1):groups[(index+delta+groups.length)%groups.length];
  next.button.focus();select(next.id);
 });
 select('export');
 return {open(id='export'){aiLoaded=false;select(id);if(!dialog.open)dialog.showModal();},saveNow:flush};
}
