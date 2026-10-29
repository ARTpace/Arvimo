/** Visual feedback adapted from the supplied design; business requests remain in app.js. */
export function initSearchMotion(panel){
 if(!panel||panel.dataset.motionReady)return;
 panel.dataset.motionReady='1';
 const input=panel.querySelector('#asset-query'),clear=panel.querySelector('#search-clear');
 const mascot=panel.querySelector('#search-mascot'),bubble=panel.querySelector('#search-mascot-bubble');
 const mini=panel.querySelector('.search-mini-bot'),search=panel.querySelector('#search-button'),ai=panel.querySelector('#theme-breakdown-btn'),kbd=panel.querySelector('kbd');
 const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
 const eyes=[...panel.querySelectorAll('.bot-eye,.vault-bot-eye')];
 panel.querySelector('.global-search>i')?.classList.add('search-icon-svg');
 search.querySelector('i')?.classList.add('search-icon-svg');
 let bubbleTimer,typeTimer,frame=0,point={x:innerWidth/2,y:innerHeight/2},bias={x:0,y:0},busy=false,audio;
 const visible=()=>!document.hidden&&!panel.hidden&&panel.getClientRects().length>0;
 const later=(fn,ms)=>setTimeout(()=>{if(visible()&&!reduced.matches)fn();},ms);
 const animate=(node,name)=>{if(reduced.matches)return;node.classList.remove(name);void node.offsetWidth;node.classList.add(name);};
 const sync=()=>{clear.hidden=!input.value;clear.classList.toggle('visible',!!input.value);panel.classList.toggle('has-search-text',!!input.value);};
 const happy=()=>{if(updateBubble)return;mascot.classList.add('happy');clearTimeout(bubbleTimer);bubbleTimer=setTimeout(()=>{bubble.classList.remove('show');mascot.classList.remove('happy');},2200);};
 let updateBubble=false;
 const greet=text=>{if(updateBubble)return;bubble.textContent=text;bubble.classList.add('show');happy();};
 function showUpdate(detail){
  mascot.classList.toggle('has-update',!!detail.available);
  if(!updateBubble&&!detail.available)return;
  updateBubble=true;clearTimeout(bubbleTimer);
  bubble.classList.add('show','update-bubble');
  const text=document.createElement('span');text.className='update-bubble-text';text.textContent=detail.message||'正在检查更新…';
  const close=document.createElement('button');close.type='button';close.className='update-bubble-close';close.textContent='×';close.setAttribute('aria-label','关闭更新提示');
  close.onclick=()=>{updateBubble=false;bubble.classList.remove('show','update-bubble');};
  bubble.replaceChildren(text);
  if(detail.available&&detail.phase!=='downloading'){
   const action=document.createElement('button');action.type='button';action.className='update-bubble-action';action.textContent=detail.actionLabel;action.disabled=!!detail.disabled;
   action.onclick=()=>window.dispatchEvent(new Event('assetvault:install-update'));bubble.append(action);
  }else if(detail.phase==='error'){
   const retry=document.createElement('button');retry.type='button';retry.className='update-bubble-action';retry.textContent='重试';retry.onclick=()=>window.dispatchEvent(new Event('assetvault:check-updates'));bubble.append(retry);
  }
  bubble.append(close);
 }
 window.addEventListener('assetvault:update-state',event=>showUpdate(event.detail));
 mascot.setAttribute('aria-label','小猫助手：检查软件更新');mascot.title='点击检查软件更新';
 const thinking=on=>{mascot.classList.toggle('thinking',on);bias=on?{x:-2.2,y:-2.4}:{x:0,y:0};updateEyes();};
 function updateEyes(){
  if(reduced.matches||!visible())return;
  for(const eye of eyes){const r=eye.getBoundingClientRect(),dx=point.x-r.left-r.width/2,dy=point.y-r.top-r.height/2,d=Math.max(28,Math.hypot(dx,dy)),max=eye.classList.contains('bot-eye')?3:2;eye.style.transform='translate('+(dx/d*max+bias.x)+'px,'+(dy/d*max+bias.y)+'px)';}
 }
 function sound(sparkle=false,freq=600){
  try{
   audio||=new (window.AudioContext||window.webkitAudioContext)();
   if(audio.state==='suspended')void audio.resume();
   (sparkle?[800,1200,1600]:[freq]).forEach((f,i)=>{const start=audio.currentTime+i*.04,osc=audio.createOscillator(),gain=audio.createGain();osc.type=sparkle?'triangle':'sine';osc.frequency.setValueAtTime(f,start);if(!sparkle)osc.frequency.exponentialRampToValueAtTime(100,start+.08);gain.gain.setValueAtTime(sparkle?.06:.12,start);gain.gain.exponentialRampToValueAtTime(.001,start+.1);osc.connect(gain);gain.connect(audio.destination);osc.start(start);osc.stop(start+.11);osc.onended=()=>{osc.disconnect();gain.disconnect();};});
  }catch{}
 }
 function burst(event,node,count=12){
  if(reduced.matches)return;
  const r=node.getBoundingClientRect(),x=event.detail?event.clientX-r.left:r.width/2,y=event.detail?event.clientY-r.top:r.height/2;
  for(let i=0;i<count;i++){const p=document.createElement('span'),a=Math.random()*Math.PI*2,speed=Math.random()*40+15,size=Math.random()*4+3;p.className='particle';Object.assign(p.style,{width:size+'px',height:size+'px',left:x+'px',top:y+'px'});p.style.setProperty('--dx',Math.cos(a)*speed+'px');p.style.setProperty('--dy',Math.sin(a)*speed+'px');node.append(p);p.addEventListener('animationend',()=>p.remove(),{once:true});}
 }
 function ripple(event,node){
  if(reduced.matches)return;
  node.querySelector('.ripple')?.remove();
  const r=node.getBoundingClientRect(),size=Math.max(r.width,r.height),p=document.createElement('span');p.className='ripple';Object.assign(p.style,{width:size+'px',height:size+'px',left:((event.detail?event.clientX-r.left:r.width/2)-size/2)+'px',top:((event.detail?event.clientY-r.top:r.height/2)-size/2)+'px'});node.append(p);p.addEventListener('animationend',()=>p.remove(),{once:true});
 }
 function blink(){mascot.classList.add('blink');mini?.classList.add('blink');setTimeout(()=>{mascot.classList.remove('blink');mini?.classList.remove('blink');},130);}
 const blinkLoop=()=>{if(visible()&&!reduced.matches){blink();if(Math.random()<.3)later(blink,280);}setTimeout(blinkLoop,3200+Math.random()*4200);};
 const glance=()=>{if(visible()&&!reduced.matches&&!mascot.classList.contains('thinking')){const dirs=[[3,0],[-3,0],[2,2],[-2,1],[0,2.5],[-3,-1]],d=dirs[Math.floor(Math.random()*dirs.length)];bias={x:d[0],y:d[1]};updateEyes();later(()=>{if(!mascot.classList.contains('thinking')){bias={x:0,y:0};updateEyes();}},800+Math.random()*600);}setTimeout(glance,5500+Math.random()*5500);};
 setTimeout(blinkLoop,2000);setTimeout(glance,4500);
 const curiosity=()=>{if(visible()&&!reduced.matches&&!mascot.matches(':hover')&&!mascot.classList.contains('thinking')&&Math.random()>.5){mascot.style.rotate=(Math.random()*7-3.5)+'deg';setTimeout(()=>mascot.style.rotate='',750);}setTimeout(curiosity,7000);};setTimeout(curiosity,7000);
 mascot.addEventListener('animationend',event=>{if(event.target===mascot)mascot.classList.remove('enter','duck','peek');});
 input.addEventListener('focus',()=>{thinking(true);greet('喵～随时为你检索 3D 资产');sound(false,480);});
 input.addEventListener('blur',()=>{if(!busy)thinking(false);});
 input.addEventListener('input',()=>{sync();greet(input.value.trim()?'准备搜索：“'+input.value.trim().slice(0,12)+'”':'等待输入关键词…');});
 input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing)animate(kbd,'pressed');});
 kbd.addEventListener('animationend',()=>kbd.classList.remove('pressed'));
 clear.addEventListener('click',()=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();sound(false,320);greet('已重置输入框');});
 mascot.addEventListener('click',event=>{animate(mascot,'duck');burst(event,mascot,6);sound(false,850);updateBubble=true;showUpdate({phase:'checking',message:'正在检查软件版本…'});window.dispatchEvent(new Event('assetvault:check-updates'));});
 panel.addEventListener('change',event=>{
  if(event.target.id!=='search-platform')return;
  sync();sound(false,750);greet('已切换至 '+event.target.selectedOptions[0].textContent);
  const text=input.placeholder;clearInterval(typeTimer);
  if(!reduced.matches){let i=0;input.placeholder='';typeTimer=setInterval(()=>{input.placeholder=text.slice(0,++i);if(i>=text.length)clearInterval(typeTimer);},22);}
 });
 panel.addEventListener('submit',()=>{sync();sound(true);animate(mascot,'duck');});
 // Capture gives feedback before business handlers disable buttons or rerender dynamic chips.
 panel.addEventListener('click',event=>{
  const button=event.target.closest('#search-button,#theme-breakdown-btn,.topic-chip,#search-platform-trigger');if(!button||button.disabled)return;
  if(button.id==='search-platform-trigger'){sound(false,520);greet('选择资产平台 ▾');return;}
  ripple(event,button);queueMicrotask(sync);
  if(button===search)burst(event,button);
  else if(button===ai){sound(true);happy();greet('AI 正在拆解搜索主题…');}
  else{for(const chip of panel.querySelectorAll('.topic-chip'))chip.classList.toggle('active',chip===button);animate(button,'pop');sound(false,680);greet('已加载推荐主题：'+button.dataset.topic);}
 },true);
 panel.addEventListener('pointermove',event=>{
  if(reduced.matches||event.pointerType==='touch')return;
  point={x:event.clientX,y:event.clientY};if(frame)return;
  frame=requestAnimationFrame(()=>{frame=0;updateEyes();});
 });
 search.addEventListener('pointermove',event=>{if(reduced.matches||event.pointerType==='touch')return;const r=search.getBoundingClientRect();search.style.setProperty('--mx',Math.max(-4,Math.min(4,(event.clientX-r.left-r.width/2)*.12))+'px');search.style.setProperty('--my',Math.max(-4,Math.min(4,(event.clientY-r.top-r.height/2)*.18))+'px');});
 search.addEventListener('pointerleave',()=>{search.style.setProperty('--mx','0px');search.style.setProperty('--my','0px');});
 panel.addEventListener('search-motion-state',event=>{
  busy=event.detail.busy;search.classList.toggle('searching-active',busy);search.setAttribute('aria-busy',String(busy));sync();
  if(busy){thinking(true);greet('正在检索资产…');animate(mascot,'duck');}
  else{thinking(document.activeElement===input);if(event.detail.ok){greet('检索完成');animate(mascot,'peek');animate(panel,'flash');}else greet('检索未完成，请查看结果区提示');}
 });
 panel.addEventListener('animationend',event=>{if(event.target===panel)panel.classList.remove('motion-enter','flash');if(event.target.classList.contains('topic-chip'))event.target.classList.remove('pop');});
 // AI's real disabled state controls its loading animation, even when its text changes.
 new MutationObserver(()=>{ai.classList.toggle('searching-active',ai.disabled);if(ai.disabled)thinking(true);else if(!busy)thinking(document.activeElement===input);sync();}).observe(ai,{attributes:true,attributeFilter:['disabled']});
 const sparkle=document.createElement('span');sparkle.className='sparkle-icon';sparkle.textContent='✦';ai.replaceChildren(sparkle,document.createTextNode(' AI 拆解'));
 animate(panel,'motion-enter');animate(mascot,'enter');sync();
}
