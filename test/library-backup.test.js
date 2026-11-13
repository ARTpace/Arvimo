import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {createBackupService} from '../server/library-backup.mjs';

const U = n => `${String(n).padStart(32, 'a')}`;
const stateOf = models => JSON.stringify({
  version: 2, models, aiTags: {}, userTags: {}, userMeta: {}, favorites: [], trashed: [], history: [], tasks: [], options: {},
});
async function fixture(t, {keep = 5, models = 2} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-backup-'));
  const storage = createLibraryStorage(dir, null, {});
  const backups = createBackupService({storage, keep});
  t.after(async () => { backups.stop(); await storage.close(); await fs.rm(dir, {recursive: true, force: true}); });
  const items = Array.from({length: models}, (_, index) => ({
    uid: U(index + 1), name: `资产${index + 1}`, platform: 'sketchfab', assetType: 'model', ext: 'fbx', tags: ['stone'], addedAt: 1000 + index,
  }));
  await fs.writeFile(path.join(dir, 'library-state.json'), JSON.stringify({'sfx-library-v2': stateOf(items)}));
  return {dir, storage, backups, models: items};
}
const readState = async dir => JSON.parse(JSON.parse(await fs.readFile(path.join(dir, 'library-state.json'), 'utf8'))['sfx-library-v2']);
async function changeLibrary(storage, dir, models) {
  const values = {'sfx-library-v2': stateOf(models)};
  await fs.writeFile(path.join(dir, 'library-state.json'), JSON.stringify(values));
  await storage.withDb(conn => conn.writeValues(values, {replace: true}));
}

test('备份是一份自包含的快照：DB 与权威 blob 都在里面', async t => {
  const {dir, backups} = await fixture(t);
  const result = await backups.runNow();
  assert.match(result.name, /^\d{8}-\d{6}$/);
  assert.equal(result.assets, 2);
  const folder = path.join(dir, 'backups', result.name);
  assert.deepEqual((await fs.readdir(folder)).sort(), ['library-state.json', 'library.db', 'meta.json']);
  assert.equal((await readState(folder)).models.length, 2);
  assert.equal((await fs.readFile(path.join(folder, 'library.db'))).subarray(0, 15).toString(), 'SQLite format 3');
  const list = await backups.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, result.name);
  assert.equal(list[0].assets, 2);
  assert.equal(list[0].hasDatabase, true);
});

test('恢复回到备份那一刻，并留下恢复前现状', async t => {
  const {dir, storage, backups, models} = await fixture(t);
  const first = await backups.runNow();
  await changeLibrary(storage, dir, [...models, {uid: U(99), name: '后来的资产', addedAt: 9999}]);
  const result = await backups.restore(first.name);
  assert.equal(result.restored, first.name);
  assert.ok(result.safety?.name);
  assert.equal((await readState(dir)).models.length, 2);
  assert.ok((await backups.list()).some(item => item.name === result.safety.name));
});

test('保留份数：超出上限的旧备份被清掉', async t => {
  const {dir, backups} = await fixture(t, {keep: 2});
  await backups.runNow(); await backups.runNow(); await backups.runNow();
  assert.equal((await backups.list()).length, 2);
  assert.equal((await fs.readdir(path.join(dir, 'backups'))).filter(name => /^\d{8}-\d{6}/.test(name)).length, 2);
});

test('非法备份编号与不存在的备份都明确报错', async t => {
  const {backups} = await fixture(t);
  await assert.rejects(backups.restore('../../etc/passwd'), /备份编号无效/);
  await assert.rejects(backups.restore('20200101-000000'), /备份不存在/);
});

test('备份失败不发布半份快照，定时器可安全停止', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-backup-fail-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const blocker = path.join(dir, 'blocker');
  await fs.writeFile(blocker, 'not a directory');
  const warnings = [];
  const service = createBackupService({storage: {dataDir: dir, withDb: async () => null}, dir: path.join(blocker, 'backups'), onWarn: message => warnings.push(message)});
  await assert.rejects(service.runNow(), /ENOTDIR|ENOTEMPTY|EPERM|EEXIST/);
  service.start(); service.stop();
  assert.ok(Array.isArray(warnings));
});

