// 拖出到外部软件之前的「文件落地」层。
//
// Windows 的 CF_HDROP 只认磁盘上的真实路径，可前端卡片手里只有描述：图站卡是原图 URL，
// 本地素材包卡是 {root, rel}。这里把三种描述统一换成绝对路径，再交给 Rust 的 DoDragDrop：
//   · local  已索引的单个文件 → 交给注入的 resolveLocal（越界 / 未索引一律拒）
//   · remote 图站高清原图     → 抓回字节写进 drag-cache，文件名安全且可复用
// 回源策略（coverLadder / Referer / cookie / 白名单）由调用方注入 fetchRemote，与 /api/image
// 共用同一份实现；本模块不认识任何具体站点，也不复制第二套 CDN 规则。
//
// 为什么必须落盘：HTML5 的 DownloadURL / Blob 只有 Chromium 自家落点认，Photoshop、PureRef、
// Krita、Affinity 这些主要接 CF_HDROP / CF_DIB。给它们真实文件，才等于「从资源管理器拖过去」。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {FORMATS} from '../src/library/format-registry.js';
import {validateUrl} from './public-http.mjs';

/** 原图上限与 /api/image?full=1 同一个数字：缩略图档 8MB 装不下 4K。 */
export const REMOTE_CAP = 64 * 1024 * 1024;
/** 图片代理与拖出共用的 MIME 白名单：缩略图档 / full 原图档。 */
export const IMAGE_MIMES_BASE = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
export const IMAGE_MIMES_FULL = [...IMAGE_MIMES_BASE, 'image/bmp', 'image/tiff', 'image/x-icon'];
export const REMOTE_MIMES = new Set(IMAGE_MIMES_FULL);
/** MIME → 扩展名从格式注册表派生，拖拽层不另写一份清单。 */
const MIME_EXT = new Map();
for (const format of Object.values(FORMATS)) {
  const mime = String(format.mime).split(';')[0].trim();
  if (!MIME_EXT.has(mime)) MIME_EXT.set(mime, format.ext);
}

const DEFAULT_LIMITS = {
  // 与图片包的单包上限（image-bundle 的 IMAGE_MAX=60）对齐：图集要能「一次全给」，
  // 32 张会在 60 张的画板里被截断，用户拿到的就不是全部图片。
  maxItems: 64,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxDirBytes: 512 * 1024 * 1024,
  cap: REMOTE_CAP,
};

/** 图片扩展名从格式注册表派生：与服务端 MIME 白名单、前端的可拖判断同源。 */
const IMAGE_EXTS = new Set(Object.values(FORMATS)
  .filter(format => format.group === 'image' || format.kind === 'image')
  .map(format => `.${format.ext}`));
const isImageFile = name => IMAGE_EXTS.has(path.extname(String(name || '')).toLowerCase());

/**
 * 把「一个文件 / 一层目录」摊平成可以直接交给 CF_HDROP 的文件清单。
 *
 * 图集资产落盘是目录（`images/01-xxx.png` + `info.json`）：把目录本身交给系统，PS / PureRef
 * 都不知道该拿它怎么办；摊成里面每一张图，才等于「从资源管理器多选拖过去」。
 * 单个文件（zip / glb / fbx）原样返回 —— 3D 导出包不该被拆开。
 */
export async function expandDragFiles(target, {maxItems = DEFAULT_LIMITS.maxItems, depth = 3} = {}) {
  const file = String(target || '');
  if (!file) return [];
  let stat;
  try { stat = await fs.stat(file); } catch { return []; }
  if (stat.isFile()) return [file];
  if (!stat.isDirectory() || depth <= 0) return [];
  const found = [];
  const names = await fs.readdir(file).catch(() => []);
  for (const name of [...names].sort()) {
    if (name.startsWith('.')) continue;                       // `.info-live-*.tmp` 之类的中间态
    const child = path.join(file, name);
    let childStat;
    try { childStat = await fs.stat(child); } catch { continue; }
    if (childStat.isDirectory()) {
      // 图片包是 `images/` 一层 + info.json；深层目录也扫，但先收当前层的图，顺序更自然。
      const nested = await expandDragFiles(child, {maxItems: maxItems - found.length, depth: depth - 1});
      found.push(...nested);
    } else if (childStat.isFile() && isImageFile(name)) {
      found.push(child);
    }
    if (found.length >= maxItems) break;
  }
  return found.slice(0, maxItems);
}

