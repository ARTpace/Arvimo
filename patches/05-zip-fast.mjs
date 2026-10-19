// Speed: optional fast ZIP. Entries at/above a size threshold skip deflate
// (STORE) because compressing big binaries is slow and saves little.
// Controlled by globalThis.__sfxFastZipBytes; 0/undefined = upstream behavior.
export default {
  file: "vendor/upstream-src/lib/zip.js",
  replacements: [
    {
      id: "fast-threshold",
      old: [
        "export async function buildZip(files) {",
        "  const enc = new TextEncoder();",
      ].join("\n"),
      new: [
        "export async function buildZip(files) {",
        '  const fastZipMin = (typeof globalThis !== "undefined" && globalThis.__sfxFastZipBytes | 0) || 0; // patched(05)',
        "  const enc = new TextEncoder();",
      ].join("\n"),
    },
    {
      id: "skip-deflate",
      old: [
        "    let payload = raw;",
        "    let method = 0;",
        "    const compressed = await deflateRaw(raw);",
      ].join("\n"),
      new: [
        "    let payload = raw;",
        "    let method = 0;",
        "    const skipDeflate = fastZipMin > 0 && raw.length >= fastZipMin;",
        "    const compressed = skipDeflate ? null : await deflateRaw(raw);",
      ].join("\n"),
    },
  ],
};
