// PSD 预览：把 Photoshop 的合并图像解出来、缩到需要的尺寸、重新编码成 PNG。
//
// 浏览器 `<img>` 不认识 PSD，所以素材包里 40 个 .psd 在缩略图墙上只能是空框。
// 这里只做「预览」这一件事，不碰图层、不碰色彩管理，目标是把合成结果按可靠的方式还原：
//  1. 只读文件尾部的合并图像（composite image data）——图层面板里那堆东西对缩略图毫无用处；
//  2. 支持 PSD 的三种压缩：RAW(0) / RLE(1) / ZIP(2,3)，深度 8/16，灰度 / RGB / CMYK；
//  3. 这里只管「解码 + 缩放 + 编码」，缓存与淘汰在 thumb-cache.mjs 里统一处理。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';

const MAX_BYTES = 256 * 1024 * 1024;

function readAt(fd, length, position) {
  const buf = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const n = fs.readSync(fd, buf, filled, length - filled, position + filled);
    if (!n) break;
    filled += n;
  }
  return filled === length ? buf : buf.subarray(0, filled);
}

/** PackBits（Photoshop 的 RLE）：一行一条，128 是空操作，<128 是字面量段，>128 是重复段。 */
function unpackBits(src, start, end, out) {
  let pos = start, at = 0;
  const limit = out.length;
  while (pos < end && at < limit) {
    const header = src[pos++];
    if (header < 128) {
      const count = header + 1;
      const stop = Math.min(pos + count, end);
      out.set(src.subarray(pos, stop), at);
      at += stop - pos;
      pos = stop;
    } else if (header > 128) {
      const count = 257 - header;
      const value = src[pos++] ?? 0;
      const stop = Math.min(at + count, limit);
      out.fill(value, at, stop);
      at = stop;
    }
  }
  return at;
}

/** ZIP 压缩的通道数据要撤销行内预测（zigzag + 逐字节累加），否则画面是斜着糊的一片。 */
function undoPrediction(buf, rows, columns) {
  for (let row = 0; row < rows; row++) {
    const base = row * columns;
    for (let i = 1; i < columns; i++) {
      buf[base + i] = (buf[base + i] + buf[base + i - 1]) & 0xff;
    }
  }
  return buf;
}

/** 解出一张 8bit 的通道数组（每通道 width*height 字节），后续合成都在 8bit 上做。 */
function decodeChannels({ fd, dataStart, compression, channels, width, height, depth, version }) {
  const bytesPerSample = depth === 16 ? 2 : 1;
  const planeSize = width * height;
  const out = [];
  for (let c = 0; c < channels; c++) out.push(new Uint8Array(planeSize));

  const to8 = (raw, plane, offset) => {
    // 16bit 大端，取高字节即可得到视觉上等价的 8bit 值。
    if (bytesPerSample === 1) plane.set(raw.subarray(offset, offset + planeSize));
    else for (let i = 0; i < planeSize; i++) plane[i] = raw[offset + i * 2];
  };

  if (compression === 0) {
    const planeBytes = planeSize * bytesPerSample;
    if ((dataStart + planeBytes * channels) > MAX_BYTES + dataStart) throw Error('PSD 数据超出预期长度');
    const raw = readAt(fd, planeBytes * channels, dataStart);
    for (let c = 0; c < channels; c++) to8(raw, out[c], c * planeBytes);
    return out;
  }

  if (compression === 1) {
    // 压缩时行首是一张「每行多少字节」表：PSD 用 uint16，PSB 用 uint32。
    const rowCount = channels * height;
    const tableBytes = rowCount * (version === 2 ? 4 : 2);
    const table = readAt(fd, tableBytes, dataStart);
    const counts = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) counts[i] = version === 2 ? table.readUInt32BE(i * 4) : table.readUInt16BE(i * 2);
    const data = readAt(fd, counts.reduce((a, b) => a + b, 0), dataStart + tableBytes);
    let cursor = 0;
    for (let c = 0; c < channels; c++) {
      const plane = out[c];
      for (let row = 0; row < height; row++) {
        const count = counts[c * height + row];
        const end = Math.min(cursor + count, data.length);
        // 16bit 的 RLE 一行是 width*2 字节，解出来后再取高字节降位。
        const line = new Uint8Array(width * bytesPerSample);
        unpackBits(data, cursor, end, line);
        if (bytesPerSample === 1) plane.set(line, row * width);
        else for (let x = 0; x < width; x++) plane[row * width + x] = line[x * 2];
        cursor = end;
      }
    }
    return out;
  }

  if (compression === 2 || compression === 3) {
    const packed = readAt(fd, Math.max(0, fs.fstatSync(fd).size - dataStart), dataStart);
    const raw = zlib.inflateSync(packed);
    const planeBytes = width * height * bytesPerSample;
    for (let c = 0; c < channels; c++) {
      const slice = raw.subarray(c * planeBytes, (c + 1) * planeBytes);
      if (compression === 3 && depth === 8) undoPrediction(slice, height, width);
      to8(slice, out[c], 0);
    }
    return out;
  }

  throw Error(`PSD 用了不认识的压缩方式（${compression}），预览生成不了`);
}

