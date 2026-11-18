import {classifyAsset} from './asset-classification.js';
import {findLocalJob} from './blender-send.js';
import {categoryMatches} from './tag-facet-map.js';
import {imageSubcategoryOf,isImageKind} from './image-subcategories.js';
import {mediaSubcategoryOf} from './doc-media-subcategories.js';

/** Asset-wide availability: an 8K file counts even when the card selects 2K. */
export function localFileState(jobs,uid){
 if(findLocalJob(jobs,uid))return 'downloaded';
 return jobs.some(job=>job.uid===uid&&job.state==='saved'&&job.fileExists===false)?'missing':'untracked';
}

/** 采集来的资产 assetType 是单数（image / texture），而筛选条的值域是复数（images / textures）。
 *  不做这层归一，从平台收进库的图片资产按「图片」筛永远是 0 条 —— 与服务端 library-query 的别名表保持同一份。 */
export function localAssetKind(model){return classifyAsset(model).kind;}

export function localAssetCategories(model){
 // 图片的用途子类由规则自动判定，和手动标签并列：既喂给侧栏计数，也让点子类时能筛出对应资产。
 // 文档 / 视频 / 音频同样派生一格「用途子类」（教程指南、音乐配乐…），
 // 侧栏类型树读的就是这个函数，所以计数与点选筛选天然同步，不用另开一条判据。
 const auto=isImageKind(model)?imageSubcategoryOf(model):mediaSubcategoryOf(model);
 return [...new Set([auto,...(Array.isArray(model.categories)?model.categories:[]),model.category,...(model.tags||[]),...(model.userTags||[])].map(value=>typeof value==='string'?value:value?.name||value?.label||'').map(value=>value.trim()).filter(Boolean))];
}

export function filterLocalAssets(models,{kind='',category='',status='',search='',english='',imageTerms=[]},jobs){
 const term=search.trim().toLocaleLowerCase();
 const words=english.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 // 图搜：视觉模型给的关键词按命中的字段加权（名称 > 标签 > 作者），命中越多排得越前。
 const terms=(Array.isArray(imageTerms)?imageTerms:[]).map(item=>String(item||'').replace(/\s+/g,' ').trim().toLocaleLowerCase()).filter(item=>item.length>=2).slice(0,24);
 const rows=models.filter(model=>(!kind||localAssetKind(model)===kind)
  &&(!category||categoryMatches(localAssetCategories(model),category))
  &&(!status||Array.isArray(jobs)&&localFileState(jobs,model.uid)===status)
  &&(!term||matches(model)));
 if(!terms.length)return rows;
 return rows.map(model=>{
   const name=String(model.name||'').toLocaleLowerCase();
   const tags=(model.tags||[]).join(' ').toLocaleLowerCase();
   const author=String(model.author||'').toLocaleLowerCase();
   let hits=0;
   for(const item of terms){
     if(name.includes(item))hits+=3;
     else if(tags.includes(item))hits+=2;
     else if(author.includes(item))hits+=1;
   }
   model._imgHits=hits;
   return model;
 }).filter(model=>model._imgHits>0).sort((a,b)=>b._imgHits-a._imgHits);
 function matches(model){const text=`${model.name||''} ${model.author||''} ${(model.tags||[]).join(' ')}`.toLocaleLowerCase();return text.includes(term)||words.length>0&&words.every(word=>text.includes(word));}
}
