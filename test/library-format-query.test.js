// 格式维度进入查询契约：字段别名、行派生、filters 白名单、HTTP GET/POST、能力位。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryServer} from '../server/library.mjs';
import {normalizeRows, fieldText, queryAssets, matchesQuery, normalizeFilters} from '../server/library-query.mjs';
import {parseSearchExpression, SEARCH_FIELDS, SEARCH_SYNTAX_HELP} from '../server/search-expression.mjs';
import {SERVER_CAPABILITIES, SERVER_VERSION, serverIsCurrent} from '../server/capabilities.mjs';

const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32), D = 'd'.repeat(32), E = 'e'.repeat(32);
const models = [
  {uid: A, name: '渲染图', filePath: 'C:/assets/a.png'},
  {uid: B, name: '模型', format: 'FBX', entries: [{rel: 'b.fbx'}]},
  {uid: C, name: '笔记', filePath: 'C:/assets/c.md'},
  {uid: D, name: '未识别', filePath: 'C:/assets/d.bin'},
  {uid: E, name: '相机原片', filePath: 'C:/assets/e.cr3'},
];
const state = {'sfx-library-v2': JSON.stringify({version: 2, models, favorites: [], aiTags: {}, userTags: {},
  userMeta: {}, trashed: [], history: [], tasks: [], options: {}})};
const LOCAL = {'X-SFX-Local': '1', 'Content-Type': 'application/json'};

