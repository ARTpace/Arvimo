// Network fallback: native passthrough + timeout behavior. No GM_* in Node,
// so the GM branch is not covered here (browser-only).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchFallback } from "../src/userscript/net.js";

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  delete globalThis.__sfxFetchPatched;
  delete globalThis.__sfxFetchTimeoutMs;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.__sfxFetchPatched;
  delete globalThis.__sfxFetchTimeoutMs;
});

test("healthy responses pass through untouched", async () => {
  const resp = { ok: true, status: 200 };
  globalThis.fetch = async () => resp;
  installFetchFallback({ timeoutMs: 1000 });
  assert.equal(await globalThis.fetch("https://example.com/x"), resp);
});

test("a hanging request fails fast with a timeout error (no GM in Node)", async () => {
  globalThis.fetch = (_url, init = {}) =>
    new Promise((_res, rej) => {
      const sig = init.signal;
      const abort = () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      };
      if (!sig) return; // hangs forever without a signal
      if (sig.aborted) abort();
      else sig.addEventListener("abort", abort, { once: true });
    });
  installFetchFallback({ timeoutMs: 50, retryMs: 5 });
  await assert.rejects(
    () => globalThis.fetch("https://example.com/slow"),
    /网络超时/
  );
});
