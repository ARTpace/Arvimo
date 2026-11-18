// 优先按数据顺序放置，允许后续卡片回填空位及宽卡配对，以减少跨列空洞。
//
// 跨列：spans 里的数字是这张卡要占几列。横版图占两列（宽度翻倍，明显更大），
// 竖版 / 方形仍占一列，尺寸和以前完全一样。跨列卡片要占住相邻的列，
// 选位时取这一段里最高的底线，免得压到邻居。
export function masonryPositions(heights,columns,gap,spans=[]){
 // 直接维护空闲区间，避免每放一张卡都合并、排序全部历史占用区间。
 const lanes=Array.from({length:columns},()=>[{top:0,bottom:Infinity}]),positions=Array(heights.length);
 let bottom=0;
 const pending=heights.map((_,index)=>index);
 const span=index=>Math.max(1,Math.min(spans[index]||1,columns));
 const slot=(want,height)=>{
  let column=0,top=Infinity;
  for(let c=0;c+want<=columns;c++){
   const indexes=Array(want).fill(0);
   let y=0;
   while(true){
    let end=Infinity,advance=0;
    for(let i=0;i<want;i++){
     const interval=lanes[c+i][indexes[i]];
     y=Math.max(y,interval.top);
     if(interval.bottom<end){end=interval.bottom;advance=i;}
    }
    if(y+height+gap<=end)break;
    indexes[advance]++;
   }
   if(y<top){top=y;column=c;}
  }
  return {column,top,span:want};
 };
 while(pending.length){
  let index=pending.shift(),want=span(index),place=slot(want,heights[index]);
  if(want===2){
   let free=0;
   for(let c=place.column;c<columns;c++){
    if(!lanes[c].some(r=>r.top<=place.top&&place.top+heights[index]+gap<=r.bottom))break;
    free++;
   }
   // 三个半列的空位优先留给宽卡，避免先塞普通卡后剩下无法使用的半列。
   if(free===3){
    const next=pending.findIndex(i=>span(i)===3&&slot(3,heights[i]).top<=place.top);
    if(next>=0){pending.unshift(index);index=pending.splice(next+1,1)[0];want=3;place=slot(want,heights[index]);}
   }
  }
  positions[index]=place;
  const rect={top:place.top,bottom:place.top+heights[index]+gap};
  bottom=Math.max(bottom,rect.bottom);
  for(let c=place.column;c<place.column+want;c++){
   const lane=lanes[c],at=lane.findIndex(r=>r.top<=rect.top&&rect.bottom<=r.bottom),space=lane[at];
   const pieces=[];
   if(space.top<rect.top)pieces.push({top:space.top,bottom:rect.top});
   if(rect.bottom<space.bottom)pieces.push({top:rect.bottom,bottom:space.bottom});
   lane.splice(at,1,...pieces);
  }
 }
 return {positions,height:bottom-(heights.length?gap:0)};
}

export function masonryCardSpan(card,columns){
 return Math.min(columns,card.classList.contains('pkg-c9')||card.classList.contains('pkg-wide')?2:1);
}

