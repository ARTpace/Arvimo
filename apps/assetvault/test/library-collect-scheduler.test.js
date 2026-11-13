// 采集调度器：到期判定、串行、并发闸门与生命周期。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectScheduler} from '../server/collect-scheduler.mjs';

const NOW = new Date(2026, 0, 1, 12, 0, 0).getTime();
const rule = patch => ({
  id: 'r-1', name: '石材', enabled: true, frequency: 'daily', hour: 9, nextRunAt: NOW - 1000, ...patch,
});

const fixture = (rules, run) => createCollectScheduler({
  rules, runner: {run}, now: () => NOW, onWarn: () => {},
});

test('tick 只跑到期且启用的规则', async () => {
  const ran = [];
  const rules = {
    list: async () => [rule({id: 'due'}), rule({id: 'later', nextRunAt: NOW + 60_000}), rule({id: 'off', enabled: false})],
    resetOverdue: async () => 0,
  };
  const out = await fixture(rules, async id => { ran.push(id); return {id}; }).tick();
  assert.deepEqual(ran, ['due']);
  assert.equal(out.ran, 1);
});

test('同一时刻重复 tick 直接跳过，不会并发打平台', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rules = {list: async () => [rule({})], resetOverdue: async () => 0};
  const scheduler = fixture(rules, async () => { await gate; return {}; });
  const first = scheduler.tick();
  const second = await scheduler.tick();
  assert.equal(second.skipped, true);
  assert.equal(second.ran, 0);
  release();
  assert.equal((await first).ran, 1);
});

test('一条规则失败不阻塞后面的规则', async () => {
  const ran = [];
  const warnings = [];
  const rules = {list: async () => [rule({id: 'bad'}), rule({id: 'good'})], resetOverdue: async () => 0};
  const scheduler = createCollectScheduler({
    rules,
    runner: {run: async id => {
      ran.push(id);
      if (id === 'bad') throw Error('搜索失败');
      return {id};
    }},
    now: () => NOW,
    onWarn: message => warnings.push(message),
  });
  const out = await scheduler.tick();
  assert.deepEqual(ran, ['bad', 'good']);
  assert.equal(out.ran, 2);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].ok, true);
  assert.ok(warnings.some(text => text.includes('搜索失败')));
});

test('start 会重置过期规则并注册心跳，stop 清理', async () => {
  let timerFn = null;
  let cleared = null;
  let reset = 0;
  const scheduler = createCollectScheduler({
    rules: {list: async () => [], resetOverdue: async () => { reset += 1; return 0; }},
    runner: {run: async () => ({})},
    now: () => NOW,
    setTimer: (fn, ms) => { timerFn = fn; return {ms, unref() {}}; },
    clearTimer: timer => { cleared = timer; },
  });
  assert.equal(scheduler.start(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reset, 1);
  assert.equal(typeof timerFn, 'function');
  assert.equal(scheduler.status().running, true);
  assert.equal(scheduler.start(), false, '重复 start 不叠加定时器');
  assert.equal(scheduler.stop(), true);
  assert.ok(cleared);
  assert.equal(scheduler.status().running, false);
  assert.equal(scheduler.stop(), false);
});
