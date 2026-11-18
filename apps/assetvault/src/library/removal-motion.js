const reduceMotion=()=>globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
const easing='cubic-bezier(.22,.61,.36,1)';
/** A separate visual copy survives list re-rendering; failed mutations restore the original. */
export async function withRemovalMotion(nodes,commit){
 const ghosts=[];
 if(!reduceMotion())for(const node of new Set(nodes||[])){
  if(!node?.isConnected||typeof node.animate!=='function')continue;
  const rect=node.getBoundingClientRect?.();
  const win=node.ownerDocument?.defaultView;
  if(!rect?.width||!rect.height||rect.bottom<0||rect.top>(win?.innerHeight||Infinity))continue;
  const ghost=node.cloneNode(true);
  ghost.removeAttribute('id');for(const child of ghost.querySelectorAll('[id]'))child.removeAttribute('id');
  ghost.classList.add('removal-ghost');ghost.setAttribute('aria-hidden','true');ghost.inert=true;
  Object.assign(ghost.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',margin:'0',transform:'none',translate:'none',zIndex:'10010',pointerEvents:'none',boxSizing:'border-box'});
  node.ownerDocument.body.append(ghost);
  const visibility=node.style.visibility;node.style.visibility='hidden';
  let animation;
  try{animation=ghost.animate([
   {opacity:1,transform:'scale(1) rotate(0deg)',filter:'blur(0px)'},
   {opacity:1,transform:'scale(1.025) rotate(-1deg)',offset:.2},
   {opacity:0,transform:'translateY(-12px) scale(.76) rotate(3deg)',filter:'blur(3px)'}
  ],{duration:280,easing,fill:'forwards'});}catch{ghost.remove();node.style.visibility=visibility;continue;}
  ghosts.push({node,ghost,visibility,animation});
 }
 try{
  const result=await commit();
  await Promise.all(ghosts.map(({animation})=>animation.finished.catch(()=>{})));
  return result;
 }finally{
  for(const {node,ghost,visibility,animation} of ghosts){animation.cancel();ghost.remove();node.style.visibility=visibility;}
 }
}
/** Board cards are recreated by paint(), so match their old/new positions by stable board id. */
export function boardPositions(host){
 if(reduceMotion())return new Map();
 return new Map([...host.querySelectorAll('[data-bd-open]')].map(node=>[node.dataset.bdOpen,node.getBoundingClientRect?.()]).filter(([,rect])=>rect?.width));
}
export function animateBoardPositions(host,before){
 if(reduceMotion()||!before.size)return;
 for(const node of host.querySelectorAll('[data-bd-open]')){
  const old=before.get(node.dataset.bdOpen),rect=node.getBoundingClientRect?.();
  if(!old||!rect||!node.animate)continue;
  const dx=old.left-rect.left,dy=old.top-rect.top;
  if(Math.abs(dx)<1&&Math.abs(dy)<1)continue;
  node.animate([{translate:`${dx}px ${dy}px`},{translate:'0px 0px'}],{duration:260,easing});
 }
}
