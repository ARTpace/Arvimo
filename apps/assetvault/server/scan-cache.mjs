// Recursive watchers identify changed packages. A full scan every five minutes
// bounds missed events; unsupported watchers retain the 15-second TTL fallback.
// Explicit invalidation/manual scan always rebuilds; TTL=0 disables reuse.
import fsp from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';

const configured=Number(process.env.SFX_SCAN_CACHE_TTL_MS);
const TTL_MS=Number.isFinite(configured)?Math.max(0,configured):15000;
const FULL_SCAN_MS=5*60*1000;
const MAX_ENTRIES = 4; // 只留最近几组根目录的缓存，避免超大资产库把内存吃爆。

const cache = new Map(); // key -> { signature, value, at }

/** 根目录签名：每根一次 stat + 一次 readdir（只取名字，不 stat 子项）。探不到的变化交给 TTL。 */
async function rootsSignature(roots) {
  const parts = [];
  for (const root of roots) {
    try {
      const stat = await fsp.stat(root);
      let names = '';
      try { names = (await fsp.readdir(root)).sort().join('|'); } catch { /* 根还在但读不动，签名只留 stat */ }
      parts.push(`${stat.mtimeMs}:${stat.size}:${names}`);
    } catch {
      parts.push('missing');
    }
  }
  return parts.join('#');
}

/** 写操作（登记 / 补写元信息 / 删除资产）之后调用：清空全部扫描缓存。 */
function discard(key,entry){for(const watcher of entry.watchers)watcher.close();cache.delete(key);}
export function invalidateScanCache(){for(const [key,entry] of cache)discard(key,entry);}

/**
 * 与资产无关的写入不该触发重扫。命中这些模式就当成「噪音」，连 generation 都不动。
 *
 * 之所以必须过滤：典型用户会把资产库放在同步盘里（微力同步 / OneDrive / Dropbox），
 * 同步器每写一个文件就产生 .sync-conflict-* / .tmp / .crdownload 一串事件；不过滤的话
 * 索引会被反复作废，前端收到的「有新文件」通知也全是假的。
 */
const NOISE = /(^|[\\/])\.(?!well-known$)|\.sync-conflict-|\.tmp$|\.temp$|\.part$|\.partial$|\.crdownload$|\.download$|\.swp$|\.lock$|\.db-wal$|\.db-shm$|^~\$/i;
export function isNoisePath(name){
 if(!name)return false;
 const value=String(name);
 return NOISE.test(value)||/(^|[\\/])(node_modules|__pycache__|\.git)([\\/]|$)/i.test(value);
}

/**
 * 磁盘变化通知：缓存层只负责说「哪个根变了」，广播与 UI 刷新由上层决定。
 * 返回退订函数，测试与热重载可以干净摘掉。
 */
const changeListeners=new Set();
/** 合并窗口：一次复制 200 个文件会来几百条事件，攒成一次通知。 */
export const CHANGE_DEBOUNCE_MS=800;
let notifyTimer=null;
const pendingRoots=new Set();
function scheduleChange(root){
 pendingRoots.add(root);
 if(notifyTimer)return;
 notifyTimer=setTimeout(()=>{
  notifyTimer=null;
  const roots=[...pendingRoots];pendingRoots.clear();
  for(const listener of changeListeners){try{listener({roots});}catch{}}
 },CHANGE_DEBOUNCE_MS);
 notifyTimer.unref?.();
}
export function onScanChange(listener){
 if(typeof listener!=='function')return()=>{};
 changeListeners.add(listener);
 return()=>{changeListeners.delete(listener);};
}

function createEntry(roots){
 const entry={watchers:[],watching:true,dirty:new Set(),generation:0,packages:new Map(),at:0,fullAt:0,value:null,pending:null};
 for(const root of roots){
  try{
   const watcher=watch(root,{recursive:true,persistent:false},(_event,name)=>{
    if(isNoisePath(name))return; // 临时文件 / 同步冲突件：不参与索引，也不惊动前端
    entry.generation++;
    scheduleChange(root);
    if(name&&entry.dirty.size<10000)entry.dirty.add(path.resolve(root,String(name)));else entry.watching=false;
   });
   watcher.on('error',()=>{entry.watching=false;entry.generation++;});
   entry.watchers.push(watcher);
  }catch{entry.watching=false;}
 }
 return entry;
}

/**
 * 带失效的缓存读取。key 需已含 roots 的完整区分度（调用方用 JSON 串）；
 * 合并在途请求；监听有效时按变化路径复用包索引，否则按 TTL 全扫。
 * 扫描期间收到变化事件时不发布缓存，下次请求重新校验。
 */
export async function cachedScan(key,{roots,compute,force=false}){
 if(!TTL_MS)return compute({});
 let entry=cache.get(key);
 if(!entry){
  if(cache.size>=MAX_ENTRIES){const oldest=cache.entries().next().value;discard(...oldest);}
  entry=createEntry(roots);cache.set(key,entry);
 }
 if(entry.pending){
  if(!force)return entry.pending;
  try{await entry.pending;}catch{}
  return cachedScan(key,{roots,compute,force});
 }
 const task=(async()=>{
  const generation=entry.generation,signature=await rootsSignature(roots);
  const full=force||!entry.value||!entry.watching||Date.now()-entry.fullAt>=FULL_SCAN_MS||(signature!==entry.signature&&!entry.dirty.size);
  if(!force&&entry.value&&!entry.dirty.size&&generation===entry.generation&&signature===entry.signature&&
    (entry.watching?Date.now()-entry.fullAt<FULL_SCAN_MS:Date.now()-entry.at<TTL_MS))return entry.value;
  const packages=new Map(entry.packages);
  const value=await compute({packageCache:packages,changedPaths:full?null:[...entry.dirty]});
  if(cache.get(key)===entry&&generation===entry.generation){
   entry.value=value;entry.packages=packages;entry.signature=signature;entry.at=Date.now();
   if(full)entry.fullAt=entry.at;
   entry.dirty.clear();
  }
  return value;
 })();
 entry.pending=task;
 try{return await task;}finally{if(entry.pending===task)entry.pending=null;}
}
