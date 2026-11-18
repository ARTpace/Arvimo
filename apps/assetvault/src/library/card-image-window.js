// 保留卡片DOM与布局，只让视口附近的图片持有解码资源。
export function createCardImageWindow(grid,{Observer=globalThis.IntersectionObserver,Mutations=globalThis.MutationObserver}={}){
 if(!grid||!Observer||!Mutations)return {refresh(){}};
 const cards=new Set(),sources=new WeakMap();
 function suspend(card){
  for(const img of card.querySelectorAll('img')){
   const src=img.getAttribute('src');if(!src)continue;
   if(img.naturalWidth&&img.naturalHeight){
    if(!img.hasAttribute('width'))img.setAttribute('width',img.naturalWidth);
    if(!img.hasAttribute('height'))img.setAttribute('height',img.naturalHeight);
   }
   sources.set(img,{src,srcset:img.getAttribute('srcset')});
   img.removeAttribute('srcset');img.removeAttribute('src');
  }
 }
 function resume(card){
  for(const img of card.querySelectorAll('img')){
   const saved=sources.get(img);if(!saved)continue;
   if(!img.hasAttribute('src')){if(saved.srcset)img.setAttribute('srcset',saved.srcset);img.setAttribute('src',saved.src);}
   sources.delete(img);
  }
 }
 const observer=new Observer(entries=>{
  for(const entry of entries){if(entry.isIntersecting)resume(entry.target);else suspend(entry.target);}
 },{rootMargin:'900px 0px'});
 function refresh(){
  const current=new Set(grid.children);
  for(const card of cards)if(!current.has(card)){suspend(card);observer.unobserve(card);cards.delete(card);}
  for(const card of current)if(!cards.has(card)){cards.add(card);observer.observe(card);}
 }
 const mutation=new Mutations(refresh);mutation.observe(grid,{childList:true});
 refresh();
 return {refresh};
}
