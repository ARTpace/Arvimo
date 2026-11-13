// 站点节奏：图站限流（尤其花瓣按 IP 累计配额）靠这一层把整包跑完，而不是「连续失败就判死」。
//
// 这些用例用注入的时钟和 sleep 压到零耗时：真正要冻结的是**决策**——该等多久、等完是否放行、
// 撞了几次之后间隔怎么变——而不是真的睡几十秒。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostThrottle,ruleForUrl,sharedHostThrottle,HOST_RULES} from '../server/host-throttle.mjs';

function harness(overrides={}){
  const waits=[];
  let clock=0;
  const throttle=createHostThrottle({
    sleep:async ms=>{waits.push(ms);clock+=ms;},
    now:()=>clock,
    random:()=>0,
    ...overrides,
  });
  return {throttle,waits,tick:ms=>{clock+=ms;},at:()=>clock};
}

const HUABAN='https://gd-hbimg.huaban.com/abc123';

test('认得出的站点走自己的规则，认不出的站点不排队',()=>{
  assert.equal(ruleForUrl(HUABAN).id,'huaban');
  assert.equal(ruleForUrl('https://hbimg.huaban.com/x').id,'huaban','旧桶域同样归花瓣管');
  assert.ok(ruleForUrl(HUABAN).minGapMs>0);
  const other=ruleForUrl('https://cdn.polyhaven.com/asset_img/x.png');
  assert.equal(other.minGapMs,0,'普通 CDN 不该被强加间隔');
  assert.equal(ruleForUrl('不是地址').id,'default');
  // 规则表是数据：加站点只加一条，且必须带 id 与 test
  for(const rule of HOST_RULES){assert.ok(rule.id&&rule.test instanceof RegExp,`规则 ${rule.id} 缺 id 或 test`);}
});

test('同一站点连要两张之间至少隔开起始间隔',async()=>{
  const {throttle,waits}=harness();
  await throttle.wait(HUABAN);
  assert.deepEqual(waits,[],'第一张不用等');
  await throttle.wait(HUABAN);
  const rule=ruleForUrl(HUABAN);
  assert.equal(waits.length,1,'第二张必须排队');
  assert.ok(waits[0]>=rule.minGapMs,`应至少等 ${rule.minGapMs}ms，实际 ${waits[0]}`);
  // 不同规则之间互不影响（不同站点各算各的节奏）
  await throttle.wait('https://cdn.polyhaven.com/a.png');
  assert.equal(waits.length,1,'别的站点不该被花瓣的间隔拖住');
});

test('撞限流：间隔升档 + 进入冷却，冷却期内下一次请求必须等满',async()=>{
  const {throttle,waits,at}=harness();
  await throttle.wait(HUABAN);            // 放行一次
  const before=throttle.stats(HUABAN).gapMs;
  const cool=throttle.penalise(HUABAN,567);
  assert.ok(cool>0,'限流必须给出冷却时间');
  assert.ok(throttle.stats(HUABAN).gapMs>before,'限流之后间隔要涨');
  assert.equal(throttle.stats(HUABAN).lastStatus,567);
  const waitedBefore=waits.length;
  await throttle.wait(HUABAN);
  assert.ok(waits.length>waitedBefore,'冷却期内要真的等');
  assert.ok(waits.at(-1)>=cool*0.5,`应等接近冷却时长，实际 ${waits.at(-1)}ms`);
  // 冷却结束后不再等一整个冷却，只按（升高后的）间隔节流
  const mark=waits.length;
  await throttle.wait(HUABAN);
  assert.equal(waits.length,mark+1);
  assert.ok(waits.at(-1)<=throttle.stats(HUABAN).gapMs,'冷却已过，只按间隔节流');
  assert.ok(at()>0);
});

test('连续限流的冷却时间指数增长，但有上限；成功后间隔才会回落',async()=>{
  const {throttle}=harness();
  const cooldowns=[];
  for(let i=0;i<12;i++)cooldowns.push(throttle.penalise(HUABAN,429));
  const rule=ruleForUrl(HUABAN);
  for(const value of cooldowns)assert.ok(value<=rule.coolMaxMs,`冷却不得超过 ${rule.coolMaxMs}ms`);
  assert.ok(cooldowns[1]>cooldowns[0],'第二次冷却应更长');
  assert.ok(cooldowns[11]>=cooldowns[2],'冷却单调不降（到顶后持平）');
  const grown=throttle.stats(HUABAN).gapMs;
  assert.equal(grown,rule.gapMaxMs,'反复限流后间隔顶到上限就不再涨');
  // 成功若干次后间隔回落，但不会低于站点起始间隔
  for(let i=0;i<rule.recoverEvery*12;i++)throttle.reward(HUABAN);
  const recovered=throttle.stats(HUABAN).gapMs;
  assert.ok(recovered<grown,'成功后应逐步提速');
  assert.ok(recovered>=rule.minGapMs,`不应低于 ${rule.minGapMs}ms`);
});

test('跑一大片之后主动歇一会儿（burst），而不是等被拦了才退',async()=>{
  const {throttle,waits}=harness({rules:[{id:'t',test:/(?:^|\.)example\.com$/i,minGapMs:0,jitterMs:0,burst:{count:3,pauseMs:5000}}]});
  const url='https://img.example.com/a.png';
  for(let i=0;i<3;i++)await throttle.wait(url);
  assert.deepEqual(waits,[],'前三张不休息');
  await throttle.wait(url);
  assert.deepEqual(waits,[5000],'第四张前要休息 burst.pauseMs');
});

test('取消信号能打断等待，且不影响后续调用',async()=>{
  const controller=new AbortController();
  let clock=0;
  const throttle=createHostThrottle({
    sleep:(ms,{signal})=>new Promise((resolve,reject)=>{
      if(signal?.aborted)return reject(signal.reason||Error('任务已取消'));
      const timer=setTimeout(()=>{clock+=ms;resolve();},ms);
      signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason||Error('任务已取消'));},{once:true});
    }),
    now:()=>clock,
    random:()=>0,
  });
  await throttle.wait(HUABAN);
  throttle.coolDown(HUABAN,500);
  controller.abort();
  await assert.rejects(throttle.wait(HUABAN,{signal:controller.signal}),()=>true);
  // 队列没有断：换一个 signal 仍然能继续（不是永远卡在 rejected 的链上）
  const done=await Promise.race([throttle.wait(HUABAN,{signal:new AbortController().signal}).then(()=>'ok'),new Promise(r=>setTimeout(()=>r('blocked'),6000))]);
  assert.equal(done,'ok');
});

test('进程级单例：两个任务共享同一份站点节奏（配额是按 IP 算的）',()=>{
  assert.equal(sharedHostThrottle(),sharedHostThrottle());
});
