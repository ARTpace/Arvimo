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
 const sizes=new WeakMap(),gridWidths=new WeakMap(),gridGaps=new WeakMap(),gridCards=new WeakMap(),dirty=new Set();
 const setStyle=(node,key,value)=>{if(node.style.getPropertyValue(key)!==value)node.style.setProperty(key,value);};
 const layout=()=>{
  frame=0;
  const grids=[...(root.matches('.model-grid.gallery')?[root]:[]),...root.querySelectorAll('.model-grid.gallery')];
  // 量不出宽度时**不是**「没有卡片」，而是「这会儿没法量」：切到下载页时 #library-view 是
  // display:none，#grid 的 clientWidth 归零。照常量算会把列数算成 1、宽度算成 0px，
  // 所有卡片被压成 0 宽堆到 (0,0)；切回来那一帧就先闪一下这种错位，再跳回正常排布。
  // 所以跳过这一轮，并且**不清 dirty**，等 ResizeObserver 在重新可见时再算一次。
  let stalled=false;
  for(const grid of grids){
   if(!(grid.clientWidth>0)){stalled=true;continue;}
   const cards=[...grid.children];
   const style=getComputedStyle(grid);
   const gapX=parseFloat(style.getPropertyValue('--lib-gap-x'));
   const gapY=parseFloat(style.getPropertyValue('--lib-gap-y'));
   const gap=Number.isFinite(gapX)?gapX:12;
   const rowGap=Number.isFinite(gapY)?gapY:14;
   const wanted=parseFloat(style.getPropertyValue('--lib-col-min'));
   const target=Number.isFinite(wanted)&&wanted>=80?wanted:190;
   const columns=window.innerWidth<=780?2:Math.max(1,Math.floor((grid.clientWidth+gap)/(target+gap)));
   const width=(grid.clientWidth-gap*(columns-1))/columns;
   const resized=gridWidths.get(grid)!==width;gridWidths.set(grid,width);
   const previous=gridCards.get(grid);
   const spacing=`${gap}:${rowGap}`;
   let changed=resized||gridGaps.get(grid)!==spacing||previous?.length!==cards.length;
   gridGaps.set(grid,spacing);
   for(const card of cards)if(resized||!sizes.has(card))setStyle(card,'--masonry-width',`${width}px`);
   if(resized&&cards.length)cards[0].getBoundingClientRect();
   const heights=cards.map((card,index)=>{
    const before=sizes.get(card);
    if(resized||dirty.has(root)||dirty.has(grid)||dirty.has(card)||!sizes.has(card))sizes.set(card,card.getBoundingClientRect().height);
    if(previous?.[index]!==card||before!==sizes.get(card))changed=true;
    return sizes.get(card);
   });
   gridCards.set(grid,cards);
   if(!changed)continue;
   const {positions,height}=masonryPositions(heights,columns,rowGap);
   cards.forEach((card,i)=>{
    setStyle(card,'--masonry-left',`${positions[i].column*(width+gap)}px`);
    setStyle(card,'--masonry-top',`${positions[i].top}px`);
   });
   setStyle(grid,'--masonry-height',`${height}px`);
  }
  if(!stalled)dirty.clear();
 };
 // 折叠动画期间 main 宽度逐帧变化，此时重排会逐张卡片强制同步布局（卡顿主因）。
 // 冻结这些帧，等 sidebar-collapse.js 在动画结束后补一次 resize 即可落到最终宽度。
 const schedule=()=>{
  // 可选链：masonry 也会被无 DOM 的 vm 环境（性能单测）直接跑，那里没有 documentElement。
  if(globalThis.document?.documentElement?.classList?.contains('side-animating'))return;
  if(!frame)frame=requestAnimationFrame(layout);
 };
 const invalidate=target=>{const card=target.closest?.('.model-card');dirty.add(card||target.closest?.('.model-grid')||root);};
 /** 立刻摆一次，不等下一帧。
  *
  * 卡片坐标是 CSS 变量（`--masonry-left/top`）给的，默认 0px；网格高度也默认 0px。
  * 「整块重建 innerHTML 后等 rAF 再量」这条路只要有一帧赶在测量之前绘制，用户就先看到
  * 所有卡片叠在左上角、页面高度塌成 0，然后「啪」一下跳开 —— 切页面 / 切瀑布流 /
  * 切内容模式时那一下闪就是它。重建方在同一个任务里调这里，测量就落在绘制之前；
  * 代价只是把本来下一帧要做的布局提前，样式本就一批算完，不会多做一遍。
  * 这里**不**往 dirty 里塞 root：新插入的卡片对象本来就不在 sizes 缓存里，
  * 会被单独量一次，沿用「只量变化过的卡」的快路径（翻页追加 60 张不会重测整屏）。
  * 不可见时走上面的 stalled 分支：什么都不写，dirty 留着，等可见了再算。 */
 const flush=()=>{layout();};
 new MutationObserver(records=>{
  for(const record of records)if(record.type!=='childList'||!record.target.matches('.model-grid'))invalidate(record.target);
  schedule();
 }).observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
 new ResizeObserver(schedule).observe(root);
 root.addEventListener('load',event=>{invalidate(event.target);schedule();},true);
 document.fonts?.ready.then(()=>{dirty.add(root);schedule();});
 window.addEventListener('resize',schedule);
 schedule();
 return {schedule,flush};
}
