import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';
import {createWebdavSync} from '../server/webdav-sync.mjs';

test('WebDAV 内容未变时忽略导出时间，真实标注变化仍上传', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-sync-clock-'));
  const storage = createLibraryStorage(dir, {snapshot: () => ({jobs: []})}, {});
  t.after(async () => { await storage.close(); await fs.rm(dir, {recursive: true, force: true}); });
  const uid = 'a'.repeat(32);
  await storage.save({[MAIN_STATE_KEY]: JSON.stringify({version: 2, models: [{uid, name: '测试资产', platform: 'sketchfab'}], trashed: [], favorites: [], userMeta: {}, userTags: {}, aiTags: {}})});
  const remote = new Map();
  let puts = 0;
  const fetchImpl = async (url, {method, body}) => {
    const key = new URL(url).pathname;
    if (method === 'PROPFIND') return new Response('', {status: 207});
    if (method === 'MKCOL') return new Response(null, {status: 201});
    if (method === 'GET') return remote.has(key) ? new Response(remote.get(key)) : new Response(null, {status: 404});
    if (method === 'PUT') { puts++; remote.set(key, Buffer.from(body)); return new Response(null, {status: 201}); }
    throw Error(`意外方法 ${method}`);
  };
  let clock = 1700000000000;
  const sync = createWebdavSync({storage, dataDir: dir, fetchImpl, now: () => clock});
  await sync.saveConfig({url: 'https://dav.invalid', auto: false});
  assert.equal((await sync.run()).action, 'uploaded');
  assert.equal(puts, 2);
  assert.equal(JSON.parse(remote.get('/AssetVault/library.json')).exportedAt, clock);
  clock += 10000;
  assert.equal((await sync.run()).action, 'noop');
  assert.equal(puts, 2, '仅时钟变化不能上传');
  await storage.withDb(db => db.applyUserSeeds([{uid, note: '新备注'}], {now: clock}));
  assert.equal((await sync.run()).action, 'uploaded');
  assert.equal(puts, 4, '业务内容变化仍需上传');
});
