// 用本机浏览器渲染页面后取 DOM。
//
// 为什么需要它：站酷（zcool）的 /work/ 作品页挂在阿里云 WAF 的「无感验证」后面 ——
// 纯 HTTP 请求（含 curl-impersonate 的 safari/firefox 指纹）一律拿到 23KB 的挑战脚本，
// 里面是几十 KB 混淆过的浏览器环境校验代码（navigator / Math / 函数 toString 哈希），
// 不是老的 acw_sc__v2 那种「arg1 重排 + 异或」能算出来的，逆向不值当。
// 而 /search/、/u/ 这些是纯客户端渲染，SSR HTML 里只有壳。
//
// 只有让真浏览器跑完 JS 才能拿到作品与作者。这里用系统 Chrome/Edge 的 `--dump-dom`
// （不需要 puppeteer，零依赖），并做了三件事：串行排队、硬超时、结果短时缓存。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { systemBrowser } from './browser-runtime.mjs';

const CACHE_TTL = 5 * 60 * 1000;      // 同一地址 5 分钟内复用：连点几张卡片不该反复启动浏览器
const cache = new Map();              // url -> {at, html}
let chain = Promise.resolve();        // 串行：Chrome 冷启动几十 MB，并发只会互相拖慢

function exe() {
  const fromEnv = process.env.SFX_BROWSER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const sys = systemBrowser();
  return sys?.found ? sys.path : null;
}

function profileDir(override) {
  if (override) {
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  const dir = path.join(os.tmpdir(), 'assetvault-headless');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 渲染一个页面，返回完整 DOM 字符串（失败返回 ''，让上层按「没抓到」处理）。
 *  `profileDir` 指向共享 profile 时，跑完的 WAF 挑战 cookie 会留在这个 profile 里，
 *  之后同站点的纯 HTTP 请求就能直接过验证（见 cookie-jar / browser-session 的 harvestCookies）。 */
export async function renderDom(url, { timeout = 25000, budget = 8000, profileDir: profileOverride = null } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.html;
  const bin = exe();
  if (!bin) throw new Error('本机没有可用的 Chrome / Edge，无法渲染需要执行 JS 的页面');

  const run = () => new Promise((resolve) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--disable-extensions', '--disable-background-networking', '--mute-audio',
      '--hide-scrollbars', '--window-size=1440,2400',
      `--user-data-dir=${profileDir(profileOverride)}`,
      `--virtual-time-budget=${budget}`,
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      '--dump-dom', url,
    ];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (killed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const html = Buffer.concat(chunks).toString('utf8');
      // 被杀掉时 stdout 往往还没写完，但只要抓到了像样的 DOM 就先用着。
      if (html.length > 2000) cache.set(url, { at: Date.now(), html });
      resolve(html);
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } finish(true); }, timeout);
    child.stdout.on('data', (b) => { chunks.push(b); bytes += b.length; if (bytes > 24 * 1024 * 1024) { try { child.kill('SIGKILL'); } catch { /* ignore */ } finish(true); } });
    child.stderr.on('data', () => { /* Chrome 的日志噪声一律丢掉 */ });
    child.on('error', () => finish(true));
    child.on('close', () => finish(false));
  });

  // 排队执行，前一个失败也要放行后面
  const task = chain.then(run, run);
  chain = task.then(() => {}, () => {});
  return task;
}

/** 本机能不能渲染（设置页/诊断用）。 */
export function headlessAvailable() {
  return Boolean(exe());
}

export function headlessInfo() {
  const bin = exe();
  return { available: Boolean(bin), path: bin, cache: cache.size };
}
