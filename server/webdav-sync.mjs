// WebDAV 云同步：把整库快照推到用户自己的 WebDAV，并在多台设备间双向合并。
//
// 为什么同步的是「整库快照」而不是 state/*.json：
// ADR-09 之后目录与用户域的权威在 SQLite，主 blob 落盘时目录字段恒为空 —— 同步那些
// 文件只会同步到设置，换台机器打开是空库。而 library-portable 已经把「目录 + 用户域 +
// 合集（含智能合集）」导出成一个可再导入的快照，正好是跨设备该带走的东西。
//
// 为什么用 merge 而不是覆盖：importLibrary 的 merge 语义是「新资产入种子、已存在的资产
// 保留本机标注」。两台机器各自整理过标签时，先合并再上传不会把对方的整理成果抹掉；
// 覆盖式同步只要有一台没同步完就会丢数据，不适合做成自动跑的定时任务。
//
// 冲突靠 rev 收敛，不做行级 diff：远端 rev 变了就先拉下来合并，合并结果作为新的本地
// 快照上传，然后记住这个 rev。下一次两边一致就什么都不做 —— 幂等，重复跑无害。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createWebdav} from './webdav-client.mjs';
import {exportLibrary, importLibrary} from './library-portable.mjs';

const CONFIG_FILE = 'sync-config.json';
const STATE_FILE = 'sync-state.json';
const SNAPSHOT_NAME = 'library.json';
const META_NAME = 'library.meta.json';
/** 自动同步的默认间隔（分钟）。太短会跟本地写盘抢 IO，太长又失去「自动」的意义。 */
export const DEFAULT_INTERVAL_MIN = 10;
export const MIN_INTERVAL_MIN = 1;
export const MAX_INTERVAL_MIN = 1440;

const clampInterval = value => {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_INTERVAL_MIN;
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, number));
};

