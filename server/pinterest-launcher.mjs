// 自动拉起 pin-grabber（Pinterest 搜索/下载引擎，独立 Python Flask 服务）。
//
// 为什么独立拉起而不是 JS 重写：Pinterest 的私有接口、cookies、翻页 bookmark 机制全在 pin-grabber
// 里调通了，AV 这边只借它的 HTTP 接口（/api/collect 搜索、/api/status 轮询、/api/related 相似）。
// 拉起前先探 5000 端口 —— 你已经手动开着就直接复用，不重复 spawn；只有空闲时才拉。
//
// 生命周期：AV 进程退出（exit / SIGINT / SIGTERM）时一并 kill 子进程。pin-grabber 的 cookies /
// 设置都落在它自己的 settings.json 磁盘上，不受 AV 重启影响。
import { spawn } from 'node:child_process';
import net from 'node:net';

/** pin-grabber 目录与启动脚本（按需改这里可换路径）。 */
const PG_DIR = 'H:/AI-Tools/pin-grabber';
const PG_APP = 'H:/AI-Tools/pin-grabber/app.py';
/** managed venv 自带 flask 3.1.3，正是 pin-grabber 启动 bat 用的那个 python。 */
const PY = 'C:/Users/zhengyuliang/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
export const PIN_GRABBER_URL = 'http://127.0.0.1:5000';
const PG_PORT = 5000;

let child = null;
let starting = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 5000 端口是否已在监听（无论谁开的）。 */
async function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PG_PORT, '127.0.0.1');
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
  });
}

/** 确保 pin-grabber 在跑：手动开着就复用，否则用 managed venv python 拉起并等端口就绪。 */
export async function ensurePinGrabber() {
  if (await portOpen()) return;
  if (!starting) {
    starting = (async () => {
      child = spawn(PY, [PG_APP], {
        cwd: PG_DIR,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.on('exit', () => { child = null; });
      child.on('error', () => { child = null; });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (await portOpen()) return;
        await sleep(500);
      }
      throw new Error('Pinterest 抓取服务（pin-grabber）启动超时，请检查 H:/AI-Tools/pin-grabber/app.py 是否能单独运行');
    })();
  }
  await starting;
  starting = null;
}

function killChild() {
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
    child = null;
  }
}
process.on('exit', killChild);
process.on('SIGINT', killChild);
process.on('SIGTERM', killChild);
