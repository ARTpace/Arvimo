// One ZIP entry per name, whatever produced the texture list.
//
// The external-gltf alias loop copies list entries into the archive by
// basename; two entries that share a basename would ship two same-named ZIP
// entries (strict verifiers reject, extractors silently overwrite). Skip an
// alias whose target name is already written.
export default {
  file: "vendor/upstream-src/lib/pipeline.js",
  replacements: [
    {
      id: "alias-unique-names",
      old: [
        "        if (wantTextures) {",
        "          for (const alias of gltfExternal.textureAliases || []) {",
        "            files.push({ name: alias.to, data: alias.data });",
        "            written.add(alias.to);",
        "          }",
        "        }",
      ].join("\n"),
      new: [
        "        if (wantTextures) {",
        "          for (const alias of gltfExternal.textureAliases || []) {",
        "            // patched(16): one ZIP entry per name, whatever produced the",
        "            // texture list — a duplicate here makes strict verifiers reject",
        "            // the archive and extractors silently overwrite entries.",
        "            if (written.has(alias.to)) continue;",
        "            files.push({ name: alias.to, data: alias.data });",
        "            written.add(alias.to);",
        "          }",
        "        }",
      ].join("\n"),
    },
  ],
};
