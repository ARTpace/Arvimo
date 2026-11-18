import {formatOf,extensionOf} from './format-registry.js';
import {materialSets} from './asset-classification.js';
import {IMAGE_SUBCATEGORIES} from './image-subcategories.js';

export const isAlbumImage=name=>formatOf(name)?.kind==='image';
/** ponytail: preserve relative folders, reuse the existing album import protocol. */
export function planImageAlbums(items){
 const folders=new Map();
 for(const item of items){
  const rel=String(item.rel||'').replace(/\\/g,'/'),at=rel.lastIndexOf('/');
  if(at<0)continue;
  const parent=rel.slice(0,at);
  if(!folders.has(parent))folders.set(parent,[]);
  folders.get(parent).push(item);
 }
 const result=new Map();
 for(const [parent,rows] of folders){
  // Mixed model/material folders retain the existing asset importer.
  if(!rows.length||rows.some(row=>!isAlbumImage(row.rel))||materialSets(rows.map(row=>row.rel)))continue;
  const nested=[...folders.keys()].some(folder=>folder.startsWith(parent+'/'));
  for(const row of rows)result.set(row.rel,nested?parent+'/本层图片':parent);
 }
 return result;
}

/** Same stem within one relative folder is one image with selectable source formats. */
export function groupImageVariants(entries){
 const groups=new Map();
 const priority=name=>['png','webp','jpg','jpeg','avif','psd','tif','tiff','tga'].indexOf(extensionOf(name));
 for(const entry of entries){
  const stem=String(entry.rel).replace(/\.[^/.]+$/,'').toLowerCase();
  if(!groups.has(stem))groups.set(stem,[]);
  groups.get(stem).push(entry);
 }
 return [...groups.values()].map(variants=>{
  variants.sort((a,b)=>{const rank=e=>{const i=priority(e.name);return i<0?99:i;};return rank(a)-rank(b);});
  return {...variants[0],variants};
 });
}

export function albumFolderView(packages,folder=''){
 const groups=new Map(),albums=[];
 for(const pkg of packages){
  const parent=pkg.albumParent ?? String(pkg.rel||'').split('/').slice(0,-1).join('/');
  if(folder&&parent!==folder&&!parent.startsWith(folder+'/'))continue;
  // 存储分类不是用户创建的图集目录，不为它们增加点击层级。
  let base=folder;
  if(!folder){const parts=parent.split('/');if(parts[0]==='图片'){parts.shift();if(IMAGE_SUBCATEGORIES.some(item=>item.label===parts[0]))parts.shift();}base=parent.slice(0,parent.length-parts.join('/').length).replace(/\/$/,'');}
  const rest=base?parent.slice(base.length).replace(/^\//,''):parent;
  if(!rest){albums.push(pkg);continue;}
  const first=rest.split('/')[0],rel=base?base+'/'+first:first;
  if(!groups.has(rel))groups.set(rel,{rel,name:first,mtime:0,albums:[]});
  const group=groups.get(rel);
  group.addedAt=Math.max(group.addedAt||0,Number(pkg.folderAddedAt?.[rel])||0,Number(pkg.addedAt||pkg.mtime)||0);
  group.albums.push(pkg);group.mtime=Math.max(group.mtime,Number(pkg.mtime)||0);
 }
 return {folders:[...groups.values()],albums};
}
export const albumImageKey=(pkg,item)=>String(pkg.root||'').replace(/\\/g,'/').toLowerCase()+'|'+[pkg.rel,item.rel].filter(Boolean).join('/').replace(/\.[^/.]+$/,'').toLowerCase();

/** 启动封面索引独立于完整清单；后台扫描返回后仍使用完整搜索数据。 */
export function localIndexSnapshot({files,packages,truncated}){
 return {version:1,files,packages:packages.map(pkg=>{
  const entries=(pkg.entries||[]).slice(0,9).map(({rel,name,ext,bytes,mtime,kind})=>({rel,name,ext,bytes,mtime,kind}));
  return {...pkg,entries,previewOnly:true,previewImageCount:groupImageVariants((pkg.entries||[]).filter(item=>isAlbumImage(item.name||item.rel))).length};
 }),truncated};
}

/** 画板封面可取图集内部图片；图集本身仍是一个成员。 */
export function albumPreviewItems(pkg,limit=6){
 return groupImageVariants((pkg.entries||[]).filter(item=>isAlbumImage(item.name||item.rel))).slice(0,limit).map(item=>({
  name:item.name||item.rel,thumbnail:`/api/local/thumb?root=${encodeURIComponent(pkg.root)}&rel=${encodeURIComponent([pkg.rel,item.rel].filter(Boolean).join('/'))}&w=512&v=${Number(item.mtime||pkg.mtime)||0}`,
 }));
}
