// A canvas board and a manual library collection share one ID and one membership set.
// The old JSON file is read only for migration; it remains an untouched recovery copy.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {listCollections, saveCollection, deleteCollection, collectionUids, setCollectionItems} from './library-collections.mjs';
import {importLibrary, PORTABLE_FORMAT, PORTABLE_VERSION} from './library-portable.mjs';
import {scanLibraryPackages} from './local-assets.mjs';
import {groupImageVariants,isAlbumImage} from '../src/library/image-albums.js';
import {MAIN_STATE_KEY} from './library-schema.mjs';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const empty = () => ({format:'artflow-project',version:2,boards:[],nodes:[],assets:[]});
const board = (id,name) => ({id,name,panOffset:{x:0,y:0},zoom:1,canvasBackgroundColor:'#18181b',operationHistory:[],operationHistoryIndex:-1});
const valid = doc => doc?.format==='artflow-project' && doc.version===2 && ['boards','nodes','assets'].every(key=>Array.isArray(doc[key]));
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const byId = list => new Map(list.map(item=>[item.id,item]));
const unresolved = asset => sourceOf(asset).startsWith('blob:');
const refs = (doc,id) => {
  const pending=new Set(doc.assets.filter(unresolved).map(asset=>asset.id));
  return new Set(doc.nodes.filter(node=>node.boardId===id && (node.properties?.albumUid || node.assetId) && !pending.has(node.assetId)).map(node=>node.properties?.albumUid || node.assetId));
};
const sourceOf = asset => asset.locator?.originalRef || asset.locator?.fileRef || asset.locator?.previewRef || '';
const stableUrl = source => String(source).replace(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+(?=\/api\/)/,'');
function remapIds(value, ids) {
  if (!value || typeof value!=='object') return;
  if (typeof value.assetId==='string' && ids.has(value.assetId)) value.assetId=ids.get(value.assetId);
  for (const child of Object.values(value)) if (child && typeof child==='object') remapIds(child,ids);
}

