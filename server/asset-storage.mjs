import path from 'node:path';

// Stable physical folders; multi-label search remains independent of the on-disk category.
export function assetStorageCategory(asset){
 const type=asset.assetType||'';
 if(asset.kind==='images'||type==='images'||type==='alphas'||asset.kind==='image')return '图片';
 if(['hdris','skybox','hdri'].includes(type)||asset.kind==='hdri')return '环境';
 if((asset.kind==='ambientcg'||asset.platform==='ambientcg')&&(!type||type==='textures')||asset.kind==='material'||['textures','smart'].includes(type))return '材质';
 if(asset.kind==='kenney'||asset.platform==='kenney'||['pack','packs'].includes(type))return '资源包';
 const text=[asset.name,asset.title,...(Array.isArray(asset.tags)?asset.tags:[])].filter(Boolean).join(' ').toLowerCase();
 const groups=[
  ['建筑',/\b(temple|building|architecture|factory|house|castle|village|bridge)\b|建筑|寺庙|房屋|工厂/],
  ['植被',/\b(tree|plant|grass|flower|bush|foliage)\b|植被|树木|花草/],
  ['载具',/\b(car|porsche|vehicle|truck|aircraft|motorcycle|ship)\b|汽车|载具|飞机/],
  ['角色',/\b(character|girl|female|male|head|human|boy|dealer)\b|角色|人物|人头/],
  ['生物',/\b(cat|dog|bird|phoenix|triceratops|dinosaur|shiba|animal|dragon|pawblo)\b|动物|生物|恐龙/],
  ['道具',/\b(tool|hammer|shield|chair|furniture|trowel|watering|pastries|food)\b|道具|工具|家具|食物/],
 ];
 const normalized=text.replace(/-(?:pack|textures|material|images|hdri)-[a-f0-9]{8}(?:\s*\(\d+\))?(?:\.zip)?$/i,'').replace(/[_-]+/g,' ');
 if(/\b(pack|collection)\b|资源包|合集/.test(normalized))return '资源包';
 return path.join('模型',groups.find(([,pattern])=>pattern.test(normalized))?.[0]||'未分类');
}

export const storageRoot=job=>job.downloadRoot||job.downloadDir;
