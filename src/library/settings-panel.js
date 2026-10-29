/** Group the existing settings controls; moving nodes preserves IDs, values and event handlers. */
import {isLanVisitor} from './visitor-mode.js';
export function createSettingsPanel({$,loadAI,updateCard,sharing,platformCard}){
 if(isLanVisitor()){
  for(const selector of ['#settings-button','#ai-settings-button','#download-settings','#settings-dialog','#ai-dialog']){
   const node=$(selector);if(node){node.hidden=true;node.inert=true;}
  }
  return {open(){}};
 }
 const dialog=$('#settings-dialog'),body=dialog.querySelector('.settings-body');
 const cards=[...body.querySelectorAll(':scope > .settings-card')];
 const exportTargets=cards.find(card=>card.querySelector('#export-targets-list'));
 const blenderCard=cards.find(card=>card.querySelector('#blender-bridge-status'));
 if(exportTargets&&blenderCard)exportTargets.append(blenderCard);
 if(exportTargets)exportTargets.querySelector('.compact-note').textContent='Maya、3ds Max、Houdini、Cinema 4D 首次使用需安装接收脚本，并重启对应软件一次。Blender 沿用现有连接；Unity、Unreal、Godot 配置项目目录。';
 const aiCard=$('#ai-dialog .settings-card');
 const footer=body.querySelector('.settings-footer');
 const groups=[
  {id:'export',label:'导出内容',section:'资产管理',description:'模型格式、贴图与新任务默认参数',cards:cards.slice(0,2)},
  {id:'storage',label:'保存与队列',description:'文件路径、任务并发与重试',cards:cards.slice(4,5)},
  {id:'connections',label:'软件与环境',section:'服务连接',description:'切换软件，检测安装与连接状态，自动安装导入脚本',cards:exportTargets?[exportTargets,...cards.slice(3,4)]:cards.slice(2,4)},
  ...(platformCard?[{id:'platforms',label:'平台模块',description:'管理在线资产来源，按需开启平台',cards:[platformCard]}]:[]),
  {id:'ai',label:'AI 接入',description:'模型连接、中文搜索翻译与后续智能整理',cards:[aiCard]},
  ...(sharing?[{id:'sharing',label:'局域网共享',description:'共享访问、密码与连接地址',cards:[sharing.card]}]:[]),
  ...(updateCard?[{id:'updates',label:'软件更新',section:'应用',description:'检查新版本、下载与安装更新',cards:[updateCard]}]:[]),
 ];
 const nav=document.createElement('nav');nav.className='settings-categories';nav.setAttribute('aria-label','设置分类');
 const content=document.createElement('div');content.className='settings-content';
 const title=document.createElement('h2');title.className='settings-page-title';
 const description=document.createElement('p');description.className='settings-page-description';
 const pages=document.createElement('div');pages.className='settings-pages';
 content.append(title,description,pages,footer);
 for(const group of groups){
  if(group.section){const heading=document.createElement('p');heading.className='settings-category-label';heading.textContent=group.section;nav.append(heading);}
  const button=document.createElement('button');button.type='button';button.textContent=group.label;button.dataset.settingsPage=group.id;
  button.setAttribute('aria-controls',`settings-page-${group.id}`);nav.append(button);
  const page=document.createElement('section');page.id=`settings-page-${group.id}`;page.setAttribute('aria-label',group.label);page.hidden=true;
  for(const card of group.cards){
   const heading=card.querySelector('.settings-section-title');
   if(!heading){page.append(card);continue;}
   const details=document.createElement('details');details.className='settings-group';details.open=true;
   const summary=document.createElement('summary');summary.append(...heading.childNodes);heading.remove();
   details.append(summary,card);page.append(details);
  }
  pages.append(page);group.page=page;group.button=button;
 }
 body.classList.add('settings-layout');body.replaceChildren(nav,content);
 dialog.querySelector('.dialog-header > span').lastChild.textContent='偏好设置';
 $('#settings-button').childNodes.forEach(node=>{if(node.nodeType===3)node.textContent='设置';});
 $('#ai-settings-button').remove();$('#ai-dialog').remove();
 let aiLoaded=false;
 function select(id){
  const active=groups.find(group=>group.id===id)||groups[0];
  for(const group of groups){group.page.hidden=group!==active;group.button.classList.toggle('active',group===active);group.button.setAttribute('aria-current',group===active?'page':'false');}
  // 平台页自带分组标题与计数器，再顶一行页面标题+描述就是三层重复，整块省掉。
  const compact=active.id==='platforms';
  title.textContent=active.label;description.textContent=active.description;
  title.hidden=compact;description.hidden=compact;footer.hidden=['ai','updates','sharing','platforms'].includes(active.id);
  content.scrollTop=0;
  if(active.id==='ai'&&!aiLoaded){aiLoaded=true;loadAI();}
  if(active.id==='sharing')sharing.load();
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
 return {open(id='export'){aiLoaded=false;select(id);if(!dialog.open)dialog.showModal();}};
}
