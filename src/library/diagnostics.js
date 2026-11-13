// 反馈面板用的环境摘要。
// 只收白名单字段：版本、系统、当前页面 / 平台、最近一次错误、最近失败的请求。
// URL 一律只留 host + path —— query 里可能带素材直链、缓存戳，甚至临时签名，不能进反馈库。

const INSTALL_KEY = 'av:install-id';
const PLATFORM_KEY = 'assetvault-last-platform-v1';
const RECENT_LIMIT = 20;

const recent = [];
let lastError = null;
let hooked = false;
let enginePromise = null;

/** 匿名安装标识：首次调用生成一次，之后一直复用，用来串起同一个用户的多次反馈。 */
export function installId() {
  try {
    let id = localStorage.getItem(INSTALL_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || `${Date.now()}${Math.random().toString(16).slice(2)}`).replace(/-/g, '').slice(0, 24);
      localStorage.setItem(INSTALL_KEY, id);
    }
    return id;
  } catch {
    return 'anonymous';
  }
}

/** 记一条失败请求（4xx / 5xx）。网络层直接抛错时没有状态码，跳过。 */
function pushFailure(status, rawUrl) {
  try {
    const u = new URL(rawUrl, location.href);
    recent.push({ status, host: u.host, path: u.pathname, at: new Date().toISOString() });
    if (recent.length > RECENT_LIMIT) recent.shift();
  } catch {
    /* 非法 URL 不记 */
  }
}

/** 挂一次 fetch 拦截。幂等：重复调用不会套娃。 */
export function hookDiagnostics() {
  if (hooked) return;
  hooked = true;
  const original = window.fetch;
  if (typeof original !== 'function') return;
  window.fetch = function patchedFetch(input, init) {
    const promise = original.call(this, input, init);
    try {
      const raw = typeof input === 'string' ? input : input?.url || '';
      promise.then(
        (res) => { if (res && res.status >= 400) pushFailure(res.status, raw); },
        () => {},
      );
    } catch {
      /* 拦截失败不能影响正常请求 */
    }
    return promise;
  };
}

/** toast 里报的错顺便存一份，反馈时自动带上，用户不用复述。 */
export function rememberError(message) {
  const text = String(message || '').trim();
  if (!text) return;
  lastError = { message: text, at: new Date().toISOString() };
}

export function currentError() {
  return lastError;
}

async function appVersion() {
  try {
    const api = window.__TAURI__;
    if (api?.app?.getVersion) return String(await api.app.getVersion());
  } catch {
    /* 浏览器模式没有这个接口 */
  }
  const text = (document.querySelector('#app-version')?.textContent || '').trim();
  return /^\d/.test(text) ? text : 'web';
}

function engineVersion() {
  if (!enginePromise) {
    enginePromise = fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => String(d?.version || ''))
      .catch(() => '');
  }
  return enginePromise;
}

function osLabel() {
  const ua = navigator.userAgent;
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  let os = platform;
  if (/Windows NT 10\.0/.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT 6\.3/.test(ua)) os = 'Windows 8.1';
  else if (/Mac OS X (\d+[._]\d+)/.test(ua)) os = `macOS ${/Mac OS X (\d+[._]\d+)/.exec(ua)[1].replace('_', '.')}`;
  else if (/Linux/.test(ua)) os = 'Linux';
  const arch = /x86_64|Win64|x64/.test(ua) ? 'x64' : /arm64|aarch64/i.test(ua) ? 'arm64' : '';
  return [os, arch].filter(Boolean).join(' ');
}

function webviewLabel() {
  const ua = navigator.userAgent;
  const edge = /Edg\/(\d+)/.exec(ua);
  if (edge) return `Edge ${edge[1]}`;
  const chrome = /Chrome\/(\d+)/.exec(ua);
  if (chrome) return `Chromium ${chrome[1]}`;
  const firefox = /Firefox\/(\d+)/.exec(ua);
  if (firefox) return `Firefox ${firefox[1]}`;
  return ua.slice(0, 80);
}

function currentPlatform() {
  try {
    return localStorage.getItem(PLATFORM_KEY) || '';
  } catch {
    return '';
  }
}

/** 汇总成可以直接塞进 payload 的对象。 */
export async function collectDiagnostics() {
  return {
    appVersion: await appVersion(),
    engine: await engineVersion(),
    os: osLabel(),
    webview: webviewLabel(),
    platform: currentPlatform(),
    page: document.querySelector('.nav.active')?.dataset.route || '',
    lastError: lastError ? `${lastError.message} · ${lastError.at}` : '',
    recent: recent.slice(-RECENT_LIMIT),
  };
}

/** 人读版：复制到剪贴板 / 贴到聊天窗口时用的纯文本。 */
export function formatDiagnostics(ctx) {
  const lines = [
    `应用 ${ctx.appVersion || '?'} · 引擎 ${ctx.engine || '?'}`,
    `${ctx.os || '?'} · ${ctx.webview || '?'}`,
    `页面 ${ctx.page || '—'} · 平台 ${ctx.platform || '—'}`,
  ];
  if (ctx.lastError) lines.push(`最近错误：${ctx.lastError}`);
  if (ctx.recent?.length) {
    lines.push(`最近失败请求（${ctx.recent.length} 条，仅 host+path）：`);
    for (const r of ctx.recent.slice(-8)) lines.push(`  ${r.status} ${r.host}${r.path}`);
    if (ctx.recent.length > 8) lines.push(`  …另有 ${ctx.recent.length - 8} 条`);
  }
  return lines.join('\n');
}
