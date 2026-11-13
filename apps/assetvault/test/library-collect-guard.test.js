// 采集守卫：令牌桶、随机抖动、429 退避与连续失败熔断。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollectGuard, refillBucket, COLLECT_BUDGETS, COLLECT_GUARD_DEFAULTS} from '../server/collect-guard.mjs';

const fixture = (patch = {}) => {
  let clock = 1_700_000_000_000;
  const sleeps = [];
  const guard = createCollectGuard({
    now: () => clock,
    sleep: async ms => { sleeps.push(ms); },
    random: () => 0.5,
    ...patch,
  });
  return {guard, sleeps, advance: ms => { clock += ms; }, at: () => clock};
};

test('refillBucket 按小时速率补充且不超过容量', () => {
  const budget = {perHour: 60, burst: 2};
  // 时间戳单位是毫秒：perHour=60 表示每秒补 1/60 个令牌，30 秒 → 0.5。
  const half = refillBucket({tokens: 0, at: 0}, budget, 30 * 1000);
  assert.equal(Math.round(half.tokens * 100) / 100, 0.5);
  const full = refillBucket({tokens: 0, at: 0}, budget, 60 * 60 * 1000);
  assert.equal(full.tokens, 2);
});

test('acquire 消耗令牌并注入抖动', async () => {
  const {guard, sleeps} = fixture();
  const first = await guard.acquire('sketchfab', 'model');
  assert.equal(first.ok, true);
  assert.equal(sleeps[0], (COLLECT_GUARD_DEFAULTS.jitterMaxMs + COLLECT_GUARD_DEFAULTS.jitterMinMs) / 2);
});

test('burst 用完后进入配额等待，时间推进后恢复', async () => {
  const {guard, advance} = fixture();
  for (let i = 0; i < COLLECT_BUDGETS.model.burst; i += 1)
    assert.equal((await guard.acquire('sketchfab', 'model')).ok, true, `第 ${i + 1} 次应通过`);
  const blocked = guard.check('sketchfab', 'model');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'budget');
  assert.ok(blocked.retryInMs > 0);
  advance(60 * 60 * 1000);
  assert.equal(guard.check('sketchfab', 'model').ok, true);
});

test('连续失败达到阈值后熔断，成功一次清零', () => {
  const {guard} = fixture();
  assert.equal(guard.noteFailure('polyfork').cooldownMs, 0);
  assert.equal(guard.noteFailure('polyfork').cooldownMs, 0);
  const third = guard.noteFailure('polyfork');
  assert.equal(third.streak, 3);
  assert.equal(third.cooldownMs, guard.config.cooldownMs);
  assert.equal(guard.check('polyfork').ok, false);
  assert.equal(guard.check('polyfork').reason, 'cooldown');

  guard.noteSuccess('polyfork');
  assert.equal(guard.check('polyfork').ok, true);
});

test('Retry-After 立即生效且不会缩短已有冷却', () => {
  const {guard, advance} = fixture();
  guard.noteFailure('artstation', {retryAfterMs: 30_000});
  const first = guard.check('artstation');
  assert.equal(first.reason, 'cooldown');
  assert.ok(first.retryInMs <= 30_000);
  guard.noteFailure('artstation', {retryAfterMs: 5_000});
  assert.ok(guard.check('artstation').retryInMs > 20_000, '较短的重试时间不能覆盖更长冷却');
  advance(30_000);
  assert.equal(guard.check('artstation').ok, true);
});

test('模型平台与图站使用不同预算', async () => {
  const {guard} = fixture();
  for (let i = 0; i < COLLECT_BUDGETS.picture.burst; i += 1) await guard.acquire('huaban', 'picture');
  assert.equal(guard.check('huaban', 'picture').ok, false);
  assert.equal(guard.check('sketchfab', 'model').ok, true, '图站配额不影响模型平台');
});

test('snapshot 暴露剩余令牌、失败次数与冷却时间', () => {
  const {guard} = fixture();
  guard.noteFailure('pexels', {retryAfterMs: 10_000});
  const row = guard.snapshot().find(item => item.platform === 'pexels');
  assert.equal(row.failStreak, 1);
  assert.ok(row.cooldownMs > 0);
});
