// S3-b/c：角色权限与变更广播的验收。
//
// 这组用例守的是三件事：
//   1. **权限最小化**：viewer 只读、editor 可写、owner 才能管成员；请求头不能抬权。
//   2. **集合语义写入入口**：POST /api/library/tags/mutate 的 200 / 400 / 409 三条路径。
//   3. **变更广播**：写入后订阅者收到事件，断线重连能补齐空档，跨站订阅被拒绝。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {createLibraryStorage, stateFileFor} from '../server/library-storage.mjs';
import {SESSION_STATE_KEY} from '../server/library-schema.mjs';
import {createLibraryApi} from '../server/library-api.mjs';
import {can, normalizeMember, saveMember, removeMember, createMemberDirectory} from '../server/library-members.mjs';

const U = n => `${String(n).padStart(32, 'a')}`;
const uidA = U(1), uidB = U(2);

const state = {
  version: 2,
  models: [
    {uid: uidA, name: '国风石灯', author: 'Alice', platform: 'sketchfab', assetType: 'model', ext: 'fbx', tags: ['stone'], addedAt: 1000},
    {uid: uidB, name: '橡木椅', author: 'Bob', platform: 'artstation', assetType: 'model', ext: 'glb', tags: ['oak'], addedAt: 2000},
  ],
  aiTags: {}, userTags: {}, userMeta: {}, favorites: [], trashed: [], history: [], tasks: [], options: {},
};

// —— 测试替身：请求 / 响应 ——————————————————————————————————————————

const jsonRes = () => {
  const res = new EventEmitter();
  res.status = 0; res.headers = {}; res.body = '';
  res.writeHead = (status, headers = {}) => { res.status = status; res.headers = {...res.headers, ...headers}; };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.write = chunk => { res.body += chunk; return true; };
  res.end = chunk => { if (chunk) res.body += chunk; res.ended = true; };
  return res;
};

const makeReq = ({method = 'POST', headers = {}, body = ''} = {}) => {
  const req = Readable.from([body]);
  req.method = method;
  req.headers = {'x-sfx-local': '1', ...headers};
  return req;
};

const apiUrl = pathname => new URL(`http://127.0.0.1${pathname}`);

/** 调一次 API，返回 {status, body} 并自动解析 JSON。 */
async function call(api, pathname, {method = 'POST', headers = {}, body = null, lanUser = '', lanMemberId = ''} = {}) {
  const req = makeReq({method, headers, body: body === null ? '' : JSON.stringify(body)});
  if (lanUser) { req.lanVisitor = true; req.lanUser = lanUser; req.lanMemberId = lanMemberId; }
  const res = jsonRes();
  const handled = await api.handle(req, res, apiUrl(pathname));
  assert.equal(handled, true, `${pathname} 应当被本模块答复`);
  let data = null;
  try { data = JSON.parse(res.body); } catch { data = null; }
  return {status: res.status, data, res};
}

// —— 装配：一个带真实 SQLite 的存储 + API ————————————————————————————

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-collab-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  await fs.writeFile(path.join(dir, 'library-state.json'), JSON.stringify({'sfx-library-v2': JSON.stringify(state)}));
  const storage = createLibraryStorage(dir, null, {});
  const api = createLibraryApi({storage});
  return {dir, storage, api};
}

// —— 一、权限模型 ——————————————————————————————————————————————————

test('权限矩阵：viewer 只读、editor 可写、owner 才能管成员', () => {
  assert.equal(can('owner', 'read'), true);
  assert.equal(can('owner', 'write'), true);
  assert.equal(can('owner', 'manage'), true);
  assert.equal(can('editor', 'read'), true);
  assert.equal(can('editor', 'write'), true);
  assert.equal(can('editor', 'manage'), false);
  assert.equal(can('viewer', 'read'), true);
  assert.equal(can('viewer', 'write'), false);
  assert.equal(can('viewer', 'manage'), false);
  assert.equal(can('不存在的角色', 'write'), false, '未知角色按最低权限处理');
});

