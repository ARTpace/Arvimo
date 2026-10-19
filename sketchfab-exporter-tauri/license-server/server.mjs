#!/usr/bin/env node
// AssetVault 轻量授权服务 —— 零依赖，只用 Node 内置模块。
//
// 职责只有两件事：登记「密钥 → 机器」，并签发绑定该机器的授权文件。
// 客户端拿到授权文件后完全离线运行，不再访问本服务。
//
// 启动:  node server.mjs           （默认端口 8787，可用 PORT 覆盖）
// 环境变量:
//   PORT              监听端口，默认 8787
//   AV_ADMIN_TOKEN    管理接口令牌，必填才能启用 /api/admin
//   AV_LICENSE_DIR    数据与私钥所在目录，默认 ./（即本文件同级的 licensing/ 与 data/）
//
// 客户端调用:
//   POST /api/activate   {key, machineId, factors:[h1,h2,h3]}  ->  {ok, license}
// 管理接口（需 X-AV-Token 头）:
//   POST /api/admin  {action:'list'}                   列出密钥与激活情况
//   POST /api/admin  {action:'revoke',  key}           吊销密钥（客户端将无法再激活）
//   POST /api/admin  {action:'unbind',  key, index}    解绑第 index 台设备（用于换机）
//   POST /api/admin  {action:'newkey', count, maxDevices, note}  在线批量发码

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.AV_LICENSE_DIR ? path.resolve(process.env.AV_LICENSE_DIR) : path.resolve(here, '..');

const privPath = path.join(root, 'licensing', 'private.pem');
const keysPath = path.join(root, 'license-server', 'data', 'keys.json');
const actPath = path.join(root, 'license-server', 'data', 'activations.json');
const PORT = Number(process.env.PORT || 8787);
const ADMIN_TOKEN = process.env.AV_ADMIN_TOKEN || '';
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
function loadPrivateKey() {
  if (!fs.existsSync(privPath)) {
    throw new Error('缺少签发私钥: ' + privPath + '（请在本机跑 node tools/keygen.mjs init 后把 licensing/private.pem 放到服务器）');
  }
  return crypto.createPrivateKey(fs.readFileSync(privPath, 'utf8'));
}

function newKey() {
  const bytes = crypto.randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return 'AV-' + s.match(/.{5}/g).join('-');
}

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 授权文件格式:  AVLIC1.<base64url(payloadJSON)>.<base64url(signature)>
function issueLicense(payload) {
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign(null, Buffer.from(body, 'utf8'), loadPrivateKey());
  return 'AVLIC1.' + body + '.' + b64u(sig);
}

// 机器判定：3 个硬件因子逐位比对，命中 >= 2 项视为同一台机器。
// 这样用户重装系统只会丢 1 项（MachineGuid），不至于授权作废；换电脑则 3 项全变。
function sameMachine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  let hit = 0;
  for (let i = 0; i < 3; i++) if (a[i] && b[i] && a[i] === b[i]) hit++;
  return hit >= 2;
}

// 桌面端的激活请求来自 WebView（origin 是 tauri.localhost），属于跨域请求，
// 因此所有响应都要带 CORS 头，并且必须正确响应预检 OPTIONS，否则激活按钮会直接失败。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-AV-Token',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Max-Age': '600',
};

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

async function activate(body) {
  const key = String(body.key || '').trim().toUpperCase();
  const machineId = String(body.machineId || '').trim();
  const factors = Array.isArray(body.factors) ? body.factors.map(String) : [];
  if (!key || !machineId || factors.length !== 3) {
    return {code: 400, obj: {ok: false, error: 'bad_request', message: '参数不完整'}};
  }
  const keys = readJson(keysPath, {});
  const rec = keys[key];
  if (!rec) return {code: 404, obj: {ok: false, error: 'invalid_key', message: '密钥无效，请核对后重试'}};
  if (rec.revoked) return {code: 403, obj: {ok: false, error: 'revoked', message: '该密钥已被停用，请联系发行方'}};

  const acts = readJson(actPath, {});
  const entry = acts[key] || (acts[key] = {devices: []});
  const maxDevices = rec.maxDevices || 2;

  const existing = entry.devices.find((d) => sameMachine(d.factors, factors) || d.machineId === machineId);
  if (!existing) {
    if (entry.devices.length >= maxDevices) {
      return {
        code: 409,
        obj: {
          ok: false, error: 'device_limit',
          message: '该密钥已激活 ' + entry.devices.length + '/' + maxDevices + ' 台设备。换电脑请联系发行方解绑。',
          devices: entry.devices.length, maxDevices,
        },
      };
    }
    entry.devices.push({machineId, factors, activatedAt: new Date().toISOString(), ip: ''});
    writeJson(actPath, acts);
  }

  const payload = {
    v: 1,
    key,
    machineId,
    factors,
    maxDevices,
    perpetual: true,
    features: ['all'],
    issuedAt: new Date().toISOString(),
  };
  return {
    ok: true,
    license: issueLicense(payload),
    devices: entry.devices.length,
    maxDevices,
    reused: !!existing,
  };
}

