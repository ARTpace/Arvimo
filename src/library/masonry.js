// 按数据顺序追加到最短列；追加卡片不会改变前面卡片的列和坐标。
export function masonryPositions(heights,columns,gap){
 const bottoms=Array(columns).fill(0);
 const positions=heights.map(height=>{
  const column=bottoms.indexOf(Math.min(...bottoms));
  const top=bottoms[column];
  bottoms[column]+=height+gap;
  return {column,top};
 });
 return {positions,height:Math.max(0,...bottoms)- (heights.length?gap:0)};
}

export function observeMasonry(root){
 let frame=0;
 const layout=()=>{
  frame=0;
  const grids=[...(root.matches('.model-grid.gallery')?[root]:[]),...root.querySelectorAll('.model-grid.gallery')];
  for(const grid of grids){
   const cards=[...grid.children];
   const gap=window.innerWidth<=780?12:18;
   const columns=window.innerWidth<=780?2:Math.max(1,Math.floor((grid.clientWidth+gap)/(250+gap)));
   const width=(grid.clientWidth-gap*(columns-1))/columns;
   for(const card of cards)card.style.setProperty('--masonry-width',`${width}px`);
   const {positions,height}=masonryPositions(cards.map(card=>card.getBoundingClientRect().height),columns,gap);
   cards.forEach((card,i)=>{
    card.style.setProperty('--masonry-left',`${positions[i].column*(width+gap)}px`);
    card.style.setProperty('--masonry-top',`${positions[i].top}px`);
   });
   grid.style.setProperty('--masonry-height',`${height}px`);
  }
 };
 const schedule=()=>{if(!frame)frame=requestAnimationFrame(layout);};
 new MutationObserver(schedule).observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
 new ResizeObserver(schedule).observe(root);
 root.addEventListener('load',schedule,true);
 window.addEventListener('resize',schedule);
 schedule();
}
