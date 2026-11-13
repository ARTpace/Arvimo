// Download scope: "model" ships the model and its textures only.
//
// The "full" pack archives Sketchfab's raw pipeline artifacts
// (file.osgjs + model_file.bin) and an external model.gltf/model.bin copy of
// the very geometry the GLB already carries. Both are large and useless for
// normal use. "model" keeps just the GLB plus textures/**, while "glb"
// (unchanged) keeps only the GLB itself.
export default {
  file: "vendor/upstream-src/lib/pipeline.js",
  replacements: [
    {
      id: "prefs-knows-model-mode",
      old: ['      packMode = prefs.packMode === "glb" ? "glb" : "full";'].join("\n"),
      new: [
        '      // patched(17): "model" = the model and its textures, nothing else.',
        "      packMode =",
        '        prefs.packMode === "glb" || prefs.packMode === "model"',
        "          ? prefs.packMode",
        '          : "full";',
      ].join("\n"),
    },
    {
      id: "options-accept-model-mode",
      old: [
        '    if (options.packMode === "glb" || options.packMode === "full") {',
        "      packMode = options.packMode;",
        "    }",
      ].join("\n"),
      new: [
        "    if (",
        '      options.packMode === "glb" ||',
        '      options.packMode === "full" ||',
        '      options.packMode === "model" // patched(17)',
        "    ) {",
        "      packMode = options.packMode;",
        "    }",
      ].join("\n"),
    },
    {
      id: "skip-raw-artifacts-for-model-mode",
      old: ['    if (packMode !== "glb") {'].join("\n"),
      new: [
        '    // patched(17): "model" skips both the raw osgjs scene and the external',
        "    // gltf/bin copy — its texture maps are collected just below.",
        '    if (packMode !== "glb" && packMode !== "model") {',
      ].join("\n"),
    },
    {
      id: "collect-model-mode-textures",
      old: [
        "    const missing = wantTextures",
        "      ? textures.filter(",
      ].join("\n"),
      new: [
        "    // patched(17): the model pack keeps the decoded texture maps and drops",
        "    // everything a viewer would never open — raw osgjs scene, the external",
        "    // gltf duplicate, the guide file. info.json below still records provenance.",
        '    if (packMode === "model") {',
        "      for (const [fname, data] of Object.entries(decrypted)) {",
        "        if (written.has(fname)) continue;",
        "        if (!/^textures\\//i.test(fname)) continue;",
        "        files.push({ name: fname, data });",
        "        written.add(fname);",
        "      }",
        "      step(",
        "        `Pack mode: model + textures (${files.length} file(s), raw osgjs skipped)`",
        "      );",
        "    }",
        "",
        "    const missing =",
        "      wantTextures // patched(17)",
        "      ? textures.filter(",
      ].join("\n"),
    },
    {
      id: "no-guide-file-in-model-mode",
      old: [
        "    files.push({",
        '      name: "README.txt",',
        "      data: new TextEncoder().encode(README_TXT),",
        "    });",
      ].join("\n"),
      new: [
        "    // patched(17): the model pack carries no guide file; info.json below",
        "    // still records provenance for the verifier.",
        '    if (packMode !== "model") {',
        "      files.push({",
        '        name: "README.txt",',
        "        data: new TextEncoder().encode(README_TXT),",
        "      });",
        "    }",
      ].join("\n"),
    },
    {
      id: "format-label-model-mode",
      old: [
        "    const format =",
        '      packMode === "glb"',
        "        ? glb",
        '          ? "glb"',
        '          : "osgjs"',
        "        : glb",
        '          ? "glb+gltf+osgjs"',
        '          : "osgjs";',
      ].join("\n"),
      new: [
        "    const format =",
        '      packMode === "glb"',
        "        ? glb",
        '          ? "glb"',
        '          : "osgjs"',
        '        : packMode === "model" // patched(17)',
        "          ? glb",
        '            ? "glb+textures"',
        '            : "osgjs"',
        "          : glb",
        '            ? "glb+gltf+osgjs"',
        '            : "osgjs";',
      ].join("\n"),
    },
    {
      id: "note-matches-model-mode",
      old: [
        "          note: glb",
        '            ? packMode === "glb"',
        '              ? "Open the .glb. See README.txt."',
        '              : "Open .glb (textures packed inside when enabled) or model.gltf. See README.txt."',
        '            : "GLB conversion failed; use file.osgjs + model_file.bin.",',
      ].join("\n"),
      new: [
        "          // patched(17): describe what this pack actually contains.",
        "          note: glb",
        '            ? packMode === "glb"',
        '              ? "Open the .glb. See README.txt."',
        '              : packMode === "model"',
        '                ? "Open the .glb (textures embedded); textures/ holds the loose maps."',
        '                : "Open .glb (textures packed inside when enabled) or model.gltf. See README.txt."',
        '            : "GLB conversion failed; use file.osgjs + model_file.bin.",',
      ].join("\n"),
    },
  ],
};
