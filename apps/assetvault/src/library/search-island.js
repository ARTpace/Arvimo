const MODE_KEY='av-search-layout';

// ponytail: move the existing panel, never clone its inputs or business handlers.
export function initSearchIsland(panel,{storage}={}){
 if(!panel||panel.dataset.islandReady)return;
 panel.dataset.islandReady='1';
 const doc=panel.ownerDocument,form=panel.querySelector('#asset-search-form');
 const input=panel.querySelector('#asset-query'),search=panel.querySelector('#search-button');
 const sticky=panel.closest('.search-sticky');
 if(!form||!input||!search||!sticky)return;
 const slot=doc.createElement('div');slot.className='search-island-slot';
 panel.before(slot);slot.append(panel);
 const toggle=panel.querySelector('#search-layout-toggle');
 if(!toggle)return;
 toggle.setAttribute('aria-controls',panel.id);
 const status=doc.createElement('div');status.className='search-island-status';
 status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=true;
 panel.append(status);
 const line=doc.createElement('button');line.type='button';line.className='island-rest-line';
 line.setAttribute('aria-label','展开搜索');line.title='展开搜索';
 line.addEventListener('click',()=>{
  clearTimeout(collapseTimer);
  panel.classList.add('island-open');
  input.focus();
 });
 const field=panel.querySelector('.search-field');
 if(field)field.insertBefore(line,field.querySelector('.global-search'));
 else form.prepend(line);
 const searchLabel=doc.createElement('span');searchLabel.className='search-button-label';
 // Keep the original submit button and its icon; only give its existing text a styling hook.
 for(const node of [...search.childNodes])if(node.nodeType===3)searchLabel.append(node);
 search.append(searchLabel);search.setAttribute('aria-label','搜索 / 解析');
 let island=false,requestedIsland=false,modeRevision=0,modeTransition=null;
 const modeAnimations=new Map();
 const reduced=doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
 function stopModeMotion(){
  modeTransition?.skipTransition();
  for(const animation of [...modeAnimations.values()])animation.cancel();
  modeAnimations.clear();sticky.classList.remove('search-layout-morphing');delete sticky.dataset.layoutMotion;
 }
 function commitMode(next,event){
  setMode(next);
  if(event.detail)toggle.blur();
  try{storage?.setItem(MODE_KEY,next);}catch{}
 }
 function switchMode(event){
  const next=requestedIsland?'normal':'island';requestedIsland=next==='island';
  const revision=++modeRevision;
  // Capture the old presentation before changing display/layout, so its controls don't hard-cut.
  if(doc.startViewTransition&&!reduced?.matches&&!doc.hidden){
   stopModeMotion();
   doc.documentElement.dataset.searchLayoutTransition='true';
   const transition=doc.startViewTransition(()=>{
    if(revision===modeRevision)commitMode(next,event);
   });
   modeTransition=transition;
   const finish=()=>{
    if(modeTransition!==transition)return;
    modeTransition=null;delete doc.documentElement.dataset.searchLayoutTransition;
   };
   transition.finished.then(finish,finish);
   return;
  }
  const nodes=[panel,sticky.querySelector('#content-kind-tabs'),doc.getElementById('library-view')].filter(node=>node?.animate);
  const moving=!reduced?.matches&&!doc.hidden;
  // Read the currently displayed geometry before cancelling an interrupted transition.
  const starts=moving?nodes.map(node=>node.getBoundingClientRect()):[];
  stopModeMotion();
  sticky.classList.add('search-layout-morphing');
  commitMode(next,event);
  const ends=moving?nodes.map(node=>node.getBoundingClientRect()):[];
  nodes.forEach((node,index)=>{
   const from=starts[index],to=ends[index];
   if(!from?.width||!from.height||!to?.width||!to.height)return;
   const scale=node===panel?` scale(${from.width/to.width},${from.height/to.height})`:'';
   const animation=node.animate([
    {transform:`translate(${from.left-to.left}px,${from.top-to.top}px)${scale}`,transformOrigin:'0 0'},
    {transform:'none',transformOrigin:'0 0'},
   ],{duration:island?440:520,easing:'cubic-bezier(.22,.8,.2,1)'});
   modeAnimations.set(node,animation);
   const finish=()=>{
    if(modeAnimations.get(node)!==animation)return;
    modeAnimations.delete(node);
    if(!modeAnimations.size){sticky.classList.remove('search-layout-morphing');delete sticky.dataset.layoutMotion;}
   };
   animation.onfinish=finish;animation.oncancel=finish;
  });
  if(modeAnimations.size)sticky.dataset.layoutMotion='true';
  else sticky.classList.remove('search-layout-morphing');
 }
 function setMode(value){
  island=value==='island';sticky.dataset.searchLayout=island?'island':'normal';
  toggle.title=island?'恢复完整搜索':'切换为灵动岛模式';
  toggle.setAttribute('aria-label',toggle.title);toggle.setAttribute('aria-pressed',String(island));
 }
 let saved='normal';try{storage??=globalThis.localStorage;saved=storage?.getItem(MODE_KEY);}catch{}
 setMode(saved);
 requestedIsland=island;
 toggle.addEventListener('click',event=>{
  switchMode(event);
 });
 reduced?.addEventListener?.('change',()=>{if(reduced.matches)stopModeMotion();});
 doc.addEventListener('visibilitychange',()=>{if(doc.hidden)stopModeMotion();});
 let failTimer=0,collapseTimer=0;
 const theme=panel.querySelector('#theme-results');
 const bubble=panel.querySelector('#search-mascot-bubble');
 function paintLine(){
  const hint=bubble?.classList.contains('show')?bubble.querySelector('.update-bubble-text')?.textContent?.trim():'';
  if(panel.classList.contains('island-busy'))line.textContent=status.textContent||'正在搜索…';
  else if(panel.classList.contains('island-fail'))line.textContent=doc.getElementById('scan-status')?.textContent?.trim()||status.textContent||'搜索未完成';
  else line.textContent=hint||'想找什么素材？告诉我吧';
  line.title=line.textContent;
 }
 function wantsOpen(){
  return panel.contains(doc.activeElement)||!!panel.querySelector('.search-image-query:not([hidden])')||!!panel.querySelector('#filter-drawer:not([hidden])');
 }
 function scheduleCollapse(){
  clearTimeout(collapseTimer);
  collapseTimer=setTimeout(()=>{if(!wantsOpen())panel.classList.remove('island-open');},300);
 }
 panel.addEventListener('pointerleave',scheduleCollapse);
 panel.addEventListener('focusin',event=>{
  if(event.target===input)panel.classList.add('island-open');
 });
 // ponytail: use the existing slot for proximity feedback; never move the click targets.
 slot.addEventListener('pointermove',event=>{
  if(!island||event.pointerType==='touch'||reduced?.matches)return;
  const bounds=panel.getBoundingClientRect();
  const distance=Math.max(bounds.left-event.clientX,0,event.clientX-bounds.right);
  panel.classList.toggle('island-near',distance<56);
 });
 slot.addEventListener('pointerleave',()=>panel.classList.remove('island-near'));
 panel.addEventListener('focusout',scheduleCollapse);
 panel.addEventListener('search-motion-state',event=>{
  const {busy,reset,ok}=event.detail||{};
  panel.classList.toggle('island-busy',!!busy);
  if(busy)panel.classList.remove('island-fail');
  const terms=theme?[...theme.querySelectorAll('.theme-chip')].map(node=>node.dataset.term).filter(Boolean):[];
  status.hidden=!!reset;status.textContent=reset?'':busy?`正在搜 · ${(terms.length?terms:[input.value.trim()]).filter(Boolean).join(' / ')||'…'}`:ok?'搜索完成':'搜索未完成';
  clearTimeout(failTimer);
  if(!busy&&ok===false){panel.classList.add('island-fail');failTimer=setTimeout(()=>{panel.classList.remove('island-fail');paintLine();},2600);}
  paintLine();
 });
 input.addEventListener('input',()=>{if(!panel.classList.contains('island-busy')){status.hidden=true;paintLine();}});
 const watch=new doc.defaultView.MutationObserver(()=>paintLine());
 if(bubble)watch.observe(bubble,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});
 const scan=doc.getElementById('scan-status'),grid=doc.getElementById('library-view');
 if(scan)watch.observe(scan,{childList:true,subtree:true,characterData:true});
 if(grid)watch.observe(grid,{childList:true});
 if(theme)watch.observe(theme,{childList:true});
 paintLine();
 doc.addEventListener('pointerdown',event=>{
  if(!island||!panel.contains(doc.activeElement)||panel.contains(event.target))return;
  if(event.target.closest('#history-pop,[data-picker-menu],#filter-drawer'))return;
  doc.activeElement?.blur();
 });
 panel.addEventListener('keydown',event=>{
  if(island&&event.key==='Escape'&&!event.isComposing)doc.activeElement?.blur();
 });
}
