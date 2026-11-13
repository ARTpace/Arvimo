// S2 的核心验收：同一条查询，走 SQL 下推与走全量内存求值，结果必须逐字节一致。
//
// 这类测试的价值不在「覆盖率」，而在**守住等价性**：下推写错一个 NULL 处理，
// 结果就会少几条，而这种 bug 用户永远发现不了。所以用例刻意覆盖边界
// （缺宽高、缺体积、缺色相、trashed、词表外标签、大小写、排除子句）。
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {compileQuery} from '../server/query-sql.mjs';
import {runPushdown} from '../server/library-pushdown.mjs';
import {rowsFromState, queryAssets, normalizeFilters} from '../server/library-query.mjs';

const U = n => `u${String(n).padStart(4, '0')}${'x'.repeat(26)}`;

/** 覆盖边界的数据集：缺宽高 / 缺体积 / 缺色相 / 单边宽高 / trashed / 词表内外标签 / 多格式。 */
const models = [
  {uid: U(1), name: '国风石灯', author: 'Alice', platform: 'sketchfab', assetType: 'model', ext: 'fbx',
    tags: ['stone', '建筑'], addedAt: 1000, bytes: 1000, likes: 10, downloadable: true, categories: ['models']},
  {uid: U(2), name: '橡木椅', author: 'Bob', platform: 'artstation', assetType: 'model', ext: 'glb',
    tags: ['oak', '建筑'], addedAt: 2000, bytes: 2000, likes: 20, downloadable: false},
  {uid: U(3), name: 'Oak Table', author: 'Carol', platform: 'sketchfab', assetType: 'texture', ext: 'png',
    tags: ['wooden', 'wood'], addedAt: 3000},
  {uid: U(4), name: 'Demo Rock', author: 'Dave', platform: 'ambientcg', assetType: 'texture', ext: 'jpg',
    tags: ['demo', 'demo-rock'], addedAt: 4000, bytes: 4000},
  {uid: U(5), name: '机器人', author: 'Erin', platform: 'local', assetType: 'model', ext: 'custom',
    tags: ['mech'], addedAt: 5000, note: '内部项目'},
  {uid: U(6), name: '光晕', author: 'Frank', platform: 'polyhaven', assetType: 'hdri', ext: 'hdr',
    tags: ['明亮'], addedAt: 6000},
  {uid: U(7), name: '布纹贴图', author: 'Alice', platform: 'ambientcg', assetType: 'texture',
    tags: ['fabric', '无缝'], addedAt: 7000, bytes: 7000},
  {uid: U(8), name: '赛博街景', author: 'Gina', platform: 'artstation', assetType: 'model', ext: 'obj',
    tags: ['卡通'], addedAt: 8000, bytes: 8000},
];
// probe 只给一部分资产：缺数据的行必须在下推路径里同样被 NULL 规则正确对待。
const assetProbe = {
  [U(1)]: {width: 2048, height: 2048, h: 30, s: 0.4, l: 0.5, hex: '#aa7744', duration: null},
  [U(2)]: {width: 1024, height: 2048, h: 200, s: 0.3, l: 0.4, hex: '#4466aa', duration: null},
  [U(3)]: {width: 4096, height: 4096, h: 120, s: 0.5, l: 0.5, hex: '#44aa55', duration: null},
  // 单边宽高：numericValue 要求宽高都有，这里应被视为「无分辨率」
  [U(4)]: {width: 3000},
  [U(6)]: {width: 8192, height: 4096, h: 350, s: 0.6, l: 0.7, hex: '#ff3333', duration: null},
  [U(8)]: {duration: 42},
};
const values = {
  'sfx-library-v2': JSON.stringify({
    version: 2, models, assetProbe,
    aiTags: {[U(1)]: ['石材'], [U(3)]: ['木材']},
    userTags: {[U(2)]: ['常用']},
    userMeta: {[U(1)]: {rating: 5, note: '主力石材'}, [U(2)]: {rating: 3}, [U(8)]: {rating: 4}},
    favorites: [U(1), U(8)],
    trashed: [{uid: U(9), name: '旧沙发', platform: 'sketchfab', tags: ['fabric'], trashedAt: 9000,
      userMeta: {rating: 2}}],
  }),
};

