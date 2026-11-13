// 画板状态源：树扁平化、坏数据降级、最近使用、持久化与写入动作。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBoard, flattenBoards, searchBoards, normalizePrefs,
  readBoardPrefs, writeBoardPrefs, withRecent, createBoardStore,
  BOARD_ACTIVE_KEY, BOARD_RECENTS_KEY, BOARD_EVENTS,
} from '../src/library/board-store.js';

const board = (id, patch = {}) => ({id, name: `画板 ${id}`, parentId: null, position: 0, assetCount: 0, ...patch});

const fakeStorage = () => {
  const data = new Map();
  return {getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), data};
};

const fakeApi = () => ({
  calls: [],
  async listBoards() { this.calls.push(['list']); return {collections: [board('a'), board('b', {parentId: 'a', position: 1})]}; },
  async saveBoard(input) { this.calls.push(['save', input]); return {id: input.id || 'new-1'}; },
  async deleteBoard(id) { this.calls.push(['delete', id]); return {removed: true}; },
  async boardItems(id, uids, action) { this.calls.push(['items', id, uids, action]); return {ok: true}; },
});

test('normalizeBoard 补默认值并拒绝无 id 的行', () => {
  assert.equal(normalizeBoard({id: 'a'}).name, '未命名画板');
  assert.equal(normalizeBoard({id: 'a', parentId: ''}).parentId, null);
  assert.equal(normalizeBoard({id: 'a', assetCount: -3}).assetCount, 0);
  assert.equal(normalizeBoard(null).id, '');
});

test('智能规则保留排序方向与随机种子，旧规则补默认值', () => {
 assert.deepEqual(normalizeBoard({id:'smart',smart:{q:'stone',filters:{tags:['warm']},sort:'random',sortOrder:'desc',seed:'fixed'}}).rule,
  {q:'stone',filters:{tags:['warm']},sort:'random',sortOrder:'desc',seed:'fixed'});
 assert.equal(normalizeBoard({smart:{}}).rule.sortOrder,'asc');
 assert.equal(normalizeBoard({smart:{}}).rule.seed,'');
});

test('树扁平化按 position 稳定排序并带 depth / path', () => {
  const rows = flattenBoards([
    board('root', {position: 1}), board('first', {position: 0}),
    board('child', {parentId: 'first', position: 0}),
    board('grand', {parentId: 'child', position: 0}),
  ]);
  assert.deepEqual(rows.map(row => row.id), ['first', 'child', 'grand', 'root']);
  assert.deepEqual(rows.map(row => row.depth), [0, 1, 2, 0]);
  assert.deepEqual(rows[2].path, ['画板 first', '画板 child', '画板 grand']);
});

test('孤儿 / 自环 / 互相成环一律降级为顶层且不会丢节点', () => {
  const rows = flattenBoards([
    board('orphan', {parentId: 'missing'}), board('self', {parentId: 'self'}),
    board('x', {parentId: 'y'}), board('y', {parentId: 'x'}),
  ]);
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.depth === 0), '坏 parent 不该挂成深层');
});

test('搜索命中名称与路径，大小写不敏感', () => {
  const rows = flattenBoards([board('a', {name: '石材'}), board('b', {name: '角色', parentId: 'a'})]);
  assert.equal(searchBoards(rows, '石').length, 2, '子画板的父路径也要能搜到');
  assert.equal(searchBoards(rows, '角色').length, 1);
  assert.equal(searchBoards(rows, '').length, 2);
});

test('偏好读写：坏 JSON / 只读存储都退化空态', () => {
  const storage = fakeStorage();
  storage.setItem(BOARD_RECENTS_KEY, '{bad json');
  assert.deepEqual(readBoardPrefs(storage), {activeId: '', recents: []});
  const prefs = writeBoardPrefs(storage, {activeId: 'c-1', recents: ['c-1', 'c-2']});
  assert.deepEqual(prefs.recents, ['c-1', 'c-2']);
  assert.equal(readBoardPrefs(storage).activeId, 'c-1');
  assert.deepEqual(readBoardPrefs({getItem: () => { throw Error('denied'); }}), {activeId: '', recents: []});
  assert.deepEqual(writeBoardPrefs({}, {activeId: 'x'}), {activeId: 'x', recents: []});
});

test('normalizePrefs 裁剪最近使用并去重', () => {
  assert.deepEqual(normalizePrefs({recents: ['a', 'a', 'b'], activeId: 3}).recents, ['a', 'a', 'b']);
  assert.deepEqual(withRecent(['b', 'c'], 'a'), ['a', 'b', 'c']);
  assert.deepEqual(withRecent(['a', 'b'], 'a'), ['a', 'b']);
});

test('store.refresh 拉列表，activeId 指向已删除画板时自动清空', async () => {
  const storage = fakeStorage();
  storage.setItem(BOARD_ACTIVE_KEY, 'gone');
  const events = [];
  const store = createBoardStore({api: fakeApi(), storage, emit: (name, detail) => events.push(name)});
  const rows = await store.refresh();
  assert.equal(rows.length, 2);
  assert.equal(store.activeId, '');
  assert.ok(events.includes(BOARD_EVENTS.changed));
});

test('setActive 写持久化并发 selected 事件', () => {
  const storage = fakeStorage();
  const events = [];
  const store = createBoardStore({api: fakeApi(), storage, emit: (name, detail) => events.push([name, detail])});
  store.setActive('c-1');
  assert.equal(store.activeId, 'c-1');
  assert.deepEqual(store.recents(), ['c-1']);
  assert.deepEqual(events[0], [BOARD_EVENTS.selected, {id: 'c-1'}]);
});

test('addItems / removeItems 走正确的 action，且 add 会记最近使用', async () => {
  const api = fakeApi();
  const store = createBoardStore({api, storage: fakeStorage()});
  await store.addItems('c-1', ['u1', 'u2']);
  await store.removeItems('c-1', ['u1']);
  assert.deepEqual(api.calls[0], ['items', 'c-1', ['u1', 'u2'], 'add']);
  assert.deepEqual(api.calls[1], ['items', 'c-1', ['u1'], 'remove']);
  assert.deepEqual(store.recents(), ['c-1']);
  assert.equal(await store.addItems('', ['u1']), 0, '空 id 不该发请求');
});

test('create / rename / remove 后都会刷新列表', async () => {
  const api = fakeApi();
  const store = createBoardStore({api, storage: fakeStorage()});
  await store.refresh();
  assert.equal(await store.create({name: '新板'}), 'new-1');
  await store.rename('a', {name: '改名'});
  await store.remove('a');
  assert.equal(api.calls.filter(call => call[0] === 'list').length, 4);
  assert.ok(api.calls.filter(call => call[0] === 'save').some(call => call[1].name === '改名'));
});
