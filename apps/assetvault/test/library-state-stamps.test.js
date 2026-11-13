// ADR-02 性能修复的契约守卫：逐域版本戳。
//
// 背景：50 万库上 state_meta 的目录域原串有 209MB。以前每次「谁更新」的比较都
// `SELECT key, value, updated_at FROM state_meta`，把 209MB 搬进内存 ——
// 记一次搜索历史实测 7.2 秒。现在版本戳同步写进小表 db_meta，只有 DB 确实更新
// （或文件丢失）时才会取那一行的 value。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createLibraryStorage, stateFileFor} from '../server/library-storage.mjs';
import {MAIN_STATE_KEY, SESSION_STATE_KEY, stateStampKey} from '../server/library-schema.mjs';

const uid = n => `${String(n).padStart(32, 'a')}`;
const blob = () => JSON.stringify({
  version: 2, models: [{uid: uid(1), name: '国风石灯', addedAt: 1}],
  favorites: [], aiTags: {}, userTags: {}, userMeta: {}, trashed: [], history: [], tasks: [], options: {},
});

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-stamps-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}
const openDb = dir => new Database(path.join(dir, 'library.db'));
const stampsOf = db => new Map(db.prepare("SELECT key, value FROM db_meta WHERE key LIKE 'state_stamp:%'").all()
  .map(row => [row.key, Number(row.value)]));

test('每次提交都写逐域版本戳，且等于各自文件的 mtime（不共用 max）', async t => {
  const dir = await temp(t);
  const storage = createLibraryStorage(dir, null, {});
  await storage.save({[MAIN_STATE_KEY]: blob()});
  await storage.mutate(
    values => ({...values, [SESSION_STATE_KEY]: JSON.stringify({history: [{kind: 'search'}]})}),
    {derived: false});

  const mainStat = await fs.stat(stateFileFor(dir, MAIN_STATE_KEY));
  const sessionStat = await fs.stat(stateFileFor(dir, SESSION_STATE_KEY));
  const db = openDb(dir);
  const stamps = stampsOf(db);
  db.close();
  assert.equal(stamps.get(stateStampKey(MAIN_STATE_KEY)), mainStat.mtimeMs);
  assert.equal(stamps.get(stateStampKey(SESSION_STATE_KEY)), sessionStat.mtimeMs);
  // 一批同时写两个域时，目录域的戳不能被会话域的 mtime 抬高 ——
  // 否则读权威会误判「DB 更新」而白搬 209MB。
  assert.ok(stamps.get(stateStampKey(MAIN_STATE_KEY)) <= stamps.get(stateStampKey(SESSION_STATE_KEY)));
});

test('文件完好且戳相等时不读 state_meta 的 value：DB 里的原串被污染也不影响', async t => {
  const dir = await temp(t);
  const main = blob();
  await createLibraryStorage(dir, null, {}).save({[MAIN_STATE_KEY]: main});
  const db = openDb(dir);
  db.prepare('UPDATE state_meta SET value = ? WHERE key = ?')
    .run(JSON.stringify({version: 2, models: []}), MAIN_STATE_KEY);
  db.close();
  // 新实例：缓存是空的，读权威必须靠版本戳判断，而不是把 DB 的 value 无条件搬回来。
  const loaded = await createLibraryStorage(dir, null, {}).load();
  assert.equal(loaded.values[MAIN_STATE_KEY], main, '文件是权威，不该被 DB 里被改坏的原串覆盖');
});

test('老库没有轻量戳时读一次 state_meta 补齐，之后行为不变', async t => {
  const dir = await temp(t);
  const main = blob();
  await createLibraryStorage(dir, null, {}).save({[MAIN_STATE_KEY]: main});
  const db = openDb(dir);
  db.prepare("DELETE FROM db_meta WHERE key LIKE 'state_stamp:%'").run();
  const before = db.prepare('SELECT updated_at FROM state_meta WHERE key = ?').get(MAIN_STATE_KEY).updated_at;
  db.close();

  const storage = createLibraryStorage(dir, null, {});
  const loaded = await storage.load();
  assert.equal(loaded.values[MAIN_STATE_KEY], main);
  const db2 = openDb(dir);
  assert.equal(stampsOf(db2).get(stateStampKey(MAIN_STATE_KEY)), before, '补齐的戳要取 state_meta 的原值');
  db2.close();
});

test('目录域文件丢失时仍能从 state_meta 恢复（轻量戳不改变恢复语义）', async t => {
  const dir = await temp(t);
  const main = blob();
  await createLibraryStorage(dir, null, {}).save({[MAIN_STATE_KEY]: main});
  await fs.rm(stateFileFor(dir, MAIN_STATE_KEY));
  const loaded = await createLibraryStorage(dir, null, {}).load();
  assert.equal(loaded.values[MAIN_STATE_KEY], main);
  assert.equal(JSON.parse(loaded.values[MAIN_STATE_KEY]).models.length, 1);
});
