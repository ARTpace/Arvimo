// AI 桥接层回归测试：用本地 mock 服务替代真实工作台，验证
// 端口发现 / 本地请求标识 / 授权闸门 / 语义方法映射，以及 MCP stdio 握手与工具调用。
// 不联网、不碰用户数据、不启动真实服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createClient} from '../server/ai-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = {
  uid: '0123456789abcdef0123456789abcdef',
  name: '低多边形树',
  author: '测试作者',
  license: 'CC BY 4.0',
  downloadable: true,
  url: 'https://sketchfab.com/models/0123456789abcdef0123456789abcdef',
  thumbnail: 'https://example.com/thumb.jpg',
  tags: ['tree', 'lowpoly'],
};
const JOB = {
  id: 'job-1', uid: MODEL.uid, name: MODEL.name, kind: 'sketchfab',
  state: 'saved', stage: 'saved', message: '已完成', filePath: 'H:\\Models\\tree.zip',
  fileExists: true, sha256: 'abc123', logs: ['准备', '校验', '完成'],
};

let server;
let port;
let tmpDir;
const seen = [];

async function startMock() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-ai-test-'));
  await fs.writeFile(path.join(tmpDir, 'placeholder.txt'), 'wait-for-port');
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    seen.push({method: req.method, path: req.url, body, local: req.headers['x-sfx-local']});
    const send = (status, value) => {
      res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify(value));
    };
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    // /api/health 在真实服务里不要求本地请求标识（端口发现就是靠它），mock 必须一致，
    // 否则客户端会判定这个端口不是 AssetVault，然后回退到用户本机真实运行的服务。
    if (pathname === '/api/health' && req.method === 'GET') return send(200, {name: 'assetvault-local-library', version: '3.12.0'});
    if (req.headers['x-sfx-local'] !== '1') return send(403, {error: '缺少本地请求标识'});
    if (pathname === '/api/downloads/capabilities') return send(200, {version: '3.12.0', browserRuntime: true});
    if (pathname === '/api/exports/targets') return send(200, [{id: 'blender', label: 'Blender', kind: 'bridge', configured: true}]);
    if (pathname === '/api/search' && req.method === 'POST') return send(200, {models: [MODEL, {...MODEL, uid: 'fedcba9876543210fedcba9876543210', name: '第二棵树'}], next: 'cursor-next', source: 'Sketchfab 在线搜索', warnings: []});
    if (pathname === '/api/scan' && req.method === 'POST') return send(200, {models: [MODEL], source: '单个模型', warnings: []});
    if (pathname === '/api/downloads/tasks' && req.method === 'POST') {
      if (body.authorized !== true) return send(400, {error: '请先确认拥有模型下载和使用授权'});
      return send(200, {added: ['job-1'], duplicates: [], opened: []});
    }
    if (pathname === '/api/downloads' && req.method === 'GET') return send(200, {version: 1, settings: {paused: false}, jobs: [JOB]});
    if (pathname === '/api/downloads/actions' && req.method === 'POST') return send(200, {errors: [], jobs: [JOB]});
    if (pathname === '/api/library-state' && req.method === 'GET') return send(200, {models: [MODEL], favorites: [MODEL.uid], exportSettings: {format: 'glb'}});
    if (pathname === '/api/library/scan' && req.method === 'POST') return send(200, {roots: ['H:\\Models'], packages: [], files: [], truncated: false});
    if (pathname === '/api/downloads/tasks/job-1/send-blender' && req.method === 'POST') return send(200, {ok: true, message: '已发送到 Blender'});
    return send(404, {error: '接口不存在'});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  await fs.writeFile(path.join(tmpDir, 'server-port.json'), JSON.stringify({port}));
}

// 端口发现测试专用：不设 AV_BASE_URL，逼客户端走 server-port.json 那条路。
const discoveryEnv = () => ({...process.env, SFX_DATA_DIR: tmpDir, AV_BASE_URL: undefined, AV_PORT: undefined, SFX_PORT: undefined});
// 其余测试显式锁定 mock 地址：用户本机可能真的开着 AssetVault（实测就开着），
// 不锁死的话断言失败会变成往真实下载队列里塞测试任务。
const testEnv = () => ({...process.env, SFX_DATA_DIR: tmpDir, AV_BASE_URL: `http://127.0.0.1:${port}`});

test.before(async () => { await startMock(); });
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(tmpDir, {recursive: true, force: true});
});

test('端口发现读取 server-port.json，并确认对方确实是 AssetVault', async () => {
  const client = createClient({env: discoveryEnv()});
  const status = await client.getStatus();
  assert.equal(status.baseUrl, `http://127.0.0.1:${port}`);
  assert.equal(status.health.name, 'assetvault-local-library');
  assert.equal(status.capabilities.version, '3.12.0');
  assert.equal(status.exportTargets[0].id, 'blender');
});

