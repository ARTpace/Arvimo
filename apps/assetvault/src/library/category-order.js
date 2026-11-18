import {MODE_PRESETS} from './mode-presets.js';

export function categoryOrder(options={}){
 const ids=MODE_PRESETS.map(row=>row.groupId);
 return [...new Set([...(Array.isArray(options.categoryOrder)?options.categoryOrder:[]).filter(id=>ids.includes(id)),...ids])];
}
export function orderedCategories(rows,options,key=row=>row.id){
 const order=categoryOrder(options);
 return [...rows].sort((a,b)=>{
  const rank=row=>{const i=order.indexOf(key(row));return i<0?order.length:i;};
  return rank(a)-rank(b);
 });
}
export function moveCategory(options,source,target,after=false){
 const order=categoryOrder(options);
 if(source===target||!order.includes(source)||!order.includes(target))return false;
 const next=order.filter(id=>id!==source);
 next.splice(next.indexOf(target)+(after?1:0),0,source);
 if(next.every((id,i)=>id===order[i]))return false;
 options.categoryOrder=next;return true;
}

/** Both surfaces use the same mother-category ids and one persisted order. */
export function setupCategoryOrder({root,state,onChange}){
 let source='',suppressClick=false,preview=null,slots=[];
 const item=event=>event.target.closest?.('[data-category-order]');
 const reduced=()=>root.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 const key=node=>(node.matches('.ck-tab')?'top:':'side:')+node.dataset.categoryOrder;
 const rowOf=node=>node.matches('.ck-tab')?node:node.closest('.ftree-group')||node;
 const restore=()=>{
  for(const slot of slots){
   slot.row.style.translate=slot.translate;
   slot.row.classList.remove('category-order-preview');
   slot.node.classList.remove('category-drop-before','category-drop-after','category-dragging');
  }
 };
 const finish=()=>{
  restore();source='';preview=null;slots=[];
  setTimeout(()=>{suppressClick=false;},0);
 };
 const showPreview=event=>{
  const node=item(event);if(!source||!node)return false;
  const horizontal=node.matches('.ck-tab'),axis=horizontal?'left':'top',size=horizontal?'width':'height';
  const coordinate=horizontal?event.clientX:event.clientY;
  const surface=slots.filter(slot=>slot.horizontal===horizontal);
  if(!surface.length)return false;
  // Hit-test the original slots, not their animated positions, to avoid oscillation.
  const target=surface.reduce((best,slot)=>Math.abs(coordinate-slot.rect[axis]-slot.rect[size]/2)<Math.abs(coordinate-best.rect[axis]-best.rect[size]/2)?slot:best);
  const after=coordinate>target.rect[axis]+target.rect[size]/2;
  const next={categoryOrder:categoryOrder(state.options)};
  moveCategory(next,source,target.id,after);
  const order=categoryOrder(next);
  if(preview&&order.every((id,i)=>id===preview[i]))return true;
  preview=order;
  for(const slot of slots)slot.node.classList.remove('category-drop-before','category-drop-after');
  if(target.id!==source)target.node.classList.add(after?'category-drop-after':'category-drop-before');
  for(const horizontal of [true,false]){
   const rows=slots.filter(slot=>slot.horizontal===horizontal);if(!rows.length)continue;
   const axis=horizontal?'left':'top',size=horizontal?'width':'height';
   const gap=rows.length>1?rows[1].rect[axis]-rows[0].rect[axis]-rows[0].rect[size]:0;
   let position=rows[0].rect[axis];
   for(const id of preview){
    const slot=rows.find(slot=>slot.id===id);if(!slot)continue;
    const delta=position-slot.rect[axis];
    slot.row.classList.toggle('category-order-preview',!reduced());
    slot.row.style.translate=horizontal?`${delta}px 0px`:`0px ${delta}px`;
    position+=slot.rect[size]+gap;
   }
  }
  return true;
 };
 root.addEventListener('dragstart',event=>{
  const node=item(event);if(!node)return;
  source=node.dataset.categoryOrder;suppressClick=true;preview=categoryOrder(state.options);
  slots=[...root.querySelectorAll('[data-category-order]')].map(node=>{
   const row=rowOf(node);
   return {node,row,id:node.dataset.categoryOrder,horizontal:node.matches('.ck-tab'),rect:row.getBoundingClientRect(),translate:row.style.translate||''};
  });
  event.dataTransfer.effectAllowed='move';
  event.dataTransfer.setData('application/x-arvimo-category',source);
  node.classList.add('category-dragging');
 });
 root.addEventListener('dragover',event=>{
  if(!showPreview(event))return;
  event.preventDefault();event.dataTransfer.dropEffect='move';
 });
 root.addEventListener('drop',event=>{
  if(!source||!item(event))return;
  event.preventDefault();
  // A drop can arrive without a preceding dragover (e.g. a quick cross-surface move).
  showPreview(event);
  const before=new Map();
  if(!reduced())for(const slot of slots)if(slot.row.animate)before.set(key(slot.node),slot.row.getBoundingClientRect());
  const order=preview,changed=order.some((id,i)=>id!==categoryOrder(state.options)[i]);
  finish();
  if(changed){
   state.options.categoryOrder=order;onChange();
   for(const node of root.querySelectorAll('[data-category-order]')){
    const row=rowOf(node),old=before.get(key(node));if(!old||!row.animate)continue;
    const next=row.getBoundingClientRect(),dx=old.left-next.left,dy=old.top-next.top;
    if(Math.abs(dx)+Math.abs(dy)<1)continue;
    row.animate([{translate:`${dx}px ${dy}px`},{translate:'0px 0px'}],{duration:220,easing:'cubic-bezier(.22,.61,.36,1)'});
   }
  }
 });
 root.addEventListener('dragend',finish);
 root.addEventListener('keydown',event=>{if(source&&event.key==='Escape')finish();},true);
 root.addEventListener('click',event=>{
  if(suppressClick&&item(event)){event.preventDefault();event.stopImmediatePropagation();}
 },true);
}
