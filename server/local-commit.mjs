// The last step of a job: move the finished deliverable into the user's download folder.
//
// "Never overwrite" is the whole contract here. A second export of the same asset has to become a
// second file rather than silently replacing the first, because the replaced one may already be
// imported elsewhere and nothing in the queue can tell the user it changed underneath them. Both
// delivery shapes share that rule, and both are the only writers that touch the download folder.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

/** Folder delivery: the staged directory is moved into place, numbered on a name clash. */
export async function commitFolder(source,folder,name){
  await fsp.mkdir(folder,{recursive:true});
  for(let i=0;i<10000;i++){
    const destination=path.join(folder,i?`${name} (${i})`:name);
    try{await fsp.rename(source,destination);return destination;}
    catch{
      // rename only works within one volume and refuses non-empty targets; fall back to a copy.
      try{await fsp.cp(source,destination,{recursive:true,errorOnExist:true,force:false});}
      catch(e){if(['EEXIST','ERR_FS_CP_EEXIST','ENOTEMPTY','ENOTDIR'].includes(e.code))continue;throw e;}
      await fsp.rm(source,{recursive:true,force:true}).catch(()=>{});
      return destination;
    }
  }
  throw Error('同名文件夹过多，请选择其他保存目录');
}

/** Archive delivery: prepared under a unique name, then linked (copied across volumes) into place. */
export async function commitArchive(source,folder,filename){
  await fsp.mkdir(folder,{recursive:true});const prepared=path.join(folder,`.sfx-${randomUUID()}.part`);
  try{
    await fsp.copyFile(source,prepared,fs.constants.COPYFILE_EXCL);
    const fd=await fsp.open(prepared,'r+');try{await fd.sync();}finally{await fd.close();}
    for(let i=0;i<10000;i++){
      const name=i?filename.replace(/\.zip$/,` (${i}).zip`):filename,destination=path.join(folder,name);
      try{
        try{await fsp.link(prepared,destination);}
        catch(e){if(['EPERM','ENOTSUP','EOPNOTSUPP','EXDEV'].includes(e.code))await fsp.copyFile(prepared,destination,fs.constants.COPYFILE_EXCL);else throw e;}
        return destination;
      }catch(e){if(e.code!=='EEXIST')throw e;}
    }
    throw Error('同名文件过多，请选择其他保存目录');
  }finally{await fsp.unlink(prepared).catch(()=>{});}
}