const db = createLibraryDb({Database, file: ':memory:'});
db.writeValues(values, {replace: true});
const rows = rowsFromState(values);
const run = input => ({plan: compileQuery(input), expected: queryAssets({rows, ...input})});
const pushed = plan => runPushdown(db, plan, {uidScope: 'all'});

/** 一个用例 = 一次编译 + 一次对照。不能下推的用例必须明确 expectPushdown:false。 */
function check(label, input, {expectPushdown = true} = {}) {
  const {plan, expected} = run(input);
  if (!expectPushdown) {
    assert.equal(plan.ok, false, `${label}：本应拒绝下推，却编译成功`);
    return;
  }
  assert.equal(plan.ok, true, `${label}：应可下推，实际拒绝（${plan.reason}）`);
  const actual = pushed(plan);
  assert.equal(actual.total, expected.total, `${label}：总数不一致`);
  assert.deepEqual(actual.uids, expected.uids, `${label}：顺序或成员不一致`);
}

test.after(() => db.close());

test('基础筛选：状态 / 评分 / 收藏 / 平台 / 类型', () => {
  check('空查询', {});
  check('只看回收站', {filters: {state: 'trashed'}});
  check('全部状态', {filters: {state: 'all'}});
  check('评分下限', {filters: {rating: [3, 5]}});
  check('评分区间', {filters: {rating: [2, 4]}});
  check('收藏', {filters: {favoriteMode: 'yes'}});
  check('未收藏', {filters: {favoriteMode: 'no'}});
  check('评分多选', {filters: {ratings: [5, 3]}});
  check('评分多选取反', {filters: {ratings: [5], excludeRating: true}});
  check('平台子串', {filters: {platforms: ['sketch']}});
  check('类型子串', {filters: {kinds: ['model']}});
});

test('多选筛选是 OR，不是 AND：内存路径用 some()，SQL 必须同义', () => {
  // 这组用例守的是「多选语义」本身：平台、类型、标签在面板上都是多选，
  // 勾两项的含义是「命中任一」。SQL 侧若编成 AND，结果会少一大截 ——
  // 而且少的那些正好是「只命中第二项」的资产，用户很难发现。
  check('多平台', {filters: {platforms: ['sketchfab', 'artstation']}});
  check('多类型', {filters: {kinds: ['model', 'texture']}});
  check('多标签', {filters: {tags: ['石材', '木材']}});
  check('多标签 + 排除', {filters: {tags: ['石材', '木材'], excludeTags: ['卡通']}});
  check('多标签 + 平台', {filters: {tags: ['石材', '木材'], platforms: ['sketchfab']}});
});

test('标签：词表展开、别名、子串兜底、排除', () => {
  check('词表父级展开（木材 → 橡木）', {filters: {tags: ['木材']}});
  check('别名筛选（wood → 木材）', {filters: {tags: ['wood']}});
  check('词表外标签走子串', {filters: {tags: ['demo']}});
  check('排除标签', {filters: {excludeTags: ['木材']}});
  check('包含 + 排除', {filters: {tags: ['建筑'], excludeTags: ['木材']}});
  // 「标签字段检索」与「标签筛选」是两件事：前者搜文本，后者走词表归一。
  check('标签字段检索（搜标准名命中别名资产）', {q: 'tag:石材'});
  check('标签字段检索（搜别名命中标准名资产）', {q: 'tag:stone'});
});

