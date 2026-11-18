// One passive listener for page and nested-panel scrolling. Only the first and
// last event change styles; scrolling never rebuilds cards or blocks input.
// Automatic paging shares the scroll-idle gate across model and picture sites.
// The callback rechecks its current route/feed; manual actions bypass this gate.
export function scrollIdleTask(run,doc=document){
 let pending=false;
 const request=()=>{
  if(doc.hidden){pending=false;return;}
  if(doc.documentElement.classList.contains('av-scrolling')){pending=true;return;}
  pending=false;run();
 };
 doc.addEventListener('assetvault:scroll-idle',()=>{if(pending)request();});
 return request;
}

export function bindScrollPerformance(doc=document,win=window){
 let timer=0,active=false;
 const finish=()=>{
  if(timer)win.clearTimeout(timer);
  timer=0;
  if(!active)return;
  active=false;
  doc.documentElement.classList.remove('av-scrolling');
  doc.dispatchEvent?.(new (win.Event||globalThis.Event)('assetvault:scroll-idle'));
 };
 const onScroll=()=>{
  if(!active){active=true;doc.documentElement.classList.add('av-scrolling');}
  if(timer)win.clearTimeout(timer);
  timer=win.setTimeout(finish,140);
 };
 const onVisibility=()=>{if(doc.hidden)finish();};
 doc.addEventListener('scroll',onScroll,{capture:true,passive:true});
 doc.addEventListener('visibilitychange',onVisibility);
 return ()=>{
  doc.removeEventListener('scroll',onScroll,true);
  doc.removeEventListener('visibilitychange',onVisibility);
  finish();
 };
}
