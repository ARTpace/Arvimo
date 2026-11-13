# Third-party code

Paths below are relative to the repository root, not this document's directory.

## Upstream: seryi882/sketchfab-downloader-extension

- Source: <https://github.com/seryi882/sketchfab-downloader-extension>
- Pinned commit: `79290fa0cfb4714f4c0d7ba617b0e3b2b1296149` (2026-08-25)
- License: GNU General Public License v3.0 (see `LICENSE`, copied from upstream)
- Location in this repo: `vendor/upstream-src/` (pristine tarball extract)
- Used modules: `lib/pipeline.js`, `lib/sf-api.js`, `lib/osgjs2gltf.js`,
  `lib/skin.js`, `lib/osg-scene.js`, `lib/osg-codec.js`, `lib/orm.js`,
  `lib/descramble.js`, `lib/decrypt.js`, `lib/zip.js`, `lib/save.js`,
  `lib/settings.js`, `lib/devlog.js`, `lib/wasm/decrypt.wasm`, `test/*`

## Our modifications (all outside vendor/)

- `patches/01-no-skeleton-animation.mjs`: animation curves are parsed whenever
  animation data exists, instead of only when a Skeleton is present.
  Regression test: `test/no-skeleton-animation.test.js`.
- `patches/02-decrypt-perf.mjs`: bulk `TypedArray.set()` copies replace
  per-byte loops in WASM decrypt input staging, plus a periodic event-loop
  yield so large decrypts no longer freeze the page.
- `patches/03-pipeline-parallel.mjs`: mesh files download in parallel,
  texture concurrency 3 → 6.
- `patches/04-sfapi-parallel.mjs`: animation clips download in parallel.
- `patches/05-zip-fast.mjs`: entries above `__sfxFastZipBytes` skip deflate.
- `patches/06-descramble-fast.mjs`: tile-hoisted descramble with memoized u3
  (identical output, ~100x faster); original kept for differential tests.
- `patches/07-stage-timing.mjs`: per-stage decode/map/encode timings on the
  descramble log line (diagnostics only, no behavior change).
- `patches/08-unfilter-fast.mjs`: in-place PNG unfilter, inlined paeth, no
  per-byte type dispatch (bit-identical output).
- `patches/09-png-helper.mjs`: ensurePngBytes (PNG passthrough, else
  decode->encode; failure keeps original) + pngFileName (.jpg/.webp/.gif
  become .png).
- `patches/10-png-only.mjs`: fetchTextures normalizes textures to PNG when
  `opts.pngOnly`/`__sfxPngOnly` is set (transcode + rename + re-dedup + logs).
- `patches/11-missing-blit-fix.mjs`: MISSING_BLIT.txt lists only real CDN
  leftovers (ORM-packed maps are not "still CDN").
- `patches/12-descramble-tiles.mjs`: tile-copy descramble fast path
  (bit-identical, see test/descramble-tiles.test.js) + dec/map stage traces.
- `patches/13-descramble-v2-call.mjs`: texture worker calls the traced/tiled
  entry (descrambleImageBytesV2).
- `patches/14-js-probe.mjs`: version + UA + JS speed probe log lines in the
  userscript shell (diagnostics only).
- `src/userscript/*`: Tampermonkey shell (network fallback, inline-WASM shim,
  download panel). No upstream files are hand-edited; patches apply at
  `pretest`/`prebuild` via `scripts/apply-patches.mjs`.

Re-verifying pristine vendor: re-extract the tarball for the pinned commit
into `vendor/upstream-src/` and run `npm run patches && npm test`.

## npm runtime dependencies bundled in the desktop installer

The Tauri/NSIS build copies the runtime closure of `better-sqlite3` into
`sketchfab-exporter-tauri/src-tauri/sidecar-server/node_modules/` so the
desktop sidecar can use the SQLite library kernel (collections, smart
collections, FTS5 search). Only JS files, the prebuilt `.node` addon, package
manifests and license texts are shipped — C++ sources, `deps/` and the
install-time downloader are excluded. Assembly and ABI smoke test:
`sketchfab-exporter-tauri/scripts/copy-sqlite-native.mjs`.

- `better-sqlite3` — MIT — <https://github.com/WiseLibs/better-sqlite3> — v12.11.1
  (`package.json` pins `^12.11.1`). License: `LICENSE`.
- `bindings` — MIT — <https://github.com/TooTallNate/node-bindings> — v1.5.0,
  used by `better-sqlite3/lib/database.js` to locate the addon. License: `LICENSE.md`.
- `file-uri-to-path` — MIT — <https://github.com/TooTallNate/file-uri-to-path> —
  v1.0.0, dependency of `bindings`. License: `LICENSE`.

Each package's license file is copied next to the shipped code inside
`sidecar-server/node_modules/<package>/`. The addon is a N-API binary built for
Windows x64; the installer's bundled Node 22 loads it directly.

## Document rendering libraries (v3.16.3)

