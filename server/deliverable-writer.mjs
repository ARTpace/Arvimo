// Shared staging writer for both ArtStation pipelines.
//
// A runner never picks filenames or moves files into the download folder: it hands DownloadManager a
// staging path plus a flat entry list, and this module turns that list into whichever shape the job
// asked for — one ZIP file, or a directory of loose files. Keeping the loop here means the Marmoset
// pipeline and the image pipeline emit structurally identical deliverables and an identical progress
// stream, so the shared verifier and the "ZIP + FBX" repacking step downstream stay pipeline-agnostic.
import fsp from 'node:fs/promises';
import path from 'node:path';
import {zipEntries} from './zip-writer.mjs';

const CHUNK=4*1024*1024;

/**
 * Write `entries` (`{name,data}`, `/`-separated names) to `output`: a directory when
 * `deliver==='folder'`, otherwise a single archive at the file path `output`.
 * `message` is the prefix of the progress text the UI shows, so each pipeline can describe what
 * was actually produced without re-implementing the writing loop.
 */
export async function writeEntriesDeliverable({entries,output,deliver='zip',signal,progress=()=>{},message='导出内容已就绪'}={}){
 if(deliver==='folder'){
  await fsp.mkdir(output,{recursive:true});
  const totalBytes=entries.reduce((n,e)=>n+e.data.length,0);
  let written=0;const begin=Date.now();
  for(const entry of entries){
   signal?.throwIfAborted();
   const target=path.join(output,...entry.name.split('/'));
   await fsp.mkdir(path.dirname(target),{recursive:true});
   await fsp.writeFile(target,entry.data);
   written+=entry.data.length;
   progress({stage:'transferring',message:`${message}，正在写入导出文件夹`,bytesWritten:written,totalBytes,transferRate:Math.round(written/Math.max(.001,(Date.now()-begin)/1000))});
  }
  return {bytes:totalBytes,folder:true,fileCount:entries.length};
 }
 const archive=zipEntries(entries);
 const handle=await fsp.open(output,'wx');
 try{
  let written=0;const begin=Date.now();
  for(let offset=0;offset<archive.length;offset+=CHUNK){
   signal?.throwIfAborted();
   const chunk=archive.subarray(offset,Math.min(offset+CHUNK,archive.length));
   await handle.write(chunk);written+=chunk.length;
   progress({stage:'transferring',message:`${message}，正在写入本机暂存文件`,bytesWritten:written,totalBytes:archive.length,transferRate:Math.round(written/Math.max(.001,(Date.now()-begin)/1000))});
  }
  await handle.sync();
 }finally{await handle.close();}
 return {bytes:archive.length,folder:false,fileCount:entries.length};
}
