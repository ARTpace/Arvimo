// 自绘下拉的纯逻辑：选项快照 + 键盘索引计算。
//
// 单独放一层是为了能在 Node 里直接单测（不需要 jsdom）：这里只处理数组和字符串，
// 不碰 DOM。picker.js 负责把结果画出来。

const MOVES={
 ArrowDown:(index,last)=>index>=last?0:index+1,
 ArrowUp:(index,last)=>index<=0?last:index-1,
 Home:()=>0,
 End:(index,last)=>last,
 PageDown:(index,last)=>Math.min(last,index+10),
 PageUp:(index,last)=>Math.max(0,index-10),
};
// 单字符键算「打字定位」，这些按键另有含义。
const RESERVED=new Set(['Shift','Control','Alt','Meta','CapsLock','Tab','Escape','Enter',' ']);

export const isMenuKey=key=>Object.hasOwn(MOVES,key);

export const isTypeaheadKey=key=>typeof key==='string'&&key.length===1&&!RESERVED.has(key);

/** 把原生 <select> 的选项读成纯数据快照（hint 来自 option 的 data-hint）。 */
export const readOptions=select=>[...select.options].map((option,index)=>({
 value:option.value,
 label:(option.textContent||'').trim(),
 hint:(option.dataset&&option.dataset.hint)||'',
 selected:option.selected,
 index,
}));

/** 打开菜单时高亮哪一项：当前选中项；没有选中项就落在第一项。 */
export const selectedIndex=options=>Math.max(0,options.findIndex(option=>option.selected));

/** 方向键的结果。index 为 -1 表示「还没高亮」，此时向下落到首项、向上落到末项。 */
export function moveIndex(index,key,count){
 if(!count)return -1;
 const move=MOVES[key];
 if(!move)return index<0?0:index;
 if(index<0)return key==='ArrowUp'||key==='End'||key==='PageUp'?count-1:0;
 return move(index,count-1);
}

/**
 * 打字定位：从当前项的下一个开始找，绕回到开头，找不到就保持原高亮。
 * 用「包含」而不是「开头」匹配——选项文字大多是中文加英文混排（如「机器人 robot」），
 * 只认开头的话打英文缩写就永远定位不到。
 */
export function typeahead(options,prefix,from=-1){
 if(!options.length||!prefix)return from;
 const needle=prefix.toLowerCase();
 const start=from<0?0:from+1;
 for(let step=0;step<options.length;step++){
  const index=(start+step)%options.length;
  if(String(options[index].label).toLowerCase().includes(needle))return index;
 }
 return from;
}
