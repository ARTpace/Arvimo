// 阶段 4：前端持久化层自动差量写入（src/library/persistent-storage.js）。
// 用 mock request 观察「到底发了什么」，不碰真实服务与 localStorage。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersistentStorage} from '../src/library/persistent-storage.js';

const a = 'a'.repeat(32);
const blob = (over = {}) => JSON.stringify({
  version: 2, models: [{uid: a, name: '石灯', tags: ['stone'], addedAt: 1}],
  aiTags: {}, userMeta: {}, userTags: {}, favorites: [], history: [], tasks: [], trashed: [], options: {}, ...over,
});
const local = {getItem: () => null, setItem() {}};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('保存失败保留后端具体原因，不只显示笼统提示',async()=>{
 const warnings=[];
 const request=async(url,options={})=>options.method==='POST'
  ?{ok:false,status:400,json:async()=>({error:'资产库迁移 v8 的 checksum 不匹配'})}
  :{ok:true,json:async()=>({values:{}})};
 const storage=await createPersistentStorage(local,request,{onWarn:message=>warnings.push(message)});
 storage.setItem('sfx-library-ui','{}');await tick();await tick();
 assert.ok(warnings.some(message=>message.includes('迁移 v8 的 checksum 不匹配')));
});

test('服务端文件移动更新读视图，不再次入库；晚到的目录页应用最新定位',async()=>{
 const b='b'.repeat(32);let finishPage;
 const second=new Promise(resolve=>{finishPage=resolve;});
 const request=async url=>{
  if(url.startsWith('/api/library-state'))return {ok:true,json:async()=>({values:{'sfx-library-v2':blob({models:[]})},catalogPaged:true,catalogTotal:2,recovered:[]})};
  if(url.includes('offset=0'))return {ok:true,json:async()=>({items:[{uid:a,name:'a.png',localRoot:'H:/素材',localRel:'a.png'}],total:2,nextOffset:1})};
  return {ok:true,json:()=>second};
 };
 const storage=await createPersistentStorage(local,request,{catalogPaged:true});
 storage.applyFileMoves({root:'H:/素材',changes:[{uid:a,from:'a.png',to:'new-a.png'},{uid:b,from:'b.png',to:'new-b.png'}]});
 assert.equal(JSON.parse(storage.getItem('sfx-library-v2')).models[0].localRel,'new-a.png');
 finishPage({items:[{uid:b,name:'b.png',localRoot:'H:/素材',localRel:'b.png'}],total:2,nextOffset:2});await storage.catalogReady;
 const late=storage.catalogModels.find(model=>model.uid===b);assert.equal(late.name,'new-b.png');assert.equal(late.localRel,'new-b.png');
});

// 默认关掉 ADR-02 分域通道：下面这一组守的是「旧差量通道 + 整块降级链」仍然可用。
test('协议升级拒绝不整块重放、不再发送后续写入，提示刷新；所有持久化 POST 携带协议',async()=>{
 const calls=[],warnings=[];
 const request=async(url,options={})=>{
  if(!options.method)return new Response(JSON.stringify({values:{'sfx-library-v2':blob()}}));
  calls.push({url,headers:options.headers});
  return new Response(JSON.stringify({error:'请刷新页面',code:'client_upgrade_required'}),{status:426});
 };
 const storage=await createPersistentStorage(local,request,{collections:false,onWarn:message=>warnings.push(message)});
 storage.setItem('sfx-library-v2',blob({userMeta:{[a]:{rating:5,note:''}}}));await tick();
 assert.equal(calls.length,1);assert.equal(calls[0].headers['X-AV-File-Protocol'],'1');
 assert.equal(calls[0].url,'/api/library/mutations');assert.match(warnings[0],/刷新/);
 storage.setItem('sfx-library-v2',blob({userMeta:{[a]:{rating:3,note:''}}}));await tick();
 assert.equal(calls.length,1,'被拒绝后不再写入，也不回传整块快照');
});