for (const keep of [1, 3]) {
  test(`满额 keep=${keep} 恢复最老项，DB/状态完整且安全副本可以退回`, async t => {
    const {dir, storage, backups, models} = await fixture(t, {keep});
    await fs.mkdir(storage.stateDir);
    await fs.writeFile(path.join(storage.stateDir, 'custom.json'), '{"value":"old"}');
    const first = await backups.runNow();
    for (let index = 1; index < keep; index++) await backups.runNow();
    const changed = [...models, {uid: U(99), name: 'later'}];
    await changeLibrary(storage, dir, changed);
    await fs.writeFile(path.join(storage.stateDir, 'custom.json'), '{"value":"new"}');
    await fs.writeFile(path.join(storage.stateDir, 'extra.json'), '{}');
    const result = await backups.restore(first.name);
    assert.equal((await readState(dir)).models.length, models.length);
    assert.equal(await storage.withDb(conn => conn.counts().assets), models.length);
    assert.equal(JSON.parse(await fs.readFile(path.join(storage.stateDir, 'custom.json'))).value, 'old');
    await assert.rejects(fs.access(path.join(storage.stateDir, 'extra.json')), /ENOENT/);
    assert.equal((await backups.list()).length, keep);
    assert.ok((await backups.list()).some(item => item.name === result.safety.name));
    await backups.restore(result.safety.name);
    assert.equal((await readState(dir)).models.length, changed.length);
    assert.equal(await storage.withDb(conn => conn.counts().assets), changed.length);
    assert.equal(JSON.parse(await fs.readFile(path.join(storage.stateDir, 'custom.json'))).value, 'new');
    assert.deepEqual((await fs.readdir(dir)).filter(name => name.startsWith('.restore-')), []);
  });
}

test('损坏/缺失快照文件与旧版坏 DB 均在修改现库前拒绝', async t => {
  const {dir, storage, backups} = await fixture(t);
  const first = await backups.runNow();
  const folder = path.join(dir, 'backups', first.name);
  const before = await fs.readFile(path.join(dir, 'library-state.json'));
  await fs.writeFile(path.join(folder, 'library-state.json'), '{broken');
  await assert.rejects(backups.restore(first.name), /完整性校验/);
  assert.deepEqual(await fs.readFile(path.join(dir, 'library-state.json')), before);
  await fs.rm(path.join(folder, 'library.db'));
  await assert.rejects(backups.restore(first.name), /完整性校验/);
  await fs.writeFile(path.join(folder, 'meta.json'), JSON.stringify({version: 2, hasDatabase: true}));
  await fs.writeFile(path.join(folder, 'library-state.json'), before);
  await fs.writeFile(path.join(folder, 'library.db'), 'SQLite format 3\0corrupt');
  await assert.rejects(backups.restore(first.name), /database|数据库|file is not/i);
  assert.deepEqual(await fs.readFile(path.join(dir, 'library-state.json')), before);
  assert.equal(await storage.withDb(conn => conn.counts().assets), 2);
  assert.equal((await backups.list()).length, 1);
});

test('安全备份失败必须中止恢复，现库与目标备份保持不变', async t => {
  const {dir, storage, backups, models} = await fixture(t, {keep: 1});
  const first = await backups.runNow();
  await changeLibrary(storage, dir, [...models, {uid: U(99), name: 'later'}]);
  const before = await fs.readFile(path.join(dir, 'library-state.json'));
  const original = storage.ensureIndex;
  storage.ensureIndex = async () => { throw Error('injected safety failure'); };
  await assert.rejects(backups.restore(first.name), /injected safety failure/);
  storage.ensureIndex = original;
  assert.deepEqual(await fs.readFile(path.join(dir, 'library-state.json')), before);
  assert.equal(await storage.withDb(conn => conn.counts().assets), 3);
  assert.equal((await backups.list())[0].name, first.name);
});

