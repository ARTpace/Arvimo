// Preserve native wheel/keyboard scrolling; extend thumb dragging beyond gutters.
export function bindScrollbarInteraction(doc=document,win=window){
 let shown=null,drag=null,frame=0,last=null;
 const show=node=>{
  if(shown===node)return;
  shown?.classList.remove('av-scrollbar-near');shown=node;
  shown?.classList.add('av-scrollbar-near');
 };
 const geometry=node=>{
  const page=node===doc.scrollingElement;
  const rect=page?{left:0,top:0,right:win.innerWidth,bottom:win.innerHeight}:node.getBoundingClientRect();
  return {rect,width:page?doc.documentElement.clientWidth:node.clientWidth,
   height:page?doc.documentElement.clientHeight:node.clientHeight,page};
 };
 const near=event=>{
  let node=event.target?.nodeType===1?event.target:doc.scrollingElement;
  while(node){
   const vertical=node.scrollHeight>node.clientHeight+1;
   const horizontal=node.scrollWidth>node.clientWidth+1;
   if(vertical||horizontal){
    const g=geometry(node),r=g.rect;
    const style=win.getComputedStyle(node);
    const allows=axis=>g.page||/auto|scroll/.test(style[axis]);
    if(vertical&&allows('overflowY')&&event.clientY>=r.top&&event.clientY<=r.bottom&&event.clientX>=r.right-24&&event.clientX<=r.right)return {node,g,axis:'y'};
    if(horizontal&&allows('overflowX')&&event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.bottom-24&&event.clientY<=r.bottom)return {node,g,axis:'x'};
   }
   node=node===doc.scrollingElement?null:node.parentElement;
  }
  return null;
 };
 const move=event=>{
  last=event;
  if(drag){
   if(!(event.buttons&1)){finish();return;}
   const coordinate=drag.axis==='y'?event.clientY:event.clientX;
   drag.node[drag.axis==='y'?'scrollTop':'scrollLeft']=drag.scroll+(coordinate-drag.start)*drag.ratio;
   event.preventDefault();return;
  }
  if(!frame)frame=win.requestAnimationFrame(()=>{frame=0;show(near(last)?.node??null);});
 };
 const down=event=>{
  if(event.button!==0)return;
  const hit=near(event);if(!hit)return;
  const {node,g,axis}=hit,r=g.rect;
  const gutter=axis==='y'?r.right-r.left-g.width:r.bottom-r.top-g.height;
  const cross=axis==='y'?r.right-event.clientX:r.bottom-event.clientY;
  // Only intercept the actual native gutter, never adjacent content/buttons.
  if(gutter<1||cross>gutter)return;
  const extent=axis==='y'?g.height:g.width;
  const total=axis==='y'?node.scrollHeight:node.scrollWidth;
  const scroll=axis==='y'?node.scrollTop:node.scrollLeft;
  const thumb=Math.min(extent,Math.max(44,extent*extent/total));
  const travel=extent-thumb,range=total-extent;
  if(travel<=0||range<=0)return;
  const coordinate=axis==='y'?event.clientY:event.clientX;
  const offset=coordinate-(axis==='y'?r.top:r.left);
  const thumbStart=scroll/range*travel;
  // Track clicks retain native page scrolling; capture starts on the thumb.
  if(offset<thumbStart||offset>thumbStart+thumb)return;
  drag={node,axis,start:coordinate,scroll,ratio:range/travel};
  show(node);node.classList.add('av-scrollbar-dragging');
  event.preventDefault();event.stopPropagation();
 };
 const finish=()=>{
  if(!drag)return;
  drag.node.classList.remove('av-scrollbar-dragging');drag=null;
  show(last?near(last)?.node??null:null);
 };
 const leave=()=>{if(!drag)show(null);};
 doc.addEventListener('mousedown',down,true);
 win.addEventListener('mousemove',move,{capture:true,passive:false});
 win.addEventListener('mouseup',finish,true);
 win.addEventListener('blur',finish);
 doc.documentElement.addEventListener('mouseleave',leave);
 return ()=>{
  finish();show(null);if(frame)win.cancelAnimationFrame(frame);
  doc.removeEventListener('mousedown',down,true);
  win.removeEventListener('mousemove',move,true);win.removeEventListener('mouseup',finish,true);
  win.removeEventListener('blur',finish);doc.documentElement.removeEventListener('mouseleave',leave);
 };
}
