#!/usr/bin/env node
// AssetVault 授权服务管理工具（命令行，走 HTTP 调 /api/admin）
//
// 用法:  node license-server/admin.mjs <命令> [参数]
// 环境:  AV_SERVER (默认 http://127.0.0.1:8787)   AV_ADMIN_TOKEN (必填)
//
//   list                              列出所有密钥、激活台数与机器码
//   new -n 20 [--devices 2] [--note 淘宝]   在线批量发码
//   revoke  AV-XXXXX-...              吊销（用户无法再激活新设备）
//   restore AV-XXXXX-...              恢复
//   unbind  AV-XXXXX-... [--index 0]  解绑第 N 台设备，用于用户换机
//   unbind  AV-XXXXX-... --machine <machineId>

const SERVER = (process.env.AV_SERVER || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.AV_ADMIN_TOKEN || '';

function parse(argv) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n' || a === '--count') out.count = Number(argv[++i]);
    else if (a === '--devices') out.devices = Number(argv[++i]);
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--index') out.index = Number(argv[++i]);
    else if (a === '--machine') out.machine = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function call(payload) {
  if (!TOKEN) {
    console.error('缺少 AV_ADMIN_TOKEN 环境变量。');
    console.error('例:  AV_ADMIN_TOKEN=你的令牌 node license-server/admin.mjs list');
    process.exit(1);
  }
  const res = await fetch(SERVER + '/api/admin', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-AV-Token': TOKEN},
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    console.error('失败: ' + (json.message || json.error || res.status));
    process.exit(1);
  }
  return json;
}

const args = parse(process.argv.slice(2));
const cmd = args._[0] || 'help';

if (cmd === 'list') {
  const r = await call({action: 'list'});
  console.log('共 ' + r.keys.length + ' 个密钥\n');
  for (const k of r.keys) {
    const used = k.devices.length + '/' + k.maxDevices;
    console.log(k.key + '   ' + used + ' 台   ' + (k.revoked ? '[已吊销]' : '正常') + (k.note ? '   ' + k.note : ''));
    for (const [i, d] of k.devices.entries()) {
      console.log('      [' + i + '] ' + d.machineId + '  ' + d.activatedAt);
    }
  }
} else if (cmd === 'new') {
  const r = await call({action: 'newkey', count: args.count || 1, maxDevices: args.devices || 2, note: args.note || ''});
  console.log('已生成 ' + r.keys.length + ' 个：');
  for (const k of r.keys) console.log('  ' + k);
} else if (cmd === 'revoke' || cmd === 'restore') {
  const key = args._[1];
  if (!key) { console.error('请给出密钥'); process.exit(1); }
  await call({action: cmd, key});
  console.log((cmd === 'revoke' ? '已吊销 ' : '已恢复 ') + key);
} else if (cmd === 'unbind') {
  const key = args._[1];
  if (!key) { console.error('请给出密钥'); process.exit(1); }
  const body = {action: 'unbind', key};
  if (Number.isInteger(args.index)) body.index = args.index;
  if (args.machine) body.machineId = args.machine;
  const r = await call(body);
  console.log('已解绑 ' + JSON.stringify(r.removed) + '，该用户可以重新激活一台设备。');
} else {
  console.log('用法: node license-server/admin.mjs <list|new|revoke|restore|unbind> [参数]');
  console.log('  需要环境变量 AV_ADMIN_TOKEN，可选 AV_SERVER');
}
