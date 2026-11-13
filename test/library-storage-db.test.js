import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createLibraryStorage, stateFileFor} from '../server/library-storage.mjs';
import {createLibraryDb} from '../server/library-db.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32);
const blob = models => JSON.stringify({version: 2, models, favorites: [], aiTags: {}, userTags: {}, userMeta: {}, trashed: [], history: [], tasks: [], options: {}});
const downloads = {snapshot: () => ({jobs: []})};
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-storage-db-'));

test('前端契约不变：save 后 load 逐字节还原，并留一份人工可读的迁移前快照', async () => {
  const dir = await temp();
  try {
    const main = blob([{uid: a, name: '国风石灯'}]);
    await fs.writeFile(path.join(dir, 'library-state.json'), JSON.stringify({'sfx-library-v2': main}));
    const first = createLibraryStorage(dir, downloads);
    await first.save({'sfx-library-v2': main, 'sfx-library-ui': '{}'});
    const second = createLibraryStorage(dir, downloads);
    const loaded = await second.load();
    assert.equal(loaded.values['sfx-library-v2'], main);
    assert.equal(loaded.values['sfx-library-ui'], '{}');
    assert.equal(loaded.scanIndex, true);
    assert.equal((await fs.readFile(path.join(dir, 'library-state.pre-db.json'), 'utf8')).includes('sfx-library-v2'), true);
    const db = createLibraryDb({Database, file: path.join(dir, 'library.db')});
    try { assert.equal(db.counts().assets, 1); assert.deepEqual(db.search('国风').map(r => r.uid), [a]); }
    finally { db.close(); }
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('快照比索引新时自动重建索引（上次写 DB 失败也能自愈）', async () => {
  const dir = await temp();
  try {
    const storage = createLibraryStorage(dir, downloads);
    await storage.save({'sfx-library-v2': blob([{uid: a, name: 'Old'}])});
    const updated = blob([{uid: a, name: 'New one'}, {uid: b, name: '国风石灯'}]);
    const file = stateFileFor(dir, 'sfx-library-v2');
    await fs.writeFile(file, JSON.stringify(updated));
    const future = new Date(Date.now() + 2000);
    await fs.utimes(file, future, future);
    const loaded = await createLibraryStorage(dir, downloads).load();
    assert.equal(loaded.values['sfx-library-v2'], updated);
    const db = createLibraryDb({Database, file: path.join(dir, 'library.db')});
    try { assert.equal(db.counts().assets, 2); assert.deepEqual(db.search('国风').map(r => r.uid), [b]); }
    finally { db.close(); }
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('损坏的快照照旧报错，DB 里的副本不掩盖数据问题', async () => {
  const dir = await temp();
  try {
    const main = blob([{uid: a, name: 'Keep'}]);
    const storage = createLibraryStorage(dir, downloads);
    await storage.save({'sfx-library-v2': main});
    await fs.writeFile(stateFileFor(dir, 'sfx-library-v2'), 'invalid');
    await assert.rejects(storage.load(), /保留原文件/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('关闭内核或原生依赖加载失败时，服务仍可用且不会创建数据库文件', async () => {
  const dir = await temp();
  try {
    const main = blob([{uid: a, name: 'Fallback'}]);
    const off = createLibraryStorage(dir, downloads, {disableDb: true});
    await off.save({'sfx-library-v2': main});
    assert.equal((await off.load()).values['sfx-library-v2'], main);
    await assert.rejects(fs.access(path.join(dir, 'library.db')));
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('ABI 不匹配的降级路径只警告一次，不阻断后续读写', async () => {
  const dir = await temp();
  try {
    const warnings = [];
    const storage = createLibraryStorage(dir, downloads, {
      dbImporter: async () => { throw Error('ABI mismatch'); },
      onWarn: message => warnings.push(message),
    });
    const main = blob([{uid: a, name: 'Still works'}]);
    await storage.save({'sfx-library-v2': main});
    assert.equal((await storage.load()).values['sfx-library-v2'], main);
    assert.equal((await storage.load()).values['sfx-library-v2'], main);
    assert.ok(warnings.some(message => message.includes('SQLite 不可用')));
    assert.equal(warnings.filter(message => message.includes('SQLite 不可用')).length, 1);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
