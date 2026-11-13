import {createMascotAssistant,MASCOT_EXPRESSIONS,MASCOT_EFFECTS,MASCOT_MOTIONS} from './mascot-assistant.js';
import {bindMascotLongPress} from './mascot-long-press.js';

export function setupMascotDeveloper({panel,assistant,enabled}){
 if(!enabled)return ()=>{};
 let dialog,preview,interval,thumbnailObserver;
 const scenarios=[
  ['分类切换',{type:'category',label:'材质'}],['搜索中',{type:'search',busy:true}],
  ['检索完成',{type:'search',busy:false,ok:true}],['没有结果',{type:'empty'}],
  ['开始下载',{type:'download',phase:'started',count:3}],['下载完成',{type:'download',phase:'completed',count:3}],
  ['下载失败',{type:'download',phase:'failed',count:2}],
  ['发现更新',{type:'update',detail:{phase:'available',available:true,version:'预览版本',message:'发现新版本',actionLabel:'模拟更新'}}]
 ];
 function closePreview(){clearInterval(interval);preview?.dispose();preview=null;}
 function build(){
  dialog=document.createElement('dialog');dialog.className='mascot-lab';dialog.setAttribute('aria-labelledby','mascot-lab-title');
  dialog.innerHTML=`<header><div><small>ARVIMO / DEVELOPER</small><h2 id="mascot-lab-title">小猫调试台</h2></div><button type="button" class="icon-button" data-lab-close aria-label="关闭小猫调试台">×</button></header>
   <div class="mascot-lab-body"><section class="mascot-lab-preview"><div data-lab-stage></div><div class="mascot-lab-preview-tools"><label>背景 <select data-lab-background><option value="dark">深色</option><option value="light">浅色</option></select></label><label><input type="checkbox" data-lab-reduced> 减少动态效果</label></div><p data-lab-status role="status">独立预览 · 不执行实际操作</p></section>
   <section class="mascot-lab-controls"><div role="tablist" aria-label="调试类别">${['表情与动效','交互场景','状态调试'].map((label,i)=>`<button type="button" id="mascot-lab-tab-${i}" role="tab" aria-controls="mascot-lab-pane-${i}" aria-selected="${i===0}" tabindex="${i===0?0:-1}" data-lab-tab="${i}">${label}</button>`).join('')}</div>
   <div role="tabpanel" id="mascot-lab-pane-0" aria-labelledby="mascot-lab-tab-0" data-lab-pane="0"><h3>表情</h3><div class="mascot-lab-effects" role="group" aria-label="预览表情">${Object.entries(MASCOT_EXPRESSIONS).map(([value,label])=>`<button type="button" data-lab-expression="${value}" aria-pressed="${value==='idle'}"><span class="mascot-lab-thumbnail" data-thumbnail-expression="${value}" aria-hidden="true"></span><span>${label}</span></button>`).join('')}</div><h3>特效</h3><div class="mascot-lab-effects" role="group" aria-label="预览特效">${Object.entries(MASCOT_EFFECTS).map(([value,label])=>`<button type="button" data-lab-effect="${value}" aria-pressed="${value==='none'}"><span class="mascot-lab-thumbnail" data-thumbnail-effect="${value}" aria-hidden="true"></span><span>${label}</span></button>`).join('')}</div><div class="mascot-lab-actions"><button type="button" data-lab-replay>重播预览</button><button type="button" data-lab-reset>恢复待机</button></div><p>修改仅影响左侧预览，关闭后不保存。</p></div>
   <div role="tabpanel" id="mascot-lab-pane-1" aria-labelledby="mascot-lab-tab-1" data-lab-pane="1" hidden><h3>模拟真实交互</h3><div class="mascot-lab-choices">${scenarios.map(([label],i)=>`<button type="button" data-lab-scenario="${i}">${label}</button>`).join('')}</div><p>按顺序触发可检查优先级与消息覆盖。下载、更新按钮仅模拟反馈。</p></div>
   <div role="tabpanel" id="mascot-lab-pane-2" aria-labelledby="mascot-lab-tab-2" data-lab-pane="2" hidden><label>查看队列 <select data-lab-source><option value="preview">预览小猫</option><option value="live">实际小猫（只读）</option></select></label><div data-lab-queue aria-live="off"></div></div></section></div>`;
  document.body.append(dialog);
  const effectGroup=dialog.querySelector('[aria-label="预览特效"]');
  effectGroup.previousElementSibling.insertAdjacentHTML('beforebegin',`<h3>身体动作</h3><div class="mascot-lab-effects" role="group" aria-label="预览身体动作">${Object.entries(MASCOT_MOTIONS).map(([value,label])=>`<button type="button" data-lab-motion="${value}" aria-pressed="${value==='idle'}"><span class="mascot-lab-thumbnail" data-thumbnail-motion="${value}" aria-hidden="true"></span><span>${label}</span></button>`).join('')}</div>`);
  const actions=dialog.querySelector('.mascot-lab-actions');
  actions.insertAdjacentHTML('beforebegin','<div class="mascot-lab-layer-options"><label><input type="checkbox" data-lab-hold> 保持表情</label><label><input type="checkbox" data-lab-hold-motion> 循环身体动作</label><label><input type="checkbox" data-lab-bubble checked> 显示气泡</label></div>');
  actions.insertAdjacentHTML('beforeend','<button type="button" data-lab-random>随机组合</button><button type="button" data-lab-replay-effect>只重播特效</button><button type="button" data-lab-replay-motion>只重播动作</button><button type="button" data-lab-reset-expression>重置表情</button><button type="button" data-lab-reset-motion>重置动作</button><button type="button" data-lab-reset-effect>清除特效</button>');
  // Shadow DOM keeps the real search component's IDs/styles isolated while sharing its actual SVG and CSS.
  const shadow=dialog.querySelector('[data-lab-stage]').attachShadow({mode:'open'});
  const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href=new URL('app.css',location.href).href;
  // Reuse the actual SVG and effect keyframes; IDs stay isolated in each thumbnail's shadow root.
  thumbnailObserver=new IntersectionObserver(entries=>{for(const entry of entries)entry.target.toggleAttribute('data-paused',!entry.isIntersecting);});
  const thumbnailStyle=`:host{display:block;width:64px;height:44px;overflow:hidden;pointer-events:none}#search-panel{margin:0!important;padding:0!important;min-height:0!important;width:112px;height:76px;border:0;background:none;isolation:auto;transform:scale(.57);transform-origin:top left}#search-panel:before{display:none}#search-panel .cat-peek{width:112px;height:76px;pointer-events:none}#search-panel .cat-peek .cat-sway{animation:lab-card-breathe 4s ease-in-out infinite!important}#search-panel .eye-slot{animation:lab-card-blink 5s ease-in-out infinite;animation-delay:var(--card-delay)}#search-panel *,#search-panel *:after,#search-panel *:before{animation-iteration-count:infinite}#search-panel .cat-sway:after{animation-duration:3s}#search-panel [data-effect]:not([data-effect="none"]) .cat-sway:after{left:48px;top:23px}#search-panel [data-effect="none"] .cat-sway:after{content:'○';left:46px;top:23px;color:#768971;font-size:26px}:host([data-paused]) *,:host([data-paused]) *:after,:host([data-paused]) *:before{animation-play-state:paused!important}:host([data-reduced]) *,:host([data-reduced]) *:after,:host([data-reduced]) *:before{animation:none!important;transition:none!important}@keyframes lab-card-breathe{0%,100%{translate:0 0}50%{translate:0 -1px}}@keyframes lab-card-blink{0%,44%,48%,100%{scale:1}46%{scale:1 .12}}@media(prefers-reduced-motion:reduce){#search-panel *,#search-panel *:after,#search-panel *:before{animation:none!important;transition:none!important}}`;
  dialog.querySelectorAll('.mascot-lab-thumbnail').forEach((host,index)=>{
   const root=host.attachShadow({mode:'open'}),sheet=stylesheet.cloneNode(),css=document.createElement('style'),container=document.createElement('div'),cat=document.createElement('span');
   css.textContent=thumbnailStyle+'#search-panel{box-shadow:none!important;background:none!important}#search-panel *,#search-panel *:after,#search-panel *:before{animation-iteration-count:infinite!important}:host([data-thumbnail-expression]) #search-panel .cat-peek .cat-sway{animation:none!important}:host([data-thumbnail-motion]) #search-panel .cat-peek .cat-sway{animation:var(--thumbnail-motion,none) 2.8s ease-in-out infinite!important}:host([data-thumbnail-motion]) #search-panel .eye-slot{animation:none}:host([data-reduced]) #search-panel .cat-peek .cat-sway{animation:none!important}@media(prefers-reduced-motion:reduce){#search-panel .cat-peek .cat-sway{animation:none!important}}';container.id='search-panel';container.setAttribute('data-search-ready','1');cat.className='cat-peek';
   css.textContent+=':host([data-thumbnail-expression]) #search-panel .cat-sway:after,:host([data-thumbnail-motion]) #search-panel .cat-sway:after{content:none}:host([data-paused]) #search-panel .cat-peek .cat-sway,:host([data-paused]) #search-panel .cat-peek .cat-ear,:host([data-paused]) #search-panel .cat-peek .bot-eye,:host([data-paused]) #search-panel .cat-peek .eye-slot,:host([data-paused]) #search-panel .cat-peek .cat-sway:after{animation-play-state:paused!important}';
   cat.setAttribute('data-expression',host.dataset.thumbnailExpression||'idle');cat.setAttribute('data-effect',host.dataset.thumbnailEffect||'none');
   cat.setAttribute('data-motion',host.dataset.thumbnailMotion||'still');
   const motionAnimations={idle:'av-body-breathe',nod:'av-body-nod',tilt:'av-body-tilt',peek:'av-body-peek',duck:'av-body-duck',sway:'av-body-sway',stretch:'av-body-stretch',bounce:'av-body-bounce',shake:'av-body-shake',dance:'av-body-dance',bow:'av-body-bow',spring:'av-body-spring',hide:'av-body-hide'};
   if(host.dataset.thumbnailMotion)css.textContent+=':host{height:54px}#search-panel{margin-top:10px!important;transform:translateX(4px) scale(.5)}';
   cat.style.setProperty('--thumbnail-motion',motionAnimations[host.dataset.thumbnailMotion]||'none');
   cat.style.setProperty('--card-delay',`${-(index%5)*.6}s`);
   if(host.dataset.thumbnailExpression||host.dataset.thumbnailMotion){cat.append(panel.querySelector('.cat-sway').cloneNode(true));cat.querySelectorAll('[style]').forEach(node=>{if(node.classList.contains('bot-eye'))node.removeAttribute('style');});}
   else{const sway=document.createElement('span');sway.className='cat-sway';cat.append(sway);}
   container.append(cat);root.append(sheet,css,container);host.setAttribute('data-paused','');thumbnailObserver.observe(host);
  });
  const style=document.createElement('style');style.textContent=`:host{display:block;--bg-panel:#0d141b;--primary-green:#c8f353;--border-panel:#344237;color:#dce5ee}#search-panel{margin:100px 16px 0;padding:0;min-height:110px;background:var(--bg-panel);border-radius:15px;max-width:100%}#search-panel .vault-bot-header{left:14px;right:12px;gap:8px;flex-wrap:wrap}#search-panel .bot-bubble{max-width:210px;white-space:normal;margin-bottom:22px}#search-panel .bot-bubble.update-bubble{max-width:210px;white-space:normal;flex-wrap:wrap}#search-panel .cat-peek{flex-shrink:0}#search-panel .cat-peek .cat-sway{pointer-events:none}#search-panel:before{background:var(--bg-panel)}:host([data-light]){--bg-panel:#f0f4e9;--primary-green:#537c17;--border-panel:#a0b28b;color:#25311d}:host([data-light]) #search-panel .bot-bubble{background:#f0f4e9;color:#35491d;border-color:#a0b28b}:host([data-reduced]) *, :host([data-reduced]) *:before,:host([data-reduced]) *:after{animation:none!important;transition:none!important}`;
  const previewPanel=document.createElement('section');previewPanel.id='search-panel';previewPanel.setAttribute('data-search-ready','1');
  previewPanel.append(panel.querySelector('.vault-bot-header').cloneNode(true));
  const cat=previewPanel.querySelector('#search-mascot');cat.className='cat-peek';cat.removeAttribute('style');cat.removeAttribute('data-developer-entry');cat.removeAttribute('title');
  shadow.append(stylesheet,style,previewPanel);
  let expression='idle',effect='none',motion='idle';
  const createPreview=()=>createMascotAssistant({panel:previewPanel,canManageUpdates:true,idleAnimations:false,onViewDownloads:()=>status('模拟操作：查看下载'),onClearFilters:()=>status('模拟操作：清除筛选'),onInstallUpdate:()=>status('模拟操作：更新，不执行安装')});
  const status=text=>{dialog.querySelector('[data-lab-status]').textContent=text;};
  function reset(){preview?.dispose();preview=createPreview();cat.classList.remove('has-update');preview.notify({type:'bubble-visibility',visible:dialog.querySelector('[data-lab-bubble]').checked});}
  function caption(){preview.notify({type:'bubble',message:{id:'preview-caption',text:`${MASCOT_EXPRESSIONS[expression]} · ${MASCOT_MOTIONS[motion]} · ${MASCOT_EFFECTS[effect]}`,duration:4500,priority:60}});}
  function playMotion(){preview.notify({type:'reset-channel',channel:'motion'});preview.notify({type:'motion',value:motion,duration:dialog.querySelector('[data-lab-hold-motion]').checked?0:3000,priority:60,replay:true});status('已播放身体动作 · 保留表情、特效与气泡');}
  function playExpression(){preview.notify({type:'reset-channel',channel:'expression'});preview.notify({type:'expression',value:expression,duration:dialog.querySelector('[data-lab-hold]').checked?0:4500,priority:60,replay:true});status('已播放表情 · 特效与气泡独立运行');}
  function playEffect(){preview.notify({type:'reset-channel',channel:'effect'});preview.notify({type:'effect',value:effect,duration:2600,priority:60,replay:true});status('已播放特效 · 保留当前表情');}
  function play(){playExpression();playMotion();playEffect();caption();status('组合预览 · 表情、身体动作、特效和气泡分别计时');}
  function queue(){
   const list=(dialog.querySelector('[data-lab-source]').value==='live'?assistant:preview)?.inspect()||[],host=dialog.querySelector('[data-lab-queue]');host.replaceChildren();
   if(!list.length){host.textContent='当前没有消息，处于待机状态。';return;}
   for(const item of list){const row=document.createElement('article'),title=document.createElement('strong'),text=document.createElement('p'),meta=document.createElement('small');title.textContent=`${{bubble:'气泡',expression:'表情',effect:'特效',motion:'身体动作'}[item.channel]} · ${item.current?'显示中':'等待中'} · ${item.id}`;text.textContent=item.channel==='expression'?MASCOT_EXPRESSIONS[item.text]:item.channel==='effect'?MASCOT_EFFECTS[item.text]:item.channel==='motion'?MASCOT_MOTIONS[item.text]:item.text;meta.textContent=`优先级 ${item.priority} · ${item.remaining===null?'持续显示':`${(item.remaining/1000).toFixed(1)} 秒`}`;row.append(title,text,meta);host.append(row);}
  }
  const tabs=[...dialog.querySelectorAll('[data-lab-tab]')];
  function selectTab(index){tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;});dialog.querySelectorAll('[data-lab-pane]').forEach(pane=>pane.hidden=Number(pane.dataset.labPane)!==index);queue();}
  dialog.addEventListener('keydown',event=>{const index=tabs.indexOf(event.target);if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3;selectTab(next);tabs[next].focus();});
  dialog.addEventListener('click',event=>{
   const button=event.target.closest('button');if(!button)return;
   if(button.hasAttribute('data-lab-close'))dialog.close();
   if(button.dataset.labTab!==undefined)selectTab(Number(button.dataset.labTab));
   if(button.dataset.labExpression){expression=button.dataset.labExpression;dialog.querySelectorAll('[data-lab-expression]').forEach(node=>node.setAttribute('aria-pressed',String(node===button)));playExpression();caption();}
   if(button.dataset.labEffect){effect=button.dataset.labEffect;dialog.querySelectorAll('[data-lab-effect]').forEach(node=>node.setAttribute('aria-pressed',String(node===button)));playEffect();caption();}
   if(button.dataset.labMotion){motion=button.dataset.labMotion;dialog.querySelectorAll('[data-lab-motion]').forEach(node=>node.setAttribute('aria-pressed',String(node===button)));playMotion();caption();}
   if(button.hasAttribute('data-lab-random')){
    const pick=(catalog,current)=>{const values=Object.keys(catalog).filter(value=>value!==current);return values[Math.floor(Math.random()*values.length)];};
    expression=pick(MASCOT_EXPRESSIONS,expression);motion=pick(MASCOT_MOTIONS,motion);effect=pick(MASCOT_EFFECTS,effect);
    for(const [kind,value] of [['expression',expression],['motion',motion],['effect',effect]])dialog.querySelectorAll(`[data-lab-${kind}]`).forEach(node=>node.setAttribute('aria-pressed',String(node.getAttribute(`data-lab-${kind}`)===value)));
    play();
   }
   if(button.hasAttribute('data-lab-replay'))play();
   if(button.hasAttribute('data-lab-replay-effect'))playEffect();
   if(button.hasAttribute('data-lab-replay-motion'))playMotion();
   if(button.hasAttribute('data-lab-reset-motion')){motion='idle';preview.notify({type:'reset-channel',channel:'motion'});dialog.querySelectorAll('[data-lab-motion]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.labMotion===motion)));status('已重置身体动作 · 保留其他状态');}
   if(button.hasAttribute('data-lab-reset-expression')){expression='idle';preview.notify({type:'reset-channel',channel:'expression'});dialog.querySelectorAll('[data-lab-expression]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.labExpression===expression)));status('已重置表情 · 保留特效与气泡');}
   if(button.hasAttribute('data-lab-reset-effect')){effect='none';preview.notify({type:'reset-channel',channel:'effect'});dialog.querySelectorAll('[data-lab-effect]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.labEffect===effect)));status('已清除特效 · 保留表情与气泡');}
   if(button.hasAttribute('data-lab-reset')){expression='idle';effect='none';motion='idle';dialog.querySelectorAll('[data-lab-expression]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.labExpression===expression)));dialog.querySelectorAll('[data-lab-effect]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.labEffect===effect)));dialog.querySelectorAll('[data-lab-motion]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.labMotion===motion)));reset();status('已恢复待机');}
   if(button.dataset.labScenario!==undefined){const [label,scenario]=scenarios[Number(button.dataset.labScenario)];preview.notify(scenario);status(`场景：${label} · 使用正式消息规则`);queue();}
  });
  dialog.querySelector('[data-lab-hold]').onchange=playExpression;
  dialog.querySelector('[data-lab-hold-motion]').onchange=()=>{cat.toggleAttribute('data-motion-loop',dialog.querySelector('[data-lab-hold-motion]').checked);playMotion();};
  dialog.querySelector('[data-lab-bubble]').onchange=event=>preview.notify({type:'bubble-visibility',visible:event.target.checked});
  dialog.querySelector('[data-lab-background]').onchange=event=>{dialog.querySelector('[data-lab-stage]').toggleAttribute('data-light',event.target.value==='light');};
  dialog.querySelector('[data-lab-reduced]').onchange=event=>{dialog.querySelectorAll('[data-lab-stage],.mascot-lab-thumbnail').forEach(node=>node.toggleAttribute('data-reduced',event.target.checked));};
  dialog.querySelector('[data-lab-source]').onchange=queue;
  dialog.addEventListener('close',()=>{closePreview();panel.querySelector('#search-mascot').focus({preventScroll:true});});
  return {reset,queue};
 }
 let controls;
 const unbind=bindMascotLongPress(panel.querySelector('#search-mascot'),{enabled,onOpen:()=>{
  if(!dialog)controls=build();
  if(dialog.open)return;
  controls.reset();dialog.showModal();controls.queue();interval=setInterval(()=>{if(!dialog.querySelector('[data-lab-pane="2"]').hidden)controls.queue();},500);
 }});
 return ()=>{unbind();closePreview();thumbnailObserver?.disconnect();dialog?.remove();};
}
