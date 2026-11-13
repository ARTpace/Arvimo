// MISSING_BLIT honest count: packOrmMaps() adds a freshly packed ORM PNG to
// the texture list with fromOrmPack=true (no fromDescramble/fromCapture), so
// the "still CDN" filter flagged it as an undecodable map. Only real CDN
// leftovers should be reported.
export default {
  file: "vendor/upstream-src/lib/pipeline.js",
  replacements: [
    {
      id: "orm-not-missing",
      old: [
        '      ? textures.filter((t) => !t.fromCapture && !t.fromDescramble)',
      ].join("\n"),
      new: [
        '      ? textures.filter(',
        '          (t) => !t.fromCapture && !t.fromDescramble && !t.fromOrmPack',
        '        ) // patched(11)',
      ].join("\n"),
    },
  ],
};
