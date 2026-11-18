// Keep attached covers stable: masonry derives height and column span from image dimensions.
// Reclaim only removed nodes; viewport visibility must never erase a live cover's source.
export function bindCardImageResidency(grid,{Mutations=globalThis.MutationObserver}={}){
 if(!grid||!Mutations)return ()=>{};
 const images=new Set();
 const release=image=>image.removeAttribute('src');
 const sync=()=>{
  for(const image of images)if(!grid.contains(image)){
   if(!image.closest?.('[data-card-cached]'))release(image);images.delete(image);
  }
  for(const image of grid.querySelectorAll('img.thumbnail'))images.add(image);
 };
 const mutations=new Mutations(sync);
 mutations.observe(grid,{childList:true,subtree:true});sync();
 return ()=>{mutations.disconnect();images.clear();};
}
