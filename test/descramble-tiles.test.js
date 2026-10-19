// patched(12): tile-copy descramble must be bit-identical to the reference
// descrambleRgba, and the v2 entry (tiles + stage traces) must match v1.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  descrambleRgba,
  descrambleRgbaTiles,
  descrambleImageBytes,
  descrambleImageBytesV2,
  encodePngRgba,
} from "../vendor/upstream-src/lib/descramble.js";

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

function randomRgba(w, h, seed) {
  const out = new Uint8ClampedArray(w * h * 4);
  const rnd = mulberry32(seed);
  for (let i = 0; i < out.length; i++) out[i] = (rnd() * 256) | 0;
  return out;
}

const PKS = [0, 1, -1, 204531, 53552, 244362, 2147483647];
const SIZES = [
  [8, 8],
  [16, 24],
  [64, 64],
  [128, 96],
  [256, 256],
  [512, 256],
];

for (const [w, h] of SIZES) {
  test(`tiles match reference ${w}x${h} (all pks)`, () => {
    for (const pk of PKS) {
      const src = randomRgba(w, h, (w * 7919) ^ (h * 104729) ^ (pk | 0));
      assert.deepEqual(
        descrambleRgbaTiles(src, w, h, pk, true),
        descrambleRgba(src, w, h, pk, true)
      );
    }
  });
}

test("tiles decline non-8-multiple sizes and uY=false", () => {
  const src = randomRgba(65, 70, 7);
  assert.equal(descrambleRgbaTiles(src, 65, 70, 123, true), null);
  assert.equal(descrambleRgbaTiles(src, 64, 64, 123, false), null);
});

test("tiles match on a 4-byte-offset view (u32 path)", () => {
  const w = 64;
  const h = 64;
  const buf = new Uint8ClampedArray(w * h * 4 + 4);
  const src = buf.subarray(4);
  const rnd = mulberry32(99);
  for (let i = 0; i < src.length; i++) src[i] = (rnd() * 256) | 0;
  assert.deepEqual(
    descrambleRgbaTiles(src, w, h, 186511, true),
    descrambleRgba(src, w, h, 186511, true)
  );
});

test("tiles match on a 2-byte-offset view (byte fallback)", () => {
  const w = 64;
  const h = 64;
  const buf = new Uint8ClampedArray(w * h * 4 + 2);
  const src = buf.subarray(2);
  const rnd = mulberry32(1234);
  for (let i = 0; i < src.length; i++) src[i] = (rnd() * 256) | 0;
  assert.deepEqual(
    descrambleRgbaTiles(src, w, h, 53552, true),
    descrambleRgba(src, w, h, 53552, true)
  );
});

test("v2 entry matches v1 bytes and reports stage traces", async () => {
  const w = 64;
  const h = 64;
  const pk = 193477;
  const png = await encodePngRgba(randomRgba(w, h, 4242), w, h);
  const logs = [];
  const a = await descrambleImageBytes(png, pk, null);
  const b = await descrambleImageBytesV2(png, pk, (m) => logs.push(m));
  assert.deepEqual(b, a);
  assert.ok(logs.some((m) => m.includes("stages: path=png-js")));
  assert.ok(logs.some((m) => m.includes("tiles")));
});
