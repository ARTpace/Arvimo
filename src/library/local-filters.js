import {findLocalJob} from './blender-send.js';

/** Asset-wide availability: an 8K file counts even when the card selects 2K. */
export function localFileState(jobs,uid){
 if(findLocalJob(jobs,uid))return 'downloaded';
 return jobs.some(job=>job.uid===uid&&job.state==='saved'&&job.fileExists===false)?'missing':'untracked';
}

/** 采集来的资产 assetType 是单数（image / texture），而筛选条的值域是复数（images / textures）。
 *  不做这层归一，从平台收进库的图片资产按「图片」筛永远是 0 条 —— 与服务端 library-query 的别名表保持同一份。 */
const KIND_ALIASES={image:'images',texture:'textures',material:'textures',hdri:'hdris',skybox:'hdris',alpha:'images',model:'models',pack:'packs',uielement:'uielement'};

export function localAssetKind(model){
 if(model.platform==='artstation')return model.hasMarmoset===false?'images':'models';
 if(model.platform==='ambientcg')return model.assetType||'textures';
 if(model.platform==='kenney')return 'packs';
 // Uiverse 资产落盘是 index.html + style.css，不是 3D 模型也不是图片：
 // 不单独判就会走到下面的默认值 'models'，UI 模式永远筛不到（2026-11-12 用户反馈）。
 if(model.platform==='uiverse')return 'uielement';
 const raw=({skybox:'hdris',smart:'textures',alphas:'images'})[model.assetType]||model.assetType||'models';
 return KIND_ALIASES[raw]||raw;
}

export function localAssetCategories(model){
 return [...new Set([...(Array.isArray(model.categories)?model.categories:[]),model.category,...(model.tags||[]),...(model.userTags||[])].map(value=>typeof value==='string'?value:value?.name||value?.label||'').map(value=>value.trim()).filter(Boolean))];
}

export function filterLocalAssets(models,{kind='',category='',status='',search='',english='',imageTerms=[]},jobs){
 const term=search.trim().toLocaleLowerCase();
 const words=english.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 // 图搜：视觉模型给的关键词按命中的字段加权（名称 > 标签 > 作者），命中越多排得越前。
 const terms=(Array.isArray(imageTerms)?imageTerms:[]).map(item=>String(item||'').replace(/\s+/g,' ').trim().toLocaleLowerCase()).filter(item=>item.length>=2).slice(0,24);
 const rows=models.filter(model=>(!kind||localAssetKind(model)===kind)
  &&(!category||localAssetCategories(model).includes(category))
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
