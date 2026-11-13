// Business state changes immediately; only user-triggered folds animate.
const running=new WeakMap();
export function setTreeOpen(section,open,animate=false){
 const body=section.querySelector(':scope > .ftree-body');
 const head=section.querySelector(':scope > .ftree-branch,:scope > .ftree-group-head');
 const changed=section.classList.contains('open')!==open;
 const moving=animate&&changed&&section.isConnected&&body?.animate&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 const start=moving?body.getBoundingClientRect().height:0;
 const opacity=moving?getComputedStyle(body).opacity:0;
 const previous=body&&running.get(body);
 if(previous){previous.animation.cancel();previous.restore();}
 section.classList.toggle('open',open);head?.setAttribute('aria-expanded',String(open));
 if(!body)return;
 body.inert=!open;
 if(!moving)return;
 const saved={display:body.style.display,transition:body.style.transition,overflow:body.style.overflow};
 body.style.transition='none';body.style.display='block';body.style.overflow='hidden';
 const end=open?body.scrollHeight:0;
 const animation=body.animate([{height:`${start}px`,opacity},{height:`${end}px`,opacity:open?1:0}],{
  duration:open?200:150,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both',
 });
 const entry={animation,restore(){
  if(running.get(body)!==entry)return;
  Object.assign(body.style,saved);running.delete(body);animation.cancel();
 }};
 running.set(body,entry);
 animation.onfinish=entry.restore;animation.oncancel=entry.restore;
}

export function setupDetailsMotion(root){
 const pending=new WeakMap();
 root.addEventListener('click',event=>{
  const summary=event.target.closest('summary');
  const details=summary?.parentElement;
  if(!details?.matches('.settings-group')||!details.animate||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  event.preventDefault();
  const previous=pending.get(details),open=!(previous?.open??details.open);
  const start=details.getBoundingClientRect().height;
  previous?.animation.cancel();
  const overflow=previous?.overflow??details.style.overflow;
  details.open=true;details.style.overflow='hidden';
  const end=open?details.scrollHeight:summary.getBoundingClientRect().height+details.offsetHeight-details.clientHeight;
  const animation=details.animate([{height:`${start}px`},{height:`${end}px`}],{duration:open?200:150,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'});
  const entry={animation,open,overflow};pending.set(details,entry);
  animation.onfinish=()=>{
   if(pending.get(details)!==entry)return;
   details.open=open;details.style.overflow=overflow;pending.delete(details);animation.cancel();
  };
 });
}