test('search_assets 带上本地请求标识，参数原样透传', async () => {
  const client = createClient({env: testEnv()});
  const result = await client.searchAssets({q: 'tree', filters: {downloadable: true, sort: 'popular'}});
  assert.equal(result.models.length, 2);
  assert.equal(result.next, 'cursor-next');
  const call = seen.findLast(item => item.path === '/api/search');
  assert.equal(call.local, '1');
  assert.equal(call.body.q, 'tree');
  assert.equal(call.body.downloadable, true);
  assert.equal(call.body.sort, 'popular');
});

test('入队下载的授权闸门：未授权不发请求，授权后映射正确', async () => {
  const client = createClient({env: testEnv()});
  await assert.rejects(
    client.enqueueDownload({models: [MODEL]}),
    err => err.code === 'AUTHORIZATION_REQUIRED',
  );
  const before = seen.filter(item => item.path === '/api/downloads/tasks').length;
  const result = await client.enqueueDownload({models: [MODEL], kind: 'sketchfab', authorized: true, options: {format: 'glb'}});
  assert.deepEqual(result.added, ['job-1']);
  const call = seen.findLast(item => item.path === '/api/downloads/tasks');
  assert.equal(call.body.authorized, true);
  assert.equal(call.body.kind, 'sketchfab');
  assert.equal(call.body.options.format, 'glb');
  assert.equal(seen.filter(item => item.path === '/api/downloads/tasks').length, before + 1);
});

test('任务、模型库与 Blender 发送映射到现有路由', async () => {
  const client = createClient({env: testEnv()});
  assert.equal((await client.getJobs()).jobs[0].id, 'job-1');
  assert.equal((await client.scanLibrary({force: true})).roots[0], 'H:\\Models');
  assert.ok(seen.some(item => item.path === '/api/library/scan?force=1'));
  assert.equal((await client.listLibrary()).favorites[0], MODEL.uid);
  assert.equal((await client.manageJob({action: 'cancel', ids: ['job-1']})).errors.length, 0);
  assert.equal((await client.sendToBlender({jobId: 'job-1'})).ok, true);
  assert.equal((await client.getAsset({uid: MODEL.uid})).models[0].uid, MODEL.uid);
});

// ---------------------------------------------------------------- MCP stdio

class MCPChild {
  constructor() {
    this.seq = 0;
    this.pending = new Map();
    this.child = spawn(process.execPath, [path.join(root, 'server', 'ai-mcp.mjs')], {
      env: {...process.env, AV_BASE_URL: `http://127.0.0.1:${port}`},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.rl = readline.createInterface({input: this.child.stdout});
    this.rl.on('line', line => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === undefined) return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}`));
      }, 8000);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    });
  }
  stop() {
    this.rl.close();
    this.child.kill();
  }
}

test('MCP 握手、工具列表、搜索 handle 入队与资源读取', async () => {
  const mcp = new MCPChild();
  try {
    const init = await mcp.send('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test', version: '1'}});
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'assetvault');

    const tools = await mcp.send('tools/list');
    assert.deepEqual(tools.result.tools.map(tool => tool.name), [
      'get_capabilities', 'search_assets', 'get_asset', 'enqueue_download',
      'get_jobs', 'manage_job', 'list_library', 'send_to_blender',
    ]);

    const status = await mcp.send('tools/call', {name: 'get_capabilities', arguments: {}});
    assert.equal(status.result.isError, undefined);
    const statusValue = JSON.parse(status.result.content[0].text);
    assert.equal(statusValue.running, true);
    assert.equal(statusValue.version, '3.12.0');
    assert.equal(statusValue.exportTargets[0].id, 'blender');
    assert.equal(statusValue.exportTargets[0].configured, true);

    const search = await mcp.send('tools/call', {name: 'search_assets', arguments: {q: 'tree', limit: 2}});
    assert.equal(search.result.isError, undefined);
    const found = JSON.parse(search.result.content[0].text);
    assert.equal(found.items.length, 2);
    assert.match(found.items[0].handle, /^s\d+:0$/);
    assert.equal(found.next, 'cursor-next');

    const blocked = await mcp.send('tools/call', {name: 'enqueue_download', arguments: {handles: [found.items[0].handle]}});
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0].text, /授权/);

    const queued = await mcp.send('tools/call', {name: 'enqueue_download', arguments: {handles: [found.items[0].handle], authorized: true}});
    assert.equal(queued.result.isError, undefined);
    assert.deepEqual(JSON.parse(queued.result.content[0].text).added, ['job-1']);

    const jobs = await mcp.send('tools/call', {name: 'get_jobs', arguments: {}});
    assert.equal(JSON.parse(jobs.result.content[0].text).jobs[0].id, 'job-1');

    const resource = await mcp.send('resources/read', {uri: `assetvault://search/${found.batchId}`});
    assert.equal(JSON.parse(resource.result.contents[0].text).models.length, 2);

    const templates = await mcp.send('resources/templates/list');
    assert.equal(templates.result.resourceTemplates.length, 2);
  } finally {
    mcp.stop();
  }
});
