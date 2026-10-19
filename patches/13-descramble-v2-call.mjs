// v0.1.6: route the texture worker through the traced/tiled descramble entry.
export default {
  file: "vendor/upstream-src/lib/sf-api.js",
  replacements: [
    {
      id: "v2-call",
      old: [
        '            const dec = await descrambleImageBytes(bytes, pk, onProgress);',
      ].join("\n"),
      new: [
        '            const dec = await descrambleImageBytesV2(bytes, pk, onProgress); // patched(12)',
      ].join("\n"),
    },
  ],
};
