// M2 只读预检：哈希只用于内容比较，不代表资产身份或删除授权。
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const LIMIT = 10000;
const abort = signal => {if (signal?.aborted) throw Object.assign(new Error('预检已取消'), {name:'AbortError', code:'ABORT_ERR'});};
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/**
 * 显式绝对路径列表；不递归、不修改原件、不写缓存，逐文件串行流式 SHA256。
 * known 是调用方提供的快照，不查询真实库，也不保证其真实性或完整性。
 * 返回每个输入一条结果。成功含 sha256；失败/读取变化不提供可采信摘要。
 * matches 标明 known/batch 来源，批内引用原始 index；保留所有重复记录。
 * 文件状态检查仅能发现可观测变化，不能证明文件在整个读取期间从未被修改。
 */
export async function preflightLocalFiles({files, known = [], signal} = {}) {
  if (!Array.isArray(files) || files.length > LIMIT || Array.from(files).some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) {
    throw new TypeError('files 须为最多 10000 项的绝对文件路径列表');
  }
  if (!Array.isArray(known) || known.length > LIMIT || Array.from(known).some(item => !item || typeof item.uid !== 'string' || !item.uid || typeof item.name !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0)) {
    throw new TypeError('known 须为最多 10000 项的 {uid,name,sha256,bytes} 索引');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal 须为 AbortSignal');
  abort(signal);
  const hashes = new Map(), names = new Map();
  const add = (map, key, item) => {const group = map.get(key) || [];group.push(item);map.set(key, group);};
  for (const item of known) {
    const ref = {source:'known',uid:item.uid,name:item.name,sha256:item.sha256.toLowerCase(),bytes:item.bytes};
    add(hashes, `${ref.bytes}:${ref.sha256}`, ref);add(names, ref.name, ref);
  }
  const results = [];
  for (const [index, file] of files.entries()) {
    abort(signal);
    const row = {index,path:file,name:path.basename(file),bytes:null,sha256:null,status:'unreadable',reason:'',matches:[]};
    let handle, stream;
    try {
      const before = await fs.lstat(file);
      abort(signal);
      row.bytes = before.size;
      if (before.isSymbolicLink()) {row.reason='symbolic-link';results.push(row);continue;}
      if (!before.isFile()) {row.reason='not-regular-file';results.push(row);continue;}
      // O_NOFOLLOW 在支持的平台防止检查后切换成链接；fstat 再核对打开的对象。
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || !same(before, opened)) {
        row.status='changed-during-read';row.reason='changed-before-open';results.push(row);continue;
      }
      const hash = createHash('sha256');
      let bytes = 0;
      stream = handle.createReadStream({autoClose:false,highWaterMark:256 * 1024,signal});
      for await (const chunk of stream) {abort(signal);hash.update(chunk);bytes += chunk.length;}
      abort(signal);
      const after = await handle.stat(), current = await fs.lstat(file);
      if (bytes !== before.size || !same(before, after) || current.isSymbolicLink() || !same(after, current)) {
        row.status='changed-during-read';row.reason='size-time-or-location-changed';results.push(row);continue;
      }
      row.bytes=bytes;row.sha256=hash.digest('hex');
      const exact=hashes.get(`${bytes}:${row.sha256}`) || [];
      const different=(names.get(row.name) || []).filter(item => item.bytes !== bytes || item.sha256 !== row.sha256);
      row.status=exact.length ? 'exact-duplicate' : different.length ? 'same-name-different-content' : 'new';
      row.matches=[...exact.map(item=>({...item,match:'content'})),...different.map(item=>({...item,match:'name'}))];
      const ref={source:'batch',index,name:row.name,sha256:row.sha256,bytes};
      add(hashes,`${bytes}:${row.sha256}`,ref);add(names,row.name,ref);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw Object.assign(new Error('预检已取消'),{name:'AbortError',code:'ABORT_ERR'});
      row.reason=error.code || 'read-failed';
    } finally {
      stream?.destroy();
      await handle?.close();
    }
    results.push(row);
  }
  abort(signal);
  return results;
}
