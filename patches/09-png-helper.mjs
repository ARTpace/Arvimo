// PNG-only helpers (userscript): passthrough for PNG bytes, decode->encode
// for anything else, original kept on failure. Inserted before
// decodePngRgba; trailing comment breaker keeps the patch idempotent
// (inserted text must not recreate its own anchor).
export default {
  file: "vendor/upstream-src/lib/descramble.js",
  replacements: [
    {
      id: "png-helpers",
      old: ["}", "", "export async function decodePngRgba(bytes) {"].join("\n"),
      new: [
        "}",
        "",
        "// patched(09): PNG-only helpers (userscript).",
        "export async function ensurePngBytes(bytes) {",
        "  const u8 = asU8(bytes);",
        "  if (isPng(u8)) return { bytes: u8, converted: false };",
        "  try {",
        "    const { rgba, width, height } = await decodeToRgba(u8);",
        "    const png = await encodePngRgba(rgba, width, height);",
        "    return { bytes: png, converted: true };",
        "  } catch (e) {",
        "    return { bytes: u8, converted: false, error: (e && e.message) || String(e) };",
        "  }",
        "}",
        "",
        "export function pngFileName(base) {",
        '  const s = String(base || "texture");',
        "  const m = s.match(/^(.*)\\.(jpe?g|webp|gif)$/i);",
        '  if (m) return m[1] + ".png";',
        "  if (/\\.[a-z0-9]{1,5}$/i.test(s)) return s;",
        '  return s + ".png";',
        "}",
        "// end png-only helpers (09).",
        "",
        "export async function decodePngRgba(bytes) {",
      ].join("\n"),
    },
  ],
};
