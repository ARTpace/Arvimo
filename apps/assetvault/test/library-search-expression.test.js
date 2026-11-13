// 搜索语法解析：移植自 Serpent（MIT）的纯函数，逐条锁死语义，防止后续「优化」悄悄改坏。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSearchExpression, tokenizeSearchExpression, SEARCH_FIELDS, SEARCH_SYNTAX_HELP} from '../server/search-expression.mjs';

test('词法：空格分词、引号保留短语与竖线、反斜杠转义', () => {
  assert.deepEqual(tokenizeSearchExpression('stone  lantern'), ['stone', 'lantern']);
  assert.deepEqual(tokenizeSearchExpression('"stone lantern" | robot'), ['stone lantern', '|', 'robot']);
  assert.deepEqual(tokenizeSearchExpression('tag:a\\ b -bot'), ['tag:a b', '-bot']);
  assert.deepEqual(tokenizeSearchExpression('  '), []);
  assert.deepEqual(tokenizeSearchExpression('a\\'), ['a\\']);
});

test('空格 = AND：同组所有 clause 都要满足', () => {
  const parsed = parseSearchExpression('stone lantern');
  assert.deepEqual(parsed.groups, []);
  assert.equal(parsed.clauses.length, 2);
  assert.deepEqual(parsed.clauses.map(c => c.values[0]), ['stone', 'lantern']);
  assert.ok(parsed.clauses.every(c => c.exclude === false && c.field === null));
});

test('竖线 = OR：拆成多个 AND 组，连续竖线不产生空组', () => {
  const parsed = parseSearchExpression('robot | stone lantern');
  assert.deepEqual(parsed.clauses, []);
  assert.equal(parsed.groups.length, 2);
  assert.equal(parsed.groups[0].length, 1);
  assert.equal(parsed.groups[1].length, 2);
  assert.equal(parseSearchExpression('a | | b').groups.length, 2);
  // 尾部竖线不该多出一个空组；只有一个非空组时仍走 clauses 快路径。
  assert.deepEqual(parseSearchExpression('a |'), {clauses: [{field: null, values: ['a'], exclude: false}], groups: []});
});

test('前导 - 表示排除，冒号别名限定字段，未知别名当普通词', () => {
  const parsed = parseSearchExpression('tag:石头 -author:demo platform:sketchfab http:foo');
  assert.deepEqual(parsed.clauses.map(c => [c.field, c.values[0], c.exclude]), [
    ['tags', '石头', false], ['author', 'demo', true],
    ['platform', 'sketchfab', false], [null, 'http:foo', false],
  ]);
  assert.ok(SEARCH_FIELDS.includes('rating'));
  assert.ok(SEARCH_FIELDS.includes('metadata'));
  assert.match(SEARCH_SYNTAX_HELP, /空格/);
});

test('空查询、纯符号、引号内冒号都不会产生垃圾条件', () => {
  assert.deepEqual(parseSearchExpression(''), {clauses: [], groups: []});
  assert.deepEqual(parseSearchExpression('   |   '), {clauses: [], groups: []});
  assert.deepEqual(parseSearchExpression('-'), {clauses: [], groups: []});
  assert.deepEqual(parseSearchExpression('"tag:stone"').clauses[0], {field: null, values: ['tag:stone'], exclude: false});
  assert.deepEqual(parseSearchExpression('"-robot"').clauses[0], {field: null, values: ['-robot'], exclude: false}, '引号里的 - 是字面量');
});
