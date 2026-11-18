// 用本机 Blender 给「浏览器渲不了」的 3D 格式生成封面：.blend / .usd / .usda / .usdc / .usdz，
// 以及前端 three.js 解析失败时的 glb/gltf/fbx/obj/stl/ply 兜底。
//
// 设计取舍（都来自同行的实测记录，见 docs/model-covers.md）：
//   · 一定要 --factory-startup：别人的启动文件会拖进偏好、插件和一堆无关对象。
//   · 一定要 --python-exit-code 1：不加的话脚本抛异常 Blender 照样 exit 0，构建链会以为成功。
//   · 串行：Blender 冷启动本身要几百 MB 内存，同时跑两个只会互相拖慢。
//   · 超时要杀进程树：只杀父进程会留下渲染子进程。
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'blender-thumb.py');
const RENDER_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 10_000;

/** 能用 Blender 出封面的格式；usd 系列没有内嵌预览，唯一的路就是渲染。 */
export const BLENDER_COVER_EXT = /\.(blend|usd|usda|usdc|usdz)$/i;

let cachedBlender; // undefined = 还没探测过；null = 确认没有

function driveLetters() {
  const found = [];
  // 只探桌面常见的盘符，别去碰断开的网络盘（existsSync 在那上面会卡住）。
  for (const letter of 'CDEFGHIJ') if (fs.existsSync(`${letter}:\\`)) found.push(letter);
  return found;
}

function candidatePaths() {
  const list = [];
  for (const name of ['AV_BLENDER', 'BLENDER', 'BLENDER_PATH']) {
    const value = process.env[name];
    if (value) list.push(value);
  }
  const seen = new Set();
  for (const letter of driveLetters()) {
    const roots = [
      `${letter}:\\Program Files\\Blender Foundation`,
      `${letter}:\\Program Files (x86)\\Blender Foundation`,
      `${letter}:\\Program Files\\Steam\\steamapps\\common\\Blender`,
      `${letter}:\\SteamLibrary\\steamapps\\common\\Blender`,
      `${letter}:\\Program Files\\Steam\\steamapps\\common\\Blender Foundation`,
    ];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      // 两种情况：root 自己就是 Blender 目录（Steam），或者下面是 Blender 4.5 这样的版本目录。
      if (fs.existsSync(path.join(root, 'blender.exe'))) { list.push(path.join(root, 'blender.exe')); continue; }
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const exe = path.join(root, entry.name, 'blender.exe');
        if (fs.existsSync(exe) && !seen.has(exe)) { seen.add(exe); list.push(exe); }
      }
    }
  }
  try {
    // 中文 Windows 上 where 找不到时会往 stderr 打一行提示，别让它漏进服务日志。
    const out = execFileSync('where', ['blender'], { windowsHide: true, timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    for (const line of out.split(/\r?\n/)) if (line.trim().endsWith('.exe')) list.push(line.trim());
  } catch { /* PATH 里没有就算了 */ }
  return list;
}

function versionOf(bin) {
  try {
    const text = execFileSync(bin, ['--version'], { windowsHide: true, timeout: PROBE_TIMEOUT_MS }).toString();
    const match = /Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0), label: match[0] };
  } catch {
    return null;
  }
}

/**
 * 找一个能用的 Blender：环境变量 → 各固定盘的常见安装位置 → PATH。
 * 多个版本同时存在时取版本号最高的（同机升级后旧目录常常还留着）。
 * 结果缓存；找不到时返回 null（调用方回「该格式暂不生成封面」，不再反复探测）。
 */
export function findBlender({ refresh = false } = {}) {
  if (!refresh && cachedBlender !== undefined) return cachedBlender;
  let best = null;
  for (const bin of candidatePaths()) {
    if (!bin || !fs.existsSync(bin)) continue;
    const version = versionOf(bin);
    if (!version) continue; // 路径能拼出来但跑不起来的（残留目录、缺 DLL）直接跳过
    const rank = version.major * 10_000 + version.minor * 100 + version.patch;
    if (!best || rank > best.rank) best = { bin, version, rank };
  }
  cachedBlender = best ? { bin: best.bin, version: best.version } : null;
  return cachedBlender;
}

/** 设置页/诊断用：不启动渲染，只报「有没有、哪个版本、在哪」。 */
export function blenderStatus(options) {
  const found = findBlender(options);
  return found
    ? { available: true, path: found.bin, version: found.version.label }
    : { available: false, path: null, version: null };
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* 进程已经没了 */ }
}

function runBlender(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, timeout: RENDER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed || error.signal) killTree(error.pid);
        const detail = String(stderr || stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || error.message;
        reject(new Error(`Blender 渲染失败：${detail}`));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

// 串行队列：同时只跑一个 Blender，其余排队（每张卡的封面只算一次，重复请求共享同一个 Promise）。
let running = 0;
const waiting = [];
const pending = new Map();

function withSlot(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      running++;
      task().then(resolve, reject).finally(() => {
        running--;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (running === 0) start();
    else waiting.push(start);
  });
}

/**
 * 渲一张 512px 透明底 PNG。
 * @returns {Promise<{png: Buffer, width: number, height: number, blender: string}>}
 */
export async function renderBlenderCover(file, { width = 512 } = {}) {
  const found = findBlender();
  if (!found) throw new Error('没找到 Blender，装一个或在设置里指定路径后才能生成这种格式的封面');
  const key = `${file}|${width}`;
  if (pending.has(key)) return pending.get(key);
  const job = withSlot(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'av-blend-'));
    const out = path.join(dir, 'cover.png');
    try {
      const args = [
        '-b',
        '--factory-startup',
        // 必须在 -P 之前：不加这句，脚本报错 Blender 也返回 0。
        '--python-exit-code', '1',
        '-P', SCRIPT_PATH,
        '--',
        '--input', file,
        '--out', out,
        '--size', String(width),
      ];
      const stdout = await runBlender(found.bin, args);
      const png = await fsp.readFile(out).catch(() => null);
      if (!png || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
        const tail = stdout.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
        throw new Error(`Blender 没有写出 PNG${tail ? `：${tail}` : ''}`);
      }
      return { png, width, height: width, blender: found.version.label };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/** 测试用：清掉探测缓存和队列状态。 */
export function resetBlenderCache() {
  cachedBlender = undefined;
  pending.clear();
}
