/**
 * CPU port of Sketchfab's texture-protection fragment shader (pv=1).
 *
 * Textures API gives `pk` per image. Viewer sets
 *   uO = -(pk * 64 % (w * h)),  uY = true
 * On Bruce Body_D 2048 this matches the official PNG exactly (MAD = 0).
 */

function idiv(a, b) {
  if (!b) return 0;
  return a * b >= 0 ? Math.trunc(a / b) : -Math.trunc(Math.abs(a) / Math.abs(b));
}

function modI(i, u) {
  return i - idiv(i, u) * u;
}

function minI(a, b) {
  return a < b ? a : b;
}

function maxI(a, b) {
  return a < b ? b : a;
}

function f3(y, t, f) {
  const x = minI(y, t);
  const n = maxI(y, t);
  if (f < x) return Math.trunc((f * (f + 1)) / 2);
  if (f < n) return Math.trunc((x * (x + 1)) / 2) + x * (f - x);
  const r = f - n;
  return (
    Math.trunc((x * (x + 1)) / 2) +
    x * (n - x) +
    (x - 1) * r -
    Math.trunc(((r - 1) * r) / 2)
  );
}

function i3(y, t, xx, xy) {
  const r = minI(y, t);
  const n = maxI(y, t);
  const v = xx + xy;
  const h = modI(v, 2) === 0;
  if (v < r) {
    return h ? f3(y, t, v) + v - xy : f3(y, t, v) + xy;
  }
  if (v < n) {
    let s = t - xy - 1;
    if (y < t) s = r - (y - xx);
    return h ? f3(y, t, v) + s : f3(y, t, v) + r - s - 1;
  }
  const s = t - xy - 1;
  const e = r + n - v - 1;
  return h ? f3(y, t, v) + s : f3(y, t, v) + e - s - 1;
}

function u3(y, t, x) {
  const v = minI(y, t);
  const r = maxI(y, t);
  if (x < Math.trunc((v * (v + 1)) / 2)) {
    const n = Math.trunc((-1 + 1e-6 + Math.sqrt(8 * x + 1)) / 2);
    const h = x - f3(y, t, n);
    const s = modI(n, 2) === 0;
    return s ? [h, n - h] : [n - h, h];
  }
  if (x < Math.trunc((v * (v + 1)) / 2) + v * (r - v)) {
    x = x - Math.trunc((v * (v + 1)) / 2);
    const n = v + Math.trunc(x / v);
    const s = modI(x, v);
    const h = modI(n, 2) === 0;
    const g = n - v + s + 1;
    const e = v - s - 1;
    const S = n - s;
    const T = s;
    if (y > t) return h ? [g, e] : [S, T];
    return h ? [T, S] : [e, g];
  }
  // GLSL: s = (-1 + int(sqrt(float(8*n+1)))) / 2
  let n =
    Math.trunc((v * (v - 1)) / 2) -
    (x - (Math.trunc((v * (v + 1)) / 2) + v * (r - v))) -
    1;
  const s = Math.trunc((-1 + Math.trunc(Math.sqrt(8 * n + 1))) / 2);
  n = r + v - s - 2;
  let h = x - f3(y, t, n);
  const g = modI(n, 2) === 0;
  const e = v + r - n - 1;
  if (g) h = e - h - 1;
  const S = n + h - y + 1;
  return [n - S, S];
}

function fVec(vx, vy, uSx, uSy) {
  const y = Math.trunc(uSx / 8);
  const t = Math.trunc(uSy / 8);
  const x = i3(y, t, Math.trunc(vx / 8), Math.trunc(vy / 8));
  const n = modI(x, 4);
  vx = modI(vx, 8);
  vy = modI(vy, 8);
  let rx = vx;
  let ry = vy;
  if (n === 1) rx = 7 - vx;
  if (n === 2) {
    rx = vy;
    ry = vx;
  }
  if (n === 3) {
    rx = 7 - vy;
    ry = vx;
  }
  return x * 64 + rx + ry * 8;
}

