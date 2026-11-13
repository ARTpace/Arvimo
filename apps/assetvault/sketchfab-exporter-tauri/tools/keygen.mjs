#!/usr/bin/env node
// AssetVault 授权密钥生成器 / 离线签发器 —— 仅供发行方本机使用。
// 私钥(licensing/private.pem)绝不可外泄、绝不进安装包、绝不提交到仓库。
//
// 用法：
//   node tools/keygen.mjs init                     首次：生成 Ed25519 密钥对，打印公钥
//   node tools/keygen.mjs sign "AVFP1.x.y.z"       为指定机器签发授权文件（离线，不需要服务器）
//   node tools/keygen.mjs new                      生成 1 个密钥（2 台设备/永久）
//   node tools/keygen.mjs new -n 20 --note 淘宝首批   批量生成 20 个
//   node tools/keygen.mjs list                     查看已发出的密钥
//   node tools/keygen.mjs pubkey                   打印公钥（要嵌进客户端）
//
// 离线签发流程：
//   1) 用户装好软件，点「复制」拿到机器指纹（形如 AVFP1.<64hex>.<64hex>.<64hex>）
//   2) 你执行：node tools/keygen.mjs sign "用户发来的指纹" --note "张三"
//   3) 把打印出来的授权文件（或 licensing/issued/<密钥>.txt）回传给用户
//   4) 用户在软件里粘贴 → 激活完成，永久离线可用

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const licDir = path.join(root, 'licensing');
const dataDir = path.join(root, 'license-server', 'data');
const privPath = path.join(licDir, 'private.pem');
const pubPath = path.join(licDir, 'pubkey.b64');
const keysPath = path.join(dataDir, 'keys.json');

// 去掉 0/O/1/I 等易混字符，方便用户手输
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function parseArgs(argv) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n' || a === '--count') out.count = Number(argv[++i]);
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--devices') out.devices = Number(argv[++i]);
    else if (a === '--key') out.key = argv[++i];
    else out._.push(a);
  }
  return out;
}

