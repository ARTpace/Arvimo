import {isPanoramicEnvironment} from '../src/library/asset-classification.js';
// 本地文件夹索引：把一个磁盘目录摊平成可预览的文件清单。
//
// 这个库以前的资产都来自各平台 API，格式受平台约束；本地索引是第一个「用户自己的文件」
// 入口，所以两件事必须做对：
//  1. 扫描要快且不能失控——层级、文件数都有上限，遇到 node_modules / .git 这类目录直接跳过；
//  2. 文件服务只认「调用方给的 root 之下」的路径，防止 rel 里塞 `..` 读到别处去。
import fs from 'node:fs';
import path from 'node:path';
import {extensionOf, formatKind, formatMime, formatGroup} from '../src/library/format-registry.js';
import {sniffImageExtension,inspectAssetFormat} from './image-sniff.mjs';

/** 相对路径统一用正斜杠，前端不必再处理两种分隔符。 */
const toPosix=value=>value.split(path.sep).join('/');

// 扩展名 → kind / MIME / 分组 / 预览策略只有一份事实源（src/library/format-registry.js）。
// 这里不再维护平行清单：新增一种格式只改注册表那一行，扫描、文件流、筛选、预览一起生效。

/** 这些目录永远不进索引：依赖、版本库、回收站、系统缓存。 */
const SKIP_DIRS=new Set(['node_modules','.git','.svn','.hg','$recycle.bin','system volume information','__pycache__','.cache','.workbuddy','.assetvault']);

const MAX_DEPTH=8;
const MAX_FILES=4000;
const MAX_FOLDERS=20000;

export function fileKind(name){
 return formatKind(name);
}

export function localMime(name){
 const mime=formatMime(name);
 // 无扩展名的图（下载下来的文件名不带后缀）：按魔数补一次，别让 <img> 收到 octet-stream。
 if(mime!=='application/octet-stream')return mime;
 const sniffed=sniffImageExtension(String(name||''));
 return sniffed?formatMime(`thumb.${sniffed}`):mime;
}

function requireFolder(value){
 const folder=String(value||'').trim();
 if(!folder)throw Error('请先选择要索引的文件夹');
 if(folder.includes('\0'))throw Error('路径里含有非法字符');
 if(!path.isAbsolute(folder))throw Error('请输入完整的文件夹路径');
 let stat=null;
 try{stat=fs.statSync(folder);}catch{throw Error('文件夹不存在或磁盘未连接');}
 if(!stat.isDirectory())throw Error('这个路径不是文件夹');
 return path.resolve(folder);
}

/** 扫描一个文件夹（递归、限量）。返回扁平文件清单，按目录层级 + 名称稳定排序。 */
export async function listLocalFolder({folder,limit=MAX_FILES}={}){
 const root=requireFolder(folder);
 const maxFiles=Math.max(1,Math.min(Number(limit)||MAX_FILES,MAX_FILES));
 const files=[];
 const stats={folders:0,skipped:0};
 let truncated=false;
 // 广度优先：浅层文件先出现，超限时用户看到的也是更靠外的内容。
 const queue=[{dir:root,rel:'',depth:0}];
 while(queue.length){
  const {dir,rel,depth}=queue.shift();
  let entries=[];
  try{entries=await fs.promises.readdir(dir,{withFileTypes:true});}
  catch{stats.skipped++;continue;}
  entries.sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries){
   if(files.length>=maxFiles){truncated=true;break;}
   const childRel=rel?`${rel}/${entry.name}`:entry.name;
   if(entry.isDirectory()){
    if(depth>=MAX_DEPTH){stats.skipped++;continue;}
    if(entry.name.startsWith('.')||SKIP_DIRS.has(entry.name.toLowerCase())){stats.skipped++;continue;}
    if(++stats.folders>MAX_FOLDERS){truncated=true;break;}
    queue.push({dir:path.join(dir,entry.name),rel:childRel,depth:depth+1});
    continue;
   }
   if(!entry.isFile()){stats.skipped++;continue;}
   // 点开头的文件（.DS_Store / Thumbs.db 一类）不算素材，和隐藏目录一起跳过。
   if(entry.name.startsWith('.')){stats.skipped++;continue;}
   let stat=null;
   try{stat=await fs.promises.stat(path.join(dir,entry.name));}catch{stats.skipped++;continue;}
   // 每个文件只读有限文件头；格式冲突保留依据，不更改原文件。
   const formatCheck=inspectAssetFormat(path.join(dir,entry.name));
   const ext=formatCheck.effective;
   const formatName=`${entry.name}.${ext}`;
   files.push({
    rel:childRel,
    name:entry.name,
    ext,
    // format/group 是筛选用的稳定字段：前端不必自己再 parse 文件名，服务端与 UI 共用一份分组。
    format:ext,
    group:formatGroup(formatName),
    kind:isPanoramicEnvironment({filePath:path.join(dir,entry.name),formatCheck})?'env':fileKind(formatName),formatCheck,
    bytes:stat.size,
    mtime:Math.round(stat.mtimeMs),
   });
  }
  if(truncated)break;
 }
 files.sort((a,b)=>a.rel.localeCompare(b.rel,'zh'));
 const parent=path.dirname(root);
 return {
  folder:root,
  parent:parent===root?null:parent,
  files,
  truncated,
  counts:files.reduce((acc,f)=>{acc[f.kind]=(acc[f.kind]||0)+1;return acc;},{}),
  scanned:{folders:stats.folders,skipped:stats.skipped},
 };
}

/** 把 {root, rel} 解析成真实文件路径，越界即拒。 */
export function resolveLocalFile({root,rel}={}){
 const resolved=resolveLocalTarget({root,rel});
 if(resolved.isDir)throw Error('这个路径不是文件');
 return {file:resolved.path,bytes:resolved.bytes,rel:resolved.rel};
}

/**
 * 把 {root, rel} 解析成真实路径，文件和目录都收。越界、绝对路径、`..` 一律拒。
 * 「在资源管理器里打开」既可能指向一个文件，也可能指向一个素材包目录（rel 本身就是目录），
 * 所以校验逻辑只写这一份，由 resolveLocalFile 与它共用。
 */
export function resolveLocalTarget({root,rel}={}){
 const base=requireFolder(root);
 const target=String(rel||'').replace(/\\/g,'/');
 if(!target||target.includes('\0'))throw Error('缺少文件路径');
 if(target.split('/').some(part=>part==='..'))throw Error('路径不合法');
 const full=path.resolve(base,target);
 if(full!==base&&!full.startsWith(base+path.sep))throw Error('路径不合法');
 let stat=null;
 try{stat=fs.statSync(full);}catch{throw Error('文件不存在或已被移动');}
 return {path:full,isDir:stat.isDirectory(),bytes:stat.isFile()?stat.size:0,rel:toPosix(path.relative(base,full))};
}

/** 解析 Range 头；返回 null 表示按整文件回（不支持的写法一律回整文件，比报错友好）。 */
export function parseRange(header,size){
 const match=/^bytes=(\d*)-(\d*)$/.exec(String(header||'').trim());
 if(!match)return null;
 const [,rawStart,rawEnd]=match;
 if(!rawStart&&!rawEnd)return null;
 let start=rawStart?Number(rawStart):null;
 let end=rawEnd?Number(rawEnd):null;
 if(start===null){                       // `bytes=-500`：最后 500 字节
  const tail=Math.min(Number(end)||0,size);
  start=Math.max(0,size-tail);
  end=size-1;
 }else{
  end=end===null?size-1:Math.min(end,size-1);
 }
 if(start>=size||start>end)return {invalid:true};
 return {start,end};
}
