// AssetVault AI 桥接层：工作台 UI / CLI / MCP 三条入口共用的唯一 HTTP 客户端。
//
// 这里刻意不引入任何第三方依赖：MCP server 常驻在 AI 客户端进程里，多一个依赖就多一处
// 需要安装和升级的地方。所有方法都只做「语义操作 -> 现有 /api 路由」的映射，不复制业务规则。
//
// 三条硬约束（都是从现有服务端代码里读出来的，别凭印象改）：
//  1. 绝大多数 /api 路由要求请求头 x-sfx-local: 1，缺了直接 403。
//  2. 端口会被 listen-port.mjs 回退，真实端口写在 <dataDir>/server-port.json，不能写死 4179。
//  3. 入队下载必须带 authorized: true（downloads.mjs 的授权确认），否则服务端拒绝。
import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveUserPaths} from './data-dir.mjs';

const DEFAULT_PORT = 4179;
const LOCAL_HEADER = {'x-sfx-local': '1'};

/** 平台 -> 搜索路由。八个平台的返回体统一是 {models, next, source, warnings}。 */
export const SEARCH_ENDPOINTS = Object.freeze({
  sketchfab: '/api/search',
  artstation: '/api/artstation/search',
  polyhaven: '/api/polyhaven/search',
  polypizza: '/api/polypizza/search',
  kenney: '/api/kenney/search',
  freestylized: '/api/freestylized/search',
  polyfork: '/api/polyfork/search',
  ambientcg: '/api/ambientcg/search',
});

/** 平台 -> 下载队列的 kind。搜索结果的 model 对象原样传给 /api/downloads/tasks 即可。 */
export const PLATFORM_KINDS = Object.freeze({
  sketchfab: 'sketchfab',
  artstation: 'artstation',
  polyhaven: 'polyhaven',
  polypizza: 'polypizza',
  kenney: 'kenney',
  freestylized: 'freestylized',
  polyfork: 'polyfork',
  ambientcg: 'ambientcg',
});

export class AVClientError extends Error {
  constructor(message, {status = null, code = 'AV_ERROR', details = null} = {}) {
    super(message);
    this.name = 'AVClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const validPort = p => Number.isInteger(p) && p > 0 && p <= 65535;
const normalizeBase = value => String(value || '').trim().replace(/\/+$/, '');

async function savedPort(env) {
  let dir;
  try {
    dir = resolveUserPaths(env).dataDir;
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'server-port.json'), 'utf8'));
    return validPort(parsed?.port) ? parsed.port : null;
  } catch {
    return null;
  }
}

function candidates(env, saved) {
  if (env.AV_BASE_URL) return [normalizeBase(env.AV_BASE_URL)];
  const ports = [];
  for (const raw of [env.AV_PORT, saved, env.SFX_PORT]) {
    const n = Number(raw);
    if (raw !== undefined && raw !== null && raw !== '' && validPort(n)) ports.push(n);
  }
  ports.push(DEFAULT_PORT);
  return [...new Set(ports)].map(port => `http://127.0.0.1:${port}`);
}

const isNetworkError = err =>
  err instanceof AVClientError && err.code === 'NETWORK' ||
  ['TypeError', 'TimeoutError', 'AbortError'].includes(err?.name) && !(err instanceof AVClientError);

/**
 * 创建一个客户端实例。常驻进程（MCP server）应复用同一个实例，端口会在服务重启后自动重新发现。
 * options: {env, fetch, baseUrl, timeoutMs}
 */
