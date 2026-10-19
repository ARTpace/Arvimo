// Folder output: hand the caller the file list instead of only a ZIP.
//
// The exporter already builds `files` in memory; the ZIP is just one way to
// deliver them. When options.output === "folder" the archive step is skipped
// entirely and the entries are returned as-is, so the worker can write them
// straight to disk. The ZIP path also returns the list (the folder writer and
// the verifier then share one source of truth) plus a byte count so the worker
// can report progress without knowing which mode it is in.
export default {
  file: "vendor/upstream-src/lib/pipeline.js",
  replacements: [
    {
      id: "folder-output-and-file-list",
      old: [
        "    step(`Building ZIP (${files.length} entries)…`);",
        "    const zip = await buildZip(files);",
        "    const zipName = wantTextures",
        "      ? `${name}-${uid.slice(0, 8)}-textures.zip`",
        "      : `${name}-${uid.slice(0, 8)}.zip`;",
        "    step(`ZIP ready: ${zipName} (${zip.length} bytes)`);",
        "    return {",
        "      zip,",
        "      zipName,",
        "      name,",
        "      author,",
        "      fileCount: files.length,",
        "      hasGlb: !!glb,",
        "    };",
      ].join("\n"),
      new: [
        "    const stem = wantTextures",
        "      ? `${name}-${uid.slice(0, 8)}-textures`",
        "      : `${name}-${uid.slice(0, 8)}`;",
        "    // patched(18): folder output skips ZIP entirely — nothing to compress,",
        "    // and the caller writes these entries to disk unchanged.",
        '    if (options.output === "folder") {',
        "      const bytes = files.reduce(",
        "        (n, f) => n + (f.data ? f.data.length : 0),",
        "        0",
        "      );",
        "      step(`Folder output: ${files.length} file(s), ${bytes} bytes (no ZIP)`);",
        "      return {",
        "        zip: null,",
        "        files,",
        "        zipName: stem,",
        "        name,",
        "        author,",
        "        bytes,",
        "        fileCount: files.length,",
        "        hasGlb: !!glb,",
        "      };",
        "    }",
        "    step(`Building ZIP (${files.length} entries)…`);",
        "    const zip = await buildZip(files);",
        "    const zipName = `${stem}.zip`;",
        "    step(`ZIP ready: ${zipName} (${zip.length} bytes)`);",
        "    return {",
        "      zip,",
        "      files, // patched(18): folder writer and verifier share one file list",
        "      zipName,",
        "      name,",
        "      author,",
        "      bytes: zip.length,",
        "      fileCount: files.length,",
        "      hasGlb: !!glb,",
        "    };",
      ].join("\n"),
    },
  ],
};
