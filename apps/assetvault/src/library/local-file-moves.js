// 服务端已经提交的定位变化只更新本地读视图，不再触发一次入库或整库保存。
export function applyLocalFileMoves(models, result) {
  if(!Array.isArray(models)||!result?.root||!Array.isArray(result.changes))return 0;
  const changes=new Map(result.changes.map(item=>[item.uid,item]));let count=0;
  for(const model of models) {
    const change=changes.get(model?.uid);if(!change)continue;
    const basename=rel=>String(rel).split(/[\\/]/).at(-1);
    if(model.name===basename(change.from))model.name=basename(change.to);
    model.localRoot=result.root;model.localRel=change.to;
    model.filePath=result.root.replace(/[\\/]$/,'')+ (result.root.includes('\\')?'\\':'/')+change.to.replace(/\//g,result.root.includes('\\')?'\\':'/');
    model.fileExists=true;
    for(const field of ['url','thumbnail','previewUrl'])if(/^\/api\/local\/(?:file|thumb)\?/.test(model[field]||'')) {
      const url=new URL(model[field],'http://local');url.searchParams.set('root',result.root);url.searchParams.set('rel',change.to);
      model[field]=url.pathname+'?'+url.searchParams.toString();
    }
    count++;
  }
  return count;
}
