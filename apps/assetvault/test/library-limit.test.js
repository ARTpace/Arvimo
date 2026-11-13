// 阶段 3：解除 1000 条 / 4MB 上限，并锁住「SQLite 是资产库权威副本」的恢复路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadLibrary, collectModels, LIBRARY_LIMIT, STORAGE_KEY} from '../src/library/library-state.js';
import {createLibraryStorage, MAX_STATE_BYTES, stateFileFor} from '../server/library-storage.mjs';

const uid = index => index.toString(16).padStart(32, '0');
const many = count => Array.from({length: count}, (_, index) => ({uid: uid(index), name: `资产 ${index}`, tags: []}));
const memoryStorage = values => ({getItem: key => values[key] ?? null, setItem(key, value) { values[key] = String(value); }});
const downloads = {snapshot: () => ({jobs: []})};

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-limit-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('1000 条上限改成单一常量，1200 条资产能完整载入与合并', () => {
  assert.ok(LIBRARY_LIMIT > 1000);
  const models = many(1200);
  const values = {[STORAGE_KEY]: JSON.stringify({version: 2, models})};
  assert.equal(loadLibrary(memoryStorage(values)).models.length, 1200);

  const merged = collectModels([], models);
  assert.equal(merged.added, 1200);
  assert.equal(merged.refused, 0, '旧实现会在第 1001 条开始拒绝');
  assert.equal(merged.models.length, 1200);

  const capped = collectModels([], models, 1000);
  assert.equal(capped.refused, 200, '阈值仍可通过参数注入，策略缝没被写死');
});

test('状态体积上限同步放宽，>4MB 的整块状态可正常保存', async t => {
  assert.ok(MAX_STATE_BYTES > 4 * 1024 * 1024);
  const dir = await temp(t);
  const storage = createLibraryStorage(dir, downloads, {disableDb: true});
  const big = 'x'.repeat(5 * 1024 * 1024);
  await storage.save({'sfx-library-ui': big});
  assert.equal((await storage.load()).values['sfx-library-ui'], big);
  // save() 的校验是同步抛错（保持旧契约），不是返回 rejected Promise。
  assert.throws(() => storage.save({'sfx-library-ui': 'y'.repeat(MAX_STATE_BYTES + 1)}), /格式无效/);
});

test('域快照丢失时从 SQLite 的 state_meta 恢复，不丢资产', async t => {
  const dir = await temp(t);
  const blob = JSON.stringify({version: 2, models: many(12), favorites: [], aiTags: {}, userTags: {}, userMeta: {}, trashed: [], history: [], tasks: [], options: {}});
  const first = createLibraryStorage(dir, downloads);
  await first.save({[STORAGE_KEY]: blob});
  await fs.rm(stateFileFor(dir, STORAGE_KEY));
  const second = createLibraryStorage(dir, downloads);
  const loaded = await second.load();
  assert.equal(loaded.values[STORAGE_KEY], blob, '文件快照只是最后防线，DB 里的原串才是运行时权威');
  assert.equal(JSON.parse(loaded.values[STORAGE_KEY]).models.length, 12);
});
