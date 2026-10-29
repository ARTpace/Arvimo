import {findLocalJob} from './blender-send.js';

/** Asset-wide availability: an 8K file counts even when the card selects 2K. */
export function localFileState(jobs,uid){
 if(findLocalJob(jobs,uid))return 'downloaded';
 return jobs.some(job=>job.uid===uid&&job.state==='saved'&&job.fileExists===false)?'missing':'untracked';
}

export function localAssetKind(model){
 if(model.platform==='artstation')return model.hasMarmoset===false?'images':'models';
 if(model.platform==='ambientcg')return model.assetType||'textures';
 if(model.platform==='kenney')return 'packs';
 return ({skybox:'hdris',smart:'textures',alphas:'images'})[model.assetType]||model.assetType||'models';
}

export function localAssetCategories(model){
 return [...new Set([...(Array.isArray(model.categories)?model.categories:[]),model.category,...(model.tags||[]),...(model.userTags||[])].map(value=>typeof value==='string'?value:value?.name||value?.label||'').map(value=>value.trim()).filter(Boolean))];
}

export function filterLocalAssets(models,{kind='',category='',status='',search='',english=''},jobs){
 const term=search.trim().toLocaleLowerCase();
 const words=english.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 return models.filter(model=>(!kind||localAssetKind(model)===kind)
  &&(!category||localAssetCategories(model).includes(category))
  &&(!status||Array.isArray(jobs)&&localFileState(jobs,model.uid)===status)
  &&(!term||matches(model)));
 function matches(model){const text=`${model.name||''} ${model.author||''} ${(model.tags||[]).join(' ')}`.toLocaleLowerCase();return text.includes(term)||words.length>0&&words.every(word=>text.includes(word));}
}