function i1(i, uSx, uSy) {
  const v = uSx * uSy;
  if (i < 0) i += v;
  i = modI(i, v);
  const y = Math.trunc(uSx / 8);
  const n = Math.trunc(uSy / 8);
  const h = Math.trunc(i / 64);
  const r = i - h * 64;
  const s = Math.trunc(r / 8);
  const S = r - s * 8;
  const e = modI(h, 4);
  const g = u3(y, n, h);
  let Tx = g[0] * 8;
  let Ty = g[1] * 8;
  if (e === 0) {
    Tx += S;
    Ty += s;
  }
  if (e === 1) {
    Tx += 7 - S;
    Ty += s;
  }
  if (e === 2) {
    Tx += s;
    Ty += S;
  }
  if (e === 3) {
    Tx += s;
    Ty += 7 - S;
  }
  return [Tx, Ty];
}

function tFn(yx, yy, off, uSx, uSy) {
  const v = uSx * uSy;
  let n = fVec(yx, yy, uSx, uSy) + off;
  if (n > v) n -= v;
  if (n < 0) n += v;
  if (n > v) return -1;
  if (n < 0) return -2;
  return n;
}

/** Viewer uniform: uO = -(pk * 64 % (w * h)) */
export function offsetFromPk(pk, w, h) {
  const area = w * h;
  if (!area) return 0;
  let rem = (Number(pk) * 64) % area;
  if (rem < 0) rem += area;
  return -rem;
}

/**
 * Descramble RGBA pixels into a new buffer.
 * @param {Uint8ClampedArray|Uint8Array} src RGBA, top-left origin
 * @param {number} w
 * @param {number} h
 * @param {number} pk protection key from textures API
 * @param {boolean} [uY=true] match viewer default
 */
export function descrambleRgba(src, w, h, pk, uY = true) {
  const out = new Uint8ClampedArray(w * h * 4);
  const offset = offsetFromPk(pk, w, h);
  for (let y = 0; y < h; y++) {
    const yy = uY ? h - y - 1 : y;
    for (let x = 0; x < w; x++) {
      const n = tFn(x, yy, offset, w, h);
      const di = (y * w + x) * 4;
      if (n >= 0) {
        const srcXY = i1(n, w, h);
        const sx = srcXY[0];
        const sy = srcXY[1];
        if (sx >= 0 && sy >= 0 && sx < w && sy < h) {
          const si = (sy * w + sx) * 4;
          out[di] = src[si];
          out[di + 1] = src[si + 1];
          out[di + 2] = src[si + 2];
          out[di + 3] = src[si + 3];
          continue;
        }
      }
      // Leftover edge on non-8 sizes: keep transparent, never error-red.
      out[di] = 0;
      out[di + 1] = 0;
      out[di + 2] = 0;
      out[di + 3] = 0;
    }
  }
  return out;
}

/**
 * Fast descramble: identical output to descrambleRgba, ~100x faster.
 * patched(06). See test/descramble-fast.test.js (differential test).
 */
