import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeamSettings} from '../src/library/team-settings.js';
import {
  roleLabel, formatStamp, backupCaption, permissionsOf, memberDraftToPayload,
  memberRows, backupRows, sessionRows, teamRequest,
} from '../src/library/team-data.js';

// ——— 一、纯数据契约 ——————————————————————————————————————————————

test('角色映射、权限门控与身份文案', () => {
  assert.equal(roleLabel('owner'), '主管');
  assert.equal(roleLabel('editor'), '编辑');
  assert.equal(roleLabel('不存在的角色'), '访客');
  assert.deepEqual(permissionsOf({canManage: true, canWrite: true, me: {name: '主机', role: 'owner'}}), {
    manage: true, write: true, restore: true, identity: '主机 · 主管',
  });
  // 编辑能备份，但不能管成员、不能恢复 —— 三个门必须分开。
  assert.deepEqual(permissionsOf({canManage: false, canWrite: true, me: {name: '小李', role: 'editor'}}), {
    manage: false, write: true, restore: false, identity: '小李 · 编辑',
  });
  assert.deepEqual(permissionsOf({}), {manage: false, write: false, restore: false, identity: '本机 · 访客'});
  assert.equal(formatStamp(null), '时间未知');
  assert.match(formatStamp(1762531200000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('行模型：脏角色降级、脏编号过滤、缺失资产数不显示成 0', () => {
  const rows = memberRows({
    me: {member_id: 'm-aaaaaaaa'},
    members: [
      {member_id: 'm-aaaaaaaa', name: '我', role: 'owner', disabled: 0},
      {member_id: 'm-bbbbbbbb', name: '怪数据', role: 'admin', disabled: '1'},
    ],
  });
  assert.equal(rows[0].isMe, true);
  assert.equal(rows[1].isMe, false);
  assert.equal(rows[1].role, 'viewer', '未知角色按最低权限渲染');
  assert.equal(rows[1].disabled, true);
  assert.deepEqual(memberRows({members: 'oops'}), []);

  assert.deepEqual(backupRows({backups: [
    {name: '../etc/passwd'},
    {name: '20261108-010000', assets: null, hasDatabase: false, at: 0},
    {name: '20261108-020000-002', assets: 500000, hasDatabase: true},
  ]}).map(row => row.name), ['20261108-010000', '20261108-020000-002']);
  assert.match(backupCaption({assets: null}), /资产数未知/);
  assert.match(backupCaption({assets: 500000, hasDatabase: true}), /500,000 条资产 · 含索引/);
});

test('表单 → 请求体；请求缝带本地标识并从 {error} 取错误', async () => {
  assert.deepEqual(memberDraftToPayload({name: ' 小李 ', role: 'editor', disabled: 1, member_id: 'm-bbbbbbbb'}), {
    name: '小李', role: 'editor', disabled: true, member_id: 'm-bbbbbbbb',
  });
  assert.deepEqual(memberDraftToPayload({name: '新人', role: 'hacker'}), {
    name: '新人', role: 'viewer', disabled: false,
  }, '新增不带 member_id，非法角色降级为访客');

  const seen = [];
  const ok = await teamRequest('/api/x', {
    method: 'POST', body: {a: 1},
    fetchFn: async (url, options) => { seen.push({url, options}); return {ok: true, json: async () => ({done: 1})}; },
  });
  assert.equal(ok.done, 1);
  assert.equal(seen[0].options.headers['X-SFX-Local'], '1');
  assert.equal(seen[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0].options.body), {a: 1});
  await assert.rejects(
    teamRequest('/api/x', {fetchFn: async () => ({ok: false, status: 403, json: async () => ({error: '没有权限'})})}),
    /没有权限/,
  );
});

// ——— 二、假 DOM 与假服务端 ————————————————————————————————————————

function element() {
  const nodes = new Map();
  return {
    children: [], dataset: {}, value: '', checked: false, textContent: '', innerHTML: '',
    hidden: false, disabled: false, title: '', type: '', className: '',
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    addEventListener() {}, setAttribute() {},
  };
}

function harness(t, initial = {}) {
  const previous = globalThis.document;
  globalThis.document = {createElement: () => element()};
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });

  const state = {
    members: initial.members ?? [
      {member_id: 'm-aaaaaaaa', name: '主管', role: 'owner', disabled: 0},
      {member_id: 'm-bbbbbbbb', name: '小李', role: 'editor', disabled: 0},
    ],
    backups: initial.backups ?? [{name: '20261108-010000', at: 1762531200000, assets: 500000, hasDatabase: true}],
    me: initial.me ?? {member_id: 'm-aaaaaaaa', name: '主管', role: 'owner', local: true},
    canManage: initial.canManage ?? true,
    canWrite: initial.canWrite ?? true,
    sessions: initial.sessions ?? [{id: 'a'.repeat(32), username: '小李', member_id: '', expires: Date.now() + 3600000}],
    config: {dir: 'D:/AssetVault/backups', keep: 5, intervalMs: 6 * 3600 * 1000},
  };
  const calls = [], notices = [], answers = [];
  let failure = null;
  const fetchFn = async (target, options = {}) => {
    const [url, search = ''] = String(target).split('?');
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({url, search, method, body, headers: options.headers || {}});
    const reply = data => ({ok: true, json: async () => data});
    if (failure && url.includes(failure.url) && (!failure.method || failure.method === method)) {
      const error = failure; failure = null;
      return {ok: false, status: error.status || 403, json: async () => ({error: error.message})};
    }
    if (url === '/api/library/members') {
      if (method === 'POST') {
        const id = body.member_id || 'm-cccccccc';
        const row = {member_id: id, name: body.name, role: body.role, disabled: body.disabled ? 1 : 0};
        const existing = state.members.find(item => item.member_id === id);
        if (existing) Object.assign(existing, row); else state.members.push(row);
        // S3 修复后 POST 与 GET 同款：直接回 me / canManage / canWrite，前端就地渲染不必再拉一次。
        return reply({member: row, members: state.members, me: state.me, canManage: state.canManage, canWrite: state.canWrite});
      }
      if (method === 'DELETE') {
        const id = new URLSearchParams(search).get('id');
        state.members = state.members.filter(item => item.member_id !== id);
        return reply({removed: true, members: state.members});
      }
      return reply({members: state.members, me: state.me, canManage: state.canManage, canWrite: state.canWrite});
    }
    if (url === '/api/lan/sessions') {
      if (method === 'POST') {
        const session = state.sessions.find(row => row.id === body.id);
        if (session) session.member_id = body.member_id;
      }
      return reply({sessions: state.sessions, migration: '旧版按姓名授权已停用'});
    }
    if (url === '/api/library/backups') {
      if (method === 'POST') {
        const name = '20261108-020000';
        state.backups.unshift({name, at: 1762534800000, assets: 500001, hasDatabase: true});
        return reply({backup: {name}, backups: state.backups}); // 同样不返回 config
      }
      return reply({backups: state.backups, config: state.config});
    }
    if (url === '/api/library/backups/restore') {
      return reply({restored: body.name, safety: {name: '20261108-015959'}});
    }
    return {ok: false, status: 404, json: async () => ({error: '未知接口'})};
  };
  const ui = createTeamSettings({
    toast: text => notices.push(text),
    ask: () => answers.shift() === true,
    fetchFn,
  });
  const q = (card, selector) => card.querySelector(selector);
  const get = {
    identity: q(ui.membersCard, '[data-team-identity]'),
    memberStatus: q(ui.membersCard, '[data-team-member-status]'),
    memberList: q(ui.membersCard, '[data-team-members]'),
    memberForm: q(ui.membersCard, '[data-team-form]'),
    nameInput: q(ui.membersCard, '[data-team-name]'),
    roleInput: q(ui.membersCard, '[data-team-role]'),
    addButton: q(ui.membersCard, '[data-team-add]'),
    backupStatus: q(ui.backupsCard, '[data-team-backup-status]'),
    backupConfig: q(ui.backupsCard, '[data-team-backup-config]'),
    backupList: q(ui.backupsCard, '[data-team-backups]'),
    runButton: q(ui.backupsCard, '[data-team-run]'),
    sessionsPanel: q(ui.membersCard, '[data-team-sessions]'),
    sessionList: q(ui.membersCard, '[data-team-session-list]'),
    sessionStatus: q(ui.membersCard, '[data-team-session-status]'),
    sessionMigration: q(ui.membersCard, '[data-team-session-migration]'),
    sessionsRefresh: q(ui.membersCard, '[data-team-sessions-refresh]'),
  };
  return {ui, get, state, calls, notices, answers, fail: error => { failure = error; }};
}

const memberRow = (h, index) => h.get.memberList.children[index].children;
const backupRow = (h, index) => h.get.backupList.children[index].children;
const sessionRow = (h, index = 0) => h.get.sessionList.children[index].children;
const postSessions = h => h.calls.filter(call => call.url === '/api/lan/sessions' && call.method === 'POST');

test('会话行模型过滤过期及无效审批 ID，不接受登录凭据作为编号', () => {
  assert.deepEqual(sessionRows({sessions: [
    {id: 'a'.repeat(32), username: '<img>', member_id: '', expires: 200},
    {id: 'b'.repeat(32), expires: 99}, {id: 'cookie-secret', expires: 200}, null,
  ]}, 100), [{id: 'a'.repeat(32), username: '<img>', member_id: '', expires: 200}]);
});

test('会话审批仅可信主机可见，远端主管不能由 canManage 获得入口', async t => {
  const remote = harness(t, {me: {name: '远端主管', role: 'owner', local: false}});
  assert.equal(remote.get.sessionsPanel.hidden, true);
  await remote.ui.load();
  assert.equal(remote.get.addButton.disabled, false);
  assert.equal(remote.get.sessionsPanel.hidden, true);
  assert.equal(remote.calls.some(call => call.url === '/api/lan/sessions'), false);
  remote.state.me.local = true;
  await remote.ui.load();
  assert.equal(remote.get.sessionsPanel.hidden, false);
  remote.fail({url: '/api/lan/sessions', message: '仅主机', status: 403});
  await remote.get.sessionsRefresh.onclick();
  assert.equal(remote.get.sessionsPanel.hidden, true);
  assert.equal(remote.get.sessionList.children.length, 0);
});

test('审批需要核实确认且显式选择启用成员，撤销提交空 member_id', async t => {
  const h = harness(t);
  h.state.members[0].disabled = true;
  await h.ui.load();
  assert.equal(h.get.sessionsPanel.hidden, false);
  let [label, status, select, approve, revoke] = sessionRow(h);
  assert.match(label.textContent, /审批 ID a{32}/);
  assert.match(status.textContent, /未批准/);
  assert.equal(select.value, '', '同名成员不自动选中');
  assert.deepEqual(select.children.map(option => option.value), ['', 'm-bbbbbbbb']);
  assert.equal(approve.disabled, true);
  assert.equal(revoke.disabled, true);
  select.value = 'm-bbbbbbbb';
  select.onchange();
  assert.equal(approve.disabled, false);
  h.answers.push(false);
  await approve.onclick();
  assert.equal(postSessions(h).length, 0);
  h.answers.push(true);
  const pending = approve.onclick();
  assert.equal(sessionRow(h)[2].disabled, true, '写入期间禁用下拉');
  assert.equal(sessionRow(h)[3].disabled, true, '防重复审批');
  await pending;
  assert.deepEqual(postSessions(h)[0].body, {id: 'a'.repeat(32), member_id: 'm-bbbbbbbb'});
  assert.equal(postSessions(h)[0].headers['X-SFX-Local'], '1');
  assert.equal(sessionRow(h)[4].disabled, false);
  await sessionRow(h)[4].onclick();
  assert.deepEqual(postSessions(h)[1].body, {id: 'a'.repeat(32), member_id: ''});
  assert.match(sessionRow(h)[1].textContent, /未批准/);
});

test('成员停用及刷新会更新审批选项，失败反馈并恢复操作', async t => {
  const h = harness(t);
  await h.ui.load();
  const disabled = memberRow(h, 1)[3].children[0];
  disabled.checked = true;
  await disabled.onchange();
  assert.deepEqual(sessionRow(h)[2].children.map(option => option.value), ['', 'm-aaaaaaaa']);
  h.state.members[0].disabled = 1;
  await h.get.sessionsRefresh.onclick();
  assert.equal(sessionRow(h)[2].disabled, true);
  assert.equal(sessionRow(h)[3].disabled, true);
  h.state.members[0].disabled = 0;
  await h.get.sessionsRefresh.onclick();
  const select = sessionRow(h)[2];
  select.value = 'm-aaaaaaaa'; select.onchange();
  h.fail({url: '/api/lan/sessions', method: 'POST', status: 409, message: '会话已失效'});
  h.answers.push(true);
  await sessionRow(h)[3].onclick();
  assert.match(h.get.sessionStatus.textContent, /会话已失效/);
  assert.equal(h.get.sessionStatus.dataset.state, 'error');
  assert.equal(sessionRow(h)[2].disabled, false);
  h.state.me.local = false;
  await h.get.sessionsRefresh.onclick();
  assert.equal(h.get.sessionsPanel.hidden, true);
  await select.onchange();
  assert.equal(postSessions(h).length, 1);
});

test('审批被 403 拒绝立即清空隐藏；重新登录的新会话不继承旧绑定', async t => {
  const h = harness(t);
  await h.ui.load();
  sessionRow(h)[2].value = 'm-bbbbbbbb';
  sessionRow(h)[2].onchange();
  h.answers.push(true);
  h.fail({url: '/api/lan/sessions', method: 'POST', status: 403, message: '仅可信主机可审批'});
  await sessionRow(h)[3].onclick();
  assert.equal(h.get.sessionsPanel.hidden, true);
  assert.equal(h.get.sessionList.children.length, 0);
  h.state.sessions = [{id: 'd'.repeat(32), username: '小李', member_id: '', expires: Date.now() + 60000}];
  await h.ui.load();
  assert.equal(sessionRow(h)[2].value, '');
  assert.equal(sessionRow(h)[4].disabled, true);
  assert.match(sessionRow(h)[0].textContent, /d{32}/);
  h.state.sessions[0].expires = 1;
  await h.get.sessionsRefresh.onclick();
  assert.match(h.get.sessionList.children[0].textContent, /暂无待审批/);
});

test('外部会话及成员名称仅 textContent 回显，空状态不再宣称同名授权', async t => {
  const hostile = '<img src=x onerror=alert(1)>';
  const h = harness(t, {members: [{member_id: 'm-bbbbbbbb', name: hostile, role: 'editor', disabled: 0}],
    sessions: [{id: 'c'.repeat(32), username: hostile, member_id: '', expires: Date.now() + 60000}]});
  await h.ui.load();
  assert.match(sessionRow(h)[0].textContent, /<img/);
  assert.equal(sessionRow(h)[0].innerHTML, '');
  assert.match(sessionRow(h)[2].children[1].textContent, /<img/);
  assert.equal(sessionRow(h)[2].children[1].innerHTML, '');
  assert.equal(memberRow(h, 0)[1].textContent, hostile);
  assert.equal(memberRow(h, 0)[1].innerHTML, '');
  h.state.members = []; h.state.sessions = [];
  await h.get.sessionsRefresh.onclick();
  assert.equal(h.get.memberList.children[0].textContent, '暂无成员');
  assert.match(h.get.memberList.children[0].title, /核实会话并批准/);
  assert.match(h.get.sessionList.children[0].textContent, /暂无待审批/);
});
const postMembers = calls => calls.filter(item => item.url === '/api/library/members' && item.method === 'POST');

test('加载：身份、成员/备份列表与保存策略都渲染出来', async t => {
  const h = harness(t);
  await h.ui.load();
  assert.match(h.get.identity.textContent, /当前身份：主管 · 主管/);
  assert.equal(h.get.memberList.children.length, 2);
  assert.equal(h.get.backupList.children.length, 1);
  assert.match(h.get.backupConfig.textContent, /保留 5 份 · 每 6 小时自动一次/);
  assert.match(backupRow(h, 0)[0].textContent, /500,000 条资产 · 含索引/);
  assert.equal(h.get.addButton.disabled, false);
  assert.equal(h.get.runButton.disabled, false);
  assert.equal(backupRow(h, 0)[1].disabled, false);
  assert.equal(h.calls[0].headers['X-SFX-Local'], '1');
});

test('权限门控：viewer 全禁用，editor 只放开「立即备份」', async t => {
  const viewer = harness(t, {canManage: false, canWrite: false, me: {member_id: '', name: '路人', role: 'viewer'}});
  await viewer.ui.load();
  assert.equal(viewer.get.addButton.disabled, true);
  assert.equal(viewer.get.memberForm.hidden, true);
  assert.equal(viewer.get.runButton.disabled, true);
  assert.equal(memberRow(viewer, 0)[2].disabled, true, '角色下拉');
  assert.equal(memberRow(viewer, 0)[3].children[0].disabled, true, '停用开关');
  assert.equal(memberRow(viewer, 0)[4].disabled, true, '删除');
  assert.equal(backupRow(viewer, 0)[1].disabled, true, '恢复');

  const editor = harness(t, {canManage: false, canWrite: true, me: {member_id: 'm-bbbbbbbb', name: '小李', role: 'editor'}});
  await editor.ui.load();
  assert.equal(editor.get.addButton.disabled, true);
  assert.equal(editor.get.runButton.disabled, false);
  assert.equal(backupRow(editor, 0)[1].disabled, true);
});

test('改角色 / 停用 / 新增：POST 体正确，且保存后不会把权限清空', async t => {
  const h = harness(t);
  await h.ui.load();
  const role = memberRow(h, 1)[2];
  role.value = 'owner';
  await role.onchange();
  assert.deepEqual(postMembers(h.calls)[0].body, {
    name: '小李', role: 'owner', disabled: false, member_id: 'm-bbbbbbbb',
  });
  // POST 现在直接回 me / canManage / canWrite，界面就地渲染，不再为刷新权限多发一次 GET。
  assert.equal(h.calls.filter(item => item.url === '/api/library/members' && item.method === 'GET').length, 1);
  assert.equal(memberRow(h, 1)[2].disabled, false, '权限没被清空');
  assert.match(h.notices.at(-1), /主管/);

  const checkbox = memberRow(h, 1)[3].children[0];
  checkbox.checked = true;
  await checkbox.onchange();
  assert.equal(postMembers(h.calls)[1].body.disabled, true);

  h.get.nameInput.value = ' 新人 ';
  h.get.roleInput.value = 'editor';
  await h.get.memberForm.onsubmit({preventDefault() {}});
  assert.deepEqual(postMembers(h.calls)[2].body, {name: '新人', role: 'editor', disabled: false});
  assert.equal(h.get.nameInput.value, '', '添加后清空输入框');
  assert.equal(h.get.memberList.children.length, 3);
});

test('删除成员：拒绝确认时不发请求，确认后才 DELETE 并刷新', async t => {
  const h = harness(t);
  await h.ui.load();
  const remove = memberRow(h, 1)[4];
  h.answers.push(false);
  await remove.onclick();
  assert.equal(h.calls.some(item => item.method === 'DELETE'), false);
  h.answers.push(true);
  await remove.onclick();
  const deleted = h.calls.find(item => item.method === 'DELETE');
  assert.equal(deleted.search, 'id=m-bbbbbbbb');
  assert.equal(h.state.members.length, 1);
  assert.equal(h.get.memberList.children.length, 1);
  assert.match(h.get.memberStatus.textContent, /已删除/);
});

test('立即备份与恢复：确认才恢复，配置说明不因 POST 丢失', async t => {
  const h = harness(t);
  await h.ui.load();
  await h.get.runButton.onclick();
  assert.equal(h.calls.some(item => item.url === '/api/library/backups' && item.method === 'POST'), true);
  assert.equal(h.get.backupList.children.length, 2);
  assert.match(h.get.backupConfig.textContent, /保留 5 份/, 'POST 不返回 config，界面重新拉取后仍要显示');
  assert.match(h.get.backupStatus.textContent, /已备份/);

  const restore = backupRow(h, 0)[1];
  h.answers.push(false);
  await restore.onclick();
  assert.equal(h.calls.some(item => item.url === '/api/library/backups/restore'), false);
  h.answers.push(true);
  await restore.onclick();
  const call = h.calls.find(item => item.url === '/api/library/backups/restore');
  assert.equal(call.body.name, '20261108-020000');
  assert.match(h.get.backupStatus.textContent, /恢复前快照 20261108-015959/);
});

test('接口失败只降级不崩：成员读取失败禁用备份，备份失败留在状态行', async t => {
  const h = harness(t);
  h.fail({url: '/api/library/members', message: '成员服务不可用'});
  await h.ui.load();
  assert.equal(h.get.memberStatus.dataset.state, 'error');
  assert.match(h.get.memberStatus.textContent, /成员服务不可用/);
  assert.equal(h.get.runButton.disabled, true, '认不出身份时一律不给写');

  const h2 = harness(t);
  await h2.ui.load();
  h2.fail({url: '/api/library/backups', method: 'POST', message: '磁盘已满'});
  await h2.get.runButton.onclick();
  assert.equal(h2.get.backupStatus.dataset.state, 'error');
  assert.match(h2.get.backupStatus.textContent, /磁盘已满/);
  assert.match(h2.notices.at(-1), /磁盘已满/);
});
