// Userscript build replaces vendor lib/decrypt.js loadWasmBytes() with an
// inline WASM blob (no chrome.runtime in a userscript). Wired by the esbuild
// plugin in scripts/build-userscript.mjs; "inline:wasm-b64" only resolves
// during that build.
export {
  decryptBinzBytes,
  outNameFor,
  DEFAULT_STATIC_KEY,
} from "../../../vendor/upstream-src/lib/decrypt.js";
import { WASM_B64 } from "inline:wasm-b64";

let cache = null;

export async function loadWasmBytes() {
  if (cache) return cache;
  const bin = atob(WASM_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  cache = out;
  return out;
}
