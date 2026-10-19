// Idle-stall guard, chunked reassembly, and GM-object (Greasemonkey) compat.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetchFallback, canUseGM } from "../src/userscript/net.js";

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  delete globalThis.__sfxFetchPatched;
  delete globalThis.__sfxFetchTimeoutMs;
  delete globalThis.GM;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.__sfxFetchPatched;
  delete globalThis.__sfxFetchTimeoutMs;
  delete globalThis.GM;
});

function streamResp(chunks, { hang = false } = {}) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: async () => {
          if (hang) return new Promise(() => {});
          if (i < chunks.length) return { done: false, value: chunks[i++] };
          return { done: true, value: undefined };
        },
        cancel: async () => {},
      }),
    },
  };
}

test("a stalled body fails fast", async () => {
  globalThis.fetch = async () => streamResp([], { hang: true });
  installFetchFallback({ timeoutMs: 500, idleMs: 40, retryMs: 5 });
  await assert.rejects(() => globalThis.fetch("https://example.com/stall"), /停滞/);
});

test("chunked bodies are reassembled into a working Response", async () => {
  const a = new TextEncoder().encode("hello ");
  const b = new TextEncoder().encode("world");
  globalThis.fetch = async () => streamResp([a, b]);
  installFetchFallback({ timeoutMs: 500, idleMs: 500, retryMs: 5 });
  const resp = await globalThis.fetch("https://example.com/chunks");
  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), "hello world");
});

test("GM.xmlHttpRequest object style works as fallback (Greasemonkey)", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const payload = new TextEncoder().encode('{"a":1}');
  globalThis.GM = {
    xmlHttpRequest: async () => ({
      status: 200,
      response: payload.buffer,
      finalUrl: "https://example.com/api",
    }),
  };
  assert.equal(canUseGM(), true);
  installFetchFallback({ timeoutMs: 500, idleMs: 500, retryMs: 5 });
  const resp = await globalThis.fetch("https://example.com/api");
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { a: 1 });
});

test("canUseGM is false without any grant", () => {
  assert.equal(canUseGM(), false);
});
