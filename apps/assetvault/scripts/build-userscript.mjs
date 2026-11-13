// Bundle src/userscript/main.js into dist/sketchfab-exporter.user.js:
// single IIFE + userscript header + inline decrypt.wasm (base64).
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const wasmPath = path.join(root, "vendor/upstream-src/lib/wasm/decrypt.wasm");
const wasmB64 = fs.readFileSync(wasmPath).toString("base64");
console.log(
  `WASM: ${fs.statSync(wasmPath).size} bytes -> base64 ${wasmB64.length} chars`
);

const header = [
  "// ==UserScript==",
  "// @name         Sketchfab 模型导出 (glTF/GLB)",
  "// @namespace    sketchfab-exporter",
  `// @version      ${pkg.version}`,
  "// @description  导出已获授权的 Sketchfab 模型为 glTF/GLB（含贴图/骨骼/动画）",
  "// @author       sketchfab-exporter",
  "// @match        https://sketchfab.com/3d-models/*",
  "// @match        https://www.sketchfab.com/3d-models/*",
  "// @grant        GM_xmlhttpRequest",
  "// @connect      sketchfab.com",
  "// @connect      www.sketchfab.com",
  "// @connect      media.sketchfab.com",
  "// @connect      static.sketchfab.com",
  "// @run-at       document-idle",
  "// @noframes",
  "// @license      GPL-3.0-only",
  "// ==/UserScript==",
  "",
].join("\n");

const shimPlugin = {
  name: "sfx-shims",
  setup(build) {
    // NOTE: args.path here is the raw specifier ("./decrypt.js"), not the
    // resolved path; match on the vendor importer instead.
    build.onResolve({ filter: /^\.\/decrypt\.js$/ }, (args) => {
      const importer = args.importer || "";
      const fromVendorLib = /upstream-src[\\/]lib[\\/][^\\/]+$/.test(importer);
      if (fromVendorLib && !importer.endsWith("decrypt-inline.js")) {
        return { path: path.join(root, "src/userscript/shims/decrypt-inline.js") };
      }
      return null;
    });
    build.onResolve({ filter: /^inline:wasm-b64$/ }, (args) => ({
      path: args.path,
      namespace: "wasm-inline",
    }));
    build.onLoad({ filter: /.*/, namespace: "wasm-inline" }, () => ({
      contents: `export const WASM_B64 = "${wasmB64}";`,
      loader: "js",
    }));
    build.onResolve({ filter: /^node:zlib$/ }, (args) => ({
      path: args.path,
      namespace: "node-shim",
    }));
    build.onLoad({ filter: /.*/, namespace: "node-shim" }, () => ({
      contents: 'throw new Error("node:zlib unavailable in browser");',
      loader: "js",
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(root, "src/userscript/main.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  minify: false,
  write: false,
  define: { SFX_VERSION: JSON.stringify(pkg.version) },
  plugins: [shimPlugin],
  logLevel: "warning",
});
const out = header + result.outputFiles[0].text;
const distDir = path.join(root, "dist");
fs.mkdirSync(distDir, { recursive: true });
const outPath = path.join(distDir, "sketchfab-exporter.user.js");
fs.writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${Buffer.byteLength(out)} bytes)`);