export function descrambleRgbaFast(src, w, h, pk, uY = true) {
  const out = new Uint8ClampedArray(w * h * 4);
  const offset = offsetFromPk(pk, w, h);
  const v = w * h;
  const yT = Math.trunc(w / 8);
  const tT = Math.trunc(h / 8);
  const memoSize = Math.ceil(v / 64) + 1;
  const memoHit = new Uint8Array(memoSize);
  // Plain arrays on purpose: u3() returns NaN off-domain (partial edge
  // tiles) and NaN must round-trip exactly to stay transparent;
  // Int32Array would coerce NaN to 0 and copy wrong pixels.
  const memoGx = new Array(memoSize);
  const memoGy = new Array(memoSize);
  for (let y = 0; y < h; y++) {
    const yy = uY ? h - y - 1 : y;
    const tty = Math.trunc(yy / 8);
    const pyBase = yy - tty * 8;
    for (let tx = 0; tx * 8 < w; tx++) {
      const tileX = i3(yT, tT, tx, tty);
      const n4 = modI(tileX, 4);
      const x0 = tx * 8;
      const x1 = x0 + 8 < w ? x0 + 8 : w;
      for (let x = x0; x < x1; x++) {
        const px8 = x - x0;
        let rx = px8;
        let ry = pyBase;
        if (n4 === 1) rx = 7 - px8;
        if (n4 === 2) {
          rx = pyBase;
          ry = px8;
        }
        if (n4 === 3) {
          rx = 7 - pyBase;
          ry = px8;
        }
        let n = tileX * 64 + rx + ry * 8 + offset;
        if (n > v) n -= v;
        if (n < 0) n += v;
        const di = (y * w + x) * 4;
        if (n > v || n < 0) {
          out[di] = 0;
          out[di + 1] = 0;
          out[di + 2] = 0;
          out[di + 3] = 0;
          continue;
        }
        let i = n;
        if (i < 0) i += v;
        i = modI(i, v);
        const hh = Math.trunc(i / 64);
        const r = i - hh * 64;
        const s = Math.trunc(r / 8);
        const S = r - s * 8;
        const e = modI(hh, 4);
        let gx;
        let gy;
        if (hh >= 0 && hh < memoSize && memoHit[hh]) {
          gx = memoGx[hh];
          gy = memoGy[hh];
        } else {
          const g = u3(yT, tT, hh);
          gx = g[0];
          gy = g[1];
          if (hh >= 0 && hh < memoSize) {
            memoHit[hh] = 1;
            memoGx[hh] = gx;
            memoGy[hh] = gy;
          }
        }
        let Tx = gx * 8;
        let Ty = gy * 8;
        if (e === 0) {
          Tx += S;
          Ty += s;
        }
        if (e === 1) {
          Tx += 7 - S;
          Ty += s;
        }
        if (e === 2) {
          Tx += s;
          Ty += S;
        }
        if (e === 3) {
          Tx += s;
          Ty += 7 - S;
        }
        if (Tx >= 0 && Ty >= 0 && Tx < w && Ty < h) {
          const si = (Ty * w + Tx) * 4;
          out[di] = src[si];
          out[di + 1] = src[si + 1];
          out[di + 2] = src[si + 2];
          out[di + 3] = src[si + 3];
        } else {
          out[di] = 0;
          out[di + 1] = 0;
          out[di + 2] = 0;
          out[di + 3] = 0;
        }
      }
    }
  }
  return out; // end descrambleRgbaFast (06)
}

function asU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

