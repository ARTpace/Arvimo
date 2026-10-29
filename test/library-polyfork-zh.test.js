import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {labelZh,valueZh,labelOf,valueOf,describeOf} from '../src/library/polyfork-zh.js';
import {normalizeZh,parseLooseJson,buildPrompt} from '../server/polyfork-zh.mjs';
import {panelHtml} from '../src/library/polyfork-params.js';

const ROOT = new URL('..', import.meta.url);
const read = file => readFileSync(new URL(`src/library/${file}`, ROOT), 'utf8');
const serverRead = file => readFileSync(new URL(`server/${file}`, ROOT), 'utf8');

// 真实字段取自 windmill-3aad49 / windmill-pump-2993a4 的 -params.json。
const schema = {
  params: [
    {key: 'colorway', kind: 'preset', label: 'Colorway', options: ['cream-stone', 'pine-and-galvanised']},
    {key: 'stone', kind: 'color', label: 'Stone', describe: 'albedo of the dominant masonry blocks'},
    {key: 'capPitch', kind: 'geometry', type: 'range', label: 'Cap pitch', describe: 'height of the conical cap'},
    {key: 'vane', kind: 'geometry', type: 'choice', label: 'Vane blades', options: ['12', '18', '24']},
    {key: 'weather', kind: 'geometry', type: 'range', label: 'Weathering'},
  ],
  presets: {'cream-stone': {}, 'pine-and-galvanised': {}},
};

test('label 能翻就用 label —— 同一个 key 在不同资产里含义会变', () => {
  assert.equal(labelZh({key: 'capPitch', label: 'Cap pitch'}), '顶盖坡度');
  assert.equal(labelZh({key: 'vane', label: 'Vane blades'}), '风轮叶片数');
  // 反证：windmill 的 timber 是木构架，windmill-pump 的 timber label 却是 Boards。
  // 若 key 表优先，这里会错误地显示成「木构架」。
  assert.equal(labelZh({key: 'timber', label: 'Boards'}), '木板');
});

test('label 翻不出来时才用 key 表兜底', () => {
  // mortar 的 label 含 minority 这个词表里没有的词，拆词失败 → 落回 key。
  assert.equal(labelZh({key: 'mortar', label: 'Mortar & minority stone'}), '砂浆与杂石');
  assert.equal(labelZh({key: 'boomtown', label: 'Boom'}), '景气');
});

test('key 没命中时走整串短语表，避免拆词拆出「墙 收分」', () => {
  assert.equal(labelZh({key: 'z1', label: 'Wall batter'}), '墙面收分');
  assert.equal(labelZh({key: 'z2', label: 'Maker\'s mark'}), '制作者标牌');
});

test('整串也不认识就逐词拼，中文语序正好是英文的修饰在前', () => {
  assert.equal(labelZh({key: 'z3', label: 'Sail count'}), '风帆数量');
  assert.equal(labelZh({key: 'z4', label: 'Roof pitch'}), '屋顶坡度');
});

test('认不全的词原样返回英文 —— 半中半英比英文更难读', () => {
  const raw = 'Baffle ridge';
  assert.equal(labelZh({key: 'z5', label: raw}), raw);
  // 反证：只要有一个词不认识就不能拼。
  assert.notEqual(labelZh({key: 'z5', label: raw}), '挡板 ridge');
});

test('带括号的 label 去掉括号内容再匹配', () => {
  assert.equal(labelZh({key: 'zz', label: 'Interior (lit at night)'}), '室内（夜间透光）');
});

test('配色方案名逐词翻，连词丢掉', () => {
  assert.equal(valueZh('cream-stone'), '奶油色石材');
  assert.equal(valueZh('pine-and-galvanised'), '松木镀锌');
  assert.equal(valueZh('moss-stone'), '苔藓石材');
});

test('纯数字选项不被翻译，原样留着', () => {
  assert.equal(valueZh('12'), '12');
  assert.equal(valueZh('18'), '18');
});

