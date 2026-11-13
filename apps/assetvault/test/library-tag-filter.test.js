import test from 'node:test';
import assert from 'node:assert/strict';
import {rowsFromState, matchesFilters, normalizeFilters} from '../server/library-query.mjs';

const uid = ch => ch.repeat(32);
const row = (tags, extra = {}) => ({uid: uid('a'), name: 'x', author: '', state: 'active', rating: 0,
  favorite: false, tags, categories: [], kinds: [], formats: [], note: '', platform: '', kind: 'models',
  model: {}, probe: null, ...extra});

const hit = (tags, filter) => matchesFilters(row(tags), normalizeFilters(filter), null);

test('选父级词能把子级一起筛出来（这才是「归类」的体感）', () => {
  assert.equal(hit(['oak'], {tags: ['木材']}), true);
  assert.equal(hit(['松木'], {tags: ['木材']}), true);
  assert.equal(hit(['marble'], {tags: ['石材']}), true);
  assert.equal(hit(['花岗岩'], {tags: ['石材']}), true);
  assert.equal(hit(['花岗岩'], {tags: ['木材']}), false);
});

test('别名在筛选时同样生效，不需要先把库里的英文标签改写掉', () => {
  assert.equal(hit(['wooden'], {tags: ['木材']}), true);
  assert.equal(hit(['wood'], {tags: ['木材']}), true);
  assert.equal(hit(['木材'], {tags: ['wood']}), true, '反向也成立：用别名去筛 canonical 标签');
  assert.equal(hit(['Stone'], {tags: ['石材']}), true);
});

test('词表里没有的值退回子串匹配，用户自造标签仍然能筛', () => {
  assert.equal(hit(['demo'], {tags: ['demo']}), true);
  assert.equal(hit(['demolition'], {tags: ['demo']}), true, '子串语义保留');
  assert.equal(hit(['other'], {tags: ['demo']}), false);
});

test('排除模式与包含模式共用同一套展开语义', () => {
  assert.equal(hit(['oak'], {tags: ['卡通'], excludeTags: ['木材']}), false);
  assert.equal(hit(['卡通'], {tags: ['卡通'], excludeTags: ['木材']}), true);
});

test('标签筛选与其它维度仍然是跨维 AND', () => {
  assert.equal(hit(['oak'], {tags: ['木材'], kinds: ['textures']}), false);
  assert.equal(hit(['oak'], {tags: ['木材'], kinds: ['models']}), true);
});

test('内存降级路径与 DB 路径共用同一语义（rowsFromState 也走词表）', () => {
  const rows = rowsFromState({'sfx-library-v2': JSON.stringify({
    models: [{uid: uid('b'), name: '椅', tags: ['oak'], assetType: 'model'}],
    userMeta: {}, favorites: [], trashed: [],
  })});
  assert.equal(matchesFilters(rows[0], normalizeFilters({tags: ['木材']}), null), true);
});
