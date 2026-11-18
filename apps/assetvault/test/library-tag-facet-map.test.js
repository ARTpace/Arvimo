import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeTagKey, ensureFacetVocab, facetModel, resolveTag,
  groupTagEntries, categoryMatches, invalidateFacetVocab,
} from '../src/library/tag-facet-map.js';

/** 一份迷你词表：够验证分组、归一、层级展开，不必造整个种子。 */
const VOCAB = {
  facets: {style: '风格', subject: '题材', material: '材质', usage: '用途', platform: '来源平台'},
  order: ['style', 'subject', 'material', 'usage', 'platform'],
  terms: [
    {v: '建筑', f: ['subject'], a: ['architecture', 'building', 'buildings']},
    {v: '住宅建筑', f: ['subject'], a: ['residential'], p: '建筑'},
    {v: '木材', f: ['material', 'subject'], a: ['wood', '木头']},
    {v: '写实', f: ['style'], a: ['realistic']},
    {v: '海报', f: ['usage'], a: ['poster']},
    {v: 'Sketchfab', f: ['platform'], a: []},
  ],
};

/** 拦下 fetch 灌一份词表进去 —— 走的是真实加载路径，不给模块开后门。 */
async function loadVocab(vocab = VOCAB) {
  invalidateFacetVocab();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ok: true, json: async () => ({vocab})});
  try { await ensureFacetVocab(); } finally { globalThis.fetch = original; }
  return facetModel();
}

test('归一键与服务端 normOf 一致：全角、大小写、多余空白都吃掉', async () => {
  // 前端和服务端各算一次归一键，两边不一致就会出现「一边能搜到、另一边搜不到」。
  assert.equal(normalizeTagKey('  ＷＯＯＤ  '), 'wood');
  assert.equal(normalizeTagKey('Low   Poly'), 'low poly');
  assert.equal(normalizeTagKey(null), '');
});

test('分组：同义词先归一到标准名再合并计数', async () => {
  await loadVocab();
  const groups = groupTagEntries([
    ['architecture', 241], ['building', 241], ['建筑', 241], ['wood', 10],
  ]);
  const subject = groups.find(group => group.key === 'subject');
  const names = subject.items.map(item => item.name);
  assert.ok(names.includes('建筑'), '应显示标准名「建筑」而不是原始英文');
  assert.ok(!names.includes('architecture'));
  // 三种写法是同一批资产的一次标注：取最大值（= 有多少个资产带这个词），
  // 相加会虚高成 723 —— 服务端 tag_counts 按 uid 去重后就是 241。
  assert.equal(subject.items.find(item => item.name === '建筑').count, 241);
});

test('分组：一个词属于多个面就出现在多组（面是边不是列）', async () => {
  await loadVocab();
  const groups = groupTagEntries([['wood', 10]]);
  // 组序按词表定义序（subject 在 material 前），不是按数量也不是按字母
  assert.deepEqual(groups.filter(group => group.items.some(item => item.name === '木材')).map(group => group.key), ['subject', 'material']);
});

test('分组：词表里没有的词进「未归类」，并排在最后', async () => {
  await loadVocab();
  const groups = groupTagEntries([['我的私藏', 3], ['写实', 5]]);
  assert.equal(groups[groups.length - 1].key, 'unfiled');
  assert.equal(groups[groups.length - 1].label, '未归类');
  assert.equal(groups[groups.length - 1].items[0].name, '我的私藏');
});

test('分组：组序按词表定义序，不按数量；空组不占位置', async () => {
  await loadVocab();
  const groups = groupTagEntries([['poster', 99], ['wood', 1]]);
  // poster 数量最多但排最后：组的次序由词表说了算（风格→题材→材质→用途→来源平台）
  assert.deepEqual(groups.map(group => group.key), ['subject', 'material', 'usage']);
  assert.equal(groups[0].items[0].name, '木材');
});

test('归一：词表里的词返回标准名与面，不在词表的原样返回', async () => {
  await loadVocab();
  assert.deepEqual(resolveTag('BUILDINGS'), {name: 'BUILDINGS', canonical: '建筑', facets: ['subject'], known: true});
  assert.deepEqual(resolveTag('随便写的'), {name: '随便写的', canonical: '随便写的', facets: [], known: false});
});

test('筛选命中：选一个词要能筛出打了它别名/子孙的资产', async () => {
  await loadVocab();
  // 点「建筑」要命中写着 architecture / building / 住宅建筑 的资产
  assert.equal(categoryMatches(['architecture'], '建筑'), true);
  assert.equal(categoryMatches(['建筑'], '建筑'), true);
  assert.equal(categoryMatches(['residential'], '建筑'), true, '子孙要一起筛出来');
  assert.equal(categoryMatches(['木材'], '建筑'), false);
});

test('筛选命中：分类不在词表里时退回精确匹配，不乱展开', async () => {
  await loadVocab();
  assert.equal(categoryMatches(['我的私藏'], '我的私藏'), true);
  assert.equal(categoryMatches(['我的私藏2'], '我的私藏'), false);
});

test('词表没加载时：分组退回单组未归类，筛选退回精确匹配', async () => {
  invalidateFacetVocab();
  assert.equal(facetModel(), null);
  const groups = groupTagEntries([['建筑', 3]]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'unfiled');
  assert.equal(categoryMatches(['建筑'], '建筑'), true);
  assert.equal(categoryMatches(['architecture'], '建筑'), false);
});
