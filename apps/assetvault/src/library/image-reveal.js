// ponytail: native load events + one observer cover all card renderers, including same-origin canvas frames.
const selector='img.thumbnail,img.model-thumb,img.task-image,img.cv-img,.model-card img,.pkg-collage img,.local-seq-cover img,.bd-card img,.bd-preview img,.local-gallery-strip img,.gallery-thumb-sidebar img,.preview-dialog img,[data-element-id] img';
const bound=new WeakSet();
export function bindImageReveal(doc=document){
 if(!doc?.documentElement||bound.has(doc))return;
 bound.add(doc);
 const style=doc.createElement('style');
 style.textContent=`.av-cover-pending{opacity:0!important}.av-cover-reveal{animation:av-cover-reveal .24s ease-out both!important}@keyframes av-cover-reveal{from{opacity:0}to{opacity:1}}@media(prefers-reduced-motion:reduce){.av-cover-reveal{animation:none!important}}`;
 (doc.head||doc.documentElement).append(style);
 const prepare=img=>{
  img.classList.remove('av-cover-reveal');
  img.classList.toggle('av-cover-pending',!img.complete);
 };
 const scan=node=>{
  if(node.nodeType!==1)return;
  if(node.matches(selector))prepare(node);
  node.querySelectorAll(selector).forEach(prepare);
  const frames=[...(node.matches('iframe')?[node]:[]),...node.querySelectorAll('iframe')];
  frames.forEach(frame=>{
   const connect=()=>{try{bindImageReveal(frame.contentDocument);}catch{/* External frames own their rendering. */}};
   if(!bound.has(frame)){bound.add(frame);frame.addEventListener('load',connect);}
   connect();
  });
 };
 doc.addEventListener('load',event=>{
  const img=event.target;if(!img.matches?.(selector))return;
  const pending=img.classList.contains('av-cover-pending');
  img.classList.remove('av-cover-pending');
  if(pending&&img.naturalWidth)img.classList.add('av-cover-reveal');
 },true);
 doc.addEventListener('error',event=>event.target.classList?.remove('av-cover-pending'),true);
 const observer=new MutationObserver(records=>{
  for(const record of records){
   if(record.type==='attributes'){if(record.target.matches(selector))prepare(record.target);}
   else record.addedNodes.forEach(scan);
  }
 });
 observer.observe(doc.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','srcset']});
 scan(doc.documentElement);
}
