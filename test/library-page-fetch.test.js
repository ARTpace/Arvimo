// 阶段 4：服务端按页取数（src/library/library-page-fetch.js）+ uidScope 契约 + 写入不污染。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPagedQuery, mergeRemoteModels, PAGE_SIZE} from '../src/library/library-page-fetch.js';
import {saveLibrary} from '../src/library/library-state.js';
import {rowsFromState, queryAssets} from '../server/library-query.mjs';

const uid = char => char.repeat(32);
const uids = ['a', 'b', 'c', 'd', 'e'].map(uid);
const pages = [
  {uids: uids.slice(0, 2), items: uids.slice(0, 2).map((id, i) => ({uid: id, name: `资产${i}`, tagKinds: {user: []}, rating: 0})), total: 5, engine: 'sqlite'},
  {uids: uids.slice(2, 4), items: uids.slice(2, 4).map((id, i) => ({uid: id, name: `资产${i + 2}`})), total: 5, engine: 'sqlite'},
  {uids: uids.slice(4), items: [{uid: uids[4], name: '资产4'}], total: 5, engine: 'sqlite'},
];

function pageRequest({status = 0} = {}) {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({path, body: options.body});
    if (status) { const error = Error('not found'); error.status = status; throw error; }
    const index = options.body.offset === 0 ? 0 : options.body.offset === 2 ? 1 : 2;
    return pages[index];
  };
  return {request, calls};
}

test('服务端页只补本地没有的资产，且标为 _remoteOnly 不写回 blob', () => {
  const state = {models: [{uid: uids[0], name: '本地已有', rating: 5}]};
  const added = mergeRemoteModels(state, pages[0].items);
  assert.equal(added, 1);
  assert.equal(state.models.length, 2);
  assert.equal(state.models[0].rating, 5, '本地已有资产绝不能被服务端页覆盖');
  assert.equal(state.models[1]._remoteOnly, true);
  let saved = null;
  saveLibrary({setItem: (key, value) => { saved = JSON.parse(value); }}, {...state, aiTags: {}, userMeta: {}, userTags: {}, favorites: [], history: [], tasks: [], trashed: [], options: {}});
  assert.equal(saved.models.length, 1, '_remoteOnly 的模型绝不进入写入契约');
  assert.equal(saved.models[0].uid, uids[0]);
});

test('按页取数：first → more → 取完，queryUids / queryOrder / remotePaging 逐步累积', async () => {
  const state = {models: []};
  const updates = [];
  const {request, calls} = pageRequest();
  const paged = createPagedQuery({request, state, onUpdate: info => updates.push(info), size: 2});
  await paged.first({q: 'stone', sort: 'recent'});
  assert.equal(state.queryUids.size, 2);
  assert.deepEqual(state.queryOrder, uids.slice(0, 2));
  assert.deepEqual(state.remotePaging, {loaded: 2, total: 5, hasMore: true});
  assert.equal(state.models.length, 2, '完整 model 已注入给 findModel / 右键菜单用');
  assert.equal(updates[0].reset, true);
  assert.equal(calls[0].body.uidScope, 'page');
  assert.equal(calls[0].body.offset, 0);

  await paged.more();
  assert.equal(state.queryUids.size, 4);
  assert.deepEqual(state.queryOrder, uids.slice(0, 4));
  assert.equal(state.remotePaging.hasMore, true);
  assert.equal(updates[1].reset, false);
  assert.equal(calls[1].body.offset, 2);

  await paged.more();
  assert.equal(state.queryUids.size, 5);
  assert.equal(state.remotePaging.hasMore, false);
  await paged.more();
  assert.equal(calls.length, 3, '取完后再点加载更多不应多发请求');
  assert.equal(PAGE_SIZE, 60);
});

test('reset 清空分页态；过期响应不能覆盖新查询', async () => {
  const state = {models: []};
  const updates = [], errors = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let first = true;
  const request = async (path, options = {}) => {
    if (first) { first = false; return pending; }
    return {...pages[0], uids: [uids[4]], items: [{uid: uids[4], name: '新查询'}], total: 1};
  };
  const paged = createPagedQuery({request, state, onUpdate: info => updates.push(info), onError: error => errors.push(error)});
  const running = paged.first({q: '旧词'});
  paged.reset();
  assert.equal(state.remotePaging, null);
  await paged.first({q: '新词'});
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].uids, [uids[4]]);
  release(pages[0]);
  await running;
  assert.equal(updates.length, 1, '旧响应到达后必须被丢弃');
  assert.equal(state.queryUids.size, 1);
  assert.deepEqual(errors, []);
});

test('智能scope复用分页：更多保留id及条件；新查询替代在途旧页', async () => {
 const state={models:[]},calls=[],errors=[];let release,rejectOld;
 const request=async(path,{body})=>{calls.push({path,body});if(body.q==='old')return new Promise((resolve,reject)=>{release=resolve;rejectOld=reject;});return pages[body.offset?1:0];};
 const paged=createPagedQuery({state,request,size:2,onError:e=>errors.push(e)});
 await paged.first({smartCollectionId:'smart-1',q:'stone',filters:{tags:['warm']},sort:'random',sortOrder:'desc',seed:'fixed'});
 await paged.more();
 assert.ok(calls.every(row=>row.path==='/smart-collections/resolve'&&row.body.id==='smart-1'));
 assert.equal(calls[1].body.offset,2);assert.deepEqual(calls[1].body.filters,{tags:['warm']});assert.equal(calls[1].body.seed,'fixed');assert.equal(calls[1].body.smartCollectionId,undefined);
 const old=paged.first({smartCollectionId:'smart-1',q:'old'});
 await paged.first({q:'new'});assert.equal(calls.at(-1).path,'/assets');
 rejectOld(Error('过期失败'));await old;assert.deepEqual(errors,[]);assert.deepEqual(state.queryOrder,uids.slice(0,2));
});

test('老进程没有 /assets 时把 404 交给面板降级，不吞掉其它错误', async () => {
  const state = {models: []};
  const errors = [];
  const {request} = pageRequest({status: 404});
  await createPagedQuery({request, state, onUpdate: () => {}, onError: error => errors.push(error)}).first({q: 'x'});
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, 404);
  assert.equal(state.remotePaging, null);
});

test('uidScope:page 只回本页 uid，默认仍是全量命中（阶段 2 契约不变）', () => {
  const rows = rowsFromState({'sfx-library-v2': JSON.stringify({
    version: 2, models: uids.map((id, i) => ({uid: id, name: `石灯${i}`, addedAt: 10 - i})),
    aiTags: {}, userMeta: {}, userTags: {}, favorites: [], trashed: [], options: {},
  })});
  const all = queryAssets({rows, limit: 2, offset: 2, sort: 'recent'});
  assert.equal(all.total, 5);
  assert.equal(all.uids.length, 5, '默认 /query 与旧调用仍拿到全部命中');
  assert.deepEqual(all.items.map(item => item.uid), uids.slice(2, 4));
  const scoped = queryAssets({rows, limit: 2, offset: 2, sort: 'recent', uidScope: 'page'});
  assert.equal(scoped.total, 5, 'total 仍是完整命中数');
  assert.deepEqual(scoped.uids, uids.slice(2, 4), '只传本页 uid，大库不再一次回传上万个');
});
