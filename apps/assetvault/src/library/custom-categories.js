import {MODE_PRESETS} from './mode-presets.js';
import {ASSET_TYPES,classifyAsset} from './asset-classification.js';
export const customCategoryValue=id=>'custom:'+id;
export const isCustomCategory=value=>String(value||'').startsWith('custom:');
export const categoryParentLabel=parent=>MODE_PRESETS.find(p=>p.groupId===parent)?.label||ASSET_TYPES[parent]||'';
export function customCategories(options={}){
 return (Array.isArray(options.customCategories)?options.customCategories:[]).filter(row=>row&&typeof row.id==='string'&&typeof row.label==='string'&&categoryParentLabel(row.parent));
}
export function categoryAssetKey(model={}){
 if(model.uid)return 'uid:'+model.uid;
 const root=model.localRoot||model.root,rel=model.localRel??model.rel;
 return root&&typeof rel==='string'?'path:'+String(root).replace(/\\/g,'/').toLowerCase()+'|'+rel.replace(/\\/g,'/').toLowerCase():'';
}
export function categoryFits(row,model){
 const kind=classifyAsset(model).kind;
 return row.parent===kind||!!MODE_PRESETS.find(p=>p.groupId===row.parent)?.localKinds.includes(kind);
}
export function categoriesForAsset(options,model){return customCategories(options).filter(row=>categoryFits(row,model));}
export function addCustomCategory(options,parent,label,id=globalThis.crypto.randomUUID()){
 label=String(label||'').trim();
 if(!categoryParentLabel(parent))throw Error('请选择有效的父分类');
 if(!label||label.length>40)throw Error('子类名称需为 1～40 个字符');
 const rows=customCategories(options);
 if(rows.some(row=>row.parent===parent&&row.label.toLowerCase()===label.toLowerCase()))throw Error('这个分类下已有同名子类');
 const row={id,parent,label};options.customCategories=[...rows,row];return row;
}
export function assignCustomCategory(options,model,id){
 const key=categoryAssetKey(model);if(!key)throw Error('这个资产缺少稳定的身份信息');
 if(id&&!categoriesForAsset(options,model).some(row=>row.id===id))throw Error('子类与资产类型不匹配');
 const assignments={...options.customCategoryByAsset};
 if(id)assignments[key]=id;else delete assignments[key];
 options.customCategoryByAsset=assignments;
}
export function customCategoryOf(options,model){
 const id=options?.customCategoryByAsset?.[categoryAssetKey(model)];
 return categoriesForAsset(options,model).find(row=>row.id===id)?.id||'';
}
export function matchesCustomCategory(options,model,value){
 return !isCustomCategory(value)||customCategoryValue(customCategoryOf(options,model))===value;
}
export function customCategoryFacets(options,parent,items){
 const rows=customCategories(options).filter(row=>row.parent===parent);
 const byId=new Map(rows.map(row=>[row.id,row])),members=new Map();
 for(const item of items){
  const key=categoryAssetKey(item),id=options?.customCategoryByAsset?.[key],row=byId.get(id);
  if(!row||!categoryFits(row,item))continue;
  if(!members.has(id))members.set(id,new Set());members.get(id).add(key);
 }
 return rows.map(row=>({...row,value:customCategoryValue(row.id),count:members.get(row.id)?.size||0}));
}

/** Removing a category never removes its assets or their original metadata. */
export function removeCustomCategory(options,id){
 options.customCategories=customCategories(options).filter(row=>row.id!==id);
 options.customCategoryByAsset=Object.fromEntries(Object.entries(options.customCategoryByAsset||{}).filter(([,value])=>value!==id));
}
