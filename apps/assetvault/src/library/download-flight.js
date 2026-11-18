/** 仅在队列接受任务后播放；最多三张，不为批量下载复制整批卡片。 */
export function captureDownloadFlight(models,doc=document){
 if(doc.body?.dataset.route!=='discover')return()=>{};
 const target=doc.querySelector('#sidebar [data-route="downloads"]');
 if(!target)return()=>{};
 const sources=models.slice(0,3).map(model=>{
  const card=[...doc.querySelectorAll('#grid [data-uid]')].find(node=>node.dataset.uid===model.uid);
  const img=card?.querySelector('img');
  return card?{rect:card.getBoundingClientRect(),src:img?.currentSrc||img?.getAttribute('src')||''}:null;
 }).filter(Boolean);
 return()=>{
  if(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
  const end=target.getBoundingClientRect();
  if(!end.width||!end.height)return;
  sources.forEach(({rect,src},index)=>{
   if(!rect.width||!rect.height)return;
   const ghost=doc.createElement(src?'img':'div');if(src)ghost.src=src;
   ghost.setAttribute('aria-hidden','true');
   Object.assign(ghost.style,{position:'fixed',left:`${rect.left}px`,top:`${rect.top}px`,width:`${Math.min(rect.width,160)}px`,height:`${Math.min(rect.height,180)}px`,objectFit:'cover',borderRadius:'14px',pointerEvents:'none',zIndex:'2147483646',background:'var(--accent,#c9f581)',boxShadow:'0 8px 28px #0006'});
   doc.body.append(ghost);
   const x=end.left+end.width/2-rect.left,y=end.top+end.height/2-rect.top;
   const animation=ghost.animate?.([{transform:'translate(0,0) scale(1)',opacity:.9},{transform:`translate(${x*.45}px,${y*.4-55}px) scale(.6)`,opacity:.85,offset:.5},{transform:`translate(${x}px,${y}px) scale(.08)`,opacity:0}],{duration:650,delay:index*65,easing:'cubic-bezier(.22,.7,.25,1)',fill:'forwards'});
   if(!animation){ghost.remove();return;}
   animation.finished.then(()=>{ghost.remove();target.animate?.([{transform:'scale(1)'},{transform:'scale(1.12)'},{transform:'scale(1)'}],{duration:240});},()=>ghost.remove());
  });
 };
}
