import {formatKind} from './format-registry.js';

export const ASSET_TYPES = Object.freeze({models:'3D 模型',images:'图片',textures:'材质',hdris:'HDRI',packs:'资源包',uielement:'UI 元素',documents:'文档',videos:'视频',audio:'音频',unknown:'待分类'});
const aliases={model:'models',image:'images',texture:'textures',material:'textures',env:'hdris',hdri:'hdris',skybox:'hdris',pack:'packs',document:'documents',video:'videos',alpha:'images',alphas:'images',smart:'textures'};
const normalize=value=>aliases[value]|| (ASSET_TYPES[value]?value:'');
export function assetFileNames(model={}) {
 const names=[];
 for(const key of ['filePath','localRel','rel','filename'])if(typeof model[key]==='string')names.push(model[key]);
 for(const key of ['entries','files','downloads','assets'])for(const item of (Array.isArray(model[key])?model[key]:[]).slice(0,200)){
  const name=typeof item==='string'?item:item?.rel||item?.name||item?.path||item?.filePath;
  if(name)names.push(name);
 }
 return [...new Set(names)];
}
/** Same material stem must contain at least two distinct channels. A mask alone is not a material. */
export function materialSets(names=[]) {
 const sets=new Map();
 for(const name of names){
  const normalized=String(name).replace(/\\/g,'/').toLowerCase();
  if(!['image','env'].includes(formatKind(normalized)))continue;
  const stem=normalized.replace(/\.[^.\/]+$/,'');
  const match=stem.match(/(?:^|[_ .-])(base_?color|albedo|diffuse|normal|roughness|metallic|metalness|ao|height|displacement|orm|arm)(?=$|[_ .-])/);
  if(!match)continue;
  const family=stem.slice(0,match.index)+stem.slice(match.index+match[0].length);
  const channel=({albedo:'color',diffuse:'color',basecolor:'color',base_color:'color',metalness:'metallic'})[match[1]]||match[1];
  if(!sets.has(family))sets.set(family,new Set());
  sets.get(family).add(channel);
 }
 return [...sets.values()].some(channels=>channels.size>=2);
}
/** Purpose and encoding differ: a PNG panorama can be an environment without being HDR encoded. */
export function hasEnvironmentHint(model={}) {
 const paths=[...assetFileNames(model),model.localRoot,model.sourceRoot,model.root,model.folder].filter(value=>typeof value==='string');
 return paths.some(value=>/(?:^|[\\/_. -])(?:hdri?|skybox|skyboxes|equirectangular|panorama)(?=$|[\\/_. -])|天空盒|环境贴图|全景/i.test(value));
}
export function isPanoramicEnvironment(model={}) {
 const dimensions=model.formatCheck||model;
 const width=Number(dimensions.width),height=Number(dimensions.height);
 return width>=1024&&height>=512&&Math.abs(width/height-2)<.02&&hasEnvironmentHint(model);
}
export function classifyAsset(model={}) {
 const result=(kind,confidence,source,reason,extra={})=>({kind,confidence,source,reasons:[reason],needsReview:kind==='unknown',...extra});
 const override=normalize(model.typeOverride);
 if(override)return result(override,1,'manual','用户手动指定');
 const names=assetFileNames(model);
 const candidate=normalize(model.assetType||model.sourceType||model.kind||model.category);
 const explicit=candidate==='unknown'?'':candidate;
 const checked=model.formatCheck;
 if((!explicit||explicit==='images'||explicit==='hdris')&&isPanoramicEnvironment(model))return result('hdris',.93,'panorama','HDR/天空盒目录或命名线索，且图片为 2:1 全景比例');
 if(checked?.detected){
  const kind=normalize(formatKind('asset.'+checked.detected));
  if(kind)return result(kind,.99,'header',checked.conflict?'文件头与扩展名不符，以文件头为准':'文件头已确认格式');
 }
 if(explicit&&explicit!=='images'&&explicit!=='documents')return result(explicit,.95,'metadata','资产来源已明确主类型');
 const platform={sketchfab:'models',ambientcg:'textures',kenney:'packs',uiverse:'uielement',artstation:model.hasMarmoset===false?'images':'models'}[model.platform];
 if(platform)return result(platform,.95,'platform','平台提供的资产类型');
 if(names.some(name=>formatKind(name)==='model'))return result('models',.92,'structure','包含模型主文件；贴图、封面和文档作为附件');
 if(names.some(name=>formatKind(name)==='env'))return result('hdris',.9,'structure','包含 HDR/EXR 环境文件');
 if(materialSets(names))return result('textures',.88,'structure','同名材质包含多个不同 PBR 通道');
 const kinds=[...new Set(names.map(name=>normalize(formatKind(name))).filter(Boolean))];
 const primary=kinds.filter(kind=>!['images','documents'].includes(kind));
 if(primary.length===1)return result(primary[0],.8,'extension','依据主文件扩展名，尚未校验文件头');
 if(explicit)return result(explicit,.85,'metadata','资产记录提供的主类型');
 if(kinds.length===1)return result(kinds[0],.75,'extension','依据文件扩展名，尚未校验文件头');
 const archive=names.some(name=>/\.(zip|7z|rar)$/i.test(name));
 return result('unknown',.3,'insufficient',archive?'压缩格式不代表资源包，需确认包内内容':'证据不足，请手动确认类别',{suggestedKind:archive?'packs':kinds[0]||''});
}
