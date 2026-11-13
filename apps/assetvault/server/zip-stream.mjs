// 把资产包目录实时打包成 ZIP 直接推给浏览器（不落临时文件）。
//
// 为什么不用 archiver / adm-zip：这两个都要么带一堆依赖、要么把内容全读进内存。
// 素材包常见 65–320MB（PSD 包），全内存打包会把服务进程顶爆，所以这里手写一个
// 只做「存储（store）」的最小 writer：
//   - 图片 / PSD / ZIP 内部本来就已经压缩过，deflate 再压一遍几乎不减小，还白烧 CPU；
//   - store 模式只需要搬字节，单线程也能跑满磁盘带宽。
//
// 代价是 CRC32 得在写 local header 之前算出来（标准要求），所以每个文件读两遍：
// 第一遍算 crc + 统计总长（顺便能给出 Content-Length，浏览器才有下载进度条），
// 第二遍边读边写。本地 SSD 上 320MB 的双读约 1–2 秒，换掉一个依赖是划算的。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';

const CHUNK = 1 << 20;
const FLAG_UTF8 = 0x0800;
const LIMIT_4G = 0xffffffff - 64 * 1024 * 1024; // 留余量：超过就别硬撑，ZIP64 这里不实现

/** Windows 上有中文、空格、括号的素材目录一大把，一律走 UTF-8 名（flag 0x800）。 */
function dosStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function localHeader(name, size, crc, stamp) {
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // 需要 2.0 版本解压
  head.writeUInt16LE(FLAG_UTF8, 6);
  head.writeUInt16LE(0, 8); // 0 = store
  head.writeUInt16LE(stamp.time, 10);
  head.writeUInt16LE(stamp.date, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(size, 18);
  head.writeUInt32LE(size, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, nameBuf]);
}

function centralHeader(name, size, crc, stamp, offset) {
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(FLAG_UTF8, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(stamp.time, 12);
  head.writeUInt16LE(stamp.date, 14);
  head.writeUInt32LE(crc, 16);
  head.writeUInt32LE(size, 20);
  head.writeUInt32LE(size, 24);
  head.writeUInt16LE(nameBuf.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk start
  head.writeUInt16LE(0, 36); // internal attr
  head.writeUInt32LE(0, 38); // external attr
  head.writeUInt32LE(offset, 42);
  return Buffer.concat([head, nameBuf]);
}

function endOfCentral(count, cdSize, cdOffset) {
  const head = Buffer.alloc(22);
  head.writeUInt32LE(0x06054b50, 0);
  head.writeUInt16LE(0, 4);
  head.writeUInt16LE(0, 6);
  head.writeUInt16LE(count, 8);
  head.writeUInt16LE(count, 10);
  head.writeUInt32LE(cdSize, 12);
  head.writeUInt32LE(cdOffset, 16);
  head.writeUInt16LE(0, 20);
  return head;
}

async function crcFile(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: CHUNK })) {
    crc = zlib.crc32(chunk, crc);
  }
  return crc >>> 0;
}

/** 递归收集文件。跳过点开头的目录（.assetvault / .git），其它一律带上，info.json 也一起打进去。 */
export async function collectPackageFiles(dir, prefix = '', out = [], depth = 0) {
  if (depth > 24) return out;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      await collectPackageFiles(abs, rel, out, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue; // 符号链接等不跟进，避免打包到目录外面去
    if (entry.name.startsWith('.')) continue;
    out.push({ abs, rel });
  }
  return out;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {{dir:string, name:string}} opts
 */
export async function streamFolderZip(res, { dir, name }) {
  const files = await collectPackageFiles(dir);
  if (!files.length) throw Error('这个素材包里没有可以打包的文件');

  // 第一遍：算 crc、拿大小、算出总长度（顺带把读不了的文件剔掉，不让它变成半个坏包）。
  const prepared = [];
  let total = 22;
  for (const file of files) {
    try {
      const stat = await fsp.stat(file.abs);
      if (!stat.isFile()) continue;
      const crc = await crcFile(file.abs);
      const nameBuf = Buffer.byteLength(file.rel, 'utf8');
      prepared.push({ ...file, size: stat.size, crc, mtime: stat.mtime, stamp: dosStamp(stat.mtime) });
      total += 30 + nameBuf + stat.size + 46 + nameBuf;
    } catch {
      // 单个文件读不了（被独占、权限不足）就跳过：宁可少一个文件，也不要发一个 CRC 错误的包。
    }
  }
  if (!prepared.length) throw Error('这个素材包里的文件都读不了（可能被占用或没有权限）');
  if (total > LIMIT_4G) throw Error('素材包超过 4GB，压缩包放不下，建议直接拷目录');

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': total,
    'Content-Disposition': `attachment; filename="asset.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
    // 打包结果随手就变（加一张图就不同），不让中间层缓存。
    'Cache-Control': 'no-store',
  });

  let offset = 0;
  const central = [];
  for (const file of prepared) {
    if (res.destroyed || res.writableEnded) return; // 访客点了取消，别继续读盘
    const head = localHeader(file.rel, file.size, file.crc, file.stamp);
    if (!res.write(head)) await once(res, 'drain');
    offset += head.length;
    for await (const chunk of fs.createReadStream(file.abs, { highWaterMark: CHUNK })) {
      if (res.destroyed || res.writableEnded) return;
      if (!res.write(chunk)) await once(res, 'drain');
      offset += chunk.length;
    }
    central.push(centralHeader(file.rel, file.size, file.crc, file.stamp, offset - file.size - head.length));
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const block of central) {
    if (!res.write(block)) await once(res, 'drain');
    cdSize += block.length;
    offset += block.length;
  }
  res.end(endOfCentral(central.length, cdSize, cdStart));
  return { count: central.length, bytes: offset };
}