test('规则层翻出来了就信规则层，模型字典只补空缺', () => {
  // 实测：模型把 windmill 的 cap pitch 译成「机头坡度」，比规则层的「顶盖坡度」差。
  const zh = {labels: {capPitch: '机头坡度', takona: '塔科纳彩绘'}, values: {'cream-stone': '奶油石', takona: '彩绘'}, describes: {stone: '墙体主色'}};
  assert.equal(labelOf({key: 'capPitch', label: 'Cap pitch'}, zh), '顶盖坡度');
  assert.equal(valueOf('cream-stone', zh), '奶油色石材');
  // 规则层认不出来的才轮到字典。
  assert.equal(labelOf({key: 'takona', label: 'Takona body paint'}, zh), '塔科纳彩绘');
  assert.equal(valueOf('takona', zh), '彩绘');
  assert.equal(describeOf({key: 'stone', describe: 'albedo'}, zh), '墙体主色');
  // 字典里也没有的，仍旧落回规则层结果，不会是空字符串。
  assert.equal(labelOf({key: 'vane', label: 'Vane blades'}, zh), '风轮叶片数');
});

test('模型返回的围栏 JSON 能剥出来', () => {
  const text = '好的，结果如下：\n```json\n{"labels":{"stone":"石材"}}\n```';
  assert.deepEqual(parseLooseJson(text), {labels: {stone: '石材'}});
  assert.equal(parseLooseJson('完全不是 JSON'), null);
});

test('白名单校验：模型编出来的键、超长文本、非字符串全丢掉', () => {
  const raw = {
    labels: {stone: '石材', 不存在的键: '幽灵', capPitch: 'x'.repeat(40)},
    values: {'cream-stone': '奶油色石材', 'red-cap': '红顶盖'},
    describes: {stone: '墙体主色'.repeat(30)},
    extra: {stone: '多余字段'},
  };
  const zh = normalizeZh(raw, schema);
  assert.equal(zh.labels.stone, '石材');
  assert.ok(!('不存在的键' in zh.labels));
  assert.ok(zh.labels.capPitch.length <= 12);
  assert.equal(zh.values['cream-stone'], '奶油色石材');
  // red-cap 不在这个资产的取值集合里，模型顺手编的也要拦掉。
  assert.ok(!('red-cap' in zh.values));
  assert.ok(zh.describes.stone.length <= 60);
  assert.ok(!('extra' in zh));
});

test('一个字都没翻出来时返回 null，前端就留在规则层', () => {
  assert.equal(normalizeZh({labels: {不存在: '无'}}, schema), null);
  assert.equal(normalizeZh(null, schema), null);
  assert.equal(normalizeZh('字符串', schema), null);
});

test('喂给模型的 prompt 带上全部待翻字段且要求纯 JSON', () => {
  const messages = buildPrompt(schema);
  const body = messages.map(m => m.content).join('\n');
  assert.match(body, /Cap pitch/);
  assert.match(body, /cream-stone/);
  assert.match(body, /\{"labels"/);
  // describe 太长会挤爆上下文，进 prompt 前要截断。
  assert.ok(body.length < 4000);
});

test('前端按 data-pf-label 就地换字，不重渲染控件', () => {
  const src = read('polyfork-params.js');
  assert.match(src, /data-pf-label=/);
  assert.match(src, /\/api\/polyfork\/zh\?/);
  // 反证：译文到了之后不能重新 innerHTML，否则正在拖的滑杆会被掐断。
  const refine = src.slice(src.indexOf('async function refineZh'), src.indexOf('function syncControls'));
  assert.ok(!/innerHTML/.test(refine));
});

test('面板第一次渲染就是中文，且带上供后续替换的锚点', () => {
  const html = panelHtml(schema, {colorway: 'cream-stone', capPitch: 0.75}, null);
  assert.match(html, />顶盖坡度</);
  assert.match(html, />配色方案</);
  assert.match(html, /data-pf-label="capPitch"/);
  // 配色方案名不再是连字符英文，而是中文色名。
  assert.match(html, /奶油色石材/);
  assert.ok(!/Cap pitch/.test(html), '英文参数名不该漏到界面上');
});

test('服务端译文接口走本地请求头校验，且复用参数清单的缓存', () => {
  const src = serverRead('library.mjs');
  assert.match(src, /pathname==='\/api\/polyfork\/zh'/);
  assert.match(src, /x-sfx-local/);
  assert.match(src, /polyforkZh\.get\(id,schema/);
});
