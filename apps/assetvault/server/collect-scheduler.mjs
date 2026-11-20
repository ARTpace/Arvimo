// 采集调度器：60 秒心跳，只跑「到期且没在跑」的规则。
//
// 刻意不用 cron：项目里没有这个依赖，而需求只有「每天一次 + 手动」。
// 串行是硬要求 —— 两条规则同时打同一平台，守卫的令牌桶也拦不住瞬时并发。
import {ruleDue} from './collect-rules.mjs';

export const COLLECT_TICK_MS = 60 * 1000;

export function createCollectScheduler({
  rules, runner, intervalMs = COLLECT_TICK_MS, now = Date.now,
  onWarn = () => {}, setTimer = setInterval, clearTimer = clearInterval,
} = {}) {
  if (!rules || !runner) throw Error('调度器缺少规则仓库或执行器');
  let timer = null;
  let ticking = false;
  const running = new Set();

  async function tick() {
    if (ticking) return {skipped: true, ran: 0, results: []};
    ticking = true;
    try {
      const stamp = now();
      const due = (await rules.list()).filter(rule => ruleDue(rule, stamp) && !running.has(rule.id));
      const results = [];
      for (const rule of due) {
        if (running.has(rule.id)) continue;
        running.add(rule.id);
        try {
          results.push({ruleId: rule.id, ok: true, run: await runner.run(rule.id)});
        } catch (error) {
          // A manual run owns the same runner lock. Do not reschedule or record it as a failure.
          if(error.code==='COLLECT_BUSY')continue;
          try{await rules.recordRun?.(rule.id,{failed:1,added:0,warnings:[String(error.message||error)]});}
          catch(writeError){onWarn(`[collect] 保存失败记录：${writeError.message}`);}
          results.push({ruleId: rule.id, ok: false, error: String(error?.message || '采集失败')});
          onWarn(`[collect] 规则「${rule.name}」执行失败：${error?.message || error}`);
        } finally {
          running.delete(rule.id);
        }
      }
      return {skipped: false, ran: results.length, results};
    } catch (error) {
      onWarn(`[collect] 调度心跳失败：${error?.message || error}`);
      return {skipped: false, ran: 0, results: []};
    } finally {
      ticking = false;
    }
  }

  function start({resetOverdue = true} = {}) {
    if (timer) return false;
    // 停机一周以上的规则不该在开机瞬间全部开跑；重置失败也不影响正常调度。
    if (resetOverdue) Promise.resolve(rules.resetOverdue?.()).catch(error => onWarn(`[collect] 过期规则重置失败：${error?.message || error}`));
    timer = setTimer(() => { tick(); }, intervalMs);
    timer?.unref?.();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearTimer(timer);
    timer = null;
    return true;
  }

  function status() {
    return {
      running: timer !== null,
      intervalMs,
      active: [...running],
      nextTickAt: timer ? now() + intervalMs : 0,
    };
  }

  return {start, stop, tick, status};
}
