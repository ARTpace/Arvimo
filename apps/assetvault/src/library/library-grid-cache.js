// 保存最近三个父页面，返回时复用卡片与已解码封面；限制容量避免随浏览持续增长。
export function createLibraryGridCache(grid){
 let current='library';const saved=new Map();
 return {switchTo(scope,view){
  if(scope===current)return null;
  if(current!=='discover'){
   const nodes=[...grid.children];for(const node of nodes){node.dataset.cardCached='1';node.remove();}
   saved.delete(current);saved.set(current,{nodes,...view});
  }
  current=scope;
  const result=saved.get(scope);saved.delete(scope);
  while(saved.size>3){const key=saved.keys().next().value;for(const node of saved.get(key).nodes)for(const img of node.querySelectorAll('img'))img.removeAttribute('src');saved.delete(key);}
  if(!result)return null;
  grid.replaceChildren(...result.nodes);for(const node of result.nodes)delete node.dataset.cardCached;
  return result;
 }};
}
