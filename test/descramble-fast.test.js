// Differential test: descrambleRgbaFast must match descrambleRgba bit-for-bit.
// Covers tile interiors, partial edge tiles, uY on/off, pk incl. 0/negative.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  descrambleRgba,
  descrambleRgbaFast,
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

function check(w, h, pk, uY) {
  const seed = (w * 1000033) ^ (h * 1009) ^ (pk | 0);
  const src = randomRgba(w, h, seed >>> 0);
  const expected = descrambleRgba(src, w, h, pk, uY);
  const actual = descrambleRgbaFast(src, w, h, pk, uY);
  assert.deepEqual(actual, expected);
}

const SMALL = [
  [8, 8],
  [7, 9],
  [16, 16],
  [64, 64],
  [65, 70],
];
const PKS = [0, 1, -1, 114988, 193477, 186511, 2147483647, 123456789];

for (const [w, h] of SMALL) {
  test(`fast matches original ${w}x${h} (all pks, uY on/off)`, () => {
    for (const pk of PKS) {
      for (const uY of [true, false]) {
        check(w, h, pk, uY);
      }
    }
  });
}

const BIG = [
  [128, 96, 114988, true],
  [200, 256, 186511, true],
  [300, 300, 193477, true],
  [300, 300, 114988, false],
  [512, 512, 114988, true],
];

for (const [w, h, pk, uY] of BIG) {
  test(`fast matches original ${w}x${h} pk=${pk} uY=${uY}`, () => {
    check(w, h, pk, uY);
  });
}
