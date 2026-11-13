import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {createLibraryApi} from '../server/library-api.mjs';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';
import {PORTABLE_FORMAT} from '../server/library-portable.mjs';

const oldUid = 'a'.repeat(32), newUid = 'b'.repeat(32);
const snapshot = () => ({format: PORTABLE_FORMAT, version: 1, assets: [{uid: newUid, name: 'new'}], trashed: [], collections: []});
const dump = conn => Object.fromEntries(conn.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .map(({name}) => [name, conn.all(`SELECT * FROM "${name}"`).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));

async function call(api, body, extra = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  Object.assign(req, {method: 'POST', headers: {'x-sfx-local': '1'}, ...extra});
  const res = {status: 0, body: '', writeHead(status) { this.status = status; }, end(value) { this.body = value; }};
  assert.equal(await api.handle(req, res, new URL('http://127.0.0.1/api/library/import')), true);
  return {status: res.status, data: JSON.parse(res.body)};
}

async function fixture(t, backups) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-portable-api-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const storage = createLibraryStorage(dir, null, {});
  await storage.save({[MAIN_STATE_KEY]: JSON.stringify({version: 2, models: [{uid: oldUid, name: 'old'}], trashed: [], userMeta: {}, userTags: {}, aiTags: {}, favorites: [], options: {keep: true}})});
  let writes = 0;
  const tracked = Object.create(storage);
  tracked.withDbWrite = handler => { writes += 1; return storage.withDbWrite(handler); };
  const api = createLibraryApi({storage: tracked, backups});
  t.after(() => api.dispose());
  const emitted = [];
  const emit = api.events.emit;
  api.events.emit = value => { emitted.push(value); return emit(value); };
  const beforeValues = await storage.withDb(dump);
  const beforeBytes = await fs.readFile(path.join(dir, 'library.db'));
  return {storage, api, emitted, get writes() { return writes; }, async unchanged() {
    assert.equal(writes, 0, '未调用导入写事务');
    assert.deepEqual(emitted, [], '未发送变更广播');
    assert.deepEqual(await fs.readFile(path.join(dir, 'library.db')), beforeBytes, '数据库文件逐字节不变');
    assert.deepEqual(await storage.withDb(dump), beforeValues, '所有数据库表值不变');
  }};
}

test('replace 未确认在备份与导入之前拒绝', async t => {
  let backups = 0;
  const f = await fixture(t, {runNow: async () => { backups += 1; }});
  const result = await call(f.api, {mode: 'replace', snapshot: snapshot()});
  assert.equal(result.status, 400);
  assert.equal(result.data.needsConfirm, true);
  assert.equal(backups, 0);
  await f.unchanged();
});

test('无效快照先拒绝，不运行备份或导入，整库零变更', async t => {
  let backups = 0;
  const f = await fixture(t, {runNow: async () => { backups += 1; }});
  for (const mode of ['replace', 'merge']) {
    const result = await call(f.api, {mode, confirm: true, snapshot: {...snapshot(), assets: [{uid: 'invalid'}]}});
    assert.equal(result.status, 400);
  }
  assert.equal(backups, 0);
  await f.unchanged();
});

test('replace 安全备份抛错返回明确503，禁止导入和广播且DB字节/值不变', async t => {
  let backups = 0;
  const f = await fixture(t, {runNow: async () => { backups += 1; throw Error('fake disk failure'); }});
  const result = await call(f.api, {mode: 'replace', confirm: true, snapshot: snapshot()});
  assert.equal(result.status, 503);
  assert.equal(result.data.code, 'safety_backup_failed');
  assert.match(result.data.error, /已取消.*备份失败/);
  assert.equal(backups, 1);
  await f.unchanged();
});

for (const backups of [null, {}]) test(`replace 备份服务${backups ? '缺少runNow' : '缺失'}时失败关闭`, async t => {
  const f = await fixture(t, backups);
  const result = await call(f.api, {mode: 'replace', confirm: true, snapshot: snapshot()});
  assert.equal(result.status, 503);
  assert.equal(result.data.code, 'safety_backup_unavailable');
  await f.unchanged();
});

test('replace 成功备份后才进入导入，返回安全副本并发送一次广播', async t => {
  let f, backups = 0;
  const safety = {name: 'fake-safe-copy'};
  f = await fixture(t, {runNow: async () => {
    backups += 1;
    assert.equal(f.writes, 0);
    assert.deepEqual((await f.storage.withDb(conn => conn.readCatalog())).models.map(item => item.uid), [oldUid]);
    return safety;
  }});
  const result = await call(f.api, {mode: 'replace', confirm: true, snapshot: snapshot()});
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.safety, safety);
  assert.equal(backups, 1);
  assert.equal(f.writes, 1);
  assert.equal(f.emitted.length, 1);
  assert.deepEqual((await f.storage.withDb(conn => conn.readCatalog())).models.map(item => item.uid), [newUid]);
});

for (const backups of [null, {runNow: async () => { throw Error('merge must not call backup'); }}]) test('merge 不依赖备份服务且保留旧资产', async t => {
  const f = await fixture(t, backups);
  const result = await call(f.api, {mode: 'merge', snapshot: snapshot()});
  assert.equal(result.status, 200);
  assert.equal(result.data.safety, null);
  assert.equal(f.writes, 1);
  assert.equal(f.emitted.length, 1);
  assert.deepEqual((await f.storage.withDb(conn => conn.readCatalog())).models.map(item => item.uid).sort(), [oldUid, newUid]);
});

test('LAN 未授权身份仍在备份和导入之前被拒绝', async t => {
  let backups = 0;
  const f = await fixture(t, {runNow: async () => { backups += 1; }});
  const result = await call(f.api, {mode: 'replace', confirm: true, snapshot: snapshot()}, {lanVisitor: true, lanUser: 'visitor'});
  assert.equal(result.status, 403);
  assert.equal(backups, 0);
  await f.unchanged();
});