export function createCanvasBoards({storage,dataDir,dropImporter,localImporter,onChanged=()=>{}}) {
  let queue=Promise.resolve();
  const albumEntries=new Map();
  async function refreshAlbums(){
    albumEntries.clear();
    const rows=await storage.withDb(conn=>conn.all(`SELECT DISTINCT a.uid,a.payload FROM assets a JOIN collection_assets c ON c.asset_id=a.uid WHERE a.state='active' AND a.payload LIKE '%"albumPackage"%'`));
    for(const row of rows||[]){const model=JSON.parse(row.payload);if(!model.albumPackage)continue;
      const pkg=model.albumPackage;
      const scanned=await scanLibraryPackages({roots:[path.join(pkg.root,...pkg.rel.split('/'))]});
      const entries=scanned.packages.find(item=>!item.rel)?.entries||scanned.files;
      albumEntries.set(row.uid,groupImageVariants(entries.filter(item=>isAlbumImage(item.name||item.rel))));
    }
  }

  const serial = fn => {const result=queue.then(fn);queue=result.catch(()=>{});return result;};
  async function state() {
    return storage.withDbWrite(conn=>{
      conn.run('CREATE TABLE IF NOT EXISTS canvas_project (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)',[]);
      const row=conn.all('SELECT payload FROM canvas_project WHERE id=1',[])[0];
      return row ? JSON.parse(row.payload) : null;
    });
  }
  const assetModel = uid => storage.withDb(conn=>{
    const row=conn.all("SELECT payload FROM assets WHERE uid=? AND state='active'",[uid])[0];
    return row ? JSON.parse(row.payload) : null;
  });
  async function normalize(input,links,importNew=true) {
    if (!valid(input)) throw Object.assign(Error('画布文档格式无效'),{status:400});
    const doc=clone(input), ids=new Map(), assets=new Map();
    for (const asset of doc.assets) {
      const albumUid=asset.metadata?.albumUid||doc.nodes.find(node=>node.assetId===asset.id)?.properties?.albumUid;
      if(albumUid){asset.metadata={...asset.metadata,albumUid};assets.set(asset.id,asset);continue;}
      const source=stableUrl(sourceOf(asset));
      if (!source) { assets.set(asset.id,asset); continue; }
      // 旧存档的 blob 属于旧 WebView，服务端无法恢复字节。保留节点，不能阻塞其他画板迁移。
      if (source.startsWith('blob:')) { assets.set(asset.id,asset); continue; }
      const key=hash(`${asset.kind}:${source}`);
      const hinted=doc.nodes.find(node=>node.assetId===asset.id)?.properties?.assetRef?.uid;
      let uid=asset.metadata?.libraryUid || hinted || links[key];
      let model=uid ? await assetModel(uid) : null;
      if (!model && uid?.startsWith('local:') && importNew && localImporter) {
        const [folder,...parts]=uid.slice(6).split('|');
        const result=await localImporter.importFile({folder,rel:parts.join('|'),mode:'linked',duplicate:'skip',nameConflict:'keep-both'});
        uid=result.asset?.uid;model=result.asset;
      }
      if (uid && !model && !links[key] && !await storage.withDb(conn=>conn.all('SELECT uid FROM assets WHERE uid=?',[uid])[0])) uid=undefined;
      if (!model && !uid && await assetModel(asset.id)) {uid=asset.id;model=await assetModel(uid);}
      if (!uid && importNew) {
        const node=doc.nodes.find(item=>item.assetId===asset.id);
        const mime=asset.locator.mimeType || 'application/octet-stream';
        const extension=asset.locator.extension || ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','video/mp4':'mp4','audio/mpeg':'mp3','image/svg+xml':'svg'}[mime]) || asset.kind;
        const name=String(node?.properties?.name || `画布素材.${extension}`);
        if (source.startsWith('data:')) {
          const match=/^data:([^,]*),(.*)$/s.exec(source);
          if (!match) throw Error('画布素材编码无效');
          const bytes=match[1].includes(';base64') ? Buffer.from(match[2],'base64') : Buffer.from(decodeURIComponent(match[2]));
          const result=await dropImporter.save({name:/\.[a-z0-9]+$/i.test(name)?name:`${name}.${extension}`,stream:[bytes],size:bytes.length,canvasBoard:node?.boardId});
          uid=result.uid;
          if (!uid) throw Error('画布素材入库失败');
          model=await assetModel(uid);
          asset.metadata={...asset.metadata,canvasImportBoard:node?.boardId};
        } else if (/^(https?:\/\/|\/api\/)/.test(source)) {
          uid=key.slice(0,32);
          model={uid,name,url:source,previewUrl:source,thumbnail:asset.locator.thumbnailRef || asset.locator.previewRef || '',assetType:asset.kind==='image'?'image':asset.kind==='video'?'video':'file',platform:'local',source:'canvas',addedAt:Date.now(),downloadable:false};
          await importLibrary({storage,payload:{format:PORTABLE_FORMAT,version:PORTABLE_VERSION,assets:[model]},mode:'merge',actor:'canvas'});
        } else throw Error('画布素材尚未持久化，请先完成文件导入');
      }
      if (!uid) continue;
      links[key]=uid;
      ids.set(asset.id,uid);
      asset.id=uid;
      asset.metadata={...asset.metadata,libraryUid:uid};
      if (model && source.startsWith('data:')) {
        const file=stableUrl(model.previewUrl || model.url);
        asset.sourceKind='external-reference';
        asset.locator=asset.kind==='image'
          ? {previewRef:file,originalRef:file,thumbnailRef:stableUrl(model.thumbnail || file),mimeType:asset.locator.mimeType || 'image/png',byteSize:model.bytes}
          : {...asset.locator,fileRef:file};
        links[hash(`${asset.kind}:${sourceOf(asset)}`)]=uid;
      }
      assets.set(uid,asset);
    }
    remapIds(doc,ids);
    doc.assets=[...assets.values()];
    for (const node of doc.nodes) if (node.assetId && assets.get(node.assetId)?.metadata?.libraryUid) {
      node.properties.assetRef={...node.properties.assetRef,uid:node.assetId};
    }
    return doc;
  }
  function persist(conn,doc,links) {
    conn.run('INSERT INTO canvas_project(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',[JSON.stringify({document:doc,links})]);
  }
  function reconcile(conn,doc) {
    const collections=listCollections(conn).filter(item=>!item.smart), existing=byId(doc.boards);
    const assets=byId(doc.assets), names=new Map();
    doc.boards=collections.map(item=>({...existing.get(item.id) || board(item.id,item.name),name:item.name}));
    const allowed=new Map(collections.map(item=>[item.id,collectionUids(conn,item.id)]));
    const pending=new Set(doc.assets.filter(unresolved).map(asset=>asset.id));
    doc.nodes=doc.nodes.filter(node=>allowed.has(node.boardId) && (node.properties?.albumUid ? allowed.get(node.boardId).has(node.properties.albumUid) : !node.assetId || pending.has(node.assetId) || allowed.get(node.boardId).has(node.assetId)));
    for (const collection of collections) {
      const present=refs(doc,collection.id);
      for (const uid of allowed.get(collection.id)) {
        const row=conn.all("SELECT payload FROM assets WHERE uid=? AND state='active'",[uid])[0];
        if (!row) continue; // A deleted/trashed asset must not remain visible on the canvas.
        const model=JSON.parse(row.payload);names.set(uid,model.name || model.title || uid);
        if(model.albumPackage && albumEntries.get(uid)?.length){
          const existingGroup=doc.nodes.find(node=>node.boardId===collection.id&&node.nodeType==='group'&&node.properties?.albumUid===uid);
          if(existingGroup)continue;
          const old=doc.nodes.find(node=>node.boardId===collection.id&&node.assetId===uid);
          const index=doc.nodes.filter(node=>node.boardId===collection.id&&!node.parentId).length;
          const others=doc.nodes.filter(node=>node.boardId===collection.id&&node.assetId!==uid);
          const x=others.length?Math.max(...others.map(node=>node.x+(node.width||0)))+48:(old?.x||0),y=old?.y||0;
          doc.nodes=doc.nodes.filter(node=>!(node.boardId===collection.id&&node.assetId===uid));
          const entries=albumEntries.get(uid),cols=Math.min(6,Math.ceil(Math.sqrt(entries.length))),gap=20,w=240,h=200;
          const groupId=`album-${collection.id}-${uid}`;
          doc.nodes.push({id:groupId,boardId:collection.id,nodeType:'group',x,y,width:cols*(w+gap)-gap,height:Math.ceil(entries.length/cols)*(h+gap)-gap,zIndex:index,properties:{name:names.get(uid),albumUid:uid}});
          entries.forEach((entry,i)=>{
            const rel=[model.albumRel||model.albumPackage.rel,entry.rel].filter(Boolean).join('/');
            const query=`root=${encodeURIComponent(model.albumRoot||model.albumPackage.root)}&rel=${encodeURIComponent(rel)}`;
            const src=`/api/local/thumb?${query}&w=1600&full=1`,assetId=`album-image-${hash(uid+'|'+entry.rel).slice(0,32)}`;
            assets.set(assetId,{id:assetId,kind:'image',sourceKind:'external-reference',locator:{previewRef:src,thumbnailRef:`/api/local/thumb?${query}&w=512`,mimeType:'image/png'},metadata:{albumUid:uid}});
            doc.nodes.push({id:`${groupId}-${i}`,boardId:collection.id,parentId:groupId,assetId,nodeType:'image',x:x+(i%cols)*(w+gap),y:y+Math.floor(i/cols)*(h+gap),width:w,height:h,zIndex:i,properties:{name:entry.name||entry.rel,albumUid:uid}});
          });
          continue;
        }
        // 按稳定 UID 刷新引用；工具内移动文件不改变节点位置、尺寸或画板归属。
        const known=assets.get(uid);
        if(known && model.localRoot && model.localRel){
          const file=stableUrl(model.previewUrl || model.url || '');
          if(file){
            known.locator=known.kind==='image'
              ? {...known.locator,originalRef:file,previewRef:file,thumbnailRef:stableUrl(model.thumbnail || file)}
              : {...known.locator,fileRef:stableUrl(model.url || file)};
            for(const node of doc.nodes)if(node.assetId===uid&&node.properties?.assetRef)node.properties.assetRef.src=file;
          }
        }
        if (present.has(uid)) continue;
        const src=stableUrl(model.previewUrl || model.thumbnail || model.url || '');
        const image=!!model.thumbnail || /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#]|$)/i.test(src) || model.assetType==='images';
        const kind=image?'image':'file';
        assets.set(uid,{id:uid,kind,sourceKind:'external-reference',locator:image?{previewRef:stableUrl(model.thumbnail || src),mimeType:'image/png'}:{fileRef:src,extension:model.ext || 'bin',mimeType:'application/octet-stream'},metadata:{libraryUid:uid}});
        const index=doc.nodes.filter(node=>node.boardId===collection.id).length;
        const hasAlbum=doc.nodes.some(node=>node.boardId===collection.id&&node.properties?.albumUid);
        const x=hasAlbum?Math.max(0,...doc.nodes.filter(node=>node.boardId===collection.id).map(node=>node.x+(node.width||0)))+48:(index%4)*352;
        doc.nodes.push({id:`library-${randomUUID()}`,boardId:collection.id,assetId:uid,nodeType:kind,x,y:hasAlbum?0:Math.floor(index/4)*272,width:320,height:240,zIndex:index,properties:{name:names.get(uid),assetRef:{uid,src}}});
      }
    }
    doc.nodes=doc.nodes.filter(node=>node.properties?.albumUid ? names.has(node.properties.albumUid) : !node.assetId || pending.has(node.assetId) || names.has(node.assetId));
    for (const node of doc.nodes) if (node.assetId && names.has(node.assetId)) node.properties.name=names.get(node.assetId);
    doc.assets=[...assets.values()];
    return doc;
  }
  async function load() {
    const saved=await state();
    if (saved) return saved;
    let legacy=null;
    try {legacy=JSON.parse(await fs.readFile(path.join(dataDir,'artflow-board.json'),'utf8'));}
    catch(error) {if (error.code!=='ENOENT') throw Error('旧画布存档无法读取，已保留原文件');}
    if (Array.isArray(legacy)) return {legacy};
    const links={};
    const doc=legacy ? await normalize(legacy,links) : empty();
    await storage.withDbWrite(conn=>{
      // Seed only a genuinely new project; an intentionally emptied project stays empty.
      if (!legacy && !listCollections(conn).some(item=>!item.smart)) doc.boards=[board(`canvas-${randomUUID()}`,'画布 1')];
      for (const item of doc.boards) {saveCollection(conn,{id:item.id,name:item.name});setCollectionItems(conn,item.id,[...refs(doc,item.id)],'set');}
      reconcile(conn,doc);persist(conn,doc,links);
    });
    return {document:doc,links};
  }
  return {
    read: () => serial(async()=>{
      await refreshAlbums();
      const saved=await load();if (saved.legacy) return saved.legacy;
      return storage.withDbWrite(conn=>{const before=JSON.stringify(saved.document),doc=reconcile(conn,saved.document);if(JSON.stringify(doc)!==before)persist(conn,doc,saved.links);return doc;});
    }),
    save: input => serial(async()=>{
      await refreshAlbums();
      const saved=await load(), links=saved.links || {};
      const incoming=await normalize(input.document || input,links);
      const base=valid(input.base) ? await normalize(input.base,links,false) : empty();
      const oldAssets=new Set(base.assets.map(asset=>asset.id));
      const imports=incoming.assets.filter(asset=>asset.metadata?.canvasImportBoard&&!oldAssets.has(asset.id));
      return storage.withDbWrite(conn=>{
        const current=saved.document ? reconcile(conn,saved.document) : empty(), previous=byId(base.boards), next=byId(incoming.boards);
        const collections=byId(listCollections(conn));
        for (const old of base.boards) if (!next.has(old.id)) deleteCollection(conn,old.id);
        for (const item of incoming.boards) {
          const before=previous.get(item.id), collection=collections.get(item.id);
          if (before && !collection) continue; // Library deletion wins over a stale canvas save.
          if (!collection || before?.name!==item.name) saveCollection(conn,{...collection,id:item.id,name:item.name});
          const oldRefs=refs(base,item.id), newRefs=refs(incoming,item.id);
          setCollectionItems(conn,item.id,[...oldRefs].filter(uid=>!newRefs.has(uid)),'remove');
          setCollectionItems(conn,item.id,[...newRefs].filter(uid=>!oldRefs.has(uid)),'add');
        }
        // Three-way merge keeps library additions and other canvases intact during delayed saves.
        const merge=(oldList,newList,currentList)=>{
          const old=byId(oldList), next=byId(newList), result=byId(currentList);
          for (const id of old.keys()) if (!next.has(id)) result.delete(id);
          for (const [id,value] of next) if (!same(old.get(id),value)) result.set(id,value);
          return [...result.values()];
        };
        current.boards=merge(base.boards,incoming.boards,current.boards);
        current.nodes=merge(base.nodes,incoming.nodes,current.nodes);
        current.assets=[...new Map([...current.assets,...incoming.assets].map(item=>[item.id,item])).values()];
        const doc=reconcile(conn,current);persist(conn,doc,links);return doc;
      }).then(async document=>{
        let cardGroups;
        if(imports.length){
          const models=new Map();
          for(const asset of imports){const model=await assetModel(asset.id);if(model)models.set(asset.id,model);}
          await storage.mutate(values=>{
            const blob=JSON.parse(values[MAIN_STATE_KEY]||'{}');
            blob.options={...blob.options};
            const groups=structuredClone(blob.options.cardGroups||[]);
            for(const asset of imports){
              const owner=document.boards.find(board=>board.id===asset.metadata.canvasImportBoard),model=models.get(asset.id);
              if(!owner||!model)continue;
              // 复用集合引用；已有集合成员不抢归属，整理/拆分后也不会每次保存又收回来。
              if(groups.some(group=>group.children.some(ref=>ref.kind==='asset'&&ref.key===asset.id)))continue;
              const id=`canvas-import-${hash(owner.id).slice(0,24)}`;
              let group=groups.find(group=>group.id===id);
              if(!group){group={id,type:'album',name:`${owner.name} · 导入`,addedAt:Date.now(),children:[]};groups.push(group);}
              group.children.push({kind:'asset',key:asset.id,level:'item',label:model.name,summary:model});
              group.addedAt=Date.now();
            }
            blob.options.cardGroups=groups;
            cardGroups=groups;
            return {...values,[MAIN_STATE_KEY]:JSON.stringify(blob)};
          });
        }
        onChanged();return {ok:true,document,...(cardGroups?{cardGroups}:{})};
      });
    }),
  };
}
