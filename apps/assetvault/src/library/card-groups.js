// ponytail: 集合只保存引用，复用资产的原始预览、文件位置与下载记录。
import {hasModelThumbnail} from './format-registry.js';
export const groupRefKey=ref=>`${ref.kind}:${ref.key}`;
/** 同目录模型包自动收纳；解散后下次扫描重建，保留单个成员拆分和移动归属。 */
export function collectModelFolders(options,files,models=[],{id=()=>crypto.randomUUID(),now=()=>Date.now()}={}){
 const folders=new Map(),paths=new Set();
 const add=(root,rel,ref)=>{
  root=String(root||'').replace(/\\/g,'/').replace(/\/$/,'');rel=String(rel||'').replace(/\\/g,'/');
  if(!root||!rel)return;
  const path=`${root}/${rel}`.toLowerCase();if(paths.has(path))return;paths.add(path);
  const parent=rel.includes('/')?rel.slice(0,rel.lastIndexOf('/')):'';
  const key=`${root}/${parent}`.toLowerCase(),label=(parent||root).split('/').pop();
  if(!folders.has(key))folders.set(key,{label,refs:[]});folders.get(key).refs.push(ref);
 };
 for(const model of models)if(['local','eagle'].includes(model.platform)&&model.localRoot&&model.localRel&&hasModelThumbnail(model.localRel)){
  add(model.localRoot,model.localRel,{kind:'asset',key:model.uid,level:'item',label:model.name,summary:model});
 }
 for(const file of files)if(hasModelThumbnail(file.rel||file.name))add(file.root,file.rel,{kind:'file',key:`${file.root}|${file.rel}`,level:'item',root:file.root,rel:file.rel,label:file.name,fileKind:file.kind,ext:file.ext,bytes:file.bytes,mtime:file.mtime});
 const groups=options.cardGroups||[],history=options.modelFolderImports||{};
 const occupied=new Set(groups.flatMap(group=>[...group.children,...(group.supersedes||[])]).map(groupRefKey));
 let changed=false;
 for(const [key,folder] of folders){
  if(folder.refs.length<2&&!history[key])continue;
  const previous=history[key],seen=new Set(previous?.seen||[]);
  let row=previous&&groups.find(group=>group.id===previous.id);
  // A history entry is not the collection itself: recover missing collection records.
  const recover=previous&&!row;
  const fresh=folder.refs.filter(ref=>recover||!seen.has(groupRefKey(ref)));
  if(!fresh.length)continue;
  const available=fresh.filter(ref=>!occupied.has(groupRefKey(ref)));
  if(!previous&&available.length<2)continue;
  if(!previous||recover){row={id:previous?.id||id(),type:'album',name:folder.label,addedAt:now(),children:[]};groups.push(row);}
  if(row){row.children.push(...available);row.addedAt=now();available.forEach(ref=>occupied.add(groupRefKey(ref)));}
  history[key]={id:row?.id||previous.id,seen:[...seen,...fresh.map(groupRefKey)]};changed=true;
 }
 if(changed){options.cardGroups=groups;options.modelFolderImports=history;}
 return changed;
}
export function createCardGroups(options,{resolve=()=>null,save=()=>{},id=()=>crypto.randomUUID(),now=()=>Date.now()}={}){
 const current=()=>typeof options==='function'?options():options;
 const rows=()=>current().cardGroups||[];
 const find=key=>rows().find(row=>row.id===key);
 const reference=row=>({kind:'group',key:row.id,level:row.type,label:row.name});
 const allowed=(source,target)=>!!source&&!!target&&groupRefKey(source)!==groupRefKey(target)&&source.level!=='folder'&&
  ((source.level==='item'&&['item','album'].includes(target.level))||(source.level==='album'&&['album','folder'].includes(target.level)));
 function commit(next){current().cardGroups=next;save();}
 function drop(source,target){
  if(!allowed(source,target))throw Error('这个组合不能合并');
  const next=structuredClone(rows());
  const get=key=>next.find(row=>row.id===key);
  function materialize(ref){
   if(ref.kind==='group')return get(ref.key);
   const resolved=resolve(ref);
   if(!resolved)throw Error('资产已变化，请刷新后再试');
   const row={id:id(),type:ref.level,name:ref.label||'新集合',addedAt:now(),children:resolved.children||[],supersedes:[ref]};
   next.push(row);return row;
  }
  let row;
  if(source.level===target.level){
   row={id:id(),type:source.level==='item'?'album':'folder',name:target.label?`${target.label} · 集合`:'新集合',addedAt:now(),children:[target,source]};
   next.push(row);
  }else{
   row=materialize(target);
   if(!row)throw Error('集合不存在');
   if(row.children.some(ref=>groupRefKey(ref)===groupRefKey(source)))return row;
   row.children.push(source);
  }
  // 已有集合中的成员拖出后改为新归属，避免多处显示同一引用。
  for(const other of next)if(other!==row)other.children=other.children.filter(ref=>groupRefKey(ref)!==groupRefKey(source)&&!(source.level===target.level&&groupRefKey(ref)===groupRefKey(target)));
  row.addedAt=now();commit(next);return row;
 }
 function remove(id){commit(rows().filter(row=>row.id!==id).map(row=>({...row,children:row.children.filter(ref=>!(ref.kind==='group'&&ref.key===id))})));}
 function hidden(){return new Set(rows().flatMap(row=>[...row.children,...(row.supersedes||[])]).map(groupRefKey));}
 // 拆分单个成员：children 与 supersedes 都要清 —— supersedes 里的引用同样进 hidden()，
 // 只删 children 会让成员在主网格继续隐身，看着像"拆了但没了"。
 function ungroupMember(id,ref){const key=groupRefKey(ref);commit(rows().map(row=>row.id===id?{...row,children:row.children.filter(item=>groupRefKey(item)!==key),supersedes:(row.supersedes||[]).filter(item=>groupRefKey(item)!==key)}:row));}
 return {rows,find,reference,allowed,drop,remove,hidden,ungroupMember,rename(id,name){name=String(name).trim();if(!name)return;commit(rows().map(row=>row.id===id?{...row,name}:row));}};
}
