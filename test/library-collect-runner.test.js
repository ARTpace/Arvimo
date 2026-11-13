// 采集执行器：过滤、去重、dryRun、入队与入板的失败分支。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCollectRules} from '../server/collect-rules.mjs';
import {createCollectPending} from '../server/collect-pending.mjs';
import {createCollectGuard} from '../server/collect-guard.mjs';
import {createCollectRunner, filterItems} from '../server/collect-runner.mjs';

const NOW = new Date(2026, 0, 1, 12, 0, 0).getTime();
const uid = char => char.repeat(32);
const item = (char, patch = {}) => ({
  uid: uid(char), key: `sketchfab:${char}`, platform: 'sketchfab', name: `Asset ${char}`,
  url: `https://cdn.example/${char}.png`, thumbnail: '', author: 'Ann', tags: ['stone'],
  assetType: 'model', license: 'CC0', downloadable: true, ...patch,
});
const ITEMS = [item('a'), item('b', {url: 'https://cdn.example/b.jpg', tags: ['wood']}), item('c')];

async function setup({search, items = ITEMS, boardOk = true, filters = {}} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-collect-runner-'));
  const rules = createCollectRules({file: path.join(dir, 'rules.json'), now: () => NOW});
  const pending = createCollectPending({file: path.join(dir, 'pending.json'), now: () => NOW});
  const guard = createCollectGuard({now: () => NOW, sleep: async () => {}, random: () => 0});
  const boards = [];
  const runner = createCollectRunner({
    rules, pending, guard,
    storage: {withDb: async fn => fn(boardOk ? {fake: true} : null)},
    search: search || (async platform => ({platform, label: platform, kind: 'model', items, warnings: []})),
    addToBoard: (conn, boardId, uids) => boards.push({boardId, uids}),
    now: () => NOW,
  });
  const rule = await rules.save({name: '石材', boardId: 'c-1', platforms: ['sketchfab'], query: 'stone', limit: 5, filters});
  return {dir, rules, pending, runner, boards, rule};
}

test('filterItems 只让有数据的维度参与过滤', () => {
  assert.equal(filterItems(ITEMS, {formats: ['png']}).length, 2);
  assert.equal(filterItems(ITEMS, {tags: ['wood']}).length, 1);
  assert.equal(filterItems(ITEMS, {excludeTags: ['stone']}).length, 1);
  assert.equal(filterItems(ITEMS, {}).length, 3);
});

test('首跑写入待合并队列并立即入板', async () => {
  const {runner, pending, boards, rule} = await setup();
  const run = await runner.run(rule.id);
  assert.equal(run.found, 3);
  assert.equal(run.added, 3);
  assert.equal(run.board.ok, true);
  assert.equal((await pending.status()).count, 3);
  assert.deepEqual(boards[0].uids.sort(), [uid('a'), uid('b'), uid('c')].sort());
  assert.equal(boards[0].boardId, 'c-1');
});

test('同一批结果第二次跑全部命中去重索引', async () => {
  const {runner, rule} = await setup();
  await runner.run(rule.id);
  const second = await runner.run(rule.id);
  assert.equal(second.found, 3);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 3);
});

test('本地过滤在入队前生效，被刷掉的条目不进画板', async () => {
  const {runner, pending, boards, rule} = await setup({filters: {formats: ['png']}});
  const run = await runner.run(rule.id);
  assert.equal(run.added, 2);
  assert.equal((await pending.status()).count, 2);
  assert.equal(boards[0].uids.length, 2);
  assert.equal(boards[0].uids.includes(uid('b')), false);
});

test('dryRun 只给预览，不写队列、不入板、不记去重', async () => {
  const {runner, pending, boards, rules, rule} = await setup();
  const preview = await runner.run(rule.id, {dryRun: true});
  assert.equal(preview.dryRun, true);
  assert.equal(preview.added, 3);
  assert.equal(preview.preview.length, 3);
  assert.equal((await pending.status()).count, 0);
  assert.equal(boards.length, 0);
  assert.equal((await rules.seenHas([`sketchfab:a`])).size, 0);

  const real = await runner.run(rule.id);
  assert.equal(real.added, 3, 'dryRun 不能提前消耗去重键');
});

test('limit 截断最终新增数量', async () => {
  const {runner, rule, rules} = await setup();
  await rules.save({...rule, limit: 2});
  const run = await runner.run(rule.id);
  assert.equal(run.added, 2);
  assert.equal(run.found, 3);
});

test('单个平台失败记入运行结果，其它平台继续', async () => {
  const {runner, rules, rule} = await setup({
    search: async platform => {
      if (platform === 'polyhaven') throw Error('429 Too Many Requests');
      return {platform, label: platform, kind: 'model', items: [item('d')], warnings: []};
    },
  });
  await rules.save({...rule, platforms: ['polyhaven', 'sketchfab']});
  const run = await runner.run(rule.id);
  assert.equal(run.failed, 1);
  assert.equal(run.added, 1);
  assert.equal(run.platforms.polyhaven.error, '429 Too Many Requests');
  assert.ok(run.warnings.some(text => text.includes('429')));
});

test('没有内核时资产仍进队列，画板写入失败只记警告', async () => {
  const {runner, pending, rule} = await setup({boardOk: false});
  const run = await runner.run(rule.id);
  assert.equal(run.board.ok, false);
  assert.equal((await pending.status()).count, 3);
  assert.ok(run.warnings.some(text => text.includes('待合并')));
});

test('规则不存在时明确报错，不会静默成功', async () => {
  const {runner} = await setup();
  await assert.rejects(() => runner.run('r-missing'), /不存在/);
});
