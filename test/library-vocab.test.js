import test from 'node:test';
import assert from 'node:assert/strict';
import {FACETS, TERMS, VOCAB_REV} from '../server/library-vocab.seed.mjs';
import {buildVocab, normOf, validateVocab} from '../server/library-vocab.mjs';

test('种子词表自身合法：面齐全、无重词、无别名撞名、无坏父级', () => {
  assert.deepEqual(validateVocab(TERMS, FACETS), []);
  assert.ok(VOCAB_REV >= 1);
  assert.deepEqual(Object.keys(FACETS), ['style', 'subject', 'material', 'usage', 'mood', 'tech']);
});

test('归一键吃掉大小写、全角与多余空白，但不改显示用 value', () => {
  assert.equal(normOf('  ＷＯＯＤ  '), 'wood');
  assert.equal(normOf('Low   Poly'), 'low poly');
  assert.equal(normOf(null), '');
});

test('别名与 canonical 都收敛到同一个 value', () => {
  const vocab = buildVocab();
  for (const input of ['wood', 'WOOD', '木头', '木材', ' Ｗｏｏｄ ']) {
    assert.equal(vocab.canonical(input), '木材', `${input} 应归一到 木材`);
  }
  assert.equal(vocab.canonical('stone'), '石材');
  assert.equal(vocab.canonical('从未出现过的词'), null);
});

test('双面词：一个值挂多条边，不需要二选一', () => {
  const vocab = buildVocab();
  assert.deepEqual([...vocab.facetsOf('木材')].sort(), ['material', 'subject']);
  assert.deepEqual([...vocab.facetsOf('石材')].sort(), ['material', 'subject']);
  // 只属于一个面的词不会被多挂
  assert.deepEqual(vocab.facetsOf('卡通'), ['style']);
  // 通过别名查询结果一致：面由值决定，不由输入形式决定
  assert.deepEqual([...vocab.facetsOf('wood')].sort(), ['material', 'subject']);
});

test('层级：检索时向下展开，含自身；无子级只返回自身', () => {
  const vocab = buildVocab();
  assert.deepEqual(vocab.descendantValues('木材').sort(), ['松木', '木材', '橡木'].sort());
  assert.deepEqual(vocab.descendantValues('石材').sort(), ['大理石', '石材', '花岗岩'].sort());
  assert.deepEqual(vocab.descendantValues('建筑'), ['建筑']);
  assert.deepEqual(vocab.descendantValues('不存在的词'), []);
});

test('validateVocab 抓得住四类脏数据', () => {
  const facets = {style: '风格', subject: '题材'};
  const problems = validateVocab([
    {value: '木材', facets: ['style'], aliases: ['wood']},
    {value: '木材', facets: ['style'], aliases: ['wood']},          // 重词 + 重别名
    {value: '石材', facets: ['nope'], aliases: ['wood']},           // 坏面 + 别名撞名
    {value: '橡木', facets: ['style'], parent: '不存在'},            // 父级缺失
    {value: '甲', facets: ['style'], parent: '乙'},                  // 成环
    {value: '乙', facets: ['style'], parent: '甲'},
    {value: '无面词', facets: []},                                  // 没归属
  ], facets);
  const text = problems.join('\n');
  assert.match(text, /重复词条：木材/);
  assert.match(text, /别名 wood 同时属于/);
  assert.match(text, /的面 nope 不在 FACETS/);
  assert.match(text, /父级 不存在 不存在/);
  assert.match(text, /层级成环/);
  assert.match(text, /无面词 没有归属任何面/);
});

test('成环的词表不会让层级展开死循环', () => {
  const vocab = buildVocab([
    {value: '甲', facets: ['style'], parent: '乙'},
    {value: '乙', facets: ['style'], parent: '甲'},
  ], {style: '风格'});
  assert.deepEqual(vocab.descendantValues('甲').sort(), ['乙', '甲'].sort());
});
