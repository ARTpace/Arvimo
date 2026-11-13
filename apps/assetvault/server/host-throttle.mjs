// 按图站「该等多久再要下一张」的调度器。
//
// 为什么必须有这一层：花瓣（gd-hbimg，EdgeOne）不是按并发限流，而是**按 IP 累计请求数**限流 ——
// 一个 294 张的画板能一口气跑完（约 1.8 张/秒），1923 张的板子却会在第 100 张左右开始整批回
// HTTP 567，之后连签名地址也一起被拦，直到冷却窗口过去。原来的做法是「连续 5 张失败就判死整包」，
// 于是越大的板子越必然失败 —— 这层就是把这个结论改掉：
//
//   1. 平时按 `minGapMs + 抖动` 拉开请求（同一站点共享一份额度，不按子域各算一份）；
//   2. 撞到限流就**升档降速**（gap 指数增长，有上限）并进入冷却，冷却结束再继续；
//   3. 跑一大片之后主动歇一会儿（burst），把「累计配额」摊平，而不是等被拦了才退。
//
// 规则表是数据而不是 if：加一个站点只加一条 `HOST_RULES`，调用点不长分支。所有参数可覆盖，
// 便于在测试里把毫秒压到 0，也便于以后按站点实测调参。

/** 图站在「同一时刻能给你多少张」上的默认脾气。按站点只描述差异，通用参数集中在 DEFAULTS。
 *
 *  间隔的调节用 AIMD（加性提速 / 乘性降速）：每成功一张就把间隔减 `gapStepMs`（慢慢试探更快），
 *  撞一次限流就 ×`gapGrowth`（迅速退让）。稳态会收敛到「刚好不撞」的速率附近，而不是
 *  「固定间隔一路撞 → 冷却 → 回落 → 再撞」那种来回振荡 —— 实测后者有 65% 的时间在冷却里。 */
const DEFAULTS = Object.freeze({
  minGapMs: 0,          // 起始间隔：0 = 不限速（普通 CDN 不需要排队）
  jitterMs: 0,          // 抖动：让节奏不像脚本
  gapStepMs: 20,        // 每成功一张，间隔减多少（加性提速）
  gapMaxMs: 8000,       // 自适应降速的上限
  gapGrowth: 2,         // 每撞一次限流，间隔乘以它（乘性降速）
  coolBaseMs: 8000,     // 第一次冷却多久
  coolMaxMs: 120000,    // 单次冷却上限
  coolRounds: 3,        // 单张图最多吃几轮冷却（超过就交给上层判失败）
  recoverEvery: 40,     // 连续成功这么多张，冷却阶梯退一档（不是清零，避免一撞就回到最狠的冷却）
  burst: null,          // {count, pauseMs}：连续要 N 张后主动休息
});

