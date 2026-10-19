// Regression test for patches/15-unique-baked-texture-names and
// patches/16-unique-zip-entry-names.
//
// Study (UID 9b3f278bacc54f219addd98215008ceb) has three materials sharing
// one albedo basename with different opacity atlases. Every bake was named
// bw_diffuse_alpha.png, so the archive carried three same-named entries and
// verifyArchive() rejected it with "ZIP 条目不安全或不受支持". Offline unit
// test for the name allocator: different bytes under one basename must get
// distinct suffixed names, identical bytes must share one name. Synthetic
// input, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  uniqueBakedTextureName,
  textureBasename,
} from "../vendor/upstream-src/lib/osgjs2gltf.js";

const A = new Uint8Array([1, 2, 3]);
const B = new Uint8Array([4, 5, 6]);
const C = new Uint8Array([7, 8, 9, 10]);
const copyOfA = new Uint8Array([1, 2, 3]);

// Mirrors the occupiedBakedName adapter: a name is taken if the bare or the
// textures/-prefixed index form already holds different bytes.
const index = (files) => (name) =>
  files[name] !== undefined ? files[name] : files["textures/" + name];

test("first bake of a basename keeps the plain name", () => {
  assert.equal(
    uniqueBakedTextureName("bw_diffuse", "_alpha.png", A, index({})),
    "bw_diffuse_alpha.png"
  );
});

test("different bytes under one basename get -2 and -3 suffixes", () => {
  const files = { "bw_diffuse_alpha.png": A };
  assert.equal(
    uniqueBakedTextureName("bw_diffuse", "_alpha.png", B, index(files)),
    "bw_diffuse-2_alpha.png"
  );
  files["bw_diffuse-2_alpha.png"] = B;
  assert.equal(
    uniqueBakedTextureName("bw_diffuse", "_alpha.png", C, index(files)),
    "bw_diffuse-3_alpha.png"
  );
});

test("identical bytes reuse the existing name", () => {
  const files = { "bw_diffuse_alpha.png": A };
  assert.equal(
    uniqueBakedTextureName("bw_diffuse", "_alpha.png", copyOfA, index(files)),
    "bw_diffuse_alpha.png"
  );
});

test("a raw texture already holding the name forces a suffix", () => {
  const files = { "textures/bw_diffuse_tint.png": A };
  assert.equal(
    uniqueBakedTextureName("bw_diffuse", "_tint.png", B, index(files)),
    "bw_diffuse-2_tint.png"
  );
});

test("suffix keeps the _alpha/_tint tail so name-based lookups still match", () => {
  const files = { "bw_diffuse_alpha.png": A };
  const name = uniqueBakedTextureName(
    "bw_diffuse",
    "_alpha.png",
    B,
    index(files)
  );
  assert.match(name, /_alpha\.png$/);
  assert.equal(textureBasename("textures/" + name), name);
});