function copyBuf(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

function isJpeg(bytes) {
  return bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function u32be(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function putU32be(b, o, v) {
  b[o] = (v >>> 24) & 255;
  b[o + 1] = (v >>> 16) & 255;
  b[o + 2] = (v >>> 8) & 255;
  b[o + 3] = v & 255;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8, start, len) {
  let c = 0xffffffff;
  const end = start + len;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateZlib(src) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("no DecompressionStream");
  }
  const ds = new DecompressionStream("deflate");
  const ab = await new Response(new Blob([copyBuf(src)]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(ab);
}

async function deflateZlib(src) {
  if (typeof CompressionStream !== "function") {
    throw new Error("no CompressionStream");
  }
  const cs = new CompressionStream("deflate");
  const ab = await new Response(new Blob([copyBuf(src)]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(ab);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, w, h, bpp) {
  // patched(08): same PNG unfiltering, minus per-row allocs, per-byte
  // type dispatch and the paeth() call (body inlined). Bit-identical.
  const stride = w * bpp;
  const out = new Uint8Array(h * stride);
  let src = 0;
  for (let y = 0; y < h; y++) {
    const type = raw[src++];
    if (src + stride > raw.length) throw new Error("png row overflow");
    const dst = y * stride;
    if (type === 0) {
      out.set(raw.subarray(src, src + stride), dst);
    } else if (type === 1) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? out[dst + i - bpp] : 0;
        out[dst + i] = (raw[src + i] + a) & 255;
      }
    } else if (type === 2) {
      if (y === 0) {
        out.set(raw.subarray(src, src + stride), dst);
      } else {
        const up = dst - stride;
        for (let i = 0; i < stride; i++) {
          out[dst + i] = (raw[src + i] + out[up + i]) & 255;
        }
      }
    } else if (type === 3) {
      const up = y === 0 ? -1 : dst - stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? out[dst + i - bpp] : 0;
        const b = up >= 0 ? out[up + i] : 0;
        out[dst + i] = (raw[src + i] + ((a + b) >> 1)) & 255;
      }
    } else if (type === 4) {
      const up = y === 0 ? -1 : dst - stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? out[dst + i - bpp] : 0;
        const b = up >= 0 ? out[up + i] : 0;
        const c = i >= bpp && up >= 0 ? out[up + i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        out[dst + i] = (raw[src + i] + pr) & 255;
      }
    } else {
      throw new Error("png filter " + type);
    }
    src += stride;
  }
  return out;
}

function toRgba(px, w, h, colorType, bitDepth, palette, trns) {
  if (bitDepth !== 8) throw new Error("png bitDepth " + bitDepth);
  const n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  if (colorType === 6) {
    rgba.set(px.subarray(0, n * 4));
    return rgba;
  }
  if (colorType === 2) {
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      const o = i * 4;
      rgba[o] = px[p];
      rgba[o + 1] = px[p + 1];
      rgba[o + 2] = px[p + 2];
      rgba[o + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 0) {
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const g = px[i];
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 4) {
    for (let i = 0, p = 0; i < n; i++, p += 2) {
      const o = i * 4;
      const g = px[p];
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = px[p + 1];
    }
    return rgba;
  }
  if (colorType === 3 && palette) {
    for (let i = 0; i < n; i++) {
      const idx = px[i] * 3;
      const o = i * 4;
      rgba[o] = palette[idx];
      rgba[o + 1] = palette[idx + 1];
      rgba[o + 2] = palette[idx + 2];
      rgba[o + 3] = trns && px[i] < trns.length ? trns[px[i]] : 255;
    }
    return rgba;
  }
  throw new Error("png colorType " + colorType);
}

// patched(09): PNG-only helpers (userscript).
export async function ensurePngBytes(bytes) {
  const u8 = asU8(bytes);
  if (isPng(u8)) return { bytes: u8, converted: false };
  try {
    const { rgba, width, height } = await decodeToRgba(u8);
    const png = await encodePngRgba(rgba, width, height);
    return { bytes: png, converted: true };
  } catch (e) {
    return { bytes: u8, converted: false, error: (e && e.message) || String(e) };
  }
}

export function pngFileName(base) {
  const s = String(base || "texture");
  const m = s.match(/^(.*)\.(jpe?g|webp|gif)$/i);
  if (m) return m[1] + ".png";
  if (/\.[a-z0-9]{1,5}$/i.test(s)) return s;
  return s + ".png";
}
// end png-only helpers (09).

export async function decodePngRgba(bytes) {
  const b = asU8(bytes);
  if (!isPng(b)) throw new Error("not a PNG");
  let o = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idats = [];
  while (o + 12 <= b.length) {
    const len = u32be(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const data = b.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      w = u32be(data, 0);
      h = u32be(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") {
      break;
    }
    o += 12 + len;
  }
  if (!w || !h) throw new Error("png missing IHDR");
  if (interlace) throw new Error("png interlaced");
  let idatLen = 0;
  for (const c of idats) idatLen += c.length;
  const idat = new Uint8Array(idatLen);
  let p = 0;
  for (const c of idats) {
    idat.set(c, p);
    p += c.length;
  }
  const bpp =
    colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const sfxT1 = sfxNowMs(); const raw = await inflateZlib(idat); sfxTrace12.inflate = sfxNowMs() - sfxT1;
  const sfxT2 = sfxNowMs(); const px = unfilter(raw, w, h, bpp); sfxTrace12.unfilter = sfxNowMs() - sfxT2;
  const sfxT3 = sfxNowMs();
  const sfxRgba = toRgba(px, w, h, colorType, bitDepth, palette, trns);
  sfxTrace12.toRgba = sfxNowMs() - sfxT3;
  sfxTrace12.path = "png-js";
  return { rgba: sfxRgba, width: w, height: h };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  putU32be(out, 0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  putU32be(out, 8 + data.length, crc32(out, 4, 4 + data.length));
  return out;
}

export async function encodePngRgba(rgba, w, h) {
  const stride = w * 4;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  putU32be(ihdr, 0, w);
  putU32be(ihdr, 4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = await deflateZlib(raw);
  const sig = new Uint8Array(PNG_SIG);
  const cIHDR = chunk("IHDR", ihdr);
  const cIDAT = chunk("IDAT", idat);
  const cIEND = chunk("IEND", new Uint8Array(0));
  const out = new Uint8Array(sig.length + cIHDR.length + cIDAT.length + cIEND.length);
  let o = 0;
  out.set(sig, o);
  o += sig.length;
  out.set(cIHDR, o);
  o += cIHDR.length;
  out.set(cIDAT, o);
  o += cIDAT.length;
  out.set(cIEND, o);
  return out;
}

// patched(12): tile-copy descramble + stage traces.
// The per-pixel loop in descrambleRgbaFast does ~10 ops per pixel to build the
// source index (modI/Math.trunc per pixel). Both transform stages are 8x8 tile
// maps, so with w,h multiples of 8 (=> area and offsetFromPk are multiples of
// 64) one destination tile always reads from exactly one source tile: the whole
// 8x8 block is copied through one precomputed offset table. Bit-identical (see
// test/descramble-tiles.test.js); falls back to the per-pixel path otherwise.
const sfxTrace12 = {
  path: "",
  inflate: 0,
  unfilter: 0,
  toRgba: 0,
  mapAlloc: 0,
  mapCopy: 0,
};

function sfxBuildTileTables(w) {
  const tabs = [];
  for (let n4 = 0; n4 < 4; n4++) {
    const per = [];
    for (let e = 0; e < 4; e++) {
      const t = new Int32Array(64);
      for (let dv = 0; dv < 8; dv++) {
        const py = 7 - dv;
        for (let du = 0; du < 8; du++) {
          let rx;
          let ry;
          if (n4 === 0) {
            rx = du;
            ry = py;
          } else if (n4 === 1) {
            rx = 7 - du;
            ry = py;
          } else if (n4 === 2) {
            rx = py;
            ry = du;
          } else {
            rx = 7 - py;
            ry = du;
          }
          let dx;
          let dy;
          if (e === 0) {
            dx = rx;
            dy = ry;
          } else if (e === 1) {
            dx = 7 - rx;
            dy = ry;
          } else if (e === 2) {
            dx = ry;
            dy = rx;
          } else {
            dx = ry;
            dy = 7 - rx;
          }
          t[(dv << 3) | du] = dy * w + dx;
        }
      }
      per.push(t);
    }
    tabs.push(per);
  }
  return tabs;
}

export function descrambleRgbaTiles(src, w, h, pk, uY = true) {
  if (uY !== true) return null;
  if ((w & 7) !== 0 || (h & 7) !== 0 || w < 8 || h < 8) return null;
  const tAlloc = sfxNowMs();
  const out = new Uint8ClampedArray(w * h * 4);
  const s = asU8(src);
  const v = w * h;
  const yT = Math.trunc(w / 8);
  const tT = Math.trunc(h / 8);
  const offset = offsetFromPk(pk, w, h);
  const tabs = sfxBuildTileTables(w);
  const memoSize = Math.ceil(v / 64) + 1;
  const memoHit = new Uint8Array(memoSize);
  const memoGx = new Array(memoSize);
  const memoGy = new Array(memoSize);
  let srcU32 = null;
  if ((s.byteOffset & 3) === 0) {
    try {
      srcU32 = new Uint32Array(s.buffer, s.byteOffset, v);
    } catch (e) {
      srcU32 = null;
    }
  }
  const outU32 = new Uint32Array(out.buffer, 0, v);
  sfxTrace12.mapAlloc = sfxNowMs() - tAlloc;
  const tCopy = sfxNowMs();
  for (let blk = 0; blk < tT; blk++) {
    const y0 = blk * 8;
    const tty = tT - 1 - blk;
    for (let tx = 0; tx < yT; tx++) {
      const tileX = i3(yT, tT, tx, tty);
      let n = tileX * 64 + offset;
      if (n < 0) n += v;
      const hh = Math.trunc(n / 64);
      let gx;
      let gy;
      if (memoHit[hh]) {
        gx = memoGx[hh];
        gy = memoGy[hh];
      } else {
        const g = u3(yT, tT, hh);
        gx = g[0];
        gy = g[1];
        memoHit[hh] = 1;
        memoGx[hh] = gx;
        memoGy[hh] = gy;
      }
      const n4 = modI(tileX, 4);
      const e = modI(hh, 4);
      if (!(gx >= 0 && gy >= 0 && gx * 8 + 8 <= w && gy * 8 + 8 <= h)) {
        for (let dv = 0; dv < 8; dv++) {
          const o = ((y0 + dv) * w + tx * 8) << 2;
          out.fill(0, o, o + 32);
        }
        continue;
      }
      const srcBase = gy * 8 * w + gx * 8;
      const D = tabs[n4][e];
      if (srcU32) {
        for (let dv = 0; dv < 8; dv++) {
          const dOff = (y0 + dv) * w + tx * 8;
          const p = dv << 3;
          for (let du = 0; du < 8; du++) {
            outU32[dOff + du] = srcU32[srcBase + D[p | du]];
          }
        }
      } else {
        for (let dv = 0; dv < 8; dv++) {
          const dOff = ((y0 + dv) * w + tx * 8) << 2;
          const p = dv << 3;
          for (let du = 0; du < 8; du++) {
            const so = (srcBase + D[p | du]) << 2;
            const o = dOff + (du << 2);
            out[o] = s[so];
            out[o + 1] = s[so + 1];
            out[o + 2] = s[so + 2];
            out[o + 3] = s[so + 3];
          }
        }
      }
    }
  }
  sfxTrace12.mapCopy = sfxNowMs() - tCopy;
  return out;
}

export async function descrambleImageBytesV2(bytes, pk, onProgress) {
  const tAll0 = sfxNowMs();
  if (bytes == null || pk == null || pk === "") {
    throw new Error("missing pk or bytes");
  }
  const key = Number(pk);
  if (!Number.isFinite(key)) throw new Error("bad pk " + pk);
  sfxTrace12.path = "native";
  sfxTrace12.inflate = 0;
  sfxTrace12.unfilter = 0;
  sfxTrace12.toRgba = 0;
  const tDec0 = sfxNowMs();
  const { rgba, width, height } = await decodeToRgba(bytes);
  const tDec = sfxNowMs() - tDec0;
  if (width < 64 || height < 64) {
    throw new Error("too small " + width + "x" + height);
  }
  if (onProgress) onProgress(`  descramble ${width}x${height} pk=${key}`);
  // patched(12): one bulk copy into our own realm. A getImageData() result (or
  // any cross-realm view) costs 10-100x per element in the hot loop; the copy
  // is a single native memcpy, so every later access is local.
  const local = new Uint8ClampedArray(rgba.length);
  local.set(rgba);
  sfxTrace12.mapAlloc = 0;
  sfxTrace12.mapCopy = 0;
  const tiled = descrambleRgbaTiles(local, width, height, key, true);
  const out = tiled || descrambleRgbaFast(local, width, height, key, true);
  if (!tiled && onProgress) {
    onProgress(`  tiles: per-pixel fallback (${width}x${height})`);
  }
  const tEnc0 = sfxNowMs();
  const png = await encodePngRgba(out, width, height);
  const tEnc = sfxNowMs() - tEnc0;
  const tAll = sfxNowMs() - tAll0;
  const tMap = tAll - tDec - tEnc;
  const fs = (ms) => (ms / 1000).toFixed(1);
  if (onProgress) {
    onProgress(
      `  descramble ${width}x${height} pk=${key} dec=${fs(tDec)}s map=${fs(tMap)}s enc=${fs(tEnc)}s`
    );
    onProgress(
      `  stages: path=${sfxTrace12.path} dec[inflate=${fs(sfxTrace12.inflate)} unfilter=${fs(sfxTrace12.unfilter)} toRgba=${fs(sfxTrace12.toRgba)}] map[alloc=${fs(sfxTrace12.mapAlloc)} copy=${fs(sfxTrace12.mapCopy)}] ${tiled ? "tiles" : "perpixel"}`
    );
  }
  return png;
}
// end patched(12)

function guessMime(bytes) {
  if (isPng(bytes)) return "image/png";
  if (isJpeg(bytes)) return "image/jpeg";
  return "application/octet-stream";
}

function bytesToBlob(bytes, mime) {
  const u8 = asU8(bytes);
  return new Blob([copyBuf(u8)], { type: mime || guessMime(u8) });
}

async function decodeViaImageDecoder(bytes) {
  if (typeof ImageDecoder !== "function") return null;
  const u8 = asU8(bytes);
  const mime = guessMime(u8);
  if (mime === "application/octet-stream") return null;
  let dec = null;
  let image = null;
  try {
    // ImageDecoder.data must be ArrayBuffer / view / stream — NOT a Blob.
    dec = new ImageDecoder({ data: copyBuf(u8), type: mime });
    const result = await dec.decode();
    image = result && result.image;
    if (!image) return null;
    const width = image.displayWidth || image.codedWidth;
    const height = image.displayHeight || image.codedHeight;
    if (typeof image.allocationSize === "function") {
      const n = image.allocationSize({ format: "RGBA" });
      const rgba = new Uint8ClampedArray(n);
      await image.copyTo(rgba, { format: "RGBA" });
      return { rgba, width, height };
    }
  } catch (_) {
    return null;
  } finally {
    try {
      if (image) image.close();
    } catch (_) {}
    try {
      if (dec) dec.close();
    } catch (_) {}
  }
  return null;
}

async function decodeViaBitmap(bytes) {
  if (typeof createImageBitmap !== "function") return null;
  if (typeof OffscreenCanvas === "undefined") return null;
  let bmp = null;
  try {
    const u8 = asU8(bytes);
    bmp = await createImageBitmap(bytesToBlob(u8, guessMime(u8)));
    const width = bmp.width;
    const height = bmp.height;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, width, height);
    return { rgba: img.data, width, height };
  } catch (_) {
    return null;
  } finally {
    try {
      if (bmp) bmp.close();
    } catch (_) {}
  }
}

async function decodeToRgba(bytes) {
  sfxTrace12.path = "native";
  const u8 = asU8(bytes);
  if (isPng(u8)) {
    try {
      return await decodePngRgba(u8);
    } catch (_) {}
  }
  const viaDec = await decodeViaImageDecoder(u8);
  if (viaDec) return viaDec;
  const viaBmp = await decodeViaBitmap(u8);
  if (viaBmp) return viaBmp;
  throw new Error("cannot decode " + guessMime(u8));
}

/**
 * If `pk` is set, descramble a PNG/JPEG blob to PNG bytes.
 */
function sfxNowMs() {
  return typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export async function descrambleImageBytes(bytes, pk, onProgress) {
  const tAll0 = sfxNowMs(); // patched(07)
  if (bytes == null || pk == null || pk === "") {
    throw new Error("missing pk or bytes");
  }
  const key = Number(pk);
  if (!Number.isFinite(key)) throw new Error("bad pk " + pk);
  const tDec0 = sfxNowMs();
  const { rgba, width, height } = await decodeToRgba(bytes);
  const tDec = sfxNowMs() - tDec0;
  if (width < 64 || height < 64) {
    throw new Error("too small " + width + "x" + height);
  }
  // Viewer still descrambles maps that are not multiples of 8 (hair 400x401).
  // The shader floors to 8px tiles; leftover edge pixels may be wrong.
  if (onProgress) onProgress(`  descramble ${width}x${height} pk=${key}`);
  const out = descrambleRgbaFast(rgba, width, height, key, true); // patched(06)
  const tEnc0 = sfxNowMs();
  const png = await encodePngRgba(out, width, height);
  const tEnc = sfxNowMs() - tEnc0;
  const tAll = sfxNowMs() - tAll0;
  // map derived: no awaits run outside dec/enc, exact up to log noise.
  const tMap = tAll - tDec - tEnc;
  if (onProgress) onProgress(`  descramble ${width}x${height} pk=${key} dec=${(tDec / 1000).toFixed(1)}s map=${(tMap / 1000).toFixed(1)}s enc=${(tEnc / 1000).toFixed(1)}s`);
  return png;
}