test('成员表：字段校验、增改删，以及「不能把最后一个主管降级」', () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  try {
    assert.throws(() => normalizeMember({name: '', role: 'viewer'}), /成员名字/);
    assert.throws(() => normalizeMember({name: '张三', role: 'root'}), /角色无效/);
    assert.throws(() => normalizeMember({name: '张三', role: 'viewer', member_id: 'bad'}), /成员编号无效/);

    const owner = saveMember(db, {name: '主机主人', role: 'owner'});
    assert.match(owner.member_id, /^m-[a-f0-9]{8}$/);
    const editor = saveMember(db, {name: '小李', role: 'editor'});
    const viewer = saveMember(db, {name: '访客', role: 'viewer'});
    assert.equal(db.raw('SELECT count(*) AS n FROM members')[0].n, 3);

    // 重复保存同一个成员号 → 更新而不是插第二行
    saveMember(db, {member_id: editor.member_id, name: '小李改', role: 'editor'});
    assert.equal(db.raw('SELECT count(*) AS n FROM members')[0].n, 3);
    assert.equal(db.all('SELECT name FROM members WHERE member_id = ?', [editor.member_id])[0].name, '小李改');

    // 最后一个 owner 不能降级 / 停用 / 删除 —— 否则没人能再管成员了
    assert.throws(() => saveMember(db, {member_id: owner.member_id, name: '主机主人', role: 'editor'}), /至少要保留/);
    assert.throws(() => saveMember(db, {member_id: owner.member_id, name: '主机主人', role: 'owner', disabled: true}), /至少要保留/);
    assert.throws(() => removeMember(db, owner.member_id), /至少要保留/);
    // 别的成员随便删
    assert.equal(removeMember(db, viewer.member_id), true);
    assert.equal(removeMember(db, 'm-00000000'), false);
  } finally { db.close(); }
});

test('身份识别：请求头不能抬权，LAN 会话才是可信来源', async () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  try {
    saveMember(db, {name: '主机主人', role: 'owner'});
    const editor = saveMember(db, {name: '小李', role: 'editor'});
    const directory = createMemberDirectory({storage: {withDb: async fn => fn(db)}});

    // 主机本地：默认 owner
    assert.equal((await directory.resolve({headers: {'x-sfx-local': '1'}})).role, 'owner');
    // 显式成员号：按号取角色
    assert.equal((await directory.resolve({headers: {'x-sfx-local': '1', 'x-sfx-member': editor.member_id}})).role, 'editor');
    // 认不出的成员号 → viewer（拼错不该放行）
    assert.equal((await directory.resolve({headers: {'x-sfx-local': '1', 'x-sfx-member': 'm-deadbeef'}})).role, 'viewer');

    // LAN 共享口令与名字不授予角色；仅主机批准绑定有效
    assert.equal((await directory.resolve({headers: {}, lanVisitor: true, lanUser: '小李'})).role, 'viewer');
    assert.equal((await directory.resolve({headers: {}, lanVisitor: true, lanUser: '没登记过的人'})).role, 'viewer');
    // 关键：请求头不能把访客抬成主管
    const escalated = await directory.resolve({headers: {'x-sfx-member': editor.member_id}, lanVisitor: true, lanUser: '没登记过的人'});
    assert.equal(escalated.role, 'viewer', '请求头与会话不一致时必须以会话为准');
    // 请求头与会话一致（同一个人的另一个成员号）才采信
    const same = await directory.resolve({headers: {'x-sfx-member': editor.member_id}, lanVisitor: true, lanUser: '小李', lanMemberId: editor.member_id});
    assert.equal(same.member_id, editor.member_id);
  } finally { db.close(); }
});

// —— 二、写入路由 ——————————————————————————————————————————————————

test('集合语义写入路由：成功落库、非法 op 报 400、版本冲突报 409', async t => {
  const {api, storage} = await fixture(t);
  const ok = await call(api, '/api/library/tags/mutate', {
    body: {ops: [{op: 'tag.add', uid: uidA, value: '木材', source: 'user'}]},
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.applied, 1);
  assert.equal(ok.data.changes[0].uid, uidA);
  assert.deepEqual(ok.data.conflicts, []);

  // 派生表真的变了（不是只改了 blob）
  const tagged = await storage.withDb(conn => conn.all('SELECT tag FROM tags WHERE uid = ? AND kind = ?', [uidA, 'user']));
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].tag, '木材');

  const bad = await call(api, '/api/library/tags/mutate', {body: {ops: [{op: 'tag.add', uid: '不是 uid', value: '木'}]}});
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /uid 无效/);

  // 带旧 rev 再改 → 409，且不覆盖别人的改动
  const rev = await storage.withDb(conn => conn.all('SELECT rev FROM assets WHERE uid = ?', [uidA])[0].rev);
  const first = await call(api, '/api/library/tags/mutate', {body: {ops: [{op: 'asset.set', uid: uidA, field: 'rating', value: 5, rev}]}});
  assert.equal(first.status, 200);
  const stale = await call(api, '/api/library/tags/mutate', {body: {ops: [{op: 'asset.set', uid: uidA, field: 'rating', value: 1, rev}]}});
  assert.equal(stale.status, 409);
  assert.equal(stale.data.conflicts[0].code, 'rev_conflict');
  const rating = await storage.withDb(conn => conn.all('SELECT rating FROM assets WHERE uid = ?', [uidA])[0].rating);
  assert.equal(rating, 5, '冲突时不得覆盖');
});