Four MIT / permissive libraries are bundled into the standalone lazy-loaded
`/doc-render.js` browser bundle (`src/library/doc-render.js`). They are
`devDependencies`: esbuild inlines them at build time, so no `node_modules`
closure is shipped with the desktop installer. Added as part of the local
asset-library document preview feature (unrelated to RSS).

| Package | Version | License | Upstream | Used for |
|---|---|---|---|---|
| `marked` | 18.1.3 | MIT | <https://github.com/markedjs/marked> | Markdown → HTML |
| `dompurify` | 3.4.17 | MPL-2.0 OR Apache-2.0 | <https://github.com/cure53/DOMPurify> | Sanitizing markdown/HTML output (XSS) |
| `docx-preview` | 0.4.1 | **Apache-2.0** | <https://github.com/VolodymyrBaydalka/docxjs> | `.docx` in-browser rendering |
| `epubjs` | 0.3.93 | BSD-2-Clause | <https://github.com/futurepress/epub.js> | `.epub` reader |

Notes:
- `docx-preview` moved from MIT to Apache-2.0 by v0.4.x — check the installed
  package's own `LICENSE` / `package.json` before quoting its license.
- `dompurify` is dual-licensed; AssetVault takes the **Apache-2.0** option.
  Neither option is AGPL/copyleft-infectious for a bundled browser library.
- `jszip` (GPLv3 OR MIT, MIT option taken), `localforage`, `@xmldom/xmldom`
  and `path-webpack` arrive transitively via `epubjs` / `docx-preview`.
- **LibreOffice** (MPL-2.0) is only invoked as an external `soffice` binary
  via `server/doc-convert.mjs` for `.pptx`/`.xlsx`/`.rtf`/etc → PDF. No
  LibreOffice source is vendored, bundled or linked; the app detects an
  existing installation and guides the user if it is missing. This is the
  same shell-out pattern already used for ffmpeg.

## Adapted from Serpent (MIT)

Serpent is an Electron + React + TypeScript asset library (MIT). Only its
data-layer contracts, format lists and pure functions were adapted into this
project's Node ESM + vanilla JS stack; no Electron, React, renderer component or
Worker TypeScript code was copied.

- Source project: Serpent, `LICENSE` = MIT, `Copyright (c) 2026 Serpent contributors`.
- `server/search-expression.mjs` ← `src/shared/search-expression.ts` (boolean
  search syntax, 91 lines of pure functions; field aliases added for AssetVault).
- `src/library/format-registry.js` ← `src/shared/media-formats.ts`,
  `audio-media.ts`, `text-media.ts`, `src/renderer/format-filter-presets.ts`
  (extension lists + 8 filter groups). Reworked into one table with derived
  indices instead of the upstream parallel arrays and six MIME functions.
- `src/library/format-filter-selection.js` ←
  `src/renderer/dimension-filter-selection.ts`, `src/shared/text-media.ts`
  (comma-token state, Shift accumulation, group tri-state, `text` expansion,
  `unknown` complement, `exclude` inversion).
- `src/library/format-filter.js` follows the interaction model of
  `src/renderer/DimensionFilterBar.tsx` (format section), reimplemented with DOM
  creation instead of React.
- `src/library/color-filter.js` ← `src/shared/color-filter-presets.ts` and
  `src/shared/color-hsl.ts` (10 preset swatches, HSL box matching, ring hue
  distance, similarity windows, custom-color preferences). Ported to pure JS.
- `src/library/asset-probe.js` ← `src/worker/palette-extractor.ts`
  (4096-bin quantised histogram + deterministic weighted k-means, dominant
  representative colour). Runs on 64x64 canvas pixels instead of sharp-decoded
  buffers; no upstream binary/decoder code is used.
- `src/library/numeric-filter.js` ← `src/renderer/filter-presets.ts`
  (orientation thresholds, 5 aspect-ratio presets with 5% tolerance,
  1K/2K/4K long-edge buckets, multi-range OR semantics).
- `src/library/filter-recency.js` ← `src/renderer/tag-filter-recency.ts`
  (most-recently-used tag names, global persistence, self-healing invalid names).
- The filter dock / panels follow the interaction model of
  `src/renderer/DimensionFilterBar.tsx`, `ColorFilterPopover.tsx`,
  `FilterTagPicker.tsx` and `SortModeControl.tsx`, reimplemented as vanilla JS
  DOM modules; no React/TSX component code was copied.

Intentional differences: `hdf` is treated as a known format in AssetVault, so the
`unknown` ("other") predicate does not silently match it. The upstream
`FORMAT_FILTER_VALUES_MAX = 256` cap is kept as `MAX_FORMAT_FILTER_VALUES`.
Colour filtering uses one dominant colour sampled from the cover thumbnail (not
a DB `revision_artifacts` row); resolution buckets therefore describe the cover
pixels unless the platform already supplies a `resolution` field.

MIT License

Copyright (c) 2026 Serpent contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
