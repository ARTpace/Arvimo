import {albumPreviewItems} from './image-albums.js';
/** Board membership references linked source files; never copies or moves originals. */
export async function prepareAlbumBoard(pkg,items,{fetchImpl=globalThis.fetch}={}){
 const batch=`album-${globalThis.crypto.randomUUID()}`,assets=[];
 const post=async(route,body)=>{
  const response=await fetchImpl(route,{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'图片引用创建失败');
  return result;
 };
 try{
  for(const item of items){
   const result=await post('/api/library/import-file',{folder:pkg.root,rel:[pkg.rel,item.rel].filter(Boolean).join('/'),mode:'linked',duplicate:'skip',nameConflict:'keep-both',batch});
   if(!result.asset?.uid)throw Error('图片引用缺少资产标识');
   assets.push(result.asset);
  }
  await post('/api/library/drop-import/flush',{batch,action:'flush'});
  return [...new Map(assets.map(asset=>[asset.uid,asset])).values()];
 }catch(error){
  await post('/api/library/drop-import/flush',{batch,action:'abort'}).catch(()=>{});
  throw error;
 }
}
/** 一张图集作为一个资产引用，画板成员数始终只增加一项。 */
export async function prepareAlbumReference(pkg,{fetchImpl=globalThis.fetch}={}){
 const key=String(pkg.root).replace(/\\/g,'/').toLowerCase()+'|'+pkg.rel;
 const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode('album|'+key));
 const uid=Array.from(new Uint8Array(digest)).slice(0,16).map(n=>n.toString(16).padStart(2,'0')).join('');
 const entries=(pkg.entries||[]).slice(0,9);
 const first=entries.find(item=>/\.(png|jpe?g|webp|avif)$/i.test(item.rel||item.name||''));
 const thumbnail=albumPreviewItems(pkg,1)[0]?.thumbnail||(first?`/api/local/thumb?root=${encodeURIComponent(pkg.root)}&rel=${encodeURIComponent([pkg.rel,first.rel].filter(Boolean).join('/'))}&w=512`:pkg.thumb||pkg.cover||'');
 const asset={uid,name:pkg.title||pkg.rel.split('/').pop(),platform:'local',assetType:'images',source:'album-reference',addedAt:Date.now(),thumbnail,
  albumPackage:{...pkg,entries},albumRoot:pkg.root,albumRel:pkg.rel};
 const response=await fetchImpl('/api/library/assets/mutate',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({ops:[{op:'asset:add',uid,model:asset}]})});
 const result=await response.json();if(!response.ok||result.conflicts?.length)throw Error(result.error||'图集引用保存失败');
 return asset;
}
/** 仅替换旧版整套导入产生的成员，原有独立资产不在此名单。 */
export function legacyAlbumMembers(pkg,models,generated=[]){
 const owned=new Set(generated),prefix=pkg.rel+'/';
 return models.filter(model=>owned.has(model.uid)&&model.sourceRoot===pkg.root&&String(model.sourceRel||'').startsWith(prefix)).map(model=>model.uid);
}
