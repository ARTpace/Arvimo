import {createAssistantMessages} from './assistant-messages.js';
import {createMascotVariations} from './mascot-variations.js';
import {MASCOT_MOTIONS} from './mascot-motions.js';
export {MASCOT_MOTIONS} from './mascot-motions.js';

export const MASCOT_EXPRESSIONS={idle:'待机',focused:'专注',happy:'开心',curious:'疑惑',worried:'担心',wink:'眨眼',sleepy:'困倦',surprised:'惊讶',proud:'得意',shy:'害羞',excited:'期待',love:'心动',annoyed:'气鼓鼓',dizzy:'晕乎乎',cool:'墨镜酷猫'};
export const MASCOT_EFFECTS={none:'无特效',sparkles:'星光',question:'问号',download:'下载标记',hearts:'爱心',sweat:'汗滴',music:'音符',idea:'灵感',success:'完成勾',orbit:'环绕光点',rain:'小雨',lightning:'闪电',flower:'小花',bubbles:'泡泡',confetti:'彩纸'};

/** Only this view owns bubble DOM. Business code supplies events, never elements. */
export function createMascotAssistant({panel,canManageUpdates=false,idleAnimations=true,onCheckUpdates=()=>{},onInstallUpdate=()=>{},onViewDownloads=()=>{},onClearFilters=()=>{},timing={},random=Math.random}){
 const bubble=panel.querySelector('#search-mascot-bubble'),mascot=panel.querySelector('#search-mascot');
 let updateId='',reopenUpdate=false,categoryExplained=false;
 const chooseVariation=createMascotVariations(random),appearances=new Map();
 const render=message=>{
  bubble.replaceChildren();bubble.classList.toggle('show',!!message);
  bubble.classList.toggle('update-bubble',!!message?.actions?.length||message?.duration===0);
  if(!message)return;
  const text=document.createElement('span');text.className='update-bubble-text';text.textContent=message.text;text.title=message.title||message.text;bubble.append(text);
  for(const action of message.actions||[]){
   const button=document.createElement('button');button.type='button';button.className='update-bubble-action';button.textContent=action.label;button.disabled=!!action.disabled;button.onclick=action.run;bubble.append(button);
  }
  if(message.duration===0){
   const close=document.createElement('button');close.type='button';close.className='update-bubble-close';close.textContent='×';close.setAttribute('aria-label','关闭助手提示');close.onclick=()=>messages.dismiss(message.id);bubble.append(close);
  }
 };
 // ponytail: four independent channels reuse the existing bounded queue and timer rules.
 const bubbles=createAssistantMessages({...timing,canManageUpdates,render});
 function visualChannel(kind,catalog,fallback){
  const renderVisual=message=>{
   const value=message?.text||fallback;
   mascot.setAttribute(`data-${kind}`,value);
   if(kind==='expression')mascot.setAttribute('aria-label',`小猫助手：${catalog[value]}`);
  };
  renderVisual(null);
  return createAssistantMessages({...timing,canManageUpdates,render:renderVisual});
 }
 const expressions=visualChannel('expression',MASCOT_EXPRESSIONS,'idle');
 const effects=visualChannel('effect',MASCOT_EFFECTS,'none');
 const motions=visualChannel('motion',MASCOT_MOTIONS,'idle');
 const channels={bubble:bubbles,expression:expressions,effect:effects,motion:motions};
 const setIdleTimer=timing.setTimer||setTimeout,clearIdleTimer=timing.clearTimer||clearTimeout;
 const idleLooks=[['idle','tilt'],['wink','idle'],['idle','peek'],['happy','nod'],['idle','sway'],['idle','stretch']];
 let idleTimer,lastIdle=-1,disposed=false;
 function scheduleIdle(){
  clearIdleTimer(idleTimer);
  if(!idleAnimations||disposed)return;
  idleTimer=setIdleTimer(()=>{
   const quiet=Object.values(channels).every(channel=>channel.inspect().length===0);
   if(quiet&&!document.hidden&&!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches){
    // 只在四层都空闲时播放，无气泡、无装饰特效，也不积压待机动作。
    const index=(lastIdle+1+Math.floor(random()*(idleLooks.length-1)))%idleLooks.length;
    lastIdle=index;
    const [expression,motion]=idleLooks[index];
    messages.publish({id:'ambient-idle',bubble:false,expression,motion,duration:2800,priority:-10});
   }
   scheduleIdle();
  },14000+Math.floor(random()*10000));
 }
 const messages={
  publish({expression,effect,motion,scene,variationKey,expressionDuration,effectDuration,motionDuration,bubble=true,...message}){
   if(scene){
    const id=message.id||'hint',previous=appearances.get(id);
    const duplicate=!['greeting','category'].includes(scene)&&previous?.scene===scene&&bubbles.inspect().some(item=>item.id===id&&item.text===message.text);
    const appearance=duplicate?previous.appearance:chooseVariation(scene,variationKey);
    appearances.set(id,{scene,appearance});({expression,effect,motion}=appearance);
   }
   const duration=message.duration??2200;
   if(expression&&MASCOT_EXPRESSIONS[expression])expressions.publish({...message,text:expression,duration:expressionDuration??duration});
   if(effect&&MASCOT_EFFECTS[effect])effects.publish({...message,text:effect,duration:effectDuration??(duration===0?2600:Math.min(duration,2600))});
   if(motion&&MASCOT_MOTIONS[motion])motions.publish({...message,text:motion,duration:motionDuration??(duration===0?3000:Math.min(duration,3000))});
   return bubble?bubbles.publish(message):false;
  },
  clear(id){Object.values(channels).forEach(channel=>channel.clear(id));},
  dismiss:id=>bubbles.dismiss(id),
  inspect:()=>Object.entries(channels).flatMap(([channel,queue])=>queue.inspect().map(item=>({...item,channel,expression:channel==='expression'?item.text:'idle',effect:channel==='effect'?item.text:'none',motion:channel==='motion'?item.text:'idle'}))),
  dispose:()=>{disposed=true;clearIdleTimer(idleTimer);appearances.clear();Object.values(channels).forEach(channel=>channel.dispose());}
 };
 render(null);
 function notify(event){
  messages.clear('ambient-idle');scheduleIdle();
  switch(event.type){
   case 'bubble-visibility':bubble.hidden=!event.visible;break;
   case 'expression':
   case 'motion':
   case 'effect':{
    const kind=event.type,catalog={expression:MASCOT_EXPRESSIONS,effect:MASCOT_EFFECTS,motion:MASCOT_MOTIONS}[kind];
    if(!Object.hasOwn(catalog,event.value))return false;
    const queue=channels[kind],id=event.id||'manual';
    if(event.replay){queue.clear(id);void mascot.offsetWidth;}
    return queue.publish({id,text:event.value,duration:event.duration??(kind==='effect'?2600:4500),priority:event.priority??20});
   }
   case 'bubble':return bubbles.publish(event.message);
   case 'reset-channel':{
    const queue=channels[event.channel];
    if(!queue)return;
    for(const item of queue.inspect())queue.clear(item.id);
    break;
   }
   case 'category':
    messages.publish({id:'category',text:`已筛选${event.label}${categoryExplained?'':'，可继续输入名称缩小范围'}`,scene:'category',priority:25,duration:3200});categoryExplained=true;break;
   /* 顶部模式轨（搜索栏上方那排图标）切换同样要给回执：同一件事「换个分类看」，
      侧边栏筛选有小猫气泡、图标轨上却毫无反应，用户会以为没点中（2026-11-14 用户反馈）。
      text 可由调用方覆盖，退出模式那种「已回到全部」不适合套「已切换到…」句式。 */
   case 'mode':
    messages.publish({id:'mode',text:event.text||`已切换到${event.label}${event.route==='library'?'分类':'模式'}`,scene:'category',priority:25,duration:3200});break;
   case 'download':{
    const failed=event.phase==='failed',done=event.phase==='completed';
    messages.publish({id:failed?'download:error':'download:activity',text:failed?`${event.count} 项下载失败`:done?`${event.count} 项资产已下载完成`:`正在下载 ${event.count} 项资产，你可以继续浏览`,scene:`download:${event.phase}`,priority:failed?40:done?30:20,duration:failed?8000:4500,actions:[{label:failed?'查看原因':'查看下载',run:onViewDownloads}]});break;
   }
   case 'empty':
    messages.publish({id:'search',text:'没有找到资产，试试英文或减少筛选条件',scene:'empty',priority:25,duration:6000,actions:[{label:'清除筛选',run:onClearFilters}]});break;
   case 'context':messages.clear('search');messages.clear('hint');break;
   case 'greeting':
    reopenUpdate=true;
    messages.publish({id:'hint',text:'随时准备搜索，试试关键词或资产链接',scene:'greeting'});
    if(canManageUpdates)onCheckUpdates();
    break;
   case 'hint':messages.publish({id:'hint',text:event.text});break;
   case 'search':messages.publish({id:'search',text:event.busy?'正在检索资产…':event.ok?'检索完成':'检索未完成，请查看结果区提示',scene:event.busy?'search:busy':event.ok?'search:done':'search:error',priority:20,duration:event.busy?0:3000});break;
   case 'update':{
    if(!canManageUpdates)return;
    const detail=event.detail;
    mascot.classList.toggle('has-update',!!detail.available);
    if(!detail.available){
     if(['current','unavailable','idle'].includes(detail.phase)){if(updateId)messages.clear(updateId);updateId='';return;}
     if(detail.phase!=='error'||!updateId)return;
    }
    const id=`update:${detail.version||'pending'}`;
    if(updateId&&updateId!==id)messages.clear(updateId);
    updateId=id;
    const short={available:`发现新版本 ${detail.version}`,ready:`${detail.version} 已准备好更新`};
    const text=/失败|任务/.test(detail.message||'')?detail.message:short[detail.phase]||detail.message;
    const actions=detail.available&&detail.phase!=='downloading'?[{label:detail.actionLabel,disabled:detail.disabled,run:onInstallUpdate}]:detail.phase==='error'?[{label:'重试',run:onCheckUpdates}]:[];
    messages.publish({id,text,title:detail.message,actions,scene:`update:${['error','downloading','ready'].includes(detail.phase)?detail.phase:'available'}`,variationKey:`${id}:${detail.phase}`,priority:50,duration:0,audience:'desktop-admin',rememberDismissal:true,force:reopenUpdate});
    reopenUpdate=false;
    break;
   }
   case 'message':return messages.publish(event.message);
  }
 }
 scheduleIdle();
 return {notify,dismiss:messages.dismiss,inspect:messages.inspect,dispose:messages.dispose};
}
