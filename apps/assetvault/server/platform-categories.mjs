import {ARTSTATION_CATEGORY_ZH} from '../src/library/filter-labels.js';
import {CATEGORIES} from '../src/library/search-options.js';

const norm=value=>String(value??'').normalize('NFKC').trim().toLowerCase();
const sketchNames=['Animals & Pets','Architecture','Art & Abstract','Cars & Vehicles','Characters & Creatures','Cultural Heritage & History','Electronics & Gadgets','Fashion & Style','Food & Drink','Furniture & Home','Music','Nature & Plants','News & Politics','People','Places & Travel','Science & Technology','Sports & Fitness','Weapons & Military'];
const artFacets={
 style:['Abstract','Anime & Manga','Fantasy','Horror','Pixel and Voxel Art','Realism','Science Fiction','Stylized'],
 subject:['Anatomy','Animals & Wildlife','Automotive','Creatures','Fashion & Costume Design','Mecha','Portraits','Props','Still Life','Toys & Collectibles','Vehicles','Weapons'],
 tech:['Hard Surface','Lighting','Photogrammetry & 3D Scanning','Technical Art','Virtual and Augmented Reality'],
};
// 平台组合分类保留完整含义，不把“角色与生物”当成同时确认角色和生物。
export const PLATFORM_CATEGORIES=Object.freeze([
 ...Object.entries(ARTSTATION_CATEGORY_ZH).map(([name,value])=>({platform:'artstation',key:name,name,value,facet:Object.keys(artFacets).find(f=>artFacets[f].includes(name))||'usage'})),
 ...CATEGORIES.filter(([slug])=>slug).map(([key,value],i)=>({platform:'sketchfab',key,name:sketchNames[i],value,facet:'subject'})),
]);
const lookup=new Map();
for(const entry of PLATFORM_CATEGORIES)for(const value of [entry.key,entry.name,entry.value])lookup.set(entry.platform+':'+norm(value),entry);

/** 只保留平台返回的分类，不接受搜索条件；未知 ID/名称原样留存，不猜层级。 */
export function normalizePlatformCategories(platform,rows,{options=[]}={}){
 if(!Array.isArray(rows))return [];
 const result=new Map();
 for(const row of rows.slice(0,128)){
  const obj=row&&typeof row==='object'&&!Array.isArray(row)?row:{};
  const scalar=typeof row==='string'||typeof row==='number'?String(row):'';
  const id=String(obj.id??obj.uid??(/^\d+$/.test(scalar)?scalar:'')).slice(0,120);
  const slug=typeof obj.slug==='string'?obj.slug.slice(0,200):'';
  const option=id?options.find(item=>String(item.value)===id):null;
  const name=String(obj.name??obj.label??obj.title??option?.label??(id?'':scalar)).trim().slice(0,200);
  if(!id&&!slug&&!name)continue;
  const record={platform,id,slug,name};result.set(JSON.stringify(record),record);
 }
 return [...result.values()];
}
export function platformCategoryRecords(model){
 const platform=norm(model.platform||(/sketchfab\.com\//i.test(model.url||'')?'sketchfab':''));
 if(!['artstation','sketchfab'].includes(platform))return [];
 return normalizePlatformCategories(platform,[...(Array.isArray(model.platformCategories)?model.platformCategories:[]),...(Array.isArray(model.categories)?model.categories:[])]);
}
export function mappedPlatformCategories(model){
 const result=new Map();
 for(const row of platformCategoryRecords(model)){
  const entry=lookup.get(row.platform+':'+norm(row.slug))||lookup.get(row.platform+':'+norm(row.name));
  if(entry)result.set(entry.value,entry);
 }
 return [...result.values()];
}
/** 已有标准名/别名复用原 ID，缺少的创建稳定种子；不使用搜索树近似映射。 */
export function addPlatformCategoryTerms(base){
 const result=base.map(term=>({...term,aliases:[...(term.aliases||[])],facets:[...term.facets]}));
 const index=new Map();for(const term of result)for(const name of [term.value,...term.aliases])index.set(norm(name),term);
 for(const entry of PLATFORM_CATEGORIES){
  const term=index.get(norm(entry.value))||index.get(norm(entry.name));
  if(term)continue;
  const next={id:`platform-category-v1:${entry.platform}:${entry.key}`,value:entry.value,facets:[entry.facet],aliases:[]};
  result.push(next);index.set(norm(next.value),next);
 }
 return result;
}