export function observeMasonry(root){
 let frame=0,resizeTimer=0;
 const sizes=new WeakMap(),paintSizes=new WeakMap(),cardWidths=new WeakMap(),gridWidths=new WeakMap(),gridGaps=new WeakMap(),gridCards=new WeakMap(),dirty=new Set();
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
   const columns=window.innerWidth<=780?Math.min(2,Math.max(1,Math.floor((grid.clientWidth+gap)/(80+gap)))):Math.max(1,Math.floor((grid.clientWidth+gap)/(target+gap)));
   // 等宽单列卡片按最短列追加，避免跨列卡片在短列上方架空。
   // 把剩余宽度均分到各列，最后一列贴齐内容区右边缘。
   const width=(grid.clientWidth-gap*(columns-1))/columns;
   // 统一整列尺寸，避免 1.5 列宽留下普通卡无法填补的半列窄洞。
   const units=columns,unitWidth=width;
   const spans=cards.map(card=>masonryCardSpan(card,columns));
   const resized=gridWidths.get(grid)!==width;gridWidths.set(grid,width);
   const previous=gridCards.get(grid);
   const spacing=`${gap}:${rowGap}`;
   let changed=resized||gridGaps.get(grid)!==spacing||previous?.length!==cards.length;
   gridGaps.set(grid,spacing);
   // 所有卡片共用列宽，横竖图片仅高度不同。
   // 宽度按卡片缓存，只有真变了才写回 —— 否则每帧都要把上千张卡的样式读一遍（性能测试守着这条）。
   for(const [index,card] of cards.entries()){
    const next=spans[index]*(unitWidth+gap)-gap;
    if(cardWidths.get(card)!==next){cardWidths.set(card,next);setStyle(card,'--masonry-width',`${next}px`);dirty.add(card);changed=true;}
   }
   // 测量前批量恢复自然布局，不能把屏幕外的占位高度当成新尺寸。
   const measuring=cards.filter(card=>resized||dirty.has(root)||dirty.has(grid)||dirty.has(card)||!sizes.has(card));
   for(const card of measuring)card.style.contentVisibility='visible';
   if(resized&&cards.length)cards[0].getBoundingClientRect();
   const heights=cards.map((card,index)=>{
    const before=sizes.get(card);
    // 布局尺寸不能取带 transform 动画的视觉包围盒，否则动画中间高度会被缓存，导致后续卡片压上来。
    if(resized||dirty.has(root)||dirty.has(grid)||dirty.has(card)||!sizes.has(card))sizes.set(card,card.offsetHeight ?? card.getBoundingClientRect().height);
    if(previous?.[index]!==card||before!==sizes.get(card))changed=true;
    return sizes.get(card);
   });
   const paintHeights=measuring.map(card=>{
    const style=getComputedStyle(card);
    const edges=['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'].reduce((sum,key)=>sum+(parseFloat(style[key])||0),0);
    return [card,Math.max(0,sizes.get(card)-edges)];
   });
   for(const [card,height] of paintHeights){
    if(paintSizes.get(card)!==height){
     paintSizes.set(card,height);setStyle(card,'--masonry-content-height',`${height}px`);
     setStyle(card,'--masonry-paint','auto');
    }
    card.style.contentVisibility='';
   }
   gridCards.set(grid,cards);
   if(!changed)continue;
   const {positions,height}=masonryPositions(heights,units,rowGap,spans);
   cards.forEach((card,i)=>{
    setStyle(card,'--masonry-left',`${positions[i].column*(unitWidth+gap)}px`);
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
  if(resizeTimer)return;
  if(!frame)frame=requestAnimationFrame(layout);
 };
 // 连续拖动窗口时保留现有卡片排布，宽度稳定 100ms 后精排一次。
 // ResizeObserver 与窗口事件共用这个入口，图片加载不会在拖动中绕过合并。
 const scheduleResize=()=>{
  if(!window.setTimeout){schedule();return;}
  if(frame){cancelAnimationFrame(frame);frame=0;}
  if(resizeTimer)window.clearTimeout(resizeTimer);
  resizeTimer=window.setTimeout(()=>{resizeTimer=0;schedule();},100);
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
 const invalidateRecords=records=>{
  for(const record of records)if(record.type!=='childList'||!record.target.matches('.model-grid'))invalidate(record.target);
 };
 const flush=()=>{
  if(resizeTimer){window.clearTimeout(resizeTimer);resizeTimer=0;}
  // Consume mutations before synchronous layout so they cannot invalidate the same cards again next frame.
  invalidateRecords(mutations.takeRecords?.()||[]);
  if(frame){cancelAnimationFrame(frame);frame=0;}layout();
 };
 const mutations=new MutationObserver(records=>{
  if(!records.length)return;
  invalidateRecords(records);
  schedule();
 });
 mutations.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
 // Our own masonry-height writes also resize the root. Only a width change
 // changes column layout; avoid feeding height updates back into another pass.
 let observedWidth;
 new ResizeObserver(entries=>{
  const width=entries[0]?.contentRect.width;
  if(width===observedWidth)return;
  const initial=observedWidth===undefined;
  observedWidth=width;
  if(initial)schedule();else scheduleResize();
 }).observe(root);
 root.addEventListener('load',event=>{invalidate(event.target);schedule();},true);
 root.addEventListener('album-layout-change',flush);
 document.fonts?.ready.then(()=>{dirty.add(root);schedule();});
 let viewportWidth=window.innerWidth;
 window.addEventListener('resize',()=>{
  if(viewportWidth===window.innerWidth)return;
  viewportWidth=window.innerWidth;scheduleResize();
 });
 window.addEventListener('library-card-size',schedule);
 schedule();
 return {schedule,flush};
}