test('格式、数值范围、检索表达式', () => {
  check('单格式', {filters: {formats: ['png']}});
  check('多格式', {filters: {formats: ['png', 'jpg']}});
  check('格式排除', {filters: {formats: ['png'], excludeFormats: true}});
  check('其他格式（反集谓词）', {filters: {formats: ['unknown']}});
  check('格式分组', {filters: {formats: ['image']}});
  check('宽高比（横图）', {filters: {ranges: [{field: 'aspect', min: 1.05}]}});
  check('宽度区间', {filters: {ranges: [{field: 'width', min: 2000}]}});
  check('长边区间', {filters: {ranges: [{field: 'longEdge', max: 3000}]}});
  check('时长', {filters: {ranges: [{field: 'duration', min: 1}]}});
  check('数值范围取反（无数据保留）', {filters: {ranges: [{field: 'width', min: 2000}], excludeRanges: true}});
  check('关键词', {q: '石'});
  check('关键词命中备注', {q: '内部项目'});
  check('字段限定 tag:', {q: 'tag:stone'});
  check('字段限定 author:', {q: 'author:alice'});
  check('排除词', {q: '-石'});
  check('OR 组', {q: '石灯 | 机器人'});
  check('数值语法 width:>=2000', {q: 'width:>=2000'});
  check('格式语法 ext:png', {q: 'ext:png'});
});

test('排序：全部下推的维度 + 反向', () => {
  for (const sort of ['recent', 'oldest', 'position', 'rating', 'color', 'resolution', 'size']) {
    check(`排序 ${sort}`, {sort});
    check(`排序 ${sort} 反向`, {sort, sortOrder: 'desc'});
  }
});

test('不可下推的条件必须如实拒绝，而不是给出近似结果', () => {
  check('按名称排序（中文 collation 不同）', {sort: 'name'}, {expectPushdown: false});
  check('随机排序', {sort: 'random'}, {expectPushdown: false});
  check('热度排序（likes 在 payload）', {sort: 'popular'}, {expectPushdown: false});
  check('颜色筛选', {filters: {colors: ['red']}}, {expectPushdown: false});
  check('category: 字段检索', {q: 'category:models'}, {expectPushdown: false});
  check('metadata: 字段检索', {q: 'metadata:foo'}, {expectPushdown: false});
});

test('V5 列化后：分类与可下载性可以下推，且与内存路径逐条一致', () => {
  // 这两条原来都是「整条查询退回全表 JS」的开关 —— 用户在筛选条上点一下分类，
  // 50 万资产就要整库搬进内存。列化后它们必须和平台 / 类型一样可下推。
  check('分类子串', {filters: {categories: ['model']}});
  check('多分类（OR）', {filters: {categories: ['model', 'texture']}});
  check('分类命中 assetType', {filters: {categories: ['hdri']}});
  check('分类 + 类型', {filters: {categories: ['model'], kinds: ['model']}});
  check('可下载', {filters: {downloadable: true}});
  check('可下载 + 平台', {filters: {downloadable: true, platforms: ['sketch']}});
  // 大小写：内存路径全小写比对，列里也是小写，不能因为用户传 'Model' 就漏。
  check('分类大写输入', {filters: {categories: ['Model']}});
});

test('uid 列表与空合集：下推结果与内存路径一致', () => {
  check('指定 uid', {filters: {uids: [U(1), U(3)]}});
  check('空合集', {collectionUids: new Set(), collectionId: 'c1'});
  check('小合集', {collectionUids: new Set([U(1), U(2)]), collectionId: 'c1'});
});

test('分页：total 是完整命中数，items 只给当前页', () => {
  const plan = compileQuery({limit: 3, offset: 2});
  const result = pushed(plan);
  const expected = queryAssets({rows, limit: 3, offset: 2});
  assert.equal(result.total, expected.total);
  assert.deepEqual(result.uids, expected.uids);
  assert.equal(result.items.length, 3);
  assert.equal(result.offset, 2);
});

test('筛选与归一化共用同一份实现，不产生第二套默认值', () => {
  // 不传 filters 时默认 state='active'，下推与内存必须都排除 trashed。
  const plan = compileQuery({});
  assert.match(plan.where, /a\.state = \?/);
  assert.deepEqual(plan.params, ['active']);
  assert.deepEqual(normalizeFilters({}).state, 'active');
});