/** 站点差异只写差异。花瓣这几个数是实测的起点，不是理论值。 */
export const HOST_RULES = Object.freeze([
  {
    // 花瓣图床：签名地址/裸路径/缩放档都在 *.huaban.com 上，共享同一份 IP 额度。
    //
    // 间隔按「实测 + 并发」定：串行 350ms 跑 150 张零冷却（约 118 请求/分钟，实测 127 秒）。
    // 下载改成 3 路并发之后，请求速率 = 1/(gap+抖动均值) 且不再被传输时间拖慢，
    // 所以取 350ms + 抖动 100ms（均值 400ms ≈ 150 请求/分钟）—— 比原来的 650+350 快 2.5 倍，
    // 仍比实测安全线留了余量；真撞了 AIMD 会翻倍退让。
    // 抖动从 350 降到 100：1923 张时平均 jitter 会白吃掉 3 分钟，而图床是按 IP 配额、
    // 不是按「节奏像不像脚本」判断，没必要为拟人化付这个代价。
    //
    // gapStepMs/recoverEvery 调得比默认更积极：并发下若撞一次，gap 从 350 翻到 700，
    // 靠每 20 张成功减 40ms 大约 175 张就能回到 350 —— 而不是一路卡在 700 等到整包结束。
    id: 'huaban',
    test: /(?:^|\.)huaban\.com$/i,
    minGapMs: 350,
    jitterMs: 100,
    gapStepMs: 40,
    gapMaxMs: 4000,
    coolBaseMs: 15000,
    coolMaxMs: 180000,
    coolRounds: 3,
    recoverEvery: 20,
    burst: { count: 300, pauseMs: 12000 },
  },
  {
    // booru 类站点（safebooru / yande.re / konachan）对密集抓取同样会 429。
    // konachan 的图站配置用的是 konachan.net（.com 只是备用域名），两个都要覆盖 ——
    // 早先只写了 `.com`，于是 konachan.net 落到「无规则」，等于完全没有节奏保护。
    id: 'booru',
    test: /(?:^|\.)(?:safebooru\.org|yande\.re|konachan\.(?:com|net))$/i,
    minGapMs: 400,
    jitterMs: 250,
    coolBaseMs: 10000,
    coolMaxMs: 120000,
  },
  {
    // pixiv：i.pximg.net 对密集请求回 429，而且触发后会持续一小会儿。120ms（≈8 张/秒）
    // 比不限速慢不了多少，却能明显少撞；真撞了 AIMD 会继续退让。
    id: 'pixiv',
    test: /(?:^|\.)(?:pixiv\.net|pximg\.net)$/i,
    minGapMs: 120,
    jitterMs: 60,
    coolBaseMs: 10000,
    coolMaxMs: 90000,
  },
  // ---- 下面几条**不加间隔**（minGapMs 继承默认 0）----
  //
  // 这些站点的图片 CDN 对单 IP 的并发相当宽松，加间隔就是纯变慢。列进规则表只是为了
  // 让「真撞到 429/5xx 时的冷却」按站点走（10s 起步而不是默认值），并且给以后按站点
  // 调参留好位置 —— 参数改这里，不用动调用点。
  {
    id: 'wallhaven',
    test: /(?:^|\.)wallhaven\.cc$/i,
    coolBaseMs: 10000,
    coolMaxMs: 90000,
  },
  {
    id: 'civitai',
    test: /(?:^|\.)(?:civitai\.com|civitai\.ai)$/i,
    coolBaseMs: 10000,
    coolMaxMs: 90000,
  },
  {
    id: 'pexels',
    test: /(?:^|\.)pexels\.com$/i,
    coolBaseMs: 10000,
    coolMaxMs: 90000,
  },
  {
    id: 'flickr',
    test: /(?:^|\.)(?:flickr\.com|staticflickr\.com)$/i,
    coolBaseMs: 10000,
    coolMaxMs: 90000,
  },
  {
    id: 'designspiration',
    test: /(?:^|\.)(?:designspiration\.com|dspncdn\.com)$/i,
    coolBaseMs: 10000,
    coolMaxMs: 90000,
  },
  {
    id: '500px',
    test: /(?:^|\.)500px\.(?:com|org)$/i,
    coolBaseMs: 10000,
    coolMaxMs: 90000,
  },
]);

const NO_RULE = Object.freeze({...DEFAULTS, id: 'default'});

function hostOf(value) {
  try { return new URL(String(value)).hostname.toLowerCase(); } catch { return ''; }
}

/** 这个地址归哪条规则管；认不出的站点也返回默认规则（不排队，但撞限流时仍会冷却）。 */
export function ruleForUrl(value, rules = HOST_RULES) {
  const host = hostOf(value);
  if (!host) return NO_RULE;
  const hit = rules.find((rule) => rule.test.test(host));
  return hit ? {...DEFAULTS, ...hit} : NO_RULE;
}

const defaultSleep = (ms, { signal } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || Error('任务已取消'));
  if (ms <= 0) return resolve();
  const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason || Error('任务已取消')); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

/**
 * 一个进程内共享的「站点节奏」。跨任务共享是有意的：配额是 IP 级的，两个任务同时各开
 * 一个调度器，等于把同一个窗口的额度分成两半打，谁都不够用。
 */