// 新通道的行为由文件后半段单独的用例覆盖。
function harness(initial, {mutationsStatus = 200, mutationsThrows = false, collections = false, collectionsThrows = false} = {}) {
  const calls = [], warnings = [], commits = [];
  const request = async (path, options = {}) => {
    if (path === '/api/library-state' && !options.method) {
      return {ok: true, json: async () => ({values: initial, recovered: [], scanIndex: true})};
    }
    calls.push({path, method: options.method, body: options.body ? JSON.parse(options.body) : null, bytes: options.body?.length || 0});
    if (path === '/api/library/tags/mutate' && collectionsThrows) throw Error('network down');
    if (path === '/api/library/mutations' && mutationsThrows) throw Error('network down');
    if (path === '/api/library/mutations' && mutationsStatus !== 200) return {ok: false, status: mutationsStatus, json: async () => ({})};
    return {ok: true, status: 200, json: async () => ({saved: true})};
  };
  const storagePromise = createPersistentStorage(local, request, {
    onCommit: info => commits.push(info), onWarn: message => warnings.push(message), collections,
  });
  return {storagePromise, calls, warnings, commits};
}

test('改一次评分只发一个 op，不再回传整块 blob', async () => {
  const h = harness({'sfx-library-v2': blob()});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({userMeta: {[a]: {rating: 5, note: ''}}}));
  await tick();
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].incremental, true);
  assert.equal(h.commits[0].applied, 1);
  assert.equal(h.calls.length, 1, '只有一次 POST');
  assert.equal(h.calls[0].path, '/api/library/mutations');
  assert.equal(h.calls[0].body.ops.length, 1);
  assert.equal(h.calls[0].body.ops[0].field, 'userMeta');
  assert.ok(h.calls[0].bytes < 300, `请求必须很小，实际 ${h.calls[0].bytes} 字节`);
});

test('models / trashed 变化、未知字段变化都退回整块写入', async () => {
  const h = harness({'sfx-library-v2': blob()});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({models: [{uid: a, name: '石灯'}, {uid: 'b'.repeat(32), name: '新资产'}]}));
  await tick();
  assert.equal(h.commits[0].incremental, false);
  assert.equal(h.calls[0].path, '/api/library-state');
  assert.ok('sfx-library-v2' in h.calls[0].body);
});

test('老进程 404：自动整块重放，并永久关掉差量通道', async () => {
  const h = harness({'sfx-library-v2': blob()}, {mutationsStatus: 404});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({favorites: [a]}));
  await tick();
  assert.equal(h.commits[0].fallback, true);
  assert.deepEqual(h.calls.map(item => item.path), ['/api/library/mutations', '/api/library-state']);
  assert.ok('sfx-library-v2' in h.calls[1].body, '整块重放必须带完整主状态');
  storage.setItem('sfx-library-v2', blob({favorites: [], userTags: {[a]: ['常用']}}));
  await tick();
  assert.equal(h.calls.length, 3, '第二次直接走整块，不再白撞 404');
  assert.equal(h.calls[2].path, '/api/library-state');
});

test('网络异常也能整块重放，数据不丢', async () => {
  const h = harness({'sfx-library-v2': blob()}, {mutationsThrows: true});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({userMeta: {[a]: {rating: 3, note: 'ok'}}}));
  await tick();
  assert.equal(h.commits[0].fallback, true);
  assert.equal(h.calls.at(-1).path, '/api/library-state');
  assert.deepEqual(h.warnings, []);
});

test('附带的大 key 单独整块提交，小 key 跟差量一起走', async () => {
  const h = harness({'sfx-library-v2': blob()});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({favorites: [a]}));
  storage.setItem('sfx-library-ui', '{"linkPanelOpen":true}');
  storage.setItem('sfx-discovery-v1', JSON.stringify({feeds: {web: {rows: [{padding: 'x'.repeat(40000)}]}}}));
  await tick();
  assert.equal(h.commits.length, 1, '同一次节流窗口合并成一个提交');
  assert.equal(h.commits[0].incremental, true);
  assert.equal(h.calls[0].path, '/api/library/mutations');
  assert.equal(h.calls[0].body.values['sfx-library-ui'], '{"linkPanelOpen":true}');
  assert.equal(h.calls[0].body.values['sfx-discovery-v1'], undefined, '大 key 不能塞进 96KB 差量请求');
  assert.equal(h.calls[1].path, '/api/library-state');
  assert.deepEqual(Object.keys(h.calls[1].body), ['sfx-discovery-v1']);
});

test('主 blob 没变但 UI 偏好变了：整块请求只带那些 key', async () => {
  const h = harness({'sfx-library-v2': blob()});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-ui', '{"linkPanelOpen":true}');
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/api/library-state');
  assert.deepEqual(Object.keys(h.calls[0].body), ['sfx-library-ui']);
  assert.equal(h.calls[0].body['sfx-library-v2'], undefined, '不重写主 blob，保持字节级契约');
});

