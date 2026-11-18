/** 只保留前后一张原图，不随图集大小累积解码图片。 */
export function createGalleryPreload(makeImage=()=>new Image()){
 const images=new Map();
 const release=image=>{image.onload=null;image.onerror=null;image.removeAttribute('src');};
 return {
  update(items,index,urlOf){
   const wanted=new Set([index-1,index+1].filter(i=>i>=0&&i<items.length&&!/^(video|3d)$/.test(items[i].type||'')));
   for(const [i,image] of images)if(!wanted.has(i)){release(image);images.delete(i);}
   for(const i of wanted)if(!images.has(i)){const image=makeImage();image.decoding='async';image.src=urlOf(items[i]);images.set(i,image);}
  },
  get:index=>images.get(index),
  clear(){for(const image of images.values())release(image);images.clear();},
 };
}
