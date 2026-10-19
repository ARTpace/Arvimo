// Network layer for the userscript build.
//
// Page-context fetch() is subject to CORS; model pages pull bytes from
// media/static subdomains, so a GM_xmlhttpRequest fallback is installed when
// the native request fails at the network level. HTTP error statuses are NOT
// retried (they are real answers, not CORS blocks).

function toPlainHeaders(headers) {
  if (!headers) return {};
  if (typeof headers === "object" && typeof headers.entries === "function") {
    try {
      return Object.fromEntries(headers.entries());
    } catch {
      return {};
    }
  }
  return { ...headers };
}

function gmGet(url, headers) {
  const details = {
    method: "GET",
    url,
    headers,
    responseType: "arraybuffer",
    timeout: 120000,
  };
  // Tampermonkey / Violentmonkey callback style.
  if (typeof GM_xmlhttpRequest === "function") {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          ...details,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) resolve(res);
            else reject(new Error(`HTTP ${res.status} for ${url}`));
          },
          onerror: () => reject(new Error(`Network request failed for ${url}`)),
          ontimeout: () => reject(new Error(`Request timeout for ${url}`)),
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  // Greasemonkey 4+ promise style.
  if (typeof GM === "object" && GM && typeof GM.xmlHttpRequest === "function") {
    return Promise.resolve()
      .then(() => GM.xmlHttpRequest(details))
      .then((res) => {
        if (res && res.status >= 200 && res.status < 300) return res;
        throw new Error(`HTTP ${res && res.status} for ${url}`);
      });
  }
  return Promise.reject(new Error("no GM xhr available"));
}

function gmResponse(res) {
  const buf =
    res.response instanceof ArrayBuffer ? res.response : new ArrayBuffer(0);
  const bytes = new Uint8Array(buf);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    url: res.finalUrl || "",
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => buf.slice(0),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
}

export function canUseGM() {
  if (typeof GM_xmlhttpRequest === "function") return true;
  try {
    return (
      typeof GM === "object" && GM !== null && typeof GM.xmlHttpRequest === "function"
    );
  } catch {
    return false;
  }
}

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_IDLE_MS = 30000;
const DEFAULT_RETRY_MS = 800;

async function fetchWithTimeout(nativeFetch, input, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await nativeFetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function promiseTimeout(promise, ms) {
  let timer = null;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("idle-timeout");
      e.name = "IdleTimeoutError";
      reject(e);
    }, ms);
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

// Re-read the body with a per-chunk idle deadline so a stalled connection
// fails fast while slow-but-moving downloads survive. Returns an equivalent
// Response (or the original when there is no stream to guard, e.g. tests).
async function fetchBodyWithIdleTimeout(resp, idleMs) {
  if (!resp || !resp.body || typeof resp.body.getReader !== "function") return resp;
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let read;
    try {
      read = await promiseTimeout(reader.read(), idleMs);
    } catch (e) {
      try {
        await reader.cancel();
      } catch {}
      const err = new Error(`网络停滞（${Math.round(idleMs / 1000)}s 无数据）`);
      err.name = "StallError";
      throw err;
    }
    if (read.done) break;
    chunks.push(read.value);
    total += read.value.length;
  }
  const body = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    body.set(c, o);
    o += c.length;
  }
  if (resp.status === 204 || resp.status === 304) {
    return new Response(null, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }
  return new Response(body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

export function installFetchFallback(opts = {}) {
  const timeoutMs =
    Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const idleMs = Number(opts.idleMs) > 0 ? Number(opts.idleMs) : DEFAULT_IDLE_MS;
  const retryMs =
    Number(opts.retryMs) >= 0 ? Number(opts.retryMs) : DEFAULT_RETRY_MS;
  if (globalThis.__sfxFetchPatched) return;
  globalThis.__sfxFetchPatched = true;
  globalThis.__sfxFetchTimeoutMs = timeoutMs;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const attempt = (input, init) =>
    fetchWithTimeout(nativeFetch, input, init, timeoutMs).then((resp) =>
      fetchBodyWithIdleTimeout(resp, idleMs)
    );
  globalThis.fetch = async (input, init = {}) => {
    let url = "";
    try {
      url = String((input && input.url) || input);
    } catch {
      url = String(input);
    }
    let err = null;
    for (let a = 0; a < 2; a++) {
      try {
        return await attempt(input, init);
      } catch (e) {
        err = e;
        if (a === 0 && retryMs > 0) await new Promise((r) => setTimeout(r, retryMs));
      }
    }
    if (!canUseGM()) {
      if (err && err.name === "AbortError") {
        throw new Error(`网络超时（${Math.round(timeoutMs / 1000)}s）: ${url}`);
      }
      throw err;
    }
    const headers = toPlainHeaders(init.headers);
    if (!headers.Referer && /sketchfab\.com/i.test(url)) {
      headers.Referer = "https://sketchfab.com/";
    }
    try {
      return gmResponse(await gmGet(url, headers));
    } catch (e2) {
      throw new Error(`网络失败（含GM通道重试）: ${url} :: ${e2.message || e2}`);
    }
  };
}
