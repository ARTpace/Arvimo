import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiHunt} from '../server/ai-hunt.mjs';

test('计划复用现有 kinds 过滤，夹紧数量并过滤未知或不可用平台',async()=>{
 let calls=0;
 const hunt=createAiHunt({settings:async()=>({enabled:true}),complete:async()=>{calls++;return {text:JSON.stringify({kind:'textures',rule:{query:'stylized wood',platforms:['missing','sketchfab']},keywords:['wood','wood']})};}});
 const result=await hunt.plan({prompt:'风格化木板',limit:999},['freestylized']);
 assert.deepEqual(result.rule.platforms,['freestylized']);assert.deepEqual(result.rule.filters,{kinds:['textures']});assert.equal(result.rule.limit,60);assert.equal(result.rule.frequency,'manual');
 await hunt.plan({prompt:'风格化木板',limit:999},['freestylized']);assert.equal(calls,1);
 hunt.clear();await hunt.plan({prompt:'风格化木板',limit:999},['freestylized']);assert.equal(calls,2);
});

test('AI 未配置或返回坏格式可降级，本地来源可用且拒绝非法来源和超长需求',async()=>{
 const hunt=createAiHunt({settings:async()=>({enabled:false}),complete:async()=>{throw Error('不应调用');}});
 const result=await hunt.plan({prompt:'木板'},['sketchfab']);assert.equal(result.degraded,true);assert.equal(result.rule.query,'木板');
 const local=await hunt.plan({prompt:'木板',scope:'local'},[]);assert.equal(local.rule.scope,'local');assert.deepEqual(local.rule.platforms,[]);
 await assert.rejects(hunt.plan({prompt:'a',scope:'invalid'}),/来源/);
 await assert.rejects(hunt.plan({prompt:'a'.repeat(301)}),/1–300/);
 const bad=createAiHunt({settings:async()=>({enabled:true}),complete:async()=>({text:'not json'})});
 assert.equal((await bad.plan({prompt:'wood'},['sketchfab'])).degraded,true);
});

test('视觉编号越界、重复和非法分数不能移出错误资产；缓存避免重复调用',async()=>{
 let calls=0;const hunt=createAiHunt({settings:async()=>({enabled:true}),complete:async()=>{calls++;return {text:JSON.stringify({scores:[{index:1,score:20},{index:1,score:90},{index:2,score:'10'},{index:17,score:50},{index:2.5,score:0},{index:3,score:101}]})};}});
 const input={goal:'木板',sheet:'data:image/jpeg;base64,YWJj',count:3,cols:4,rows:4};
 assert.deepEqual((await hunt.rank(input)).scores,[{index:1,score:90,why:''}]);await hunt.rank(input);assert.equal(calls,1);
 await assert.rejects(hunt.rank({...input,sheet:'https://example.com/image.jpg'}),/拼图/);
 await assert.rejects(hunt.rank({...input,count:17}),/参数/);
});

test('视觉有效的空评分与调用失败分开，失败不缓存',async()=>{
 let fail=true,calls=0;const hunt=createAiHunt({settings:async()=>({enabled:true}),complete:async()=>{calls++;if(fail)throw Error('timeout');return {text:'{"scores":[]}'};}});
 const input={goal:'wood',sheet:'data:image/jpeg;base64,YWJj',count:1,cols:4,rows:4};
 assert.equal((await hunt.rank(input)).status,'failed');fail=false;
 assert.equal((await hunt.rank(input)).status,'ok');assert.equal(calls,2);
});
