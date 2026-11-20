export const PICTURE_FIRST_PAGE=24;
/** A temporarily unchanged window is not proof that its source is exhausted. */
export function mergePicturePage(ps,data,next){
 const field=ps.mode==='boards'?'boards':'items';
 const key=item=>field==='boards'?item.id||item.url:ps.platform==='xiaohongshu'?item.key||item.url:item.url;
 const have=new Set((ps[field]||[]).map(key));
 const fresh=[];
 for(const item of data[field]||[]){
  const id=key(item);
  if(!id||have.has(id))continue;
  have.add(id);fresh.push(item);
 }
 if(fresh.length)ps[field]=[...(ps[field]||[]),...fresh];
 if(field==='items'&&data.order==='liked-desc'){
  const ordered=new Map();
  for(const item of [...(data.items||[]),...(ps.items||[])])if(!ordered.has(key(item)))ordered.set(key(item),item);
  ps.items=[...ordered.values()];
 }
 ps.truncated=!!data.truncated;
 ps.total=Math.max(0,Number(data.total)||0);
 ps.warning=data.warning||'';
 // Retry the same window if the background crawl has not filled it yet.
 if(fresh.length||!ps.truncated)ps.limit=next;
 return fresh;
}
