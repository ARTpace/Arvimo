// 采集守卫：令牌桶 + 随机抖动 + 429 退避 + 连续失败熔断。
//
// 这不是「优化」，是上线前置条件：默认设置会同时开多个平台，Polyfork 匿名只有 40 次/小时，
// ArtStation 会 429，站酷有 WAF。没有这层，第一条规则跑几分钟就会把账号 / IP 打黑，
// 而且用户看到的是「一条都没收到」，比报错更难排查。
export const COLLECT_BUDGETS = Object.freeze({
  model: Object.freeze({perHour: 30, burst: 6}),
  picture: Object.freeze({perHour: 12, burst: 3}),
});

export const COLLECT_GUARD_DEFAULTS = Object.freeze({
  failLimit: 3,
  cooldownMs: 6 * 60 * 60 * 1000,
  jitterMinMs: 500,
  jitterMaxMs: 2000,
});

/** 令牌桶补充是纯函数：只依赖上次补充时间，测试不用等真实时钟。 */
export function refillBucket(bucket, budget, now) {
  const capacity = Math.max(1, Number(budget?.burst) || 1);
  const perHour = Math.max(1, Number(budget?.perHour) || 1);
  const tokens = Math.min(capacity, Math.max(0, Number(bucket?.tokens) || 0) + Math.max(0, now - Number(bucket?.at ?? now)) * (perHour / 3600000));
  return {tokens, at: now};
}

const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createCollectGuard({
  now = Date.now,
  sleep = sleepDefault,
  random = Math.random,
  budgets = COLLECT_BUDGETS,
  options = COLLECT_GUARD_DEFAULTS,
} = {}) {
  const config = {...COLLECT_GUARD_DEFAULTS, ...(options || {})};
  const buckets = new Map();
  const failures = new Map();
  const blockedUntil = new Map();

  function budgetFor(kind) {
    return budgets[kind] || budgets.model;
  }

  /** 先看能不能跑，不消耗令牌；调度器据此跳过而不是撞上去再失败。 */
  function check(platform, kind = 'model') {
    const stamp = now();
    const until = Number(blockedUntil.get(platform)) || 0;
    if (until > stamp) return {ok: false, reason: 'cooldown', retryInMs: until - stamp};
    const budget = budgetFor(kind);
    // 新平台从满桶开始：否则第一次请求永远是「0 令牌 → 超出配额」，采集一条都收不到。
    const current = buckets.get(platform);
    const bucket = current ? refillBucket(current, budget, stamp) : {tokens: budget.burst, at: stamp};
    buckets.set(platform, bucket);
    if (bucket.tokens < 1) {
      const wait = Math.ceil((1 - bucket.tokens) * 3600000 / Math.max(1, budget.perHour));
      return {ok: false, reason: 'budget', retryInMs: wait};
    }
    return {ok: true, retryInMs: 0};
  }

  /** 真正开始请求前调用：检查 + 扣令牌 + 随机抖动（抖动在调用方 await 之前完成）。 */
  async function acquire(platform, kind = 'model') {
    const verdict = check(platform, kind);
    if (!verdict.ok) return verdict;
    const bucket = buckets.get(platform);
    buckets.set(platform, {...bucket, tokens: Math.max(0, bucket.tokens - 1)});
    const span = Math.max(0, config.jitterMaxMs - config.jitterMinMs);
    const wait = Math.round(config.jitterMinMs + random() * span);
    if (wait > 0) await sleep(wait);
    return {ok: true, retryInMs: 0, waitedMs: wait};
  }

  function noteSuccess(platform) {
    failures.set(platform, 0);
    blockedUntil.delete(platform);
  }

  /** retryAfterMs 来自 Retry-After 头；没有就按连续失败次数熔断。 */
  function noteFailure(platform, {retryAfterMs = 0} = {}) {
    const stamp = now();
    const streak = (Number(failures.get(platform)) || 0) + 1;
    failures.set(platform, streak);
    const explicit = Math.max(0, Number(retryAfterMs) || 0);
    if (explicit > 0) {
      blockedUntil.set(platform, Math.max(Number(blockedUntil.get(platform)) || 0, stamp + explicit));
      return {streak, cooldownMs: explicit};
    }
    if (streak >= config.failLimit) {
      blockedUntil.set(platform, stamp + config.cooldownMs);
      return {streak, cooldownMs: config.cooldownMs};
    }
    return {streak, cooldownMs: 0};
  }

  function snapshot() {
    const stamp = now();
    return [...new Set([...buckets.keys(), ...failures.keys(), ...blockedUntil.keys()])].map(platform => ({
      platform,
      tokens: Math.floor(Number(buckets.get(platform)?.tokens) || 0),
      failStreak: Number(failures.get(platform)) || 0,
      cooldownMs: Math.max(0, (Number(blockedUntil.get(platform)) || 0) - stamp),
    }));
  }

  return {check, acquire, noteSuccess, noteFailure, snapshot, budgets, config};
}
