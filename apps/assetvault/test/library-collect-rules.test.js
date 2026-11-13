// 收集规则仓库：纯函数边界 + 持久化 + 运行回写。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COLLECT_LIMITS, createCollectRules, normalizeRule, nextDailyAt, ruleDue, pruneSeen,
} from '../server/collect-rules.mjs';

const NOW = new Date(2026, 0, 1, 12, 0, 0).getTime();
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'av-collect-rules-'));
const ruleInput = patch => ({
  name: '石材参考', boardId: 'c-1', platforms: ['polyhaven'], query: 'stone wall', limit: 20, ...patch,
});

test('normalizeRule 补默认值并夹紧边界', () => {
  const rule = normalizeRule(ruleInput({limit: 999, hour: 99, frequency: 'weekly'}), NOW);
  assert.match(rule.id, /^r-[a-f0-9]{16}$/);
  assert.equal(rule.limit, COLLECT_LIMITS.perRun);
  assert.equal(rule.hour, 23);
  assert.equal(rule.frequency, 'manual', '未知频率退回手动');
  assert.equal(rule.mode, 'auto');
  assert.equal(rule.enabled, true);
  assert.equal(rule.nextRunAt, 0, '手动规则没有下次触发');
  assert.deepEqual(rule.filters, {formats: [], tags: [], excludeTags: [], kinds: []});
});

test('daily 规则自动算出下次触发时间', () => {
  const rule = normalizeRule(ruleInput({frequency: 'daily', hour: 9}), NOW);
  assert.equal(rule.nextRunAt, nextDailyAt(9, NOW));
  assert.equal(new Date(rule.nextRunAt).getHours(), 9);
  assert.ok(rule.nextRunAt > NOW, '今天 9 点已过则应排到明天');
});

test('nextDailyAt 今天未到点用今天，已到点用明天', () => {
  const today = nextDailyAt(18, NOW);
  assert.equal(new Date(today).getDate(), new Date(NOW).getDate());
  const tomorrow = nextDailyAt(9, NOW);
  assert.equal(new Date(tomorrow).getDate(), new Date(NOW).getDate() + 1);
});

test('ruleDue 只认启用的 daily 且到期', () => {
  assert.equal(ruleDue({enabled: true, frequency: 'daily', nextRunAt: NOW - 1}, NOW), true);
  assert.equal(ruleDue({enabled: false, frequency: 'daily', nextRunAt: NOW - 1}, NOW), false);
  assert.equal(ruleDue({enabled: true, frequency: 'manual', nextRunAt: NOW - 1}, NOW), false);
  assert.equal(ruleDue({enabled: true, frequency: 'daily', nextRunAt: NOW + 10}, NOW), false);
  assert.equal(ruleDue({enabled: true, frequency: 'daily', nextRunAt: 0}, NOW), false);
});

test('pruneSeen 按写入时间保留最近条目', () => {
  const seen = Object.fromEntries(Array.from({length: 10}, (_, i) => [`p:${i}`, i + 1]));
  const kept = pruneSeen(seen, 3);
  assert.deepEqual(Object.keys(kept).sort(), ['p:7', 'p:8', 'p:9']);
});

test('规则 CRUD 落盘并可被新实例读回', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'collect-rules.json');
  const rules = createCollectRules({file, now: () => NOW});
  const saved = await rules.save(ruleInput({frequency: 'daily', hour: 18}));
  assert.equal((await rules.list()).length, 1);
  assert.equal((await rules.get(saved.id)).query, 'stone wall');

  await rules.save({...saved, name: '石材参考 v2'});
  assert.equal((await rules.list())[0].name, '石材参考 v2');
  assert.equal((await rules.list()).length, 1, '同 id 保存是更新而不是新增');

  const reopened = createCollectRules({file, now: () => NOW});
  assert.equal((await reopened.list())[0].name, '石材参考 v2');
  assert.equal(await reopened.remove(saved.id), true);
  assert.equal((await reopened.list()).length, 0);
  assert.equal(await reopened.remove(saved.id), false);
});

