// ADR-02：四域分离的验收。
//
// 守的四件事：
//   1. 域合并是**字段级**覆盖，域里没给的字段不能被无声清空；
//   2. 高频域写入不碰目录域文件（50 万资产时那份文件是 209MB）；
//   3. 用户域权威在 DB，定点写之后刷新能读回；
//   4. 合并语义不缩小目录，彻底删除必须走显式通道。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryStorage, stateFileFor} from '../server/library-storage.mjs';
import {MAIN_STATE_KEY, USER_STATE_KEY, SESSION_STATE_KEY} from '../server/library-schema.mjs';
import {mergeDomains} from '../server/library-blob.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32);
const downloads = {snapshot: () => ({jobs: []})};
const catalog = models => JSON.stringify({
  version: 2, models, trashed: [], favorites: [], aiTags: {}, userTags: {}, userMeta: {},
  history: [], tasks: [], options: {},
});
const two = [{uid: a, name: '石灯', addedAt: 1}, {uid: b, name: '椅子', addedAt: 2}];

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-domains-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('mergeDomains 是字段级覆盖：域里没给的字段沿用主 blob', () => {
  const merged = mergeDomains({
    [MAIN_STATE_KEY]: JSON.stringify({
      version: 2, models: two, favorites: [a], aiTags: {[a]: ['stone']},
      userTags: {}, userMeta: {}, history: [], tasks: [], options: {},
    }),
    [USER_STATE_KEY]: JSON.stringify({userMeta: {[a]: {rating: 5, note: '项目A'}}}),
    [SESSION_STATE_KEY]: JSON.stringify({history: [{kind: 'search', params: {q: '灯'}}]}),
  });
  assert.equal(merged.models.length, 2);
  assert.deepEqual(merged.favorites, [a], '用户域只给了 userMeta，favorites 不能被清空');
  assert.deepEqual(merged.aiTags, {[a]: ['stone']}, 'AI 标签同样要留着');
  assert.equal(merged.userMeta[a].rating, 5);
  assert.deepEqual(merged.history, [{kind: 'search', params: {q: '灯'}}]);
});

test('一域一文件：写会话域不重写目录域文件，读视图仍能看到最新会话', async t => {
  const dir = await temp(t);
  const storage = createLibraryStorage(dir, downloads, {});
  await storage.save({[MAIN_STATE_KEY]: catalog(two)});
  const file = stateFileFor(dir, MAIN_STATE_KEY);
  const before = await fs.readFile(file, 'utf8');

  // 与 /api/library/session 路由背后的存储调用完全同形。
  await storage.mutate(
    values => ({...values, [SESSION_STATE_KEY]: JSON.stringify({history: [{kind: 'search', params: {q: '灯'}}]})}),
    {derived: false},
  );

  assert.equal(await fs.readFile(file, 'utf8'), before, '记一次搜索不能重写 209MB 的目录文件');
  // 域文件是「字符串的状态值」再包一层 JSON：两次 parse 才拿到对象。
  const session = JSON.parse(JSON.parse(await fs.readFile(stateFileFor(dir, SESSION_STATE_KEY), 'utf8')));
  assert.equal(session.history.length, 1);
  const view = JSON.parse((await storage.load()).values[MAIN_STATE_KEY]);
  assert.equal(view.history.length, 1, '旧前端只读主 blob，读视图必须把会话域合并回去');
  assert.equal(view.models.length, 2);
});

test('用户域权威在 DB：定点写标签与评分后刷新能读回，目录文件字节不变', async t => {
  const dir = await temp(t);
  const storage = createLibraryStorage(dir, downloads, {});
  await storage.save({[MAIN_STATE_KEY]: catalog(two)});
  const file = stateFileFor(dir, MAIN_STATE_KEY);
  const before = await fs.readFile(file, 'utf8');

  const result = await storage.mutateTags([
    {op: 'tag.add', uid: a, value: '木材', source: 'user'},
    {op: 'asset.set', uid: b, field: 'rating', value: 4},
  ], {actor: 'tester'});
  assert.equal(result.applied, 2, 'applied 是受影响资产数');
  assert.deepEqual(result.conflicts, [], '不带版本号的 op 不能被误判成冲突');

  assert.equal(await fs.readFile(file, 'utf8'), before, '定点写不该动目录域文件');
  const view = JSON.parse((await storage.load()).values[MAIN_STATE_KEY]);
  assert.equal(view.userMeta[b].rating, 4);
  assert.deepEqual(view.userTags[a], ['木材']);
  assert.equal(view.models.length, 2);
});

test('合并语义：前端只回传一页目录，服务端已有资产不会被抹掉', async t => {
  const dir = await temp(t);
  const storage = createLibraryStorage(dir, downloads, {});
  await storage.save({[MAIN_STATE_KEY]: catalog(two)});
  // 模拟分页前端只发回它看到的那一页。
  await storage.save({[MAIN_STATE_KEY]: catalog([{uid: a, name: '石灯', addedAt: 1}])});
  const view = JSON.parse((await storage.load()).values[MAIN_STATE_KEY]);
  assert.equal(view.models.length, 2);
  const rows = await storage.withDb(conn => conn.all('SELECT uid FROM assets ORDER BY position'));
  assert.deepEqual(rows.map(row => row.uid), [a, b]);
});

test('彻底删除走显式通道：资产行、标签与检索正文一起清干净', async t => {
  const dir = await temp(t);
  const storage = createLibraryStorage(dir, downloads, {});
  await storage.save({[MAIN_STATE_KEY]: catalog(two)});
  await storage.mutateTags([{op: 'tag.add', uid: b, value: '待删', source: 'user'}]);

  const removed = await storage.withDb(conn => conn.removeAssets([b], {actor: 'tester'}));
  assert.equal(removed.removed, 1);
  const left = await storage.withDb(conn => ({
    assets: conn.all('SELECT uid FROM assets'),
    tags: conn.all('SELECT uid FROM tags WHERE uid = ?', [b]),
    audit: conn.all("SELECT action FROM audit_log WHERE action = 'asset.remove'"),
  }));
  assert.deepEqual(left.assets.map(row => row.uid), [a]);
  assert.deepEqual(left.tags, []);
  assert.equal(left.audit.length, 1, '每次删除都要留审计行');
});