const sha1 = value => createHash('sha1').update(value).digest('hex');
const newRev = () => `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
// 导出时刻是传输元数据，不属于需要同步的业务内容。
const contentHash = ({exportedAt, ...content}) => sha1(JSON.stringify(content));

export function createWebdavSync({storage, dataDir, onSynced = () => {}, onWarn = () => {}, now = Date.now, fetchImpl = fetch} = {}) {
  if (!storage) throw Error('缺少资产库存储实例');
  const configFile = path.join(dataDir, CONFIG_FILE);
  const stateFile = path.join(dataDir, STATE_FILE);
  let running = null;
  let timer = null;

  async function readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { return fallback; }
  }

  async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  }

  async function readConfig() {
    const raw = await readJson(configFile, null);
    if (!raw || typeof raw !== 'object') return null;
    return {
      url: String(raw.url || '').trim(),
      username: String(raw.username || ''),
      password: String(raw.password || ''),
      remoteDir: String(raw.remoteDir || 'AssetVault').replace(/^\/+|\/+$/g, '') || 'AssetVault',
      auto: raw.auto !== false,
      intervalMin: clampInterval(raw.intervalMin),
    };
  }

  async function readState() {
    const raw = await readJson(stateFile, null);
    return {
      remoteRev: raw?.remoteRev ? String(raw.remoteRev) : null,
      localHash: raw?.localHash ? String(raw.localHash) : null,
      lastAt: Number(raw?.lastAt) || 0,
      lastResult: raw?.lastResult && typeof raw.lastResult === 'object' ? raw.lastResult : null,
      lastError: raw?.lastError ? String(raw.lastError) : null,
    };
  }

  /** 前端拿到的配置永远不含密码；hasPassword 只回答「存过没有」。 */
  async function status() {
    const [config, state] = await Promise.all([readConfig(), readState()]);
    return {
      configured: !!config?.url,
      url: config?.url || '',
      username: config?.username || '',
      hasPassword: !!config?.password,
      remoteDir: config?.remoteDir || 'AssetVault',
      auto: config?.auto !== false,
      intervalMin: config?.intervalMin || DEFAULT_INTERVAL_MIN,
      running: !!running,
      ...state,
    };
  }

  async function saveConfig(input = {}) {
    const previous = await readConfig();
    const url = String(input.url ?? previous?.url ?? '').trim();
    if (url && !/^https?:\/\//i.test(url)) throw Error('WebDAV 地址必须以 http:// 或 https:// 开头');
    const next = {
      url,
      username: String(input.username ?? previous?.username ?? ''),
      // 密码留空表示「不改」：设置页拿不到原密码，空字符串若当成新值会把已存的密码清掉。
      password: typeof input.password === 'string' && input.password ? input.password : (previous?.password || ''),
      remoteDir: String(input.remoteDir ?? previous?.remoteDir ?? 'AssetVault').replace(/^\/+|\/+$/g, '') || 'AssetVault',
      auto: input.auto === undefined ? (previous?.auto !== false) : !!input.auto,
      intervalMin: clampInterval(input.intervalMin ?? previous?.intervalMin ?? DEFAULT_INTERVAL_MIN),
    };
    await writeJson(configFile, next);
    // 配置一变，原来的 rev 基线就没有意义了：换服务器后不能拿旧 rev 去比对新库。
    await writeJson(stateFile, {...(await readState()), remoteRev: null, localHash: null});
    restartTimer(next);
    return status();
  }

  function client(config) {
    return createWebdav({url: config.url, username: config.username, password: config.password, fetchImpl});
  }

  async function connect(config) {
    const dav = client(config);
    await dav.test();
    await dav.ensureDir(config.remoteDir);
    return dav;
  }

  async function test(input) {
    const current = await readConfig();
    const config = {
      ...(current || {}),
      ...(input || {}),
      password: typeof input?.password === 'string' && input.password ? input.password : (current?.password || ''),
    };
    if (!config.url) throw Error('请先填写 WebDAV 地址');
    const dav = await connect(config);
    return {ok: true, base: `${dav.base}/${config.remoteDir}`, remoteDir: config.remoteDir};
  }

  /**
   * 执行一次同步。互斥：定时器与手动按钮撞车时，后到的直接复用进行中的那次结果。
   * 返回 {action: 'uploaded'|'downloaded'|'merged'|'noop', rev, at}。
   */
  async function run({manual = false} = {}) {
    if (running) return running;
    running = (async () => {
      const config = await readConfig();
      if (!config?.url) throw Error('还没有配置 WebDAV 服务器');
      const state = await readState();
      const dav = await connect(config);

      const remoteMeta = await dav.get(`${config.remoteDir}/${META_NAME}`).then(buffer => {
        if (!buffer) return null;
        try { return JSON.parse(buffer.toString('utf8')); } catch { return null; }
      }).catch(error => { throw Error(`读取远端同步信息失败：${error.message}`); });

      let snapshot = await exportLibrary({storage, now});
      let localHash = contentHash(snapshot);
      const localChanged = localHash !== state.localHash;
      const remoteChanged = !!remoteMeta?.rev && remoteMeta.rev !== state.remoteRev;

      let action = 'noop';
      // 远端比基线新 → 先拉到本地合并。合并后重新导出，后面上传的就是合并结果。
      if (remoteChanged) {
        const payload = await dav.get(`${config.remoteDir}/${SNAPSHOT_NAME}`);
        if (payload) {
          let parsed = null;
          try { parsed = JSON.parse(payload.toString('utf8')); } catch { parsed = null; }
          if (!parsed) throw Error('远端快照不是有效的 JSON，已跳过本次下载（可用「上传」覆盖它）');
          const report = await importLibrary({storage, payload: parsed, mode: 'merge', actor: 'webdav'});
          snapshot = await exportLibrary({storage, now});
          localHash = contentHash(snapshot);
          action = 'merged';
          onSynced({report, direction: 'down'});
        }
      }

      const shouldUpload = action === 'merged' || localChanged || !remoteMeta;
      if (shouldUpload) {
        const body = Buffer.from(JSON.stringify(snapshot), 'utf8');
        await dav.put(`${config.remoteDir}/${SNAPSHOT_NAME}`, body);
        const rev = newRev();
        await dav.put(`${config.remoteDir}/${META_NAME}`, Buffer.from(JSON.stringify({
          rev,
          at: new Date(now()).toISOString(),
          bytes: body.length,
          device: process.env.COMPUTERNAME || process.env.HOSTNAME || 'unknown',
        }), 'utf8'));
        await writeJson(stateFile, {...state, remoteRev: rev, localHash, lastAt: now(), lastResult: {action: 'uploaded', bytes: body.length, rev}, lastError: null});
        if (action !== 'merged') action = 'uploaded';
        onSynced({direction: 'up', bytes: body.length});
      } else {
        await writeJson(stateFile, {...state, localHash, lastAt: now(), lastResult: {action: 'noop'}, lastError: null});
      }
      return {action, rev: (await readState()).remoteRev, at: now(), manual};
    })().catch(async error => {
      const state = await readState().catch(() => ({}));
      await writeJson(stateFile, {...state, lastError: String(error?.message || error), lastAt: now()}).catch(() => {});
      throw error;
    }).finally(() => { running = null; });
    return running;
  }

  function restartTimer(config) {
    if (timer) { clearInterval(timer); timer = null; }
    if (!config?.url || config.auto === false) return;
    const period = clampInterval(config.intervalMin) * 60 * 1000;
    timer = setInterval(() => {
      run().catch(error => onWarn(`WebDAV 自动同步失败：${error?.message || error}`));
    }, period);
    timer.unref?.();
  }

  async function start() {
    const config = await readConfig();
    restartTimer(config);
    return status();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {status, saveConfig, test, run, start, stop, configFile};
}