test('暂存复制失败不修改现库，备份复制失败不发布半份备份', async t => {
  const {dir, storage, backups} = await fixture(t);
  const first = await backups.runNow();
  const before = await fs.readFile(path.join(dir, 'library-state.json'));
  const copyFile = fs.copyFile;
  t.mock.method(fs, 'copyFile', async (source, target, ...args) => {
    if (String(target).includes(`${path.sep}staged${path.sep}`)) throw Error('injected copy failure');
    return copyFile(source, target, ...args);
  });
  await assert.rejects(backups.restore(first.name), /injected copy failure/);
  assert.deepEqual(await fs.readFile(path.join(dir, 'library-state.json')), before);
  t.mock.restoreAll();
  await fs.mkdir(storage.stateDir);
  await fs.writeFile(path.join(storage.stateDir, 'custom.json'), '{}');
  t.mock.method(fs, 'copyFile', async (source, target, ...args) => {
    if (String(source).startsWith(storage.stateDir)) throw Error('injected state copy failure');
    return copyFile(source, target, ...args);
  });
  await assert.rejects(backups.runNow(), /injected state copy failure/);
  assert.equal((await backups.list()).length, 1);
  assert.deepEqual((await fs.readdir(path.join(dir, 'backups'))).filter(name => name.endsWith('.tmp')), []);
});

test('替换中途失败回滚已安装状态和原 DB，保留安全备份', async t => {
  const {dir, storage, backups, models} = await fixture(t, {keep: 1});
  await fs.mkdir(storage.stateDir);
  await fs.writeFile(path.join(storage.stateDir, 'custom.json'), '{"value":"old"}');
  const first = await backups.runNow();
  await changeLibrary(storage, dir, [...models, {uid: U(99), name: 'later'}]);
  await fs.writeFile(path.join(storage.stateDir, 'custom.json'), '{"value":"new"}');
  const before = await fs.readFile(path.join(dir, 'library-state.json'));
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (String(source).includes(`${path.sep}staged${path.sep}`) && path.basename(source) === 'library.db') throw Error('injected install failure');
    return rename(source, target);
  });
  await assert.rejects(backups.restore(first.name), /injected install failure/);
  assert.deepEqual(await fs.readFile(path.join(dir, 'library-state.json')), before);
  assert.equal(JSON.parse(await fs.readFile(path.join(storage.stateDir, 'custom.json'))).value, 'new');
  assert.equal(await storage.withDb(conn => conn.counts().assets), 3);
  assert.equal((await backups.list()).length, 2, '失败不清理目标或安全副本');
  t.mock.restoreAll();
  const safety = (await backups.list()).find(item => item.name !== first.name);
  await backups.restore(safety.name);
  assert.equal(await storage.withDb(conn => conn.counts().assets), 3);
});

test('恢复、跨实例备份和清理互斥，同秒并发备份不冲突', async t => {
  const {dir, storage, backups} = await fixture(t, {keep: 1});
  const first = await backups.runNow();
  const peer = createBackupService({storage, keep: 1});
  let entered;
  const paused = new Promise(resolve => { entered = resolve; });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const exclusive = storage.exclusive;
  storage.exclusive = action => exclusive(async () => { entered(); await gate; return action(); });
  const restoring = backups.restore(first.name);
  await paused;
  let completed = false;
  const concurrent = peer.runNow().then(() => { completed = true; });
  const pruning = peer.prune();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.ok((await backups.list()).some(item => item.name === first.name));
  resume();
  await Promise.all([restoring, concurrent, pruning]);
  storage.exclusive = exclusive;
  const names = await Promise.all(Array.from({length: 4}, () => peer.runNow()));
  assert.equal(new Set(names.map(item => item.name)).size, 4);
  assert.equal((await backups.list()).length, 1);
  assert.equal(await storage.withDb(conn => conn.counts().assets), 2);
});