test('保存时校验必填项', async () => {
  const dir = await tmp();
  const rules = createCollectRules({file: path.join(dir, 'r.json'), now: () => NOW});
  await assert.rejects(() => rules.save(ruleInput({boardId: ''})), /画板/);
  await assert.rejects(() => rules.save(ruleInput({platforms: []})), /平台/);
  await assert.rejects(() => rules.save(ruleInput({query: '  '})), /关键词/);
});

test('recordRun 回写状态、累计新增并记录去重键', async () => {
  const dir = await tmp();
  const rules = createCollectRules({file: path.join(dir, 'r.json'), now: () => NOW});
  const rule = await rules.save(ruleInput({frequency: 'daily', hour: 9}));
  const run = await rules.recordRun(rule.id, {
    found: 5, added: 3, skipped: 2, failed: 0, platforms: {polyhaven: {found: 3}},
  }, ['polyhaven:stone-1', 'polyhaven:stone-2']);
  assert.equal(run.added, 3);
  const next = await rules.get(rule.id);
  assert.equal(next.lastStatus, 'ok');
  assert.equal(next.totalAdded, 3);
  assert.equal(next.failStreak, 0);
  assert.ok(next.lastRunAt > 0 && next.nextRunAt > next.lastRunAt);
  assert.deepEqual([...(await rules.seenHas(['polyhaven:stone-1', 'nope']))], ['polyhaven:stone-1']);
  assert.equal((await rules.snapshot()).seenCount, 2);
});

test('连续全失败累计 failStreak，成功一次清零', async () => {
  const dir = await tmp();
  const rules = createCollectRules({file: path.join(dir, 'r.json'), now: () => NOW});
  const rule = await rules.save(ruleInput({}));
  await rules.recordRun(rule.id, {found: 0, added: 0, skipped: 0, failed: 2, platforms: {}});
  assert.equal((await rules.get(rule.id)).failStreak, 1);
  await rules.recordRun(rule.id, {found: 1, added: 1, skipped: 0, failed: 0, platforms: {}});
  assert.equal((await rules.get(rule.id)).failStreak, 0);
  assert.equal((await rules.get(rule.id)).lastStatus, 'ok');
});

test('resetOverdue 只把停机超一周的 daily 规则推到下一个时间点', async () => {
  const dir = await tmp();
  const rules = createCollectRules({file: path.join(dir, 'r.json'), now: () => NOW});
  const stale = await rules.save(ruleInput({name: '旧', frequency: 'daily', hour: 9}));
  const fresh = await rules.save(ruleInput({name: '新', frequency: 'daily', hour: 9}));
  const week = 8 * 24 * 60 * 60 * 1000;
  const data = JSON.parse(await fs.readFile(path.join(dir, 'r.json'), 'utf8'));
  data.rules = data.rules.map(item => item.id === fresh.id ? {...item, nextRunAt: NOW - 1000} : {...item, nextRunAt: NOW - week});
  await fs.writeFile(path.join(dir, 'r.json'), JSON.stringify(data));

  const reloaded = createCollectRules({file: path.join(dir, 'r.json'), now: () => NOW});
  assert.equal(await reloaded.resetOverdue(), 1);
  const rows = await reloaded.list();
  assert.ok(rows.find(item => item.id === stale.id).nextRunAt > NOW);
  assert.equal(rows.find(item => item.id === fresh.id).nextRunAt, NOW - 1000, '未超期的规则不动');
});

test('坏文件不会让规则仓库崩掉', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'r.json');
  await fs.writeFile(file, '{ broken');
  const rules = createCollectRules({file, now: () => NOW});
  assert.deepEqual(await rules.list(), []);
  await rules.save(ruleInput({}));
  assert.equal((await rules.list()).length, 1);
});