test('首次迁移（服务端没有主状态）走整块写入', async () => {
  const h = harness({});
  await h.storagePromise;
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/api/library-state');
  assert.ok('sfx-library-v2' in h.calls[0].body);
});

// —— ADR-02 分域通道 ——————————————————————————————————————————————
// 守的核心是「高频写入不再回传整块 blob」：50 万资产时那份 blob 是 209MB。

test('ADR-02：改一次评分只发一个 asset.set，整块 blob 一个字节都不回传', async () => {
  const h = harness({'sfx-library-v2': blob()}, {collections: true});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({userMeta: {[a]: {rating: 5, note: ''}}}));
  await tick();
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].incremental, true);
  assert.deepEqual(h.commits[0].domains, ['user']);
  assert.equal(h.calls.length, 1, '只有一次 POST');
  assert.equal(h.calls[0].path, '/api/library/tags/mutate');
  assert.deepEqual(h.calls[0].body.ops, [{op: 'asset.set', uid: a, field: 'rating', value: 5}]);
  assert.ok(h.calls[0].bytes < 300, `请求必须很小，实际 ${h.calls[0].bytes} 字节`);
});

test('ADR-02：搜索历史只发 /session，不碰主 blob', async () => {
  const h = harness({'sfx-library-v2': blob()}, {collections: true});
  const storage = await h.storagePromise;
  const history = [{kind: 'search', params: {q: '石灯'}}];
  storage.setItem('sfx-library-v2', blob({history}));
  await tick();
  assert.deepEqual(h.commits[0].domains, ['session']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/api/library/session');
  assert.deepEqual(h.calls[0].body.history, history);
  assert.equal(h.calls[0].body['sfx-library-v2'], undefined);
});

test('ADR-02：标签增删翻译成 tag.add / tag.remove，带正确来源', async () => {
  const h = harness({'sfx-library-v2': blob({userTags: {[a]: ['旧标签', '保留']}})}, {collections: true});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({userTags: {[a]: ['保留', '新标签']}}));
  await tick();
  assert.deepEqual(h.calls[0].body.ops, [
    {op: 'tag.remove', uid: a, source: 'user', value: '旧标签'},
    {op: 'tag.add', uid: a, source: 'user', value: '新标签'},
  ]);
});

test('ADR-02 / 5.4：回收站彻底清空只发显式删除，不回传整块目录', async () => {
  const b = 'b'.repeat(32);
  const h = harness({'sfx-library-v2': blob({trashed: [{uid: b, name: '旧', trashedAt: 1}]})}, {collections: true});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob());
  await tick();
  const removed = h.calls.find(call => call.path === '/api/library/assets/remove');
  assert.deepEqual(removed.body.uids, [b], '合并语义下「blob 里少了」不算删除，必须显式通知');
  assert.equal(h.calls.some(call => call.path === '/api/library-state' && call.method === 'POST' && call.body['sfx-library-v2']),
    false, '5.4 起纯 purge 不再回传整块目录');
});

test('ADR-02：未知字段变化退回整块写入，不猜语义', async () => {
  const h = harness({'sfx-library-v2': blob()}, {collections: true});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({someFutureField: {a: 1}}));
  await tick();
  assert.equal(h.commits[0].incremental, false);
  assert.equal(h.calls[0].path, '/api/library-state');
  assert.ok('sfx-library-v2' in h.calls[0].body);
});

test('ADR-02：新通道失败自动整块重放，并永久关掉分域通道', async () => {
  const h = harness({'sfx-library-v2': blob()}, {collections: true, collectionsThrows: true});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({favorites: [a]}));
  await tick();
  assert.equal(h.commits[0].fallback, true);
  assert.equal(h.calls.at(-1).path, '/api/library-state');
  assert.ok('sfx-library-v2' in h.calls.at(-1).body, '整块重放必须带完整主状态');
  const before = h.calls.length;
  storage.setItem('sfx-library-v2', blob({favorites: [], userTags: {[a]: ['常用']}}));
  await tick();
  assert.equal(h.calls.length, before + 1, '第二次直接走整块，不再白撞失败的新通道');
  assert.equal(h.calls.at(-1).path, '/api/library-state');
});