export function createHostThrottle({ rules = HOST_RULES, sleep = defaultSleep, now = Date.now, onWait = null, random = Math.random } = {}) {
  const states = new Map();

  const stateFor = (url) => {
    const rule = ruleForUrl(url, rules);
    let state = states.get(rule.id);
    if (!state) {
      state = { rule, gapMs: rule.minGapMs, nextAt: 0, cooldownUntil: 0, rounds: 0, burstCount: 0, sinceReward: 0, lastStatus: null, waits: 0, cooledMs: 0 };
      states.set(rule.id, state);
    }
    return state;
  };

  /** 等到「此刻可以发请求」为止。
   *
   *  **预约式放行，不是排队式**：调用进来时同步「占住」自己的槽位（`nextAt` 往后推一个 gap），
   *  然后各自 await 到自己的槽位。这样三个并发 worker 在 t=0 同时进来，拿到 0 / gap / 2gap，
   *  互不阻塞 —— 单张的下载与写盘就落进了别人的等待间隙里。
   *
   *  早先用的是 `chain.then(run)` 串行队列，结果是：第二张必须等第一张的 `wait()` 整段跑完才轮得到，
   *  而单张请求只要 120ms、gap 是 400ms，于是「等待」把下载完全吞掉，实测并发峰值永远是 1，
   *  每张都要多付一份下载+写盘时间。请求速率两者相同（都是 1/gap），但流水线才有意义。
   *
   *  JS 单线程保证同步段不被打断，所以「读 nextAt → 写入 nextAt+gap」之间不会被别的调用插队。
   */
  const wait = async (url, { signal, label = '' } = {}) => {
    const state = stateFor(url);
    const startedAt = now();
    // burst：连要 N 张之后主动停一下，把累计计数摊平，而不是等被拦了再退。
    let burstPause = 0;
    const burst = state.rule.burst;
    if (burst && state.burstCount >= burst.count) {
      state.burstCount = 0;
      burstPause = burst.pauseMs;
    }
    const slot = Math.max(state.nextAt, state.cooldownUntil, startedAt + burstPause);
    state.burstCount++;
    state.nextAt = slot + state.gapMs + Math.round(random() * state.rule.jitterMs);
    const delay = slot - startedAt;
    if (delay > 0) {
      state.waits++;
      if (state.cooldownUntil > startedAt) state.cooledMs += delay;
      onWait?.({ id: state.rule.id, label, ms: delay, reason: state.cooldownUntil > startedAt ? 'cooldown' : burstPause ? 'burst' : 'gap', status: state.lastStatus });
      await sleep(delay, { signal });
    }
    return { waitedMs: delay, gapMs: state.gapMs };
  };

  /** 撞限流：间隔乘性翻倍（退让）+ 进入冷却。返回本次冷却毫秒数，供调用方写进度提示。 */
  const penalise = (url, status) => {
    const state = stateFor(url);
    state.rounds++;
    state.sinceReward = 0;
    state.lastStatus = Number(status) || null;
    const base = state.gapMs || state.rule.minGapMs;
    state.gapMs = Math.min(Math.round(base * state.rule.gapGrowth), state.rule.gapMaxMs);
    state.nextAt = now() + state.gapMs;
    const cool = Math.min(Math.round(state.rule.coolBaseMs * 2 ** (state.rounds - 1)), state.rule.coolMaxMs);
    state.cooldownUntil = Math.max(state.cooldownUntil, now() + cool);
    return cool;
  };

  /** 成功一次：间隔加性收窄（试探更快）。冷却阶梯只在连续成功一大片之后退一档 ——
   *  撞一下就把冷却清零，会让节奏在「刚被放过 → 立刻再撞」之间来回弹。 */
  const reward = (url) => {
    const state = stateFor(url);
    state.sinceReward++;
    const step = state.rule.gapStepMs;
    if (step > 0) state.gapMs = Math.max(state.rule.minGapMs, state.gapMs - step);
    if (state.sinceReward >= state.rule.recoverEvery) {
      state.sinceReward = 0;
      state.rounds = Math.max(0, state.rounds - 1);
    }
  };

  /** 整包级别的强制休息（连续多张都取不回来时用）：不进冷却链，只把下一次放行推后。 */
  const coolDown = (url, ms, status) => {
    const state = stateFor(url);
    state.lastStatus = Number(status) || state.lastStatus;
    state.cooldownUntil = Math.max(state.cooldownUntil, now() + ms);
    return ms;
  };

  const stats = (url) => {
    if (url) {
      const state = states.get(ruleForUrl(url, rules).id);
      return state ? { ...state } : null;
    }
    return [...states.values()].map((state) => ({ ...state }));
  };

  return { wait, penalise, reward, coolDown, stats, ruleForUrl: (url) => ruleForUrl(url, rules) };
}

let shared = null;

/** 进程级单例：图片下载、拖出落盘、代理取图共用同一份站点节奏。 */
export function sharedHostThrottle() {
  if (!shared) shared = createHostThrottle();
  return shared;
}

/** 限流类状态码：429 是标准，567 是花瓣 EdgeOne 的自定义码，5xx 是网关临时不可用。
 *  判定本身复用 net-errors 的 isTransientStatus，这里只负责「值不值得降速等待」。 */
export { isTransientStatus } from './net-errors.mjs';
