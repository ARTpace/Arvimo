/** Group the existing settings controls; moving nodes preserves IDs, values and event handlers. */
import {isLanVisitor} from './visitor-mode.js';
import {setupDetailsMotion} from './disclosure-motion.js';
import {icon} from './icon-set.js';
import {createLibraryShortcutSettings} from './library-shortcut-settings.js';
export function createSettingsPanel({$,loadAI,updateCard,sharing,platformCard,autoSave,team,migrate,stores,desktop,appearance,sync,ensureCanvas,libraryShortcuts}){
 if(isLanVisitor()){
  for(const selector of ['#settings-button','#ai-settings-button','#download-settings','#settings-dialog','#ai-dialog']){
   const node=$(selector);if(node){node.hidden=true;node.inert=true;}
  }
  return {open(){},saveNow(){}};
 }
 const dialog=$('#settings-dialog'),body=dialog.querySelector('.settings-body');
const cards=[...body.querySelectorAll(':scope > .settings-card')];
const cardOf=selector=>cards.find(card=>card.querySelector(selector));
/* 按控件找卡，而不是按下标切数组：卡一多，下标就会悄悄错位。 */
const introCard=cardOf('#open-setup-wizard');
const exportCard=cardOf('#pack-mode');
const blenderCard=cardOf('#blender-bridge-status');
const runtimeCard=cardOf('#browser-runtime-status');
const storageCard=cardOf('#backend-concurrency');
const exportTargets=cardOf('#export-targets-list');
if(exportTargets)exportTargets.querySelector('.compact-note').textContent='Unity、Unreal、Godot 填工程目录（需含 Assets/），其它软件填内容 / 导入目录。Maya、3ds Max、Houdini、Cinema 4D 首次使用需安装接收脚本，并重启对应软件一次；Blender 沿用下方桥接，无需配置。';
/* AI 页是四张职责单一的卡：启用与接口 / 访问凭据 / 模型 / 连接与索引。 */
const aiCards=[...$('#ai-dialog').querySelectorAll('.settings-card')];
// 石墨台面：每个分类配一枚图标，左栏靠形状定位，不再是一列同色的字。
const groups=[
  /* 导出与保存并入下方「通用」一页，不再单列。 */
  /* 平台模块独立成页：在线平台 / 图站的开关、登录态、配图能力与批量测试都是「这个资产库能连哪些外部站」，
     不再作为资产库的页内标签——那一栏已经装着导出与保存队列了。 */
  ...(platformCard?[{id:'platforms',icon:'globe',label:'平台模块',description:'按需开启在线资产来源；开关改动即时保存，关闭只影响在线检索与解析',cards:[platformCard]}]:[]),
  ...(aiCards.length?[{id:'ai',icon:'sparkle',label:'资产库 AI',description:'把翻译、打标签与语义检索接到你自己的模型服务上',cards:aiCards}]:[]),
  /* 软件连接独立成页：Unity / Unreal / Godot / Maya / 3ds Max / Houdini / Cinema 4D 的导入目录与接收脚本、
     Blender 桥接、后台浏览器，都是「把工作台接到外部软件」这一件事，不再挂在资产库的页内标签里。 */
  ...(exportTargets||blenderCard||runtimeCard?[{id:'software',icon:'cube',label:'软件连接',description:'检测各软件的连接状态、安装接收脚本，并准备后台浏览器运行环境',cards:[exportTargets,blenderCard,runtimeCard].filter(Boolean)}]:[]),
  ...(sharing?[{id:'sharing',icon:'share',label:'局域网共享',description:'共享访问、密码与连接地址',cards:[sharing.card]}]:[]),
  // 「导出与迁移」卡片跟着 team 页走：它同样只对主机开放，且和备份是同一件事的两个方向。
  ...(team?[{id:'team',icon:'folder',label:'资产库',description:'资源库管理、成员权限与备份迁移',cards:[team.membersCard,team.backupsCard,...(migrate?[migrate]:[]),...(stores?[stores]:[]),...(sync?[sync.card]:[])]}]:[]),
  /* 外观、启动、导出、保存都在「通用」一页，一次滚到底，不再拆分类也不留子标签。 */
  ...((appearance||desktop||introCard||exportCard||storageCard)?[{id:'prefs',icon:'settings',label:'通用',description:'',embedSection:'builtin.core-settings.general',cards:[appearance?.card,desktop?.card,introCard,exportCard,storageCard].filter(Boolean)}]:[]),
  ...(updateCard?[{id:'updates',icon:'refresh',label:'软件更新',description:'当前版本、检查更新与自动更新',cards:[updateCard]}]:[]),
];
const shortcutCard=createLibraryShortcutSettings(libraryShortcuts||{getBindings:()=>({}),setBindings:()=>{}});
groups.push({id:'library-hotkeys',icon:'keyboard',label:'资产库',description:'',cards:[shortcutCard]});
/* 左栏是主干：AI 单独一支，排在画布之后；翻译、标签、语义检索都归它，不再挂在「扩展与连接」下。
   平台模块紧接软件连接：一个管「接到哪些外部软件」，一个管「接到哪些外部站」，都在「扩展与连接」之前。 */
const categories=[...(team?[['data','资产库','folder']]:[]),['general','通用','settings'],['hotkeys','快捷键','keyboard'],['canvas','画布','cube'],['ai','AI','sparkle'],['plugins','插件','layers'],['software','软件连接','cube'],...(platformCard?[['platforms','平台模块','globe']]:[]),['extensions','扩展与连接','shapes'],...(updateCard?[['updates','软件更新','refresh']]:[])];
// 这些分类的内容由画布注入，点入口时要确保画布已挂载；未挂载则记下 section id，注册后跳过去。
const canvasEntrySections={hotkeys:'builtin.core-settings.hotkeys',plugins:'builtin.settings-plugins'};
 // Explicit scopes keep plugin names from deciding where settings live.
 const canvasCategories=new Map();
 const categoryOf=id=>canvasCategories.get(id)||({'library-hotkeys':'hotkeys',prefs:'general',general:'general',export:'general',storage:'general',platforms:'platforms',ai:'ai',software:'software',sharing:'extensions',team:'data',startup:'general',updates:'updates',appearance:'general','canvas:loading':'canvas'}[id]||'canvas');
 /* 画布语言 / 快捷键由画布侧挂载，一页只能挂一个，无法和通用页的内置卡片同屏；
    它们本来就是画布设置，统一收到「画布」分类下，通用页保持单页不留子标签。 */
 /* 画布侧这些 section 不挂到资产库设置里：它们要 Electron preload 的桥，网页画布拿不到。 */
 const CANVAS_HIDDEN_SECTIONS=new Set(['builtin.config-manager.presets','builtin.config-manager.storage']);
 const canvasDefaults={
  'general':['canvas','画布通用'],
  // 语言 section 已嵌入「通用」页，不再单独成页。
  'builtin.core-settings.hotkeys':['canvas','画布'],
  'builtin.core-settings.ai':['ai','画布 Gemini 密钥'],
  'builtin.settings-ai-models':['ai','画布 AI 模型'],
  'builtin.asset-library.panel':['extensions','画布素材来源'],
  'builtin.settings-plugins':['extensions','插件'],
  'builtin.headless.mcp':['extensions','MCP'],
 };

 const nav=document.createElement('nav');nav.className='settings-categories';nav.setAttribute('aria-label','设置分类');
 const navSearch=document.createElement('label');navSearch.className='settings-nav-search';navSearch.innerHTML=`${icon('search')}<input type="search" placeholder="搜索设置项" aria-label="搜索设置项">`;nav.append(navSearch);
 const content=document.createElement('div');content.className='settings-content';
 const title=document.createElement('h2');title.className='settings-page-title';
 const description=document.createElement('p');description.className='settings-page-description';
 const subnav=document.createElement('div');subnav.className='settings-unified-tabs';
 const pages=document.createElement('div');pages.className='settings-pages';
 content.append(title,description,subnav,pages);
 for(const group of groups){

  const button=document.createElement('button');button.type='button';button.innerHTML=`${icon(group.icon)}<span>${group.label}</span>`;
  button.dataset.settingsPage=group.id;
  button.setAttribute('aria-controls',`settings-page-${group.id}`);subnav.append(button);
  const page=document.createElement('section');page.id=`settings-page-${group.id}`;page.setAttribute('aria-label',group.label);page.hidden=true;
  const teamTabs=group.id==='team'?document.createElement('div'):null;
  const teamPanels=[];
  if(teamTabs){teamTabs.className='settings-team-tabs';teamTabs.setAttribute('role','tablist');teamTabs.setAttribute('aria-label','协作与数据分类');page.append(teamTabs);}
  let pinnedStore=null;
  for(const card of group.cards){
   const heading=card.querySelector('.settings-section-title');
   if(group.id==='prefs'){
    // 通用页平铺：分区标题提到卡片外做小标题，不再套 details 的折叠箭头。
    if(heading){heading.remove();page.append(heading);}
    page.append(card);continue;
   }
   // 资产库页的资源库卡片是核心，常驻在 tab 栏上方，不参与 tab 切换。
   if(group.id==='team'&&card===stores&&heading){
    const details=document.createElement('details');details.className='settings-group settings-pinned-store';details.open=true;
    const summary=document.createElement('summary');summary.append(...heading.childNodes);heading.remove();
    details.append(summary,card);page.insertBefore(details,teamTabs);pinnedStore=details;continue;
   }
   if(!heading){page.append(card);continue;}
   const details=document.createElement('details');details.className='settings-group';details.open=true;
   const summary=document.createElement('summary');summary.append(...heading.childNodes);heading.remove();
   details.append(summary,card);page.append(details);
  }
  if(teamTabs){
   // 资源库已常驻顶部，tab 只留成员权限 / 备份恢复 / 导入导出 / 云同步。
   const labels=[['成员权限','shield'],['备份恢复','save'],...(migrate?[['导入导出','export']]:[]),...(sync?[['云同步','refresh']]:[])];
   const sections=[...page.children].filter(node=>node!==teamTabs&&node!==pinnedStore);
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
  // 画布侧按 settings-page-${id} 找容器并 portal 内容；给通用页留一个语言槽位，语言就和外观/启动同屏了。
  if(group.embedSection){const slot=document.createElement('div');slot.id=`settings-page-${group.embedSection}`;slot.className='settings-canvas-slot';page.append(slot);}
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
 const AUTO_FIELDS=new Set(['backend-concurrency','backend-retries','pack-mode','texture-size','scan-limit']);
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
 let aiLoaded=false,currentGroup=null,pendingSelect=null;
 const scrollPositions=new Map();
 /* 外观与启动已合成「通用」一页：旧代码里传 appearance / startup 的入口在这里归并。 */
 const pageAlias={appearance:'prefs',startup:'prefs',export:'prefs',storage:'prefs','builtin.core-settings.general':'prefs'};
 function select(id){
  const active=groups.find(group=>group.id===(pageAlias[id]||id))||groups[0];
  const category=categoryOf(active.id);
  for(const button of nav.querySelectorAll('[data-category]'))button.classList.toggle('active',button.dataset.category===category);
  for(const group of groups)group.button.hidden=categoryOf(group.id)!==category;
  // 通用页把语言 section 嵌进同屏槽位：选中它时派发语言 id，画布侧才会把语言组件 portal 进来。
  window.dispatchEvent(new CustomEvent('arvimo:settings-select',{detail:{id:active.embedSection||active.canvasId||null}}));
  if(currentGroup)scrollPositions.set(currentGroup.id,pages.scrollTop);
  for(const group of groups){group.page.hidden=group!==active;group.button.classList.toggle('active',group===active);group.button.setAttribute('aria-current',group===active?'page':'false');}
  // 平台页也是「页标题 + 分组」两级：页标题说明这一屏管什么，分组标题只留平台自身的「在线平台」。
  /* 一个分类只剩一页时收起子标签栏：单页页签只是噪音。 */
  subnav.hidden=groups.filter(group=>categoryOf(group.id)===category).length<2;
  content.dataset.page=active.id;
  title.textContent=category==='hotkeys'?'快捷键':active.label;description.textContent=active.description;description.hidden=!active.description;
  pages.scrollTop=scrollPositions.get(active.id)||0;currentGroup=active;
  // 切分类的过渡：内容淡入并上移 6px，替代原来的硬切。
  active.page.classList.remove('is-in');void active.page.offsetWidth;active.page.classList.add('is-in');
  if(active.id==='ai'&&!aiLoaded){aiLoaded=true;loadAI();}
  if(active.id==='sharing')sharing.load();
  if(active.id==='prefs'){void desktop?.refresh();void ensureCanvas?.();} // 语言 section 由画布注入，通用页激活时确保画布已挂载
  if(active.id==='team')void team?.load();
 }
 subnav.addEventListener('click',event=>{const button=event.target.closest('[data-settings-page]');if(button)select(button.dataset.settingsPage);});
 subnav.addEventListener('keydown',event=>{
  const visible=groups.filter(group=>!group.button.hidden);
  const index=visible.findIndex(group=>group.button===event.target);if(index<0)return;
  const delta={ArrowDown:1,ArrowRight:1,ArrowUp:-1,ArrowLeft:-1}[event.key];
  if(!delta&&event.key!=='Home'&&event.key!=='End')return;
  event.preventDefault();const next=event.key==='Home'?visible[0]:event.key==='End'?visible.at(-1):visible[(index+delta+visible.length)%visible.length];
  next.button.focus();select(next.id);
 });
 const navSections=[['设置',['general','hotkeys']],['功能',['canvas','ai','plugins','software','platforms','extensions']],['数据与维护',['data','updates']]];
 for(const [heading,ids] of navSections){
  const section=document.createElement('div');section.className='settings-nav-section';
  const caption=document.createElement('div');caption.className='settings-nav-caption';caption.textContent=heading;section.append(caption);
  for(const id of ids){
  const category=categories.find(item=>item[0]===id);if(!category)continue;
  const [,label,glyph]=category;
  const button=document.createElement('button');button.type='button';button.dataset.category=id;button.innerHTML=`${icon(glyph)}<span>${label}</span>`;
  button.onclick=()=>{const first=groups.find(group=>categoryOf(group.id)===id);if(first)select(first.id);else if(canvasEntrySections[id])pendingSelect=canvasEntrySections[id];if(id==='canvas'||canvasEntrySections[id])void ensureCanvas?.();};section.append(button);
  }
  if(section.querySelector('button'))nav.append(section);
 }
 const navEmpty=document.createElement('p');navEmpty.className='settings-nav-empty';navEmpty.textContent='未找到设置项';navEmpty.hidden=true;nav.append(navEmpty);
 navSearch.querySelector('input').addEventListener('input',event=>{
  const query=event.target.value.trim().toLowerCase();let matches=0;
  for(const section of nav.querySelectorAll('.settings-nav-section')){
   let visible=0;for(const button of section.querySelectorAll('[data-category]')){
    const text=[button.textContent,...groups.filter(group=>categoryOf(group.id)===button.dataset.category).map(group=>`${group.label} ${group.description||''} ${group.page.textContent}`)].join(' ').toLowerCase();
    button.hidden=!!query&&!text.includes(query);if(!button.hidden)visible++;
   }
   section.hidden=!visible;matches+=visible;
  }
  navEmpty.hidden=matches>0;
 });
 const canvasPlaceholder={id:'canvas:loading',label:'画布',description:'正在加载画布设置…',cards:[]};
 function addCanvasPage(group){
  const button=document.createElement('button');button.type='button';button.dataset.settingsPage=group.id;button.textContent=group.label;subnav.append(button);
  const page=document.createElement('section');page.hidden=true;page.id=`settings-page-${group.id}`;page.classList.add('settings-canvas-page');
  // 插件页内容自带工具栏与列表线，再套一层页面卡就成了「卡中卡」；标记出来由 CSS 平铺。
  if(group.id==='builtin.settings-plugins')page.classList.add('settings-flat-page');
  pages.append(page);Object.assign(group,{button,page});groups.push(group);
 }
 addCanvasPage(canvasPlaceholder);
 window.addEventListener('arvimo:settings-register',event=>{
  const {sections,source}=event.detail||{};if(source!==window.__avArtflow?.frame?.contentWindow||!Array.isArray(sections))return;
  const previous=currentGroup?.id;
  for(const group of groups.filter(group=>group.canvasId||group===canvasPlaceholder)){group.page.remove();group.button.remove();groups.splice(groups.indexOf(group),1);}
  canvasCategories.clear();
  for(const section of sections){
   if(section.id==='builtin.core-settings.general')continue; // 语言已嵌进通用页，跳过独立建页
   /* 「设置预设」与「存储」是 Artflow 桌面版专属：靠 preload 暴露的 window.artflowConfig 读写配置卷，
      资产库的 iframe 画布没有这个桥 —— 预设库永远空、三个按钮点了无反应、存储页永远「读取中」。
      与其留两页空壳，不如整块不挂载。 */
   if(CANVAS_HIDDEN_SECTIONS.has(section.id))continue;
   const defaults=canvasDefaults[section.id];
   // 快捷键/插件独立成侧栏分类：section 自带的 category 会抢先命中，这里先按 id 强制归类。
   const forcedCategory={'builtin.core-settings.hotkeys':'hotkeys','builtin.settings-plugins':'plugins'}[section.id];
   const category=forcedCategory||(categories.some(([id])=>id===section.category)?section.category:defaults?.[0]||(section.group==='extensions'?'extensions':'canvas'));
   canvasCategories.set(section.id,category);
   const group={id:section.id,canvasId:section.id,label:defaults?.[1]||section.label,description:category==='hotkeys'?'':'作用于画布；沿用已有配置与保存方式',cards:[]};addCanvasPage(group);
  }
  const target=pendingSelect||(groups.some(group=>group.id===previous)?previous:previous==='canvas:loading'?(sections.find(section=>section.id==='builtin.view-tools.view')?.id||sections[0]?.id||'export'):'export');
  pendingSelect=null;
  select(groups.some(group=>group.id===target)?target:'export');
 });
 window.addEventListener('arvimo:settings-open',event=>{
  const id=event.detail?.id;select(groups.some(group=>group.id===(pageAlias[id]||id))?id:groups.find(group=>group.canvasId)?.id||'canvas:loading');if(!dialog.open)dialog.showModal();
 });
 window.addEventListener('arvimo:settings-reveal-canvas',()=>{dialog.close();document.querySelector('[data-route="canvas"]')?.click();});
 dialog.addEventListener('close',()=>window.dispatchEvent(new CustomEvent('arvimo:settings-select',{detail:{id:null}})));
 select('export');
 return {open(id='export'){if(id.startsWith('canvas:')||groups.some(group=>group.id===id&&group.canvasId))void ensureCanvas?.();aiLoaded=false;select(id);if(!dialog.open)dialog.showModal();},saveNow:flush};
}