function newKey() {
  const bytes = crypto.randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return 'AV-' + s.match(/.{5}/g).join('-');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 与 Rust 侧 licensing::machine_code 保持一致（仅展示用，不参与校验）。 */
function machineCodeOf(factors) {
  const h = crypto.createHash('sha256').update(factors.join('|')).digest('hex').toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
}

/** 解析机器指纹串。必须恰好 3 段且每段为 64 位十六进制 —— 少一段会签出必然通过的授权。 */
function parseFingerprint(text) {
  const m = /^AVFP1\.(.+)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const parts = m[1].split('.').map((s) => s.trim());
  if (parts.length !== 3) return null;
  if (!parts.every((p) => /^[0-9a-f]{64}$/i.test(p))) return null;
  return parts;
}

function cmdInit() {
  if (fs.existsSync(privPath)) {
    console.log('私钥已存在，未覆盖：' + privPath);
    console.log('如要重新生成，请先手动删除该文件（注意：旧密钥签发的授权会全部失效）。');
    return;
  }
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(licDir, {recursive: true});
  fs.writeFileSync(privPath, privateKey.export({type: 'pkcs8', format: 'pem'}), 'utf8');
  const raw = publicKey.export({type: 'spki', format: 'der'}).subarray(-32);
  fs.writeFileSync(pubPath, raw.toString('base64'), 'utf8');
  console.log('已生成 Ed25519 密钥对。');
  console.log('  私钥: ' + privPath + '   ← 绝对不要外泄');
  console.log('  公钥: ' + pubPath);
  console.log('\n客户端要嵌入的公钥（raw 32 字节 base64）：');
  console.log('  ' + raw.toString('base64'));
  console.log('\n把上面这串公钥填进 src-tauri/src/licensing.rs 的 LICENSE_PUBKEY 常量。');
}

function cmdSign(args) {
  if (!fs.existsSync(privPath)) {
    console.error('尚未初始化：请先运行  node tools/keygen.mjs init');
    process.exit(1);
  }
  const raw = args._[1] || args.fingerprint || '';
  const factors = parseFingerprint(raw);
  if (!factors) {
    console.error('机器指纹格式不正确。');
    console.error('应形如： AVFP1.<64位hex>.<64位hex>.<64位hex>');
    console.error('请让用户在软件激活页点「复制」，把完整指纹发给你。');
    process.exit(1);
  }

  const devices = Number.isFinite(args.devices) && args.devices > 0 ? args.devices : 2;
  const machineId = machineCodeOf(factors);

  // 记录用密钥：显式指定则用它，否则新分配一个（便于日后再查「这份授权是谁的」）。
  const store = readJson(keysPath, {});
  let key = args.key ? String(args.key).trim().toUpperCase() : '';
  if (key && store[key] && store[key].machineCode && store[key].machineCode !== machineId) {
    console.error('该密钥已绑定另一台机器（' + store[key].machineCode + '），请换一个或省略 --key。');
    process.exit(1);
  }
  if (!key) {
    do { key = newKey(); } while (store[key]);
  }

  const payload = {
    v: 1,
    key,
    machineId,
    factors,
    maxDevices: devices,
    perpetual: true,
    features: ['all'],
    issuedAt: new Date().toISOString(),
  };

  // 签名对象是 base64url 文本本身 —— 必须和 Rust 侧 payload_of 的验签对象完全一致。
  const priv = crypto.createPrivateKey(fs.readFileSync(privPath, 'utf8'));
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64u(crypto.sign(null, Buffer.from(body, 'utf8'), priv));
  const license = 'AVLIC1.' + body + '.' + sig;

  store[key] = {
    createdAt: new Date().toISOString(),
    maxDevices: devices,
    note: args.note || '',
    revoked: false,
    machineCode: machineId,
    issued: 'offline',
  };
  writeJson(keysPath, store);

  const outDir = path.join(licDir, 'issued');
  fs.mkdirSync(outDir, {recursive: true});
  const outFile = path.join(outDir, key + '.txt');
  fs.writeFileSync(outFile, license + '\n', 'utf8');

  console.log('已签发（绑定机器码 ' + machineId + '，' + devices + ' 台，永久）：');
  console.log('  记录用密钥: ' + key + (args.note ? '   备注: ' + args.note : ''));
  console.log('  文件: ' + outFile + '   （可直接把这个文件发给用户）');
  console.log('\n授权文件内容（复制整段发给用户也可以）：');
  console.log(license);
}

function cmdNew(args) {
  if (!fs.existsSync(privPath)) {
    console.error('尚未初始化：请先运行  node tools/keygen.mjs init');
    process.exit(1);
  }
  const count = Number.isFinite(args.count) && args.count > 0 ? args.count : 1;
  const devices = Number.isFinite(args.devices) && args.devices > 0 ? args.devices : 2;
  const store = readJson(keysPath, {});
  const made = [];
  for (let i = 0; i < count; i++) {
    let k;
    do { k = newKey(); } while (store[k]);
    store[k] = {
      createdAt: new Date().toISOString(),
      maxDevices: devices,
      note: args.note || '',
      revoked: false,
    };
    made.push(k);
  }
  writeJson(keysPath, store);
  console.log('已生成 ' + made.length + ' 个密钥（每码 ' + devices + ' 台设备，永久有效）：');
  for (const k of made) console.log('  ' + k);
  console.log('\n白名单已写入: ' + keysPath);
  console.log('把 keys.json 同步到你部署的授权服务上即可让这些码生效（供在线激活用）。');
}

function cmdList() {
  const store = readJson(keysPath, {});
  const entries = Object.entries(store);
  if (!entries.length) { console.log('还没有任何密钥。'); return; }
  console.log('共 ' + entries.length + ' 个密钥：');
  for (const [k, v] of entries) {
    const extra = [];
    if (v.machineCode) extra.push('机器码 ' + v.machineCode);
    if (v.issued) extra.push('方式:' + v.issued);
    if (v.revoked) extra.push('[已吊销]');
    if (v.note) extra.push(v.note);
    console.log('  ' + k + '  ' + v.maxDevices + '台  ' + extra.join('  '));
  }
}

function cmdPubkey() {
  if (!fs.existsSync(pubPath)) { console.error('尚未初始化，请先 init。'); process.exit(1); }
  console.log(fs.readFileSync(pubPath, 'utf8').trim());
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'help';
({init: cmdInit, sign: () => cmdSign(args), new: () => cmdNew(args), list: cmdList, pubkey: cmdPubkey, help: () => {
  console.log('用法: node tools/keygen.mjs <init|sign|new|list|pubkey> [选项]');
  console.log('  init                     生成密钥对（只做一次）');
  console.log('  sign "<机器指纹>"        为指定机器签发授权文件（离线，主用）');
  console.log('       [--key AV-XXXXX-…] [--devices 台数] [--note 备注]');
  console.log('  new [-n 数量] [--devices 台数] [--note 备注]   仅生成密钥（在线模式用）');
  console.log('  list                     列出所有密钥');
  console.log('  pubkey                   打印公钥');
}})[cmd]?.();
