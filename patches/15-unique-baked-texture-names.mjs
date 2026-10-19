// Baked tint/alpha composites must not share one file name.
//
// Study (UID 9b3f278bacc54f219addd98215008ceb) has three materials that bake
// different alpha composites from the same albedo basename. Every bake was
// named bw_diffuse_alpha.png, so textureFiles kept only the last bake's bytes,
// all three materials bound to one image, and the ZIP carried three
// same-named entries — strict verifiers reject that and extractors silently
// overwrite entries. Same bytes still share one name; different bytes get a
// -2, -3... stem suffix that keeps the _alpha/_tint tail intact.
export default {
  file: "vendor/upstream-src/lib/osgjs2gltf.js",
  replacements: [
    {
      id: "unique-baked-name-helper",
      old: [
        "  return out;",
        "}",
        "",
        "/**",
        " * Convert Sketchfab osgjs + bins (+ optional textures) to GLB (+ optional external glTF).",
        " * @param {Map|object|null} viewerMaterials - from parseViewerMaterials(info)",
        " */",
      ].join("\n"),
      new: [
        "  return out;",
        "}",
        "",
        "// patched(15): baked composites (tint / alpha) used to be named after the",
        "// source map's basename only, so several materials baking DIFFERENT bytes",
        "// from the same basename (one albedo + several opacity atlases) all produced",
        "// e.g. bw_diffuse_alpha.png three times: the last bake silently replaced the",
        "// other lookups in textureFiles, every material bound to one image, and",
        "// strict ZIP verifiers rejected the duplicate entries. Same bytes keep",
        "// sharing one name; different bytes get a -2, -3... stem suffix.",
        "export function uniqueBakedTextureName(stem, tail, data, occupied) {",
        "  let base = stem;",
        "  let n = 2;",
        "  for (;;) {",
        "    const name = base + tail;",
        "    const prev = occupied(name);",
        "    if (prev === undefined) return name;",
        "    if (",
        "      prev === data ||",
        "      (prev.length === data.length && prev.every((v, i) => v === data[i]))",
        "    ) {",
        "      return name;",
        "    }",
        "    base = stem + '-' + n++;",
        "  }",
        "}",
        "",
        "/**",
        " * Convert Sketchfab osgjs + bins (+ optional textures) to GLB (+ optional external glTF).",
        " * @param {Map|object|null} viewerMaterials - from parseViewerMaterials(info)",
        " */",
      ].join("\n"),
    },
    {
      id: "occupied-baked-name-adapter",
      old: [
        "  const { global: textureMap, perGeom: perGeomMaps } = buildTextureMaps(",
        "    geometries,",
        "    list,",
        "    textureFiles,",
        "    viewerMaterials",
        "  );",
        "",
        "  // Opacity-only cards (hair dithering with no albedo): tint × opacity alpha.",
      ].join("\n"),
      new: [
        "  const { global: textureMap, perGeom: perGeomMaps } = buildTextureMaps(",
        "    geometries,",
        "    list,",
        "    textureFiles,",
        "    viewerMaterials",
        "  );",
        "  // patched(15): probe both index forms so a baked name never collides with",
        "  // a raw texture or an earlier bake (see uniqueBakedTextureName above).",
        "  const occupiedBakedName = (name) =>",
        "    textureFiles[name] !== undefined",
        "      ? textureFiles[name]",
        "      : textureFiles['textures/' + name];",
        "",
        "  // Opacity-only cards (hair dithering with no albedo): tint × opacity alpha.",
      ].join("\n"),
    },
    {
      id: "tint-name-unique",
      old: [
        "      const bakedName =",
        "        textureBasename(map.alpha).replace(/\\.[^.]+$/, '') + '_tint.png';",
      ].join("\n"),
      new: [
        "      const bakedName = uniqueBakedTextureName(",
        "        textureBasename(map.alpha).replace(/\\.[^.]+$/, ''),",
        "        '_tint.png',",
        "        baked,",
        "        occupiedBakedName",
        "      ); // patched(15)",
      ].join("\n"),
    },
    {
      id: "alpha-name-unique",
      old: [
        "      const bakedName =",
        "        textureBasename(map.albedo).replace(/\\.[^.]+$/, '') + '_alpha.png';",
      ].join("\n"),
      new: [
        "      const bakedName = uniqueBakedTextureName(",
        "        textureBasename(map.albedo).replace(/\\.[^.]+$/, ''),",
        "        '_alpha.png',",
        "        baked.data,",
        "        occupiedBakedName",
        "      ); // patched(15)",
      ].join("\n"),
    },
  ],
};
