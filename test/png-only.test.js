// Patches 09/10: PNG-only helpers. PNG passes through untouched, garbage /
// undecodable input keeps the original (failure fallback), filenames are
// normalized to .png. (Real JPEG->PNG transcoding needs browser decoders,
// so it is verified by userscript retest, not here.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodePngRgba,
  ensurePngBytes,
  pngFileName,
} from "../vendor/upstream-src/lib/descramble.js";

test("ensurePngBytes passes PNG through by reference", async () => {
  const png = await encodePngRgba(new Uint8ClampedArray([9, 8, 7, 255]), 1, 1);
  const out = await ensurePngBytes(png);
  assert.equal(out.converted, false);
  assert.equal(out.error, undefined);
  assert.ok(out.bytes === png);
});

test("ensurePngBytes keeps garbage on decode failure", async () => {
  const bad = new Uint8Array([1, 2, 3, 4, 5]);
  const out = await ensurePngBytes(bad);
  assert.equal(out.converted, false);
  assert.ok(out.bytes === bad);
  assert.match(String(out.error), /cannot decode/);
});

test("ensurePngBytes keeps GIF/JPEG when no decoder exists (Node)", async () => {
  const gif = new Uint8Array([
    71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 255, 255, 255, 0, 0, 0, 33,
    249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
  ]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  for (const input of [gif, jpg]) {
    const out = await ensurePngBytes(input);
    assert.equal(out.converted, false);
    assert.ok(out.bytes === input);
    assert.match(String(out.error), /cannot decode/);
  }
});

test("pngFileName normalizes image extensions to .png", () => {
  assert.equal(pngFileName("a.jpg"), "a.png");
  assert.equal(pngFileName("photo.JPEG"), "photo.png");
  assert.equal(pngFileName("x.webp"), "x.png");
  assert.equal(pngFileName("y.gif"), "y.png");
  assert.equal(pngFileName("z.png"), "z.png");
  assert.equal(pngFileName("A.B.JPG"), "A.B.png");
  assert.equal(pngFileName("noext"), "noext.png");
});