/** 按面积平均缩小：alpha / 蒙版素材缩小后边缘才不会碎成一格一格的。 */
export function downscale(plane, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return plane;
  const out = new Uint8Array(dstW * dstH);
  const scaleX = srcW / dstW, scaleY = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor(y * scaleY), y1 = Math.min(srcH, Math.ceil((y + 1) * scaleY));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * scaleX), x1 = Math.min(srcW, Math.ceil((x + 1) * scaleX));
      let sum = 0, count = 0;
      for (let sy = y0; sy < y1; sy++) {
        const row = sy * srcW;
        for (let sx = x0; sx < x1; sx++) { sum += plane[row + sx]; count++; }
      }
      out[y * dstW + x] = count ? Math.round(sum / count) : 0;
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 极简 PNG 编码：灰度(0) / RGB(2) / RGBA(6)，8bit，自适应选择 filter 0。 */
export function encodePng(width, height, colorType, planes) {
  const channelCount = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const stride = width * channelCount;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    raw[base] = 0;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channelCount; c++) raw[base + 1 + x * channelCount + c] = planes[c][y * width + x];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;            // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 主入口：解码 PSD 合并图像 → 缩到 maxSize → PNG。失败一律抛错，让调用方回 415。 */
export async function psdToPng(file, { maxSize = 1024 } = {}) {
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw Error('不是文件');
  if (stat.size > MAX_BYTES) throw Error('PSD 超过 256MB，前端预览会自动跳过');

  // 缓存不在这里做：统一交给 thumb-cache.mjs（所有缩略图共用一份目录与淘汰策略）。
  return enqueue(() => renderPsd(file, maxSize));
}

/** 转码排队：一个包里几十张 PSD 会同时来请求，串行算完再发，别把事件循环堵死。
 *  缓存命中在上面就直接返回了，不进队列。 */
let pending = Promise.resolve();
function enqueue(task) {
  const run = pending.then(task, task);
  pending = run.then(() => {}, () => {});
  return run;
}

export async function renderPsd(file, maxSize) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = readAt(fd, 26, 0);
    if (head.length < 26 || head.toString('latin1', 0, 4) !== '8BPS') throw Error('不是有效的 PSD 文件');
    const version = head.readUInt16BE(4);
    const channels = head.readUInt16BE(12);
    const height = head.readUInt32BE(14);
    const width = head.readUInt32BE(18);
    const depth = head.readUInt16BE(22);
    const colorMode = head.readUInt16BE(24);   // 1=灰度 3=RGB 4=CMYK
    if (!width || !height) throw Error('PSD 尺寸为 0，无法预览');
    if (width * height > 40_000_000) throw Error('PSD 分辨率过大，暂不生成预览');

    let offset = 26;
    offset += 4 + readAt(fd, 4, offset).readUInt32BE(0);          // 调色板 / 色彩模式数据
    offset += 4 + readAt(fd, 4, offset).readUInt32BE(0);          // 图像资源（缩略图、ICC 等，预览用不到）
    offset += 4 + readAt(fd, 4, offset).readUInt32BE(0);          // 图层与蒙版信息
    const compression = readAt(fd, 2, offset).readUInt16BE(0);
    const dataStart = offset + 2;

    const planes = decodeChannels({ fd, dataStart, compression, channels, width, height, depth, version });

    // 合成成灰度 / RGB / RGBA。CMYK 只是顺手支持，避免遇到印刷稿直接失败。
    let colorType, pixels;
    if (colorMode === 1 || (channels === 1 && colorMode !== 3 && colorMode !== 4)) {
      colorType = 0;
      pixels = [planes[0]];
    } else if (colorMode === 4) {
      colorType = 2;
      const [C, M, Y, K] = planes;
      const r = new Uint8Array(width * height), g = new Uint8Array(width * height), b = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) {
        const k = K ? K[i] : 0;
        r[i] = 255 - Math.min(255, (C?.[i] || 0) + k);
        g[i] = 255 - Math.min(255, (M?.[i] || 0) + k);
        b[i] = 255 - Math.min(255, (Y?.[i] || 0) + k);
      }
      pixels = [r, g, b];
    } else {
      const hasAlpha = channels >= 4 && planes[3] && planes[3].some(v => v !== 255);
      colorType = hasAlpha ? 6 : 2;
      pixels = hasAlpha ? [planes[0], planes[1], planes[2], planes[3]] : [planes[0], planes[1], planes[2]];
    }

    const scale = maxSize === 0 ? 1 : Math.min(1, maxSize / Math.max(width, height));
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));
    const finalPlanes = pixels.map(plane => downscale(plane, width, height, outW, outH));
    return { buffer: encodePng(outW, outH, colorType, finalPlanes), width: outW, height: outH };
  } finally {
    fs.closeSync(fd);
  }
}
