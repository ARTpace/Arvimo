// 极简 CDP 客户端：直接跟本机 Chrome/Edge 的 DevTools 协议说话，零依赖（Node 22 自带 WebSocket）。
//
// 为什么不用 playwright/puppeteer：本工具要打进安装包，多一个 200MB 的 chromium 下载不划算，
// 而且我们真正需要的只有三件事 —— 读 cookie、导航取 DOM、监听网络响应里的图片。
//
// 两种形态：
//   headless  —— 后台渲染（优先 chrome-headless-shell，回退系统 Edge/Chrome）
//   headed    —— 有界面的窗口，用户在里头手动登录，我们只管把登录后的 cookie 导出来
// headed 必须是完整浏览器（headless-shell 没有 UI，登录无从谈起）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { browserExePath, systemBrowser } from './browser-runtime.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 本机可用的浏览器可执行文件。headed 只认系统浏览器，headless 优先自带的 headless-shell。 */
export function browserExe(mode = 'headless') {
  if (mode === 'headed') {
    const sys = systemBrowser();
    return sys.found ? { path: sys.path, name: sys.name, kind: 'system' } : null;
  }
  const bundled = browserExePath();
  if (bundled && fs.existsSync(bundled)) return { path: bundled, name: 'chrome-headless-shell', kind: 'bundled' };
  const sys = systemBrowser();
  return sys.found ? { path: sys.path, name: sys.name, kind: 'system' } : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 一个页面的 CDP 连接。只开一个 target，够用且省内存。 */
export class CdpPage {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || 'CDP 调用失败'));
        else resolve(msg.result);
        return;
      }
      if (!msg.method) return;
      for (const fn of this.listeners.get(msg.method) || []) {
        try { fn(msg.params); } catch { /* 监听器自己出错不影响主流程 */ }
      }
    });
    ws.addEventListener('close', () => { this.closed = true; });
    ws.addEventListener('error', () => { this.closed = true; });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => {
      const arr = this.listeners.get(method) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  send(method, params = {}, timeout = 20000) {
    if (this.closed) return Promise.reject(new Error('浏览器连接已断开'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  /** 导航并等 load（loadEventFired 或超时，超时不算失败，很多站永远等不到干净 load）。 */
  async goto(url, { timeout = 25000, waitForQuiet = 0 } = {}) {
    let loaded = false;
    const off = this.on('Page.loadEventFired', () => { loaded = true; });
    try {
      await this.send('Page.navigate', { url }, timeout);
      const t0 = Date.now();
      while (!loaded && Date.now() - t0 < timeout) await sleep(120);
      if (waitForQuiet > 0) {
        // 等网络安静：一段时间内没有新的 responseReceived
        let last = Date.now();
        const off2 = this.on('Network.responseReceived', () => { last = Date.now(); });
        while (Date.now() - last < waitForQuiet && Date.now() - t0 < timeout + waitForQuiet) await sleep(200);
        off2();
      }
      return { loaded, ms: Date.now() - t0 };
    } finally { off(); }
  }

  async html() {
    const r = await this.send('Runtime.evaluate', {
      expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
      returnByValue: true,
      awaitPromise: false,
    }, 25000);
    return String(r?.result?.value || '');
  }

  async title() {
    const r = await this.send('Runtime.evaluate', { expression: 'document.title || ""', returnByValue: true });
    return String(r?.result?.value || '');
  }

  /** 指定域（含子域）的 cookie → `k=v; k2=v2`。CDP 返回明文，不受 Chrome 磁盘加密影响。 */
  async cookieHeader(hostFilter = null) {
    const r = await this.send('Storage.getCookies', {});
    const all = r?.cookies || [];
    const picked = hostFilter ? all.filter((c) => hostMatches(c.domain, hostFilter)) : all;
    return picked;
  }

  close() {
    try { this.ws.close(); } catch { /* 已关 */ }
  }
}

/** 域名匹配：`.zcool.com.cn` 也算 `zcool.com.cn` 的子域。 */
export function hostMatches(cookieDomain, host) {
  if (!cookieDomain || !host) return false;
  const d = String(cookieDomain).replace(/^\./, '').toLowerCase();
  const h = String(host).replace(/^\./, '').toLowerCase();
  return h === d || h.endsWith('.' + d);
}

/**
 * 启动一个浏览器并连上第一个页面。
 * 返回 { page, child, port, exe, mode }。
 */
export async function launchBrowser({ mode = 'headless', profileDir, timeout = 30000, extraArgs = [] } = {}) {
  const exe = browserExe(mode);
  if (!exe) {
    throw new Error(mode === 'headed'
      ? '要登录需要完整浏览器（本机没找到 Chrome / Edge）'
      : '本机没有可用的 Chrome / Edge');
  }
  if (!profileDir) throw new Error('缺少 profileDir');
  fs.mkdirSync(profileDir, { recursive: true });

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  try { fs.unlinkSync(portFile); } catch { /* 本来就没有 */ }

  const args = [
    mode === 'headed' ? '--new-window' : '--headless=new',
    '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--mute-audio', '--hide-scrollbars',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1440,2000',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    // 登录窗口必须用浏览器自己的 UA：本机 headed 跑的是 Edge，硬改成 Chrome/126 会留下
    // 「UA 说 Chrome、client hints 说 Edge」的矛盾，Google 直接判浏览器被篡改。只有 headless
    // 渲染才需要伪装 UA 去骗站点。
    ...(mode === 'headed' ? [] : [`--user-agent=${BROWSER_UA}`]),
    // 不关这个，CDP 拉起的窗口 navigator.webdriver 就是 true（实测 old 配置 wd:true，
    // 带上这个开关后 wd:false）。Google 见到 webdriver 一律弹「此浏览器或应用可能不安全」。
    '--disable-blink-features=AutomationControlled',
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(exe.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: mode !== 'headed' });
  let stderr = '';
  child.stderr?.on('data', (b) => { if (stderr.length < 4000) stderr += b.toString(); });

  let port = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fs.existsSync(portFile)) {
      const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (/^\d+$/.test(first)) { port = Number(first); break; }
    }
    if (child.exitCode !== null) break;
    await sleep(150);
  }
  if (!port) {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    throw new Error(`浏览器启动失败${stderr ? '：' + stderr.split('\n')[0].slice(0, 120) : ''}`);
  }

  // 找（或建）一个 page target
  let page = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 15000) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const hit = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (hit) { page = hit; break; }
      // 没有 page target 就新建一个
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).catch(() => {});
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  if (!page) {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    throw new Error('浏览器起来了但拿不到可用的页面');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接浏览器超时')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接浏览器失败')); }, { once: true });
  });

  const cdpPage = new CdpPage(ws);
  await cdpPage.send('Page.enable', {}, 10000).catch(() => {});
  await cdpPage.send('Network.enable', {}, 10000).catch(() => {});

  return { page: cdpPage, child, port, exe, mode };
}

/** 让浏览器退出，尽量干净。 */
export function killBrowser(child, { grace = 3000 } = {}) {
  if (!child || child.exitCode !== null) return;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve();
    }, grace);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

export function defaultProfileDir() {
  return path.join(os.tmpdir(), 'assetvault-headless');
}