// —— 三、角色门控 ——————————————————————————————————————————————————

test('角色门控：viewer 写操作 403，editor 可以写，成员路由只有主管能改', async t => {
  const {api} = await fixture(t);
  const created = await call(api, '/api/library/members', {body: {name: '访客', role: 'viewer'}});
  assert.equal(created.status, 200);
  const viewerId = created.data.member.member_id;
  const editor = await call(api, '/api/library/members', {body: {name: '小李', role: 'editor'}});
  assert.equal(editor.status, 200);
  const editorId = editor.data.member.member_id;

  // viewer 写 → 403
  const denied = await call(api, '/api/library/tags/mutate', {
    lanUser: '访客', body: {ops: [{op: 'tag.add', uid: uidA, value: '木材', source: 'user'}]},
  });
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /没有写入权限/);

  // viewer 伪造成 editor 的成员号 → 仍然 403（请求头不能抬权）
  const forged = await call(api, '/api/library/tags/mutate', {
    lanUser: '访客', headers: {'x-sfx-member': editorId},
    body: {ops: [{op: 'tag.add', uid: uidA, value: '木材', source: 'user'}]},
  });
  assert.equal(forged.status, 403);

  // editor 写 → 放行
  const allowed = await call(api, '/api/library/tags/mutate', {
    lanUser: '小李', lanMemberId: editorId, body: {ops: [{op: 'tag.add', uid: uidA, value: '木材', source: 'user'}]},
  });
  assert.equal(allowed.status, 200);

  // 成员管理：editor 不行，viewer 不行，owner（本地）行
  assert.equal((await call(api, '/api/library/members', {lanUser: '小李', body: {name: '新人', role: 'viewer'}})).status, 403);
  assert.equal((await call(api, '/api/library/members', {lanUser: '访客', body: {name: '新人', role: 'viewer'}})).status, 403);
  const promoted = await call(api, '/api/library/members', {body: {member_id: viewerId, name: '访客', role: 'editor'}});
  assert.equal(promoted.status, 200);
  assert.equal(promoted.data.member.role, 'editor');
  // 提权后立刻生效（写操作会主动失效成员缓存）
  const after = await call(api, '/api/library/tags/mutate', {
    lanUser: '访客', lanMemberId: viewerId, body: {ops: [{op: 'tag.add', uid: uidB, value: '木材', source: 'user'}]},
  });
  assert.equal(after.status, 200);

  // 成员列表所有人都能读，但只有主管看得到 canManage
  const list = await call(api, '/api/library/members', {method: 'GET'});
  assert.equal(list.status, 200);
  assert.equal(list.data.members.length, 2);
  assert.equal(list.data.canManage, true);
  assert.equal(list.data.canWrite, true);
  const visitorView = await call(api, '/api/library/members', {method: 'GET', lanUser: '访客', lanMemberId: viewerId});
  assert.equal(visitorView.status, 200);
  assert.equal(visitorView.data.canManage, false);
  // 「访客」此时已被提升为编辑：不能管成员，但可以立即备份。
  assert.equal(visitorView.data.me.role, 'editor');
  assert.equal(visitorView.data.canWrite, true);
  const stranger = await call(api, '/api/library/members', {method: 'GET', lanUser: '没登记的人'});
  assert.equal(stranger.data.canWrite, false, '未登记的访客一律只读');
});

// —— 四、变更广播 ——————————————————————————————————————————————————

// —— 三、协作取数与变更广播 ——————————————————————————————————————————

test('主状态超过前端契约上限时：定点写依然成功，且一个字节都不碰 blob', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-bigblob-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  // 造一个超过 16MB 上限的主状态：50 万条时实测 209MB，契约装不下。
  const big = 'x'.repeat(17 * 1024 * 1024);
  const state = {...JSON.parse(JSON.stringify({
    version: 2, models: [{uid: uidA, name: '国风石灯', platform: 'sketchfab', addedAt: 1}],
    aiTags: {}, userTags: {}, userMeta: {}, favorites: [], trashed: [],
  })), note: big};
  const legacy = path.join(dir, 'library-state.json');
  await fs.writeFile(legacy, JSON.stringify({'sfx-library-v2': JSON.stringify(state)}));
  const before = await fs.readFile(legacy, 'utf8');
  const storage = createLibraryStorage(dir, null, {});
  const api = createLibraryApi({storage});

  const response = await call(api, '/api/library/tags/mutate', {
    body: {ops: [{op: 'tag.add', uid: uidA, value: '木材', source: 'user'}]},
  });
  assert.equal(response.status, 200, '超限不能整条写失败 —— 派生表才是权威');
  assert.equal(response.data.applied, 1);
  // ADR-02：用户域权威在 DB，定点写根本不写 blob —— 209MB 的主状态原封不动。
  assert.equal(await fs.readFile(legacy, 'utf8'), before);
  assert.equal(response.data.blobSkipped, false, '不再有「blob 超限跳过」：DB 就是权威，本来就不写 blob');
  // 派生表真的更新了
  const tagged = await storage.withDb(conn => conn.all('SELECT tag FROM tags WHERE uid = ? AND kind = ?', [uidA, 'user']));
  assert.equal(tagged.length, 1);
});

