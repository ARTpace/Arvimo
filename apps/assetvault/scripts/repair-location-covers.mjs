// 修复稳定定位曾把封面重写成主文件的记录；默认仅预演，不移动或生成资产文件。
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import {resolveUserPaths} from '../server/data-dir.mjs';
import {packageDirOf} from '../server/asset-claim.mjs';
import {createLibraryDb} from '../server/library-db.mjs';
import {fetchProjectJson, projectImageAssets} from '../server/artstation-project.mjs';
import {cachePlatformCover,localPlatformCover} from '../server/platform-cover.mjs';

const apply=process.argv.includes('--apply');
const recoverRemote=process.argv.includes('--recover-remote');
const {dataDir}=resolveUserPaths();
const file=path.join(dataDir,'library.db');
const db=new Database(file,{readonly:true,fileMustExist:true});
const rows=db.prepare("SELECT uid,name,platform,thumbnail,payload,rev FROM assets WHERE state='active' AND platform NOT IN ('','local')").all();
const plans=[],unresolved=[];
function referencesMain(url,model){
  if(!/^\/api\/local\/(thumb|file)\?/.test(String(url||'')))return false;
  const u=new URL(url,'http://local');
  const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  return same(String(u.searchParams.get('rel')||'').replace(/\\/g,'/'),String(model.localRel||'').replace(/\\/g,'/'))
    && same(path.resolve(u.searchParams.get('root')||'.'),path.resolve(model.localRoot||'.'));
}
try {
  for(const row of rows){
    const model=JSON.parse(row.payload);
    if(!model.localRoot||!model.localRel)continue;
    const broken=referencesMain(model.thumbnail,model);
    const existingPreview=localPlatformCover(model.thumbnail);
    if(!broken&&!(existingPreview&&row.thumbnail!==existingPreview))continue;
    let cover=broken?'':existingPreview,platformThumbnail='';
    // 非主文件的已有本地封面可能是用户选择的图片，优先保留它。
    if(!cover&&row.thumbnail?.startsWith('/api/local/')&&!referencesMain(row.thumbnail,model))cover=row.thumbnail;
    const dir=packageDirOf(model);
    if(!cover&&dir){
      const names=await fs.readdir(dir);
      for(const name of names.filter(n=>/^preview\.(png|jpe?g|webp|gif|avif)$/i.test(n)).sort()){
        const preview=path.join(dir,name),rel=path.relative(model.localRoot,preview);
        if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))continue;
        try {await sharp(preview).metadata();}catch{continue;}
        const stat=await fs.stat(preview);
        cover='/api/local/thumb?'+new URLSearchParams({root:model.localRoot,rel:rel.split(path.sep).join('/'),w:'384',v:String(Math.trunc(stat.mtimeMs))});
        break;
      }
    }
    if(!cover)cover=[model.platformThumbnail,row.thumbnail].find(url=>/^https?:\/\//i.test(String(url||'')))||'';
    if(!cover&&dir){try{const info=JSON.parse(await fs.readFile(path.join(dir,'info.json'),'utf8'));if(/^https?:\/\//i.test(info.thumbnail||''))cover=info.thumbnail;}catch{}}
    if(!cover&&recoverRemote&&dir&&model.platform==='artstation'){
      const project=await fetchProjectJson(model.sourceUrl||'',{signal:AbortSignal.timeout(15000)}).catch(()=>null);
      const candidate=project?.cover?.medium_image_url||project?.cover?.small_image_url||projectImageAssets(project)[0]?.url||'';
      if(/^https:\/\//i.test(candidate)){
        platformThumbnail=candidate;cover=candidate;
        if(apply){
          const cached=await cachePlatformCover(dir,candidate,{timeout:12000});
          if(cached){
            const relative=path.relative(model.localRoot,cached);
            if(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)){
              cover='/api/local/thumb?'+new URLSearchParams({root:model.localRoot,rel:relative.split(path.sep).join('/'),w:'384',v:String(Date.now())});
            }
          }
        }
      }
    }
    if(!cover){unresolved.push({uid:row.uid,name:row.name});continue;}
    plans.push({row,cover,platformThumbnail});
  }
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',platformAssets:rows.length,repairable:plans.length,unresolved:unresolved.length,items:plans.map(({row,cover})=>({name:row.name,thumbnail:cover})),unresolvedItems:unresolved},null,2));
  if(apply&&plans.length){
    const backupDir=path.resolve('output','thumbnail-repair-'+new Date().toISOString().replace(/[:.]/g,'-'));
    await fs.mkdir(backupDir,{recursive:true});
    await db.backup(path.join(backupDir,'library.db'));
    await fs.writeFile(path.join(backupDir,'records.json'),JSON.stringify(plans.map(({row})=>row),null,2));
    const writer=createLibraryDb({Database,file});
    try{
      const result=writer.applyAssetOps(plans.map(({row,cover,platformThumbnail})=>({op:'asset:patch',uid:row.uid,rev:row.rev,patch:{thumbnail:cover,...(platformThumbnail?{platformThumbnail}:{})}})),{actor:'repair-location-covers'});
      if(result.applied!==plans.length||result.conflicts?.length)throw Error('修复存在版本冲突：'+JSON.stringify(result));
      const current=writer.all('SELECT uid,thumbnail,payload FROM assets');
      for(const {row,cover} of plans){const saved=current.find(item=>item.uid===row.uid);if(saved?.thumbnail!==cover||JSON.parse(saved.payload).thumbnail!==cover)throw Error('封面回读不一致: '+row.uid);}
      console.log(JSON.stringify({applied:result.applied,backupDir,verified:true}));
    }finally{writer.close();}
  }
}finally{db.close();}
