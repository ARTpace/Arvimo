# Third-party code

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
