// Diagnostics: time decode/map/encode inside descrambleImageBytes and log a
// one-line breakdown per texture. No behavior change (same return values).
// map is derived as total-dec-enc (no awaits run outside dec/enc, so this is
// exact even when textures interleave) to avoid touching patch 06's line:
// later patches must preserve earlier patches' new-text verbatim, or the
// earlier patch errors on re-run (see scripts/apply-patches.mjs).
export default {
  file: "vendor/upstream-src/lib/descramble.js",
  replacements: [
    {
      id: "now-helper",
      old: [
        " */",
        "export async function descrambleImageBytes(bytes, pk, onProgress) {",
      ].join("\n"),
      new: [
        " */",
        "function sfxNowMs() {",
        '  return typeof performance === "object" && typeof performance.now === "function"',
        "    ? performance.now()",
        "    : Date.now();",
        "}",
        "",
        "export async function descrambleImageBytes(bytes, pk, onProgress) {",
      ].join("\n"),
    },
    {
      id: "time-decode",
      old: [
        "  const { rgba, width, height } = await decodeToRgba(bytes);",
        "  if (width < 64 || height < 64) {",
      ].join("\n"),
      new: [
        "  const tDec0 = sfxNowMs();",
        "  const { rgba, width, height } = await decodeToRgba(bytes);",
        "  const tDec = sfxNowMs() - tDec0;",
        "  if (width < 64 || height < 64) {",
      ].join("\n"),
    },
    {
      id: "time-total",
      old: [
        "export async function descrambleImageBytes(bytes, pk, onProgress) {",
        '  if (bytes == null || pk == null || pk === "") {',
      ].join("\n"),
      new: [
        "export async function descrambleImageBytes(bytes, pk, onProgress) {",
        "  const tAll0 = sfxNowMs(); // patched(07)",
        '  if (bytes == null || pk == null || pk === "") {',
      ].join("\n"),
    },
    {
      id: "time-encode",
      old: ["  return encodePngRgba(out, width, height);"].join("\n"),
      new: [
        "  const tEnc0 = sfxNowMs();",
        "  const png = await encodePngRgba(out, width, height);",
        "  const tEnc = sfxNowMs() - tEnc0;",
        "  const tAll = sfxNowMs() - tAll0;",
        "  // map derived: no awaits run outside dec/enc, exact up to log noise.",
        "  const tMap = tAll - tDec - tEnc;",
        "  if (onProgress) onProgress(`  descramble ${width}x${height} pk=${key} dec=${(tDec / 1000).toFixed(1)}s map=${(tMap / 1000).toFixed(1)}s enc=${(tEnc / 1000).toFixed(1)}s`);",
        "  return png;",
      ].join("\n"),
    },
  ],
};
