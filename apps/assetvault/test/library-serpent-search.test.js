import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {parseSearchExpression} from '../server/search-expression.mjs';
import {createLibraryDb} from '../server/library-db.mjs';
import {rowsFromState, queryAssets} from '../server/library-query.mjs';
import {compileQuery} from '../server/query-sql.mjs';
import {runPushdown} from '../server/library-pushdown.mjs';

// 仅内存 SQLite 和人工元数据；真实本地库查询入口，不是远端站点检索或 UI 验收。
test('Serpent 字段短语在现有本地库内存/SQL入口生效，普通词与整词字面量保持兼容', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
  const values = {'sfx-library-v2': JSON.stringify({version: 2, models: [
    {uid: a, name: 'Robot Arm', author: 'Alice Smith', tags: ['hard surface'], platform: 'local', url: 'https://example.invalid/robot', filePath: '/art/robot arm.glb', addedAt: 3},
    {uid: b, name: 'Robot Leg', author: 'Bob Jones', tags: ['organic'], platform: 'local', url: 'https://example.invalid/leg', addedAt: 2},
    {uid: c, name: 'tag:literal -marker', author: 'Other', tags: [], platform: 'local', addedAt: 1},
  ], userMeta: {[a]: {note: 'hero unit'}}, favorites: [], trashed: []})};
  const rows = rowsFromState(values);
  const db = createLibraryDb({Database, file: ':memory:'});
  try {
    db.writeValues(values, {replace: true});
    for (const [q, expected] of [
      ['Robot', [a, b]],
      ['Robot Arm', [a]],
      ['name:"Robot Arm"', [a]],
      ['tag:"hard surface" author:"Alice Smith"', [a]],
      ['Robot -author:"Alice Smith"', [b]],
      ['name:"Robot Arm" | name:"Robot Leg"', [a, b]],
      ['desc:"hero unit"', [a]],
      ['url:robot', [a]],
      ['"tag:literal"', [c]],
      ['"-marker"', [c]],
      ['name:"Robot Arm" -tag:"hard surface"', []],
    ]) {
      assert.deepEqual(queryAssets({rows, q}).uids, expected, `内存 ${q}`);
      const plan = compileQuery({q});
      assert.equal(plan.ok, true, `SQL可下推 ${q}`);
      assert.deepEqual(runPushdown(db, plan, {uidScope: 'all'}).uids, expected, `SQL ${q}`);
    }
    const q = 'path:"robot arm"';
    assert.deepEqual(queryAssets({rows, q}).uids, [a]);
    assert.equal(compileQuery({q}).ok, false, 'path 继续沿已有内存降级，不伪造 SQL 字段');
    assert.deepEqual(parseSearchExpression('name:"Robot Arm"').clauses[0], {field: 'name', values: ['Robot Arm'], exclude: false});
  } finally { db.close(); }
});
