// S3-c 前端：远端变更应用器的验收。
//
// 守的是三件事：
//   1. **只覆盖该覆盖的**：评分 / 备注 / 标签 / 收藏按服务端的值来，别的不动。
//   2. **没变就不报**：服务端推来一份一模一样的数据，不该触发重绘。
//   3. **删干净**：对方把最后一个标签删了，本地也要删掉（不能留空数组）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyRemoteDetails} from '../src/library/remote-sync.js';

const uid = 'a'.repeat(32);

const makeState = () => ({
  userMeta: {[uid]: {rating: 3, note: '本地备注'}},
  userTags: {[uid]: ['常用']},
  aiTags: {[uid]: ['石材']},
  favorites: new Set([uid]),
});

test('远端改动覆盖本地：评分、备注、标签、收藏', () => {
  const state = makeState();
  const result = applyRemoteDetails(state, [{
    uid, rating: 5, note: '对方改的备注', favorite: false,
    userTags: ['常用', '新增'], aiTags: ['石材', '木纹'],
  }]);
  assert.equal(result.changed, 1);
  assert.deepEqual(state.userMeta[uid], {rating: 5, note: '对方改的备注'});
  assert.deepEqual(state.userTags[uid].sort(), ['新增', '常用'].sort());
  assert.deepEqual(state.aiTags[uid].sort(), ['石材', '木纹'].sort());
  assert.equal(state.favorites.has(uid), false);
});

test('一模一样的数据不算变化（不触发重绘）', () => {
  const state = makeState();
  const result = applyRemoteDetails(state, [{
    uid, rating: 3, note: '本地备注', favorite: true, userTags: ['常用'], aiTags: ['石材'],
  }]);
  assert.equal(result.changed, 0);
  assert.deepEqual(result.uids, []);
});

test('对方删掉最后一个标签，本地也要删掉键，不能留空数组', () => {
  const state = makeState();
  applyRemoteDetails(state, [{uid, rating: 3, note: '本地备注', favorite: true, userTags: [], aiTags: []}]);
  assert.equal(state.userTags[uid], undefined);
  assert.equal(state.aiTags[uid], undefined);
});

test('脏数据一律忽略，不许把状态写坏', () => {
  const state = makeState();
  const result = applyRemoteDetails(state, [
    {uid: '不是 uid', rating: 5},
    {uid, rating: 99, note: 'x'.repeat(5000)},
    null,
    '字符串',
  ]);
  assert.equal(result.changed, 1, '只有那条合法 uid 的算变化');
  assert.equal(state.userMeta[uid].rating, 5, '评分被夹到 0~5');
  assert.equal(state.userMeta[uid].note.length, 2000, '备注被截到 2000 字');
  assert.deepEqual(state.userTags[uid], ['常用'], '脏数据不许动标签');
});
