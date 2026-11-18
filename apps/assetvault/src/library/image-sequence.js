// 图片序列识别：把「同目录 + 同前缀 + 尾部编号」的一串图认成一条序列。
//
// 为什么不交给服务端：扫描结果本来就整目录摊平给了前端（listLocalFolder），
// 再写一套服务端分组只会多一份要同步的规则。这里保持纯函数：无 DOM、无 fs，
// 服务端将来想复用也能直接 import（沿用 format-registry 的做法）。
//
// 判定刻意保守 —— 误判成序列会把一堆无关的图从网格里吞掉，用户找不到东西：
//   1. 只认 image（模型贴图那种 model/env 不动）；
//   2. 编号必须在文件名末尾，前缀可以为空（001.png 也算）；
//   3. 同一组里编号必须唯一（img_01 与 img_1 会撞号，宁可拆成两组）；
//   4. 至少 MIN_FRAMES 帧才成序列，两张图叫「同名前缀」，不叫序列。

export const MIN_FRAMES = 3;
/** 编号上限 6 位：再多基本是哈希前缀，不是序列号。 */
const TAIL_INDEX = /^(.*?)(\d{1,6})$/u;

/** `frame_0012.png` → {prefix:'frame_', index:12, ext:'png'}；不是编号结尾返回 null。 */
export function parseSequenceName(name){
 const raw=String(name||'');
 const dot=raw.lastIndexOf('.');
 if(dot<=0)return null;
 const stem=raw.slice(0,dot);
 const ext=raw.slice(dot+1).toLowerCase();
 const match=TAIL_INDEX.exec(stem);
 if(!match)return null;
 return {prefix:match[1],index:Number(match[2]),ext,digits:match[2].length};
}

/** rel 的目录部分（'' 表示根）。 */
function dirOf(rel){
 const value=String(rel||'');
 const cut=value.lastIndexOf('/');
 return cut<0?'':value.slice(0,cut);
}

function keyOf(file){return `${file.root}|${file.rel}`;}

/**
 * 把扁平文件清单折叠成序列。
 * @returns {{sequences:Array, memberKeys:Set<string>, loose:Array}}
 *   sequences 里每条都带 frames（按编号升序）、count、bytes、mtime（末帧时间）。
 *   memberKeys 是「已归属某条序列」的文件 key 集合，渲染层用它剔除重复卡。
 */
export function groupImageSequences(files){
 const list=Array.isArray(files)?files:[];
 const groups=new Map();
 const memberKeys=new Set();
 for(const file of list){
  if(!file||file.kind!=='image')continue;
  const parsed=parseSequenceName(file.name||file.rel);
  if(!parsed)continue;
  const groupKey=[file.root,dirOf(file.rel),parsed.prefix,parsed.ext].join('\u0000');
  let group=groups.get(groupKey);
  if(!group){group={key:groupKey,root:file.root,dir:dirOf(file.rel),prefix:parsed.prefix,ext:parsed.ext,frames:[],seen:new Set()};groups.set(groupKey,group);}
  // 撞号（img_0001 与 img_1 同前缀同扩展名）说明命名不成序列，整组作废更安全。
  if(group.seen.has(parsed.index)){group.duplicate=true;continue;}
  group.seen.add(parsed.index);
  group.frames.push({...file,index:parsed.index});
 }
 const sequences=[];
 for(const group of groups.values()){
  if(group.duplicate||group.frames.length<MIN_FRAMES)continue;
  group.frames.sort((a,b)=>a.index-b.index);
  const frames=group.frames;
  const last=frames[frames.length-1];
  const first=frames[0];
  sequences.push({
   key:group.key,
   uid:'seq:'+[group.root,group.dir,group.prefix,group.ext].join('|'),
   root:group.root,
   dir:group.dir,
   prefix:group.prefix,
   ext:group.ext,
   frames,
   count:frames.length,
   bytes:frames.reduce((sum,frame)=>sum+(Number(frame.bytes)||0),0),
   addedAt:frames.reduce((max,frame)=>Math.max(max,Number(frame.addedAt||frame.mtime)||0),0),
   mtime:frames.reduce((max,frame)=>Math.max(max,Number(frame.mtime)||0),0),
   // 首帧当封面：缩略图接口按 rel 取，不需要额外字段。
   cover:first,
   // 用于展示的名字：范围比单帧更能说明这是序列。
   label:`${group.prefix}${String(first.index).padStart(4,'0')}–${String(last.index).padStart(4,'0')}.${group.ext}`,
  });
  for(const frame of frames)memberKeys.add(keyOf(frame));
 }
 sequences.sort((a,b)=>a.label.localeCompare(b.label,'zh'));
 const loose=list.filter(file=>file&&!memberKeys.has(keyOf(file)));
 return {sequences,memberKeys,loose};
}