test('ADR-02：/session 轻量写只落会话域，权威主状态一个字节都不动', async t => {
  const {dir, api} = await fixture(t);
  const legacy = path.join(dir, 'library-state.json');
  const before = await fs.readFile(legacy, 'utf8');
  const history = [{kind: 'search', params: {q: '灯'}}];
  const response = await call(api, '/api/library/session', {body: {history, options: {}}});
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.fields, ['history', 'options']);
  assert.equal(await fs.readFile(legacy, 'utf8'), before, '记一次搜索不能重写整份主状态');
  const session = JSON.parse(JSON.parse(await fs.readFile(stateFileFor(dir, SESSION_STATE_KEY), 'utf8')));
  assert.deepEqual(session.history, history);

  const bad = await call(api, '/api/library/session', {body: {history: '不是数组'}});
  assert.equal(bad.status, 400, '会话数据格式必须校验，不能把脏数据写进域文件');
});

test('协作取数：按 uid 取回这些资产的用户可变部分', async t => {
  const {api} = await fixture(t);
  await call(api, '/api/library/tags/mutate', {body: {ops: [
    {op: 'tag.add', uid: uidA, value: '木材', source: 'user'},
    {op: 'asset.set', uid: uidA, field: 'rating', value: 4},
    {op: 'asset.set', uid: uidA, field: 'note', value: '项目A'},
    {op: 'asset.set', uid: uidB, field: 'favorite', value: true},
  ]}});

  const detail = await call(api, '/api/library/assets/detail', {method: 'POST', body: {uids: [uidA, uidB]}});
  assert.equal(detail.status, 200);
  assert.equal(detail.data.details.length, 2);
  const first = detail.data.details.find(item => item.uid === uidA);
  assert.equal(first.rating, 4);
  assert.equal(first.note, '项目A');
  assert.deepEqual(first.userTags, ['木材']);
  assert.equal(detail.data.details.find(item => item.uid === uidB).favorite, true);

  // 空列表与非法 uid 都要安静处理
  assert.deepEqual((await call(api, '/api/library/assets/detail', {method: 'POST', body: {uids: []}})).data.details, []);
  const junk = await call(api, '/api/library/assets/detail', {method: 'POST', body: {uids: ['不是 uid', '']}});
  assert.equal(junk.status, 200);
  assert.deepEqual(junk.data.details, []);
});

test('SSE：写入后订阅者收到事件，断线重连能补齐空档', async t => {
  const {api} = await fixture(t);

  // 先写一次，产生 seq=1
  await call(api, '/api/library/tags/mutate', {body: {ops: [{op: 'tag.add', uid: uidA, value: '木材', source: 'user'}]}});

  // 带 Last-Event-ID=0 重连 → 空档里的事件立刻补发
  const res = jsonRes();
  const req = makeReq({method: 'GET', headers: {'last-event-id': '0'}});
  await api.handle(req, res, apiUrl('/api/library/events'));
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.match(res.body, /: connected/);
  assert.match(res.body, new RegExp(`id: 1\\ndata: \\{.*"uid":"${uidA}"`), '空档里的事件应被补发');

  // 实时事件：再写一次，在线的订阅者立刻收到
  const live = await call(api, '/api/library/tags/mutate', {body: {ops: [{op: 'asset.set', uid: uidB, field: 'rating', value: 4}]}});
  assert.equal(live.status, 200);
  assert.match(res.body, new RegExp(`id: 2\\ndata: \\{.*"kind":"asset".*"uid":"${uidB}".*"rev":\\d+`, 's'), '在线订阅者应立刻收到新事件');
});

test('SSE：跨站订阅被拒绝，同站与本地脚本放行', async t => {
  const {api} = await fixture(t);
  const cross = await call(api, '/api/library/events', {method: 'GET', headers: {origin: 'http://evil.example'}});
  assert.equal(cross.status, 403);
  const fetched = await call(api, '/api/library/events', {method: 'GET', headers: {'sec-fetch-site': 'cross-site'}});
  assert.equal(fetched.status, 403);
  // EventSource 带不了自定义头，所以没有 x-sfx-local 也要放行
  const res = jsonRes();
  const req = makeReq({method: 'GET', headers: {}});
  req.headers = {};
  await api.handle(req, res, apiUrl('/api/library/events'));
  assert.equal(res.status, 200);
});