const rows = () => normalizeRows(models.map(model => ({uid: model.uid, payload: JSON.stringify(model)})));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-format-api-'));
  const previous = process.env.SFX_DATA_DIR;
  process.env.SFX_DATA_DIR = dir;
  let server;
  try { server = createLibraryServer(); }
  finally { if (previous === undefined) delete process.env.SFX_DATA_DIR; else process.env.SFX_DATA_DIR = previous; }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, {recursive: true, force: true});
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const call = async (base, pathname, {method = 'GET', body} = {}) => {
  const response = await fetch(base + pathname, {method, headers: LOCAL,
    body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json().catch(() => ({}))};
};
// SQLite 表没有 ORDER BY，行序由派生索引决定；这里只关心命中集合，不锁死顺序。
const hitUids = data => [...(data.uids || [])].sort();

test('检索语法新增 ext:/format:/filetype:，帮助文本同步', () => {
  assert.ok(SEARCH_FIELDS.includes('format'));
  assert.match(SEARCH_SYNTAX_HELP, /ext:/);
  for (const alias of ['ext', 'extension', 'format', 'filetype']) {
    assert.equal(parseSearchExpression(`${alias}:png`).clauses[0].field, 'format');
  }
  assert.equal(matchesQuery(rows()[0], parseSearchExpression('ext:png')), true);
  assert.equal(matchesQuery(rows()[0], parseSearchExpression('-ext:png')), false);
  assert.equal(matchesQuery(rows()[1], parseSearchExpression('format:model')), true, '分组 id 也可作为 format 值');
  assert.equal(matchesQuery(rows()[0], parseSearchExpression('ext:pngx')), false, '后缀是精确匹配');
});

test('normalizeRows 派生 formats / formatGroups，两条引擎同形', () => {
  const list = rows();
  assert.deepEqual(list[0].formats, ['png']);
  assert.deepEqual(list[0].formatGroups, ['image']);
  assert.deepEqual(list[1].formats, ['fbx']); // format 字段与包内条目同名后缀只算一次
  assert.ok(list[2].formats.includes('md'));
  assert.deepEqual(list[3].formatGroups, []);
  assert.equal(fieldText(list[0], 'format'), 'png image');
});

test('本库格式归位后，分组 id 检索也覆盖 USD / HDR / OGV / ZIP', () => {
  const local = normalizeRows([
    {uid: A, payload: JSON.stringify({uid: A, filePath: 'C:/assets/a.usdz'})},
    {uid: B, payload: JSON.stringify({uid: B, filePath: 'C:/assets/b.hdr'})},
    {uid: C, payload: JSON.stringify({uid: C, filePath: 'C:/assets/c.ogv'})},
    {uid: D, payload: JSON.stringify({uid: D, filePath: 'C:/assets/d.zip'})},
  ]);
  const hit = (index, q) => matchesQuery(local[index], parseSearchExpression(q));
  assert.deepEqual(local[0].formatGroups, ['model']);
  assert.equal(hit(0, 'format:model'), true, 'USD 归 3D 模型组后 format:model 应命中');
  assert.equal(hit(0, 'format:extra'), false, '旧的本库扩展组 id 已废弃');
  assert.equal(hit(1, 'format:image'), true);
  assert.equal(hit(2, 'format:video'), true);
  assert.equal(hit(3, 'format:misc'), true);
  assert.equal(hit(0, 'ext:usdz'), true, '精确后缀检索不受归位影响');
});

test('filters.formats 白名单：正向 / 排除 / text / unknown / 未激活', () => {
  const list = rows();
  const uids = filters => queryAssets({rows: list, filters}).uids;
  assert.deepEqual(uids({formats: ['png', 'jpg']}), [A]);
  assert.deepEqual(uids({formats: ['cr3']}), [E], '相机 RAW 也能按后缀筛');
  assert.deepEqual(uids({formats: ['text']}), [C]);
  assert.deepEqual(uids({formats: ['unknown']}), [D]);
  assert.deepEqual(uids({formats: ['png'], excludeFormats: true}), [B, C, D, E]);
  assert.equal(uids({}).length, 5);
  assert.equal(normalizeFilters({}).formats.active, false, '老请求不带 formats 时不影响结果');
  assert.equal(normalizeFilters({formats: 'png, jpg'}).formats.exts.length, 2, 'GET 的逗号字符串也接受');
});

test('HTTP：/query/status 暴露 format 字段，POST /query 与 GET /assets 都吃格式筛选', async t => {
  const base = await fixture(t);
  assert.equal((await call(base, '/api/library-state', {method: 'POST', body: state})).status, 200);
  const status = await call(base, '/api/library/query/status');
  assert.equal(status.status, 200);
  assert.ok(status.data.fields.includes('format'));
  assert.match(status.data.syntax, /ext:/);

  const post = body => call(base, '/api/library/query', {method: 'POST', body});
  assert.deepEqual((await post({q: 'ext:cr3'})).data.uids, [E]);
  assert.deepEqual((await post({filters: {formats: ['text']}})).data.uids, [C]);
  assert.deepEqual(hitUids((await post({filters: {formats: ['png'], excludeFormats: true}})).data), [B, C, D, E].sort());
  assert.deepEqual((await post({filters: {formats: ['unknown']}})).data.uids, [D]);

  const get = query => call(base, `/api/library/assets?${query}`);
  assert.deepEqual((await get('formats=png,jpg')).data.uids, [A]);
  assert.deepEqual(hitUids((await get('formats=png&exclude=1')).data), [B, C, D, E].sort());
  assert.equal((await get('formats=')).data.total, 5, '空 formats 等于没有筛选');
});

test('能力位与版本：老进程必须被启动器换掉', () => {
  assert.equal(SERVER_CAPABILITIES.libraryFormatFilter, true);
  assert.equal(SERVER_CAPABILITIES.version, SERVER_VERSION);
  // 版本只升不降（3.13.0 加格式能力位，3.13.1 格式归位需换掉旧进程）：只卡下限，不锁死具体值。
  const [major, minor, patch] = SERVER_VERSION.split('.').map(Number);
  assert.ok(major * 10000 + minor * 100 + patch >= 31301,
    `SERVER_VERSION 必须 >= 3.13.1，实际 ${SERVER_VERSION}`);
  assert.equal(serverIsCurrent({...SERVER_CAPABILITIES, libraryFormatFilter: false}), false);
  assert.equal(serverIsCurrent(SERVER_CAPABILITIES), true);
});

test('前端本地网格与服务端共用同一匹配器，不再自备格式判断', async () => {
  const local = await fs.readFile(new URL('../src/library/local-files.js', import.meta.url), 'utf8');
  assert.match(local, /import \{FORMATS, extensionOf, formatOf, formatKind, formatsOfModel\}/);
  assert.match(local, /matchesFormatFilter\(\[file\.ext\|\|file\.format\]/);
  assert.match(local, /matchesFormatFilter\(formatsOfModel\(pkg\)/);
  assert.match(local, /const mode=entry\?\.preview\|\|'none'/);
  assert.ok(!local.includes('(png|jpe?g'), '不允许再留一份手写扩展名正则');
  const app = await fs.readFile(new URL('../src/library/app.js', import.meta.url), 'utf8');
  assert.match(app, /createFormatFilterState\(\)/);
  assert.match(app, /localFiles\.matches\(file,\{query,kind,formats\}\)/);
});