/** 拖到 PS 里显示的文件名：去掉非法字符、限长，空了就退回固定词。 */
function safeStem(name) {
  return String(name || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .trim().slice(0, 60) || 'assetvault';
}

/**
 * @param {object} options
 * @param {string} options.dir                         临时拖放目录
 * @param {(url:string, ctx:{signal:AbortSignal}) => Promise<any>} options.fetchRemote 回源（复用 /api/image）
 * @param {(item:object) => Promise<string>} options.resolveLocal  {root,rel} → 绝对路径
 * @param {(item:object) => Promise<string[]>} [options.resolveAsset] {uid} → 该资产落盘后的可拖文件
 *        （路径只能由服务端从自己的任务记录里取；前端拿不到也不该给绝对路径）
 * @param {(host:string) => boolean} options.isAllowedHost         远端域名白名单
 * @param {typeof DEFAULT_LIMITS} [options.limits]
 */
export function createDragStage({dir, fetchRemote, resolveLocal, resolveAsset, isAllowedHost, limits = {}} = {}) {
  const {maxItems, maxAgeMs, maxDirBytes, cap} = {...DEFAULT_LIMITS, ...limits};
  let pruning = null;

  /** 清掉过期的临时图；目录超预算时按最旧优先删。失败只影响缓存，不改主流程。 */
  async function prune() {
    if (pruning) return pruning;
    pruning = (async () => {
      const names = await fs.readdir(dir).catch(() => []);
      const rows = [];
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          const stat = await fs.stat(file);
          if (stat.isFile()) rows.push({file, mtime: stat.mtimeMs, size: stat.size});
        } catch { /* 已经被别的请求删了 */ }
      }
      rows.sort((a, b) => a.mtime - b.mtime);
      let total = rows.reduce((sum, row) => sum + row.size, 0);
      for (const row of rows) {
        if (Date.now() - row.mtime <= maxAgeMs && total <= maxDirBytes) break;
        await fs.unlink(row.file).catch(() => {});
        total -= row.size;
      }
    })().finally(() => { pruning = null; });
    return pruning;
  }

  /** 抓一张高清原图落到 drag-cache，返回绝对路径。同一 URL 已落盘就直接复用。 */
  async function stageRemote(item, signal) {
    const target = validateUrl(item.url);
    if (!/^https?:$/.test(target.protocol)) throw Error('只支持 http/https 图片地址');
    if (!isAllowedHost?.(target.hostname)) throw Error('这个图片域名不在允许清单里');
    const key = createHash('sha1').update(`${item.url}\n${item.name || ''}`).digest('hex').slice(0, 16);
    await fs.mkdir(dir, {recursive: true});
    // 命中缓存就不用再回源：pointerdown 预热和 dragstart 常常会对同一张图发两次请求。
    const cached = (await fs.readdir(dir).catch(() => []))
      .find(name => name.includes(key) && !name.endsWith('.part'));
    if (cached) {
      const hit = path.join(dir, cached);
      try { if ((await fs.stat(hit)).size > 0) return hit; } catch { /* 重新抓 */ }
    }

    const remote = await fetchRemote(target.href, {signal});
    if (!remote || remote.status >= 400) {
      try { remote?.stream?.destroy?.(); } catch { /* 已经断了 */ }
      throw Error('原图取不到，站方可能要求登录');
    }
    const mime = String(remote.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!REMOTE_MIMES.has(mime)) {
      try { remote.stream?.destroy?.(); } catch { /* 已经断了 */ }
      throw Error('这个地址不是可拖出的图片');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of remote.stream) {
      size += chunk.length;
      if (size > cap) {
        try { remote.stream.destroy(); } catch { /* 已经断了 */ }
        throw Error('原图超过大小上限，先下载到本地再拖');
      }
      chunks.push(chunk);
    }
    if (!size) throw Error('原图是空的');
    const file = path.join(dir, `${safeStem(item.name)}-${key}.${MIME_EXT.get(mime) || 'jpg'}`);
    // 先写 .part 再原子改名：拖放开始时绝不能让目标软件读到半张图。
    const part = `${file}.part`;
    await fs.writeFile(part, Buffer.concat(chunks));
    await fs.rename(part, file);
    return file;
  }

  /**
   * 把前端给的一组描述换成真实文件路径。
   * 单个 local 文件失效（被移走 / 改名）只跳过它，别让整包多图集合因此一张都拖不出去。
   */
  async function resolve(items, {signal} = {}) {
    if (!Array.isArray(items)) throw Error('缺少拖放条目');
    if (items.length > maxItems) throw Error(`一次最多拖 ${maxItems} 个文件`);
    const files = [];
    for (const item of items) {
      if (item?.type === 'local') {
        try { files.push(await resolveLocal(item)); } catch { /* 跳过失效文件 */ }
      } else if (item?.type === 'asset') {
        // 资产库卡片：已落盘的图集会展开成里面的每一张图（PS 开多文档、PureRef 收一排），
        // 单个模型文件原样给。查不到任务时由 resolveAsset 抛出可读原因。
        const resolved = await resolveAsset?.(item, {signal});
        if (Array.isArray(resolved)) files.push(...resolved);
      } else if (item?.type === 'remote') {
        files.push(await stageRemote(item, signal));
      } else {
        throw Error('未知的拖放条目类型');
      }
    }
    const unique = [...new Set(files.filter(Boolean))].slice(0, maxItems);
    if (!unique.length) throw Error('没有可拖出的文件，请先下载到本地再试');
    prune().catch(() => {});
    return {files: unique};
  }

  return {resolve, prune};
}
