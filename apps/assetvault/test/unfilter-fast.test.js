// Patch 08: fast unfilter must match the PNG spec exactly.
// Hand-computed vectors (ground truth by arithmetic) + randomized
// differential test against an independent test-local reference,
// all exercised through the real decodePngRgba (chunk parsing included).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePngRgba } from "../vendor/upstream-src/lib/descramble.js";

// --- minimal PNG writer (test-only) ---
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32bytes(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function be32(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function pngChunk(type, data) {
  const head = [...type].map((c) => c.charCodeAt(0));
  const body = [...head, ...data];
  return [...be32(data.length), ...body, ...be32(crc32bytes(body))];
}
function buildPng(w, h, colorType, filtered) {
  const ihdr = [...be32(w), ...be32(h), 8, colorType, 0, 0, 0];
  const idat = [...deflateSync(Buffer.from(filtered))];
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...pngChunk("IHDR", ihdr),
    ...pngChunk("IDAT", idat),
    ...pngChunk("IEND", []),
  ]);
}

// --- independent reference (PNG spec, deliberately different structure) ---
function paethRef(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
function unfilterRef(filtered, w, h, bpp) {
  const stride = w * bpp;
  const out = new Uint8Array(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = filtered[p++];
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[y * stride + i - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + i] : 0;
      const upLeft = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      const fv = filtered[p++];
      let r;
      if (f === 0) r = fv;
      else if (f === 1) r = fv + left;
      else if (f === 2) r = fv + up;
      else if (f === 3) r = fv + ((left + up) >> 1);
      else if (f === 4) r = fv + paethRef(left, up, upLeft);
      else throw new Error("ref filter " + f);
      out[y * stride + i] = r & 255;
    }
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function expectRgba(w, h, colorType, filtered, expected) {
  const png = buildPng(w, h, colorType, filtered);
  const got = await decodePngRgba(png);
  assert.equal(got.width, w);
  assert.equal(got.height, h);
  assert.deepEqual(got.rgba, new Uint8ClampedArray(expected));
}

// Hand vector A: filter 0 RGBA passthrough.
test("unfilter hand vector A (None, RGBA)", async () => {
  await expectRgba(
    2, 2, 6,
    [0, 10, 20, 30, 40, 50, 60, 70, 80, 0, 90, 100, 110, 120, 130, 140, 150, 160],
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]
  );
});

// Hand vector B: filter 1 Sub on RGB; byte8 wraps (250+35=285 -> 29).
test("unfilter hand vector B (Sub, RGB)", async () => {
  await expectRgba(
    3, 1, 2,
    [1, 10, 20, 30, 5, 5, 5, 200, 1, 250],
    [10, 20, 30, 255, 15, 25, 35, 255, 215, 26, 29, 255]
  );
});

// Hand vector C: filter 2 Up on gray; 250+50=300 -> 44.
test("unfilter hand vector C (Up, gray)", async () => {
  await expectRgba(
    2, 2, 0,
    [2, 100, 50, 2, 10, 250],
    [100, 100, 100, 255, 50, 50, 50, 255, 110, 110, 110, 255, 44, 44, 44, 255]
  );
});

// Hand vector D: filter 4 Paeth on 2x2 RGBA (hand-traced, incl. pb-win row).
test("unfilter hand vector D (Paeth, RGBA)", async () => {
  await expectRgba(
    2, 2, 6,
    [4, 10, 20, 30, 40, 1, 2, 3, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6],
    [10, 20, 30, 40, 11, 22, 33, 44, 15, 25, 35, 45, 21, 31, 41, 51]
  );
});

// Hand vector E: filter 3 Average on RGBA.
test("unfilter hand vector E (Average, RGBA)", async () => {
  await expectRgba(2, 1, 6, [3, 8, 8, 8, 8, 4, 4, 4, 4], [8, 8, 8, 8, 8, 8, 8, 8]);
});

// toRgba sanity for non-RGBA color types (filter 0 isolates conversion).
test("unfilter sanity: gray/alpha/RGB filter-0 conversion", async () => {
  await expectRgba(2, 1, 4, [0, 10, 200, 30, 40], [10, 10, 10, 200, 30, 30, 30, 40]);
  await expectRgba(1, 1, 2, [0, 7, 8, 9], [7, 8, 9, 255]);
  await expectRgba(1, 1, 0, [0, 128], [128, 128, 128, 255]);
});

test("unfilter rejects bad filter type", async () => {
  const png = buildPng(2, 1, 6, [7, 1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(() => decodePngRgba(png), /png filter 7/);
});

test("unfilter rejects truncated rows", async () => {
  const png = buildPng(2, 1, 6, [0, 1, 2, 3]);
  await assert.rejects(() => decodePngRgba(png), /png row overflow/);
});

// Randomized differential: vendor unfilter vs independent reference.
// colorType 6 keeps toRgba on its bulk path so only unfilter is compared.
async function checkRandom(w, h, pattern, seed) {
  const stride = w * 4;
  const rnd = mulberry32(seed);
  const filtered = [];
  for (let y = 0; y < h; y++) {
    const f = pattern === "mixed" ? (rnd() * 5) | 0 : Number(pattern);
    filtered.push(f);
    for (let i = 0; i < stride; i++) filtered.push((rnd() * 256) | 0);
  }
  const png = buildPng(w, h, 6, filtered);
  const got = await decodePngRgba(png);
  const want = unfilterRef(filtered, w, h, 4);
  assert.deepEqual(got.rgba, new Uint8ClampedArray(want));
}

for (const [w, h] of [[1, 1], [5, 3], [16, 16], [65, 33]]) {
  test(`unfilter random differential ${w}x${h} (all filters, mixed)`, async () => {
    for (const pattern of ["0", "1", "2", "3", "4", "mixed"]) {
      for (const seed of [1, 2]) {
        await checkRandom(w, h, pattern, seed * 1000 + w * 131 + h);
      }
    }
  });
}

test("unfilter random differential 256x256 mixed", async () => {
  await checkRandom(256, 256, "mixed", 42);
});