function admin(body) {
  const keys = readJson(keysPath, {});
  const acts = readJson(actPath, {});
  switch (body.action) {
    case 'list': {
      const rows = Object.entries(keys).map(([k, v]) => ({
        key: k,
        maxDevices: v.maxDevices,
        revoked: !!v.revoked,
        note: v.note || '',
        createdAt: v.createdAt,
        devices: (acts[k]?.devices || []).map((d) => ({machineId: d.machineId, activatedAt: d.activatedAt})),
      }));
      return {ok: true, keys: rows};
    }
    case 'revoke': {
      const k = String(body.key || '').toUpperCase();
      if (!keys[k]) return {code: 404, obj: {ok: false, error: 'invalid_key'}};
      keys[k].revoked = true;
      writeJson(keysPath, keys);
      return {ok: true, revoked: k};
    }
    case 'restore': {
      const k = String(body.key || '').toUpperCase();
      if (!keys[k]) return {code: 404, obj: {ok: false, error: 'invalid_key'}};
      keys[k].revoked = false;
      writeJson(keysPath, keys);
      return {ok: true};
    }
    case 'unbind': {
      const k = String(body.key || '').toUpperCase();
      if (!acts[k]) return {code: 404, obj: {ok: false, error: 'no_activation'}};
      const idx = Number(body.index);
      if (Number.isInteger(idx) && idx >= 0) {
        const removed = acts[k].devices.splice(idx, 1);
        writeJson(actPath, acts);
        return {ok: true, removed: removed.map((d) => d.machineId)};
      }
      if (body.machineId) {
        const before = acts[k].devices.length;
        acts[k].devices = acts[k].devices.filter((d) => d.machineId !== body.machineId);
        writeJson(actPath, acts);
        return {ok: true, removed: before - acts[k].devices.length};
      }
      return {code: 400, obj: {ok: false, error: 'need_index_or_machine_id'}};
    }
    case 'newkey': {
      const count = Math.min(Math.max(Number(body.count) || 1, 1), 500);
      const maxDevices = Number(body.maxDevices) || 2;
      const made = [];
      for (let i = 0; i < count; i++) {
        let k;
        do { k = newKey(); } while (keys[k]);
        keys[k] = {createdAt: new Date().toISOString(), maxDevices, note: body.note || '', revoked: false};
        made.push(k);
      }
      writeJson(keysPath, keys);
      return {ok: true, keys: made};
    }
    default:
      return {code: 400, obj: {ok: false, error: 'unknown_action'}};
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // 预检请求：WebView 发 JSON 跨域 POST 前一定会先来一发 OPTIONS。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, {ok: true, service: 'assetvault-license', time: new Date().toISOString()});
    }
    if (req.method === 'POST' && url.pathname === '/api/activate') {
      const out = await activate(await readBody(req));
      return send(res, out.code || 200, out.obj || out);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin') {
      if (!ADMIN_TOKEN) return send(res, 503, {ok: false, error: 'admin_disabled', message: '未设置 AV_ADMIN_TOKEN'});
      if (req.headers['x-av-token'] !== ADMIN_TOKEN) return send(res, 401, {ok: false, error: 'unauthorized'});
      const out = admin(await readBody(req));
      return send(res, out.code || 200, out.obj || out);
    }
    return send(res, 404, {ok: false, error: 'not_found'});
  } catch (err) {
    return send(res, 500, {ok: false, error: 'server_error', message: err.message});
  }
});

server.listen(PORT, () => {
  console.log('[assetvault-license] listening on :' + PORT);
  console.log('  私钥: ' + privPath + (fs.existsSync(privPath) ? '  (已就绪)' : '  ✗ 缺失'));
  console.log('  密钥白名单: ' + keysPath);
  console.log('  管理接口: ' + (ADMIN_TOKEN ? '已启用' : '未启用（未设 AV_ADMIN_TOKEN）'));
});
