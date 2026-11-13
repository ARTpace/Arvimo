// 阶段 5.6 的两条验收：目录读投影必须瘦（内存），V5 列化必须可回填（可下推）。
//
// 这两个改动都在「读侧」，出错的表现都是「界面看起来正常、但筛选少了东西」，
// 所以测试直接盯住契约本身：剥掉的字段清单、回填后的列值、下推与内存路径的一致性。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {compileQuery} from '../server/query-sql.mjs';
import {runPushdown} from '../server/library-pushdown.mjs';
import {rowsFromState, queryAssets} from '../server/library-query.mjs';

const U = n => `s${String(n).padStart(4, '0')}${'y'.repeat(26)}`;
const temp = async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'av-slim-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
};

/** 一条带下载任务包袱的资产：logs / verification 正是目录里最占地方的两个字段。 */
const models = [
  {uid: U(1), name: '石灯', platform: 'sketchfab', assetType: 'model', categories: ['props'],
    addedAt: 1000, downloadable: true, filePath: 'D:/assets/lamp.fbx', bytes: 2048,
    logs: ['开始下载', '校验完成', '已保存'], verification: {entries: 12, sha256: 'a'.repeat(64)}},
  {uid: U(2), name: '布纹贴图', platform: 'ambientcg', assetType: 'texture',
    addedAt: 2000, downloadable: false, bytes: 512},
];
const values = {'sfx-library-v2': JSON.stringify({version: 2, models, trashed: []})};

test('目录读投影剥掉下载任务重字段，其余字段一个不少', async t => {
  const dir = await temp(t);
  const db = createLibraryDb({Database, file: path.join(dir, 'library.db')});
  db.writeValues(values, {replace: true});

  const page = db.readCatalogPage(0, 10);
  const lamp = page.items.find(model => model.uid === U(1));
  assert.ok(lamp, '资产必须在目录里');
  assert.equal(lamp.logs, undefined, '下载日志不进目录：它是任务详情，卡片一个字段都用不到');
  assert.equal(lamp.verification, undefined, '校验报告同理');
  // 卡片与右键菜单真正读的字段必须原样保留，否则「瘦身」会变成「丢功能」。
  assert.equal(lamp.filePath, 'D:/assets/lamp.fbx');
  assert.equal(lamp.bytes, 2048);
  assert.equal(lamp.name, '石灯');
  assert.equal(db.readCatalog().models.length, 2, '整表读取同样走瘦身投影');
  db.close();
});

test('V5 回填：列被清空后重开库自动补回，分类筛选照常命中', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'library.db');
  const first = createLibraryDb({Database, file});
  first.writeValues(values, {replace: true});
  first.close();

  // 模拟老库：V5 之前写下的行，两列都是空的，且没有回填标记。
  const raw = new Database(file);
  raw.prepare('UPDATE assets SET category_text = NULL, downloadable = 0').run();
  raw.prepare("DELETE FROM db_meta WHERE key = 'derive_v5'").run();
  raw.close();

  const reopened = createLibraryDb({Database, file});
  assert.equal(reopened.getMeta('derive_v5') !== null, true, '回填必须留下标记，只跑一次');

  const rows = rowsFromState(values);
  for (const query of [{filters: {categories: ['props']}}, {filters: {downloadable: true}}]) {
    const expected = queryAssets({rows, ...query});
    const plan = compileQuery(query);
    assert.equal(plan.ok, true, `回填后应可下推：${plan.reason}`);
    const actual = runPushdown(reopened, plan, {uidScope: 'all'});
    assert.deepEqual(actual.uids, expected.uids, '回填出来的列必须与内存路径给出同一批资产');
  }
  reopened.close();
});
