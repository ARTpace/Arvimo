import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryServer} from '../server/library.mjs';

const uid = n => String(n).repeat(32);
const headers = {'X-SFX-Local': '1', 'Content-Type': 'application/json'};
test('智能画板保存零写入校验、排序持久、规则OR手动AND用户条件及真实分页', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-smart-'));
  const previous = process.env.SFX_DATA_DIR;
  process.env.SFX_DATA_DIR = dir;
  let server;
  try { server = createLibraryServer(); }
  finally { if (previous === undefined) delete process.env.SFX_DATA_DIR; else process.env.SFX_DATA_DIR = previous; }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(dir, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body) => {
    const response = await fetch(base + '/api/' + route, {method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, ...await response.json()};
  };
  await call('library-state', {'sfx-library-v2': JSON.stringify({version: 2, models: [
    {uid: uid(1), name: 'A stone', tags: ['stone'], addedAt: 1, filePath: '/test/a'},
    {uid: uid(2), name: 'B stone', tags: ['stone'], addedAt: 2},
    {uid: uid(3), name: 'C manual', tags: ['wood'], addedAt: 3},
    {uid: uid(4), name: 'D outside', tags: ['wood'], addedAt: 4},
  ], trashed: [{uid: uid(5), name: 'E trashed', tags: ['wood'], trashedAt: 5}], favorites: [], userMeta: {}, userTags: {}, aiTags: {}})});
  for (const body of [{q: '| -'}, {filters: {rating: [0, 5], favorite: false, bogus: true}}, {sort: 'rating'}]) {
    assert.equal((await call('library/smart-collections', {name: 'reject', ...body})).status, 400);
  }
  assert.equal((await call('library/collections')).collections.length, 0);
  const created = await call('library/smart-collections', {name: 'stone', q: 'tag:stone', sort: 'recent', sortOrder: 'desc', seed: 'stable'});
  assert.equal(created.status, 200);
  assert.equal(created.rule.sortOrder, 'desc');
  assert.equal(created.rule.seed, 'stable');
  const listed = (await call('library/collections')).collections[0];
  assert.equal(listed.smart.sortOrder, 'desc');
  assert.equal(listed.smart.seed, 'stable');
  assert.deepEqual(listed.smart.filters, {});
  await call('library/collections/items', {id: created.id, uids: [uid(1), uid(3), uid(5)], action: 'set'});
  const resolve = extra => call('library/smart-collections/resolve', {id: created.id, uidScope: 'page', limit: 1, ...extra});
  const first = await resolve({});
  assert.equal(first.total, 3);
  assert.deepEqual(first.uids, [uid(1)]);
  assert.equal(first.items[0].filePath, '/test/a');
  assert.equal(first.hasMore, true);
  assert.equal(first.pushdown, true);
  const second = await resolve({offset: 1});
  assert.deepEqual(second.uids, [uid(2)]);
  const third = await resolve({offset: 2});
  assert.deepEqual(third.uids, [uid(3)]);
  assert.equal(third.hasMore, false);
  const outside = await resolve({q: 'name:outside | name:manual'});
  assert.deepEqual(outside.uids, [uid(3)], 'OR不可逃离规则或manual scope');
  assert.equal(outside.total, 1);
  const sameField = await resolve({filters: {tags: ['wood']}});
  assert.deepEqual(sameField.uids, [uid(3)], '用户同字段条件不得覆盖规则且manual仍能命中');
  assert.equal(sameField.total, 1);
  const reversed = await resolve({sortOrder: 'asc'});
  assert.deepEqual(reversed.uids, [uid(3)]);
  const fallback = await resolve({q: 'path:/test'});
  assert.equal(fallback.pushdown, false);
  assert.deepEqual(fallback.uids, [uid(1)]);
  assert.equal(fallback.items[0].filePath, '/test/a');
  const legacy = await call('library/smart-collections/resolve', {id: created.id});
  assert.equal(legacy.total, 3);
  assert.equal(legacy.uids.length, 3);
  assert.equal(new Set(legacy.uids).size, 3);
  const rejectedUpdate = await call('library/smart-collections', {id: created.id, name: 'bad', q: ''});
  assert.equal(rejectedUpdate.status, 400);
  assert.equal((await call('library/collections')).collections[0].name, 'stone');
});
