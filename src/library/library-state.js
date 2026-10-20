export const STORAGE_KEY='sfx-library-v2';
export const LEGACY_KEY='sfx-library-v1';
export const UI_KEY='sfx-library-ui';
/** 界面开关（折叠状态等）单独存一份：不与模型库 schema 混在一起，加开关不用迁移数据。 */
export const UI_DEFAULTS={linkPanelOpen:false};
export const UID=/^[a-f0-9]{32}$/i;
import {mergeTags} from './asset-tags.js';
const active=new Set(['queued','running','saving','cancelling']);
export function mergeModels(current,incoming){
 const map=new Map(current.filter(m=>UID.test(m?.uid)).map(m=>[m.uid,m]));
 for(const m of incoming||[])if(UID.test(m?.uid))map.set(m.uid,{...map.get(m.uid),...m});
 return [...map.values()];
}
export function collectModels(current,incoming,limit=1000){
 const map=new Map(current.map(m=>[m.uid,m]));let added=0,refused=0;
 for(const m of mergeModels([],incoming)){
  const old=map.get(m.uid);if(!old&&map.size>=limit){refused++;continue;}
  if(!old)added++;map.set(m.uid,{...old,...m,addedAt:old?.addedAt||Date.now()});
 }
 return {models:[...map.values()],added,refused};
}
/**
 * Export defaults. UI-hidden choices are deliberately fixed: direct folder output, GLB + FBX,
 * texture download, PNG texture conversion and fast local writing are always on.
 */
const OPTION_DEFAULTS={packMode:'model',maxTextureEdge:0,output:'folder',format:'fbx',downloadTextures:true,pngOnly:true,fastZip:true,scanLimit:120,optionsVersion:3};
/**
 * Move a pre-v2 profile onto the new defaults, but never overwrite a choice the user made: only
 * the *old default values* (packMode "full", maxTextureEdge 2048) are remapped, so an explicit
 * "glb" or "keep 4K" survives. Without this, an existing browser would keep downloading raw osgjs
 * scenes and downscaled maps even though the UI now calls those the non-defaults.
 */
function normalizeOptions(stored){
 const saved=stored&&typeof stored==='object'&&!Array.isArray(stored)?stored:{};
 const base=saved.optionsVersion===OPTION_DEFAULTS.optionsVersion?{...OPTION_DEFAULTS,...saved}:{
  ...OPTION_DEFAULTS,
  packMode:saved.packMode==='glb'?'glb':OPTION_DEFAULTS.packMode,
  maxTextureEdge:[0,4096].includes(saved.maxTextureEdge)?saved.maxTextureEdge:OPTION_DEFAULTS.maxTextureEdge,
  scanLimit:[120,300,500].includes(saved.scanLimit)?saved.scanLimit:OPTION_DEFAULTS.scanLimit,
 };
 return {...base,output:'folder',format:'fbx',downloadTextures:true,pngOnly:true,fastZip:true,optionsVersion:OPTION_DEFAULTS.optionsVersion};
}
export function loadLibrary(storage){ let data={},migrated=false,warning='';
 try{
  const v2=storage.getItem(STORAGE_KEY),raw=v2??storage.getItem(LEGACY_KEY);
  if(raw){try{data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data))throw Error();migrated=v2===null;}catch{if(!storage.getItem(STORAGE_KEY+'-invalid-backup'))storage.setItem(STORAGE_KEY+'-invalid-backup',raw);warning='本地记录格式损坏，原始内容已备份；未自动覆盖旧版数据。';data={};}}
 }catch{warning='无法访问浏览器存储；请检查隐私设置。';}
 const models=mergeModels([],Array.isArray(data.models)?data.models:[]).slice(0,1000);
 const favorites=new Set((Array.isArray(data.favorites)?data.favorites:[]).filter(id=>UID.test(id)));
 const tasks=(Array.isArray(data.tasks)?data.tasks:[]).filter(t=>UID.test(t?.uid)).slice(-80).map(t=>({...t,state:active.has(t.state)?'interrupted':t.state,logs:Array.isArray(t.logs)?t.logs.slice(-80):[]}));
 const history=(Array.isArray(data.history)?data.history:[]).filter(h=>h&&typeof h==='object').map(h=>h.kind==='search'?h:{...h,kind:'web'}).filter(h=>h.kind==='search'?(h.params&&typeof h.params.q==='string'&&h.params.q.trim()!==''):typeof h.url==='string'&&/^https?:\/\//.test(h.url)).slice(0,12);
 const aiTags=Object.fromEntries(Object.entries(data.aiTags&&typeof data.aiTags==='object'?data.aiTags:{}).filter(([uid,tags])=>UID.test(uid)&&Array.isArray(tags)).map(([uid,tags])=>[uid,mergeTags(tags)]));
 return {models,favorites,tasks,history,aiTags,options:normalizeOptions(data.options),migrated,warning};
}
export function saveLibrary(storage,state){
 storage.setItem(STORAGE_KEY,JSON.stringify({version:2,models:state.models,aiTags:state.aiTags||{},favorites:[...state.favorites],history:state.history,tasks:state.tasks.slice(-80).map(t=>({...t,logs:t.logs.slice(-80)})),options:state.options}));
}
/** 读取界面开关。存读取不了（隐私模式 / 存储满）时静默回落到默认值，不能因此挡住启动。 */
export function loadUi(storage){
 const ui={...UI_DEFAULTS};
 try{
  const raw=storage?.getItem(UI_KEY);if(!raw)return ui;
  const data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data))return ui;
  for(const key of Object.keys(UI_DEFAULTS))if(typeof data[key]===typeof UI_DEFAULTS[key])ui[key]=data[key];
 }catch{}
 return ui;
}
export function saveUi(storage,ui){
 try{storage.setItem(UI_KEY,JSON.stringify({...UI_DEFAULTS,...ui}));}catch{}
}
export const DISCOVERY_KEY='sfx-discovery-v1';
/** 上次的搜索结果和侧栏筛选。刷新或重启后先画出来，不必把缩略图和分类重新拉一遍。 */
export function loadDiscovery(storage){
 try{
  const data=JSON.parse(storage?.getItem(DISCOVERY_KEY)||'null');
  if(!data||typeof data!=='object'||Array.isArray(data))return null;
  const feeds={};
  for(const [mode,feed] of Object.entries(data.feeds||{})){
   if(!feed||!Array.isArray(feed.rows))continue;
   feeds[mode]={rows:feed.rows.filter(row=>row&&typeof row==='object').slice(0,48),request:feed.request||null,next:typeof feed.next==='string'?feed.next:null,pages:Number(feed.pages)||1,status:String(feed.status||''),warnings:Array.isArray(feed.warnings)?feed.warnings.slice(0,4):[]};
  }
  return {platform:typeof data.platform==='string'?data.platform:'',source:data.source==='link'?'link':'search',pageSize:Number(data.pageSize)||0,filters:data.filters&&typeof data.filters==='object'?data.filters:{},feeds};
 }catch{return null;}
}
export function saveDiscovery(storage,snapshot){
 try{storage?.setItem(DISCOVERY_KEY,JSON.stringify(snapshot));}catch{}
}