export function createClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || globalThis.fetch;
  const defaultTimeout = options.timeoutMs || 30_000;
  let baseUrl = normalizeBase(options.baseUrl) || null;

  async function discover() {
    if (baseUrl) return baseUrl;
    const urls = candidates(env, await savedPort(env));
    const failures = [];
    for (const url of urls) {
      try {
        const res = await fetchImpl(`${url}/api/health`, {signal: AbortSignal.timeout(1200)});
        if (!res.ok) {
          failures.push(`${url} -> HTTP ${res.status}`);
          continue;
        }
        const info = await res.json();
        // 端口可能被别的程序占着，必须确认对面确实是 AssetVault，而不是随便一个本地服务。
        if (info?.name !== 'assetvault-local-library') {
          failures.push(`${url} -> 不是 AssetVault 服务`);
          continue;
        }
        baseUrl = url;
        return url;
      } catch (err) {
        failures.push(`${url} -> ${err?.message || '连接失败'}`);
      }
    }
    throw new AVClientError(
      '未找到运行中的 AssetVault 服务。请先双击 AssetVault.lnk（或运行 npm run library）启动工作台服务；' +
      '若服务使用自定义端口，可设置 AV_BASE_URL 或 AV_PORT。',
      {code: 'SERVICE_NOT_RUNNING', details: failures},
    );
  }

  // 登录闸门开了以后，CLI / MCP / 脚本这类本机进程不再有「人点过登录」的 cookie，
  // 改用机器令牌（与账号文件同一处，仅本机可读）。ADR-13 把账号提到库外面后，
  // 令牌也跟着搬了；dataDir 那份是给还没升级的老实例留的退路。
  // 读不到就什么都不带 —— 没开登录的服务（测试实例）本来也不需要。
  let machineToken = null, tokenLoaded = false;
  async function machineAuth() {
    if (!tokenLoaded) {
      tokenLoaded = true;
      const paths = resolveUserPaths(env);
      for (const dir of [paths.accountsDir, paths.dataDir]) {
        try {
          machineToken = (await fs.readFile(path.join(dir, 'auth-token'), 'utf8')).trim() || null;
          if (machineToken) break;
        } catch { machineToken = null; }
      }
    }
    return machineToken ? {'x-av-token': machineToken} : {};
  }

  async function rawRequest(url, pathname, {method, body, timeoutMs, signal}) {
    let res;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      res = await fetchImpl(url + pathname, {
        method,
        headers: {...LOCAL_HEADER, ...(await machineAuth()), Accept: 'application/json', ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      throw new AVClientError(`无法连接 AssetVault 服务（${url}）：${err?.message || err}`, {code: 'NETWORK', details: err?.message});
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = {raw: text.slice(0, 500)};
    }
    if (!res.ok) {
      const message = data?.error || `HTTP ${res.status}`;
      throw new AVClientError(`AssetVault 拒绝请求：${message}`, {status: res.status, code: res.status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR', details: data});
    }
    return data;
  }

  /** 统一请求入口：服务重启换了端口时，自动重新发现一次再重试。 */
  async function request(pathname, {method = 'GET', body, timeoutMs = defaultTimeout, signal} = {}) {
    const url = await discover();
    try {
      return await rawRequest(url, pathname, {method, body, timeoutMs, signal});
    } catch (err) {
      if (!isNetworkError(err) || options.baseUrl) throw err;
      baseUrl = null;
      const next = await discover();
      return rawRequest(next, pathname, {method, body, timeoutMs, signal});
    }
  }

  const post = (pathname, body, opts) => request(pathname, {...opts, method: 'POST', body});
  const get = (pathname, opts) => request(pathname, {...opts, method: 'GET'});

  return {
    /** 当前解析到的服务地址，仅供状态展示 / 排错。 */
    async baseUrl() {
      return discover();
    },
    request,

    /** 服务版本、能力位、导出目标与服务是否就绪。 */
    async getStatus() {
      const url = await discover();
      const [health, capabilities, targets] = await Promise.allSettled([
        get('/api/health'),
        get('/api/downloads/capabilities'),
        get('/api/exports/targets'),
      ]);
      const value = r => (r.status === 'fulfilled' ? r.value : {error: String(r.reason?.message || r.reason)});
      return {
        baseUrl: url,
        health: value(health),
        capabilities: value(capabilities),
        exportTargets: value(targets),
      };
    },

    /**
     * 统一在线搜索。q 是关键词；filters 里的键原样透传（各平台筛选名不同）；
     * cursor 用于翻页，来自上一次返回的 next。
     */
    async searchAssets({platform = 'sketchfab', q = '', filters = {}, cursor, timeoutMs} = {}) {
      const endpoint = SEARCH_ENDPOINTS[platform];
      if (!endpoint) throw new AVClientError(`不支持的平台 ${platform}，可用：${Object.keys(SEARCH_ENDPOINTS).join(', ')}`, {code: 'BAD_ARGUMENT'});
      if (typeof q !== 'string') throw new AVClientError('关键词 q 必须是字符串', {code: 'BAD_ARGUMENT'});
      if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new AVClientError('filters 必须是对象', {code: 'BAD_ARGUMENT'});
      const input = {...filters, q};
      if (cursor !== undefined && cursor !== null && cursor !== '') input.cursor = String(cursor);
      return post(endpoint, input, {timeoutMs});
    },

    /** 按 UID / URL 取详情，复用 /api/scan 的解析链路。 */
    async getAsset({uid, url, ids} = {}) {
      const input = Array.isArray(ids) ? {ids} : uid ? {ids: [String(uid)]} : url ? {url: String(url)} : null;
      if (!input) throw new AVClientError('需要 uid、url 或 ids 之一', {code: 'BAD_ARGUMENT'});
      return post('/api/scan', input);
    },

    /**
     * 把搜索结果加入后台下载队列。立即返回 {added, duplicates, opened}，不等待下载完成。
     * authorized 必须由用户明确确认，服务端会二次校验，这里先挡一道并给出可读的提示。
     */
    async enqueueDownload({models, kind = 'sketchfab', authorized, options, folder, force, openInBlender} = {}) {
      if (!Array.isArray(models) || !models.length) throw new AVClientError('models 必须是非空数组', {code: 'BAD_ARGUMENT'});
      if (authorized !== true) {
        throw new AVClientError(
          '下载前必须确认你拥有该模型的下载与使用授权：请让用户明确确认后，把 authorized 设为 true。可下载不等于可以商用。',
          {code: 'AUTHORIZATION_REQUIRED'},
        );
      }
      const input = {models, kind, authorized: true};
      if (options !== undefined) input.options = options;
      if (folder !== undefined) input.folder = folder;
      if (force !== undefined) input.force = force === true;
      if (openInBlender !== undefined) input.openInBlender = openInBlender === true;
      return post('/api/downloads/tasks', input);
    },

    /** 下载队列快照（含全部任务原始字段）。 */
    async getJobs() {
      return get('/api/downloads');
    },

    async manageJob({action, ids} = {}) {
      if (!['cancel', 'retry', 'hold', 'resume', 'remove'].includes(action)) throw new AVClientError(`不支持的任务操作 ${action}`, {code: 'BAD_ARGUMENT'});
      if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new AVClientError('ids 必须是 1–500 个任务 ID', {code: 'BAD_ARGUMENT'});
      return post('/api/downloads/actions', {action, ids});
    },

    /** 浏览器本地存储里的模型库 / 收藏 / 设置。 */
    async listLibrary() {
      return get('/api/library-state');
    },

    /** 磁盘上的素材包索引（不含已登记为下载任务的条目）。 */
    async scanLibrary({force = false} = {}) {
      return post(`/api/library/scan${force ? '?force=1' : ''}`, {}, {timeoutMs: 120_000});
    },

    /** 把已保存的任务送进当前 Blender 场景。 */
    async sendToBlender({jobId} = {}) {
      if (!jobId) throw new AVClientError('需要 jobId', {code: 'BAD_ARGUMENT'});
      return post(`/api/downloads/tasks/${encodeURIComponent(jobId)}/send-blender`, {});
    },

    /** 资产库检索（阶段 2~4）：与前端 /api/library/assets 同一套查询语义，按页返回完整 model。 */
    async queryLibrary(input = {}) {
      return post('/api/library/assets', {
        q: input.q === undefined ? '' : String(input.q),
        filters: input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters) ? input.filters : {},
        ...(input.sort ? {sort: String(input.sort)} : {}),
        ...(input.sortOrder ? {sortOrder: String(input.sortOrder)} : {}),
        ...(input.limit !== undefined ? {limit: Number(input.limit)} : {}),
        ...(input.offset !== undefined ? {offset: Number(input.offset)} : {}),
        uidScope: 'page',
      });
    },

    /** 合集（含智能合集）：服务端返回 parentId / assetCount / smart 规则。 */
    async listCollections() { return get('/api/library/collections'); },
    async saveCollection(board) { return post('/api/library/collections', board); },
    async saveSmartCollection(rule) { return post('/api/library/smart-collections', rule); },
    async deleteCollection(id) {
      return request(`/api/library/collections?id=${encodeURIComponent(String(id))}`, {method: 'DELETE'});
    },
    async setCollectionItems({id, uids, action}) {
      return post('/api/library/collections/items', {id, uids, action});
    },

    /** 集合语义写入：批量打标 / 改评分 / 收藏 / 备注，只动受影响的资产。 */
    async mutateTags(ops) { return post('/api/library/tags/mutate', {ops}); },

    async exportTargets() {
      return get('/api/exports/targets');
    },
  };
}

/** 便捷入口：一次性调用（CLI 每次都是一个新进程）。 */
export const client = () => createClient();
