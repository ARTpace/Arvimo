// Post-build checks for the userscript bundle. Fails loudly on any miss.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distPath = path.join(root, "dist/sketchfab-exporter.user.js");
const dist = fs.readFileSync(distPath, "utf8");
const fail = (m) => {
  console.error("VERIFY FAIL: " + m);
  process.exit(1);
};

if (!dist.startsWith("// ==UserScript==")) fail("missing userscript header");
for (const token of ["GM_xmlhttpRequest", "@match", "@connect"]) {
  if (!dist.includes(token)) fail("header missing " + token);
}
const m = dist.match(/WASM_B64 = "([A-Za-z0-9+/=]+)"/);
if (!m) fail("WASM_B64 not inlined");
const wasm = Buffer.from(m[1], "base64");
const orig = fs.statSync(
  path.join(root, "vendor/upstream-src/lib/wasm/decrypt.wasm")
).size;
if (wasm.length !== orig) fail(`wasm size ${wasm.length} != ${orig}`);
if (wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
  fail("wasm magic bad");
}
if (dist.includes("chrome.runtime.getURL")) {
  fail("unshimmed chrome.runtime.getURL remains");
}
// esbuild drops plain // comments, so verify the patched CODE, not the marker.
if (!dist.includes("animationCurves = buildAnimationCurves(osgjs, animationBins)")) {
  fail("unconditional animation parsing missing from bundle");
}
if (dist.includes("? buildAnimationCurves(osgjs, animationBins)")) {
  fail("skeleton-gated animation parsing still present in bundle");
}
const vendorDecrypt = fs.readFileSync(
  path.join(root, "vendor/upstream-src/lib/decrypt.js"),
  "utf8"
);
if (!vendorDecrypt.includes("mem.set(input.subarray(off, off + len), iOff)")) {
  fail("decrypt bulk-copy patch (02) not applied to vendor");
}
const vendorPipeline = fs.readFileSync(
  path.join(root, "vendor/upstream-src/lib/pipeline.js"),
  "utf8"
);
if (!vendorPipeline.includes("Downloading mesh files (parallel)")) {
  fail("parallel binz patch (03) not applied to vendor");
}
if (!vendorPipeline.includes("concurrency: 6")) {
  fail("texture concurrency patch (03) not applied to vendor");
}
const vendorSfApi = fs.readFileSync(
  path.join(root, "vendor/upstream-src/lib/sf-api.js"),
  "utf8"
);
if (!vendorSfApi.includes("patched(04)")) {
  fail("parallel animations patch (04) not applied to vendor");
}
const vendorZip = fs.readFileSync(
  path.join(root, "vendor/upstream-src/lib/zip.js"),
  "utf8"
);
if (!vendorZip.includes("__sfxFastZipBytes")) {
  fail("fast zip patch (05) not applied to vendor");
}
const vendorDescramble = fs.readFileSync(
  path.join(root, "vendor/upstream-src/lib/descramble.js"),
  "utf8"
);
if (!vendorDescramble.includes("descrambleRgbaFast")) {
  fail("fast descramble patch (06) not applied to vendor");
}
if (!vendorDescramble.includes("sfxNowMs")) {
  fail("stage timing patch (07) not applied to vendor");
}
if (!vendorDescramble.includes("patched(08)")) {
  fail("fast unfilter patch (08) not applied to vendor");
}
if (!vendorDescramble.includes("ensurePngBytes")) {
  fail("png helper patch (09) not applied to vendor");
}
if (!vendorSfApi.includes("__sfxPngOnly")) {
  fail("png-only patch (10) not applied to vendor");
}
if (!vendorPipeline.includes("patched(11)")) {
  fail("missing-blit fix (11) not applied to vendor");
}
if (!vendorDescramble.includes("descrambleRgbaTiles")) {
  fail("tile fast path (12) not applied to vendor");
}
if (!vendorSfApi.includes("descrambleImageBytesV2")) {
  fail("v2 descramble call (13) not applied to vendor");
}
if (!vendorSfApi.includes("descrambleImageBytesV2")) {
  fail("v2 descramble call (13) not applied to vendor");
}
// Bundle-level tripwires: esbuild keeps an unimported identifier as a global,
// so a call site without its import still built (v0.1.6 shipped a bundle whose
// tile path was dead until this check existed). The literal below only exists
// in descrambleImageBytesV2; the identifier check must stay at zero because a
// correctly imported/renamed symbol never survives minification by name.
if (!dist.includes("per-pixel fallback")) {
  fail("tile descramble path (12) missing from bundle");
}
// A symbol that is both defined and called appears at least twice (this build
// keeps names); a lone occurrence means the call site lost its import and the
// tile path is dead code at runtime.
const v2Refs = dist.split("descrambleImageBytesV2").length - 1;
if (v2Refs === 1) {
  fail("descrambleImageBytesV2 referenced once - import missing in sf-api.js");
}
if (!dist.includes("stages: path=")) {
  fail("stage trace log (12) missing from bundle");
}
const mainSrc = fs.readFileSync(path.join(root, "src/userscript/main.js"), "utf8");
if (!mainSrc.includes("sfxProbe")) {
  fail("js probe (14) missing from main.js");
}
console.log(
  `VERIFY OK: ${(Buffer.byteLength(dist) / 1024).toFixed(1)} KB, ` +
    `wasm ${wasm.length} bytes, no chrome.runtime refs`
);