test('索引提示：只在「谓词能靠索引判定」时才给，否则会把顺序读表变成随机读表', () => {
  // 取页提示（沿排序索引扫，凑够一页就停）：要求所有谓词都能在 (state, added_at, position, uid) 上判定。
  const tagOnly = compileQuery({filters: {tags: ['木材']}, sort: 'recent'});
  assert.equal(tagOnly.indexHint, 'assets_cover_state_added_idx', '纯标签筛选应当拿到排序索引提示');
  // 平台 / 类型 / 评分 / 收藏都要回表 → 不能给排序索引提示。
  for (const [label, input] of [
    ['平台', {filters: {platforms: ['sketchfab']}}],
    ['类型', {filters: {kinds: ['models']}}],
    ['评分', {filters: {rating: [4, 5]}}],
    ['收藏', {filters: {favoriteMode: 'yes'}}],
    ['文本检索', {q: '石'}],
    ['数值区间', {filters: {ranges: [{field: 'width', min: 100}]}}],
  ]) {
    assert.equal(compileQuery(input).indexHint, '', `${label} 筛选不应当拿排序索引提示`);
  }
  // state='all' 时索引首列用不上，一律不给提示。
  assert.equal(compileQuery({filters: {state: 'all'}, sort: 'recent'}).indexHint, '');
  // 排序不在索引里（评分 / 分辨率）也不给提示。
  assert.equal(compileQuery({sort: 'rating'}).indexHint, '');
  assert.equal(compileQuery({sort: 'resolution'}).indexHint, '');
});

test('COUNT 索引提示：引用的列必须在统一覆盖索引里，否则 COUNT 仍会逐行回表', () => {
  const COUNT_INDEX = 'assets_cover_state_fav_rating_kind_platform_text_idx';
  // 列筛选与文本检索都要用上统一覆盖索引（实测 COUNT 快 58~153 倍）。
  for (const [label, input] of [
    ['平台+类型+评分', {filters: {platforms: ['sketchfab'], kinds: ['models'], rating: [4, 5]}}],
    ['收藏+评分', {filters: {favoriteMode: 'yes', rating: [4, 5]}}],
    ['关键词', {q: '石'}],
    ['标签字段检索', {q: 'tag:石材'}],
  ]) {
    assert.equal(compileQuery(input).countIndexHint, COUNT_INDEX, `${label} 应当拿到 COUNT 索引提示`);
  }
  // 引用了索引之外的列（数值列 / url）就不能用那条索引。
  assert.equal(compileQuery({filters: {ranges: [{field: 'width', min: 100}]}}).countIndexHint, '');
  // 纯标签筛选用现成的 (state, uid) 覆盖索引就够，不必绕远路。
  assert.equal(compileQuery({filters: {tags: ['木材']}}).countIndexHint, '');
});

test('索引提示不改变结果：强制索引与自然计划必须逐条一致', () => {
  // 这是本轮改动的安全底线。INDEXED BY 只约束用哪个索引，不改 ORDER BY；
  // 但万一某个索引满足不了 ORDER BY，SQLite 会报错而不是给出错序结果 —— 这里把它钉死。
  const cases = [
    {filters: {tags: ['木材']}, sort: 'recent', limit: 5},
    {filters: {tags: ['木材']}, sort: 'recent', limit: 5, offset: 2},
    {filters: {tags: ['木材']}, sort: 'recent', sortOrder: 'desc', limit: 5},
    {filters: {tags: ['木材']}, sort: 'oldest', limit: 5},
    {filters: {platforms: ['sketchfab']}, sort: 'recent', limit: 5},
    {q: '石', sort: 'recent', limit: 5},
  ];
  for (const input of cases) {
    const plan = compileQuery(input);
    const natural = db.queryPage({...plan, indexHint: '', countIndexHint: ''});
    const forced = db.queryPage(plan);
    assert.equal(forced.total, natural.total, `${JSON.stringify(input)}：total 不一致`);
    assert.deepEqual(forced.assetRows.map(r => r.uid), natural.assetRows.map(r => r.uid),
      `${JSON.stringify(input)}：uid 序列不一致`);
  }
});
