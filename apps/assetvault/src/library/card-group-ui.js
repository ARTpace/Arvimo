import {createCardGroups,groupRefKey} from './card-groups.js';
import {contentMatchesKind,modeAllowsLocalKind} from './content-kind-tabs.js';
import {hasModelThumbnail} from './format-registry.js';

export function createCardGroupUI({state,localFiles,cardView,findModel,esc,icon,persist,render,toast,enabled=()=>true,readKind=()=>state.contentKind||'',doc=document}){
 let active='',history=[];
 const grid=doc.getElementById('grid');
 const store=createCardGroups(()=>state.options,{save:()=>persist(),resolve:ref=>{
  if(ref.kind==='package'){
   const pkg=packageFor(ref);
   if(!pkg)return null;
   if(pkg.previewOnly||pkg.truncatedEntries)throw Error('图集完整清单尚未就绪，请扫描完成后再试');
   return {children:(pkg.entries||[]).map(item=>fileRef({root:pkg.root,rel:[pkg.rel,item.rel].filter(Boolean).join('/'),name:item.name,kind:'image',mtime:pkg.mtime}))};
  }
  if(ref.kind==='folder')return {children:localFiles.packages().filter(pkg=>pkg.category==='images'&&pkg.rel.startsWith(ref.key+'/')).map(packageRef)};
  return null;
 }});
 const available=()=>enabled()&&state.route==='library'&&!['trash','favorites'].includes(state.filter);
 const groupFor=ref=>ref.kind==='group'?store.find(ref.key):null;
 const packageFor=ref=>localFiles.packages().find(pkg=>`${pkg.root}|${pkg.rel}`===ref.key);
 const fileFor=ref=>localFiles.entries().find(file=>`${file.root}|${file.rel}`===ref.key)||{root:ref.root,rel:ref.rel,name:ref.label,kind:ref.fileKind||'image',ext:ref.ext||ref.rel?.split('.').pop(),bytes:ref.bytes||0,mtime:ref.mtime||0};
 function fileRef(file){return {kind:'file',key:`${file.root}|${file.rel}`,level:'item',root:file.root,rel:file.rel,label:file.name,fileKind:file.kind,ext:file.ext,bytes:file.bytes,mtime:file.mtime};}
 function packageRef(pkg){return {kind:'package',key:`${pkg.root}|${pkg.rel}`,level:pkg.category==='images'?'album':'item',root:pkg.root,rel:pkg.rel,label:pkg.title};}
 function assetRef(model){return {kind:'asset',key:model.uid,level:'item',label:model.name,summary:Object.fromEntries(['uid','name','thumbnail','platform','assetType','url','author','assetId','artId','mviewUrl','source','format','filePath','localRoot','localRel','packageDir','hasMarmoset','kind','downloadable','sourceRoot','sourceRel'].map(key=>[key,model[key]]))};}
 function refForCard(card){
  if(!available()||!card)return null;
  if(card.dataset.cardGroup){const row=store.find(card.dataset.cardGroup);return row?store.reference(row):null;}
  if(card.dataset.albumFolder)return {kind:'folder',key:card.dataset.albumFolder,level:'folder',label:card.querySelector('strong')?.textContent||'图集文件夹'};
  if(card.dataset.package){const pkg=packageFor({key:card.dataset.package});return pkg?packageRef(pkg):null;}
  if(card.dataset.file){const file=localFiles.entries().find(file=>`${file.root}|${file.rel}`===card.dataset.file)||store.rows().flatMap(row=>row.children).find(ref=>ref.kind==='file'&&ref.key===card.dataset.file);return file?fileRef(file.rel?{...file,name:file.name||file.label,kind:file.fileKind||file.kind}:file):null;}
  if(card.dataset.uid){const model=findModel(card.dataset.uid);if(model?.albumPackage)return packageRef(model.albumPackage);return model?assetRef(model):null;}
  return null;
 }
 function refs(){return store.find(active)?.children||[];}
 function includes(ref){return refs().some(item=>groupRefKey(item)===groupRefKey(ref));}
 function accepts(ref){if(!available())return true;if(active)return includes(ref);return !!state.search||!store.hidden().has(groupRefKey(ref));}
 // 合集沿用普通卡片的类型规则；文件夹递归检查成员，不按封面推断。
 function matchesType(ref,seen=new Set()){
  const kind=readKind();if(!kind)return true;
  if(ref.kind==='group'){
   if(seen.has(ref.key))return false;seen.add(ref.key);
   return (groupFor(ref)?.children||[]).some(child=>matchesType(child,seen));
  }
  if(ref.kind==='asset'){const model=findModel(ref.key)||ref.summary;return !!model&&contentMatchesKind(model,kind);}
  if(ref.kind==='file')return modeAllowsLocalKind(kind,'files',fileFor(ref));
  if(ref.kind==='package'){const pkg=packageFor(ref);return !!pkg&&modeAllowsLocalKind(kind,'packages',pkg);}
  if(ref.kind==='folder')return localFiles.packages().some(pkg=>pkg.category==='images'&&pkg.rel.startsWith(ref.key+'/')&&modeAllowsLocalKind(kind,'packages',pkg));
  return false;
 }
 function thumb(ref,seen=new Set()){
  if(ref.kind==='asset'){const model=findModel(ref.key)||ref.summary;return model?cardView.imageUrl(model):'';}
  if(ref.kind==='file')return `/api/local/thumb?${new URLSearchParams({root:ref.root,rel:ref.rel,w:'256'})}`;
  if(ref.kind==='package'){const pkg=packageFor(ref);if(!pkg)return '';const item=localFiles.packageImages(pkg)[0];return item?`/api/local/thumb?${new URLSearchParams({root:pkg.root,rel:[pkg.rel,item.rel].filter(Boolean).join('/'),w:'256'})}`:pkg.thumb||'';}
  const row=groupFor(ref);if(!row||seen.has(row.id))return '';seen.add(row.id);return row.children.map(child=>thumb(child,seen)).find(Boolean)||'';
 }
 function groupCard(row){
  const shots=row.children.slice(0,4).map(ref=>{const src=thumb(ref);let model=false;
   try{model=hasModelThumbnail(new URL(src,'http://local').searchParams.get('rel')||'');}catch{}
   return `<div>${src?`<img${model?' class="model-thumb"':''} src="${esc(src)}" loading="lazy" decoding="async" alt="">`:icon(row.type==='folder'?'folder':'cube')}</div>`;
  }).join('');
  return `<article class="model-card drag-collection-card${row.type==='folder'?' drag-collection-folder':''}" data-card-group="${esc(row.id)}" role="button" tabindex="0" title="打开${row.type==='folder'?'集合文件夹':'集合'}：${esc(row.name)}"><div class="drag-collection-mosaic">${shots}</div><div class="drag-collection-caption"><strong>${esc(row.name)}</strong><span>${row.children.length} ${row.type==='folder'?'个集合':'项资产'}</span></div></article>`;
 }
 function extras(){
  if(!available())return [];
  const items=[];
  const push=(ref,html,name,time)=>items.push({key:`group-member:${groupRefKey(ref)}`,name,mtime:time||0,html});
  const groups=active?refs().filter(ref=>ref.kind==='group').map(groupFor).filter(Boolean):store.rows().filter(row=>!store.hidden().has(groupRefKey(store.reference(row))));
  for(const row of groups)if(matchesType(store.reference(row))&&(!state.search||row.name.toLowerCase().includes(state.search.toLowerCase())))push(store.reference(row),groupCard(row),row.name,row.addedAt);
  if(active)for(const ref of refs()){
   if(!matchesType(ref))continue;
   if(ref.kind==='file'){const file=fileFor(ref);push(ref,localFiles.card(file),file.name,file.addedAt||file.mtime);}
   if(ref.kind==='package'){const pkg=packageFor(ref);if(pkg)push(ref,localFiles.packageCard(pkg),pkg.title,pkg.addedAt||pkg.mtime);}
  }
  return items;
 }
 const nav=doc.createElement('div');nav.className='drag-group-nav';nav.hidden=true;grid.before(nav);
 function paintNav(){
  const row=available()&&store.find(active);nav.hidden=!row;
  if(row)nav.innerHTML=`<button type="button" data-group-back>${icon('arrow-left')}返回</button><input data-group-name aria-label="集合名称" value="${esc(row.name)}"><button type="button" data-group-dissolve title="解散集合，保留全部资产">解散集合</button>`;
 }
 function open(id){
  if(!store.find(id))return;history.push(active);active=id;localFiles.resetAlbumFolder();state.selected.clear();paintNav();render();
 }
 function dissolve(id=active){
  if(!store.find(id))return false;
  store.remove(id);active=history.pop()||'';localFiles.resetAlbumFolder?.();
  paintNav();render();toast('集合已解散，原资产已保留');return true;
 }
 // 拆分单个成员：只删引用，资产留在原地；成员回到「全部资产」可见。
 function split(ref){
  if(!active||!ref)return false;
  const row=store.find(active);
  if(!row||!row.children.some(child=>groupRefKey(child)===groupRefKey(ref)))return false;
  store.ungroupMember(active,ref);state.selected?.clear?.();
  render();toast('已从合集移出，原资产保留在库里');return true;
 }
 nav.addEventListener('click',event=>{
  if(event.target.closest('[data-group-back]')){active=history.pop()||'';paintNav();render();}
  if(event.target.closest('[data-group-dissolve]'))dissolve();
 });
 nav.addEventListener('change',event=>{if(event.target.matches('[data-group-name]')){store.rename(active,event.target.value);paintNav();render();}});
 for(const name of ['click','keydown'])grid.addEventListener(name,event=>{
  if(!available()||(name==='keydown'&&!['Enter',' '].includes(event.key)))return;
  const fileCard=event.target.closest?.('[data-file]'),ref=active&&fileCard&&refs().find(ref=>ref.kind==='file'&&ref.key===fileCard.dataset.file);
  if(ref){event.preventDefault();event.stopImmediatePropagation();localFiles.openFile(fileFor(ref));return;}
  const card=event.target.closest?.('[data-card-group]');if(!card||!available()||(name==='keydown'&&!['Enter',' '].includes(event.key)))return;
  event.preventDefault();event.stopImmediatePropagation();void open(card.dataset.cardGroup);
 },true);
 return {
  source:refForCard,
  canDrop:(source,card)=>store.allowed(source,refForCard(card)),
  label:(source,card)=>{const target=refForCard(card);return target?.level===source.level?(source.level==='item'?'合成集合':'合成集合文件夹'):(target?.level==='folder'?'放入集合文件夹':'加入集合');},
  async drop(source,card){try{const target=refForCard(card);if(target?.kind==='package'&&packageFor(target)?.previewOnly)await localFiles.scan();store.drop(source,target);state.selected.clear();active='';history=[];localFiles.resetAlbumFolder();paintNav();render();toast('已整理到集合');}catch(error){toast(error.message);}},
  acceptsModel:model=>accepts(assetRef(model)),acceptsFile:file=>accepts(fileRef(file)),acceptsPackage:pkg=>accepts(packageRef(pkg)),
  active:()=>available()&&!!active,
  scope:()=>available()&&active?`group:${active}`:'',
  models:()=>refs().filter(ref=>ref.kind==='asset'&&matchesType(ref)).map(ref=>findModel(ref.key)||ref.summary).filter(Boolean),
  extras,
  reset(){active='';history=[];paintNav();},
  refresh:paintNav,
  store,
  refOf:refForCard,
  split,
  dissolve,
  findAsset:uid=>store.rows().flatMap(row=>row.children).find(ref=>ref.kind==='asset'&&ref.key===uid)?.summary,
 };
}
