/**
 * S3 收尾：成员权限与自动备份的设置界面（DOM 层）。
 *
 * 数据契约在 team-data.js；这里只负责把行模型变成节点、把事件变成请求。
 * 名字一律 textContent 回显，绝不拼进 innerHTML —— 成员名来自局域网登录页，属于外部输入。
 */
import {icon} from './icon-set.js';
import {ROLES, roleLabel, permissionsOf, memberDraftToPayload, memberRows, backupRows, sessionRows, formatStamp, teamRequest} from './team-data.js';

/** 设置面板里两张卡片共用的小状态行。 */
function setStatus(node, message, bad = false) {
  node.textContent = message;
  node.dataset.state = bad ? 'error' : 'idle';
}

/**
 * 建两张卡片。返回 {membersCard, backupsCard, load}，由 settings-panel.js 挂到分类页里。
 * ask() 是确认弹窗缝（默认 window.confirm），测试可注入以免阻塞。
 */
export function createTeamSettings({toast = () => {}, ask, fetchFn} = {}) {
  const confirmWith = message => ask ? ask(message) === true
    : typeof globalThis.confirm === 'function' && globalThis.confirm(message) === true;
  const call = (url, options) => teamRequest(url, {...options, fetchFn});

  const membersCard = document.createElement('section');
  membersCard.className = 'settings-card team-compact';
  membersCard.innerHTML = `<div class="settings-section-title"><span>成员与权限</span><small>展示名不代表身份</small></div>
    <div class="team-row">
     <span class="team-identity" data-team-identity></span>
     <span class="team-status" role="status" data-team-member-status></span>
     <button type="button" class="icon-button" data-team-members-refresh title="刷新成员" aria-label="刷新成员">${icon('rotate')}</button>
    </div>
    <span class="team-help" tabindex="0" role="note" aria-label="权限说明" title="登录名仅作展示，不能证明身份。访客默认只读；主机核实会话后批准成员权限。停用立即生效，已开始的任务不受影响。">${icon('help')}</span>
    <div class="team-list" data-team-members></div>
    <form class="team-form" data-team-form>
     <input type="text" data-team-name placeholder="成员展示名" maxlength="24" required aria-label="成员名">
     <select data-team-role aria-label="新成员角色"><option value="viewer">访客</option><option value="editor">编辑</option><option value="owner">主管</option></select>
     <button type="submit" class="icon-button" data-team-add title="添加成员" aria-label="添加成员">${icon('plus')}</button>
    </form>
    <div data-team-sessions hidden>
     <div class="settings-section-title"><span>局域网会话审批</span><small>仅主机可操作</small></div>
     <span class="team-help" tabindex="0" role="note" aria-label="会话审批说明" title="先通过可信渠道核实访客及审批 ID，再选择成员批准。不要凭展示名授权。访客重新登录或主机重启后，必须重新批准。">${icon('help')}</span>
     <span class="team-help team-migration" tabindex="0" role="note" aria-label="兼容说明" data-team-session-migration></span>
     <div class="team-row"><span class="team-status" role="status" data-team-session-status></span>
      <button type="button" class="icon-button" data-team-sessions-refresh title="刷新会话与成员" aria-label="刷新会话与成员">${icon('rotate')}</button></div>
     <div class="team-list" data-team-session-list></div>
    </div>`;

  const backupsCard = document.createElement('section');
  backupsCard.className = 'settings-card team-compact';
  backupsCard.innerHTML = `<div class="settings-section-title"><span>自动备份</span><small title="快照保存资产库状态，不包含原始资源文件；恢复前会先自动备份当前状态。">状态快照 ⓘ</small></div>
    <div class="team-row">
     <span class="team-status" role="status" data-team-backup-status></span>
     <button type="button" class="secondary" data-team-run title="立即创建状态快照" aria-label="立即备份">${icon('save')}<span>备份</span></button>
     <button type="button" class="icon-button" data-team-backups-refresh title="刷新备份" aria-label="刷新备份">${icon('rotate')}</button>
    </div>
    <p class="team-note" data-team-backup-config></p>
    <div class="team-list" data-team-backups></div>`;

  const q = (card, selector) => card.querySelector(selector);
  const identity = q(membersCard, '[data-team-identity]');
  const memberStatus = q(membersCard, '[data-team-member-status]');
  const memberList = q(membersCard, '[data-team-members]');
  const memberForm = q(membersCard, '[data-team-form]');
  const nameInput = q(membersCard, '[data-team-name]');
  const roleInput = q(membersCard, '[data-team-role]');
  const addButton = q(membersCard, '[data-team-add]');
  const backupStatus = q(backupsCard, '[data-team-backup-status]');
  const backupConfig = q(backupsCard, '[data-team-backup-config]');
  const backupList = q(backupsCard, '[data-team-backups]');
  const runButton = q(backupsCard, '[data-team-run]');

  const sessionsPanel = q(membersCard, '[data-team-sessions]');
  const sessionList = q(membersCard, '[data-team-session-list]');
  const sessionStatus = q(membersCard, '[data-team-session-status]');
  const sessionMigration = q(membersCard, '[data-team-session-migration]');
  const sessionsRefresh = q(membersCard, '[data-team-sessions-refresh]');
  sessionsPanel.hidden = true;
  let permissions = permissionsOf({});
  let local = false, members = [], sessions = [], sessionBusy = false, sessionEpoch = 0;

  function hideSessions() {
    local = false;
    sessionEpoch++;
    sessions = [];
    sessionsPanel.hidden = true;
    sessionList.replaceChildren();
  }

  function renderSessions(data) {
    sessions = sessionRows(data);
    sessionList.replaceChildren();
    const enabled = members.filter(row => !row.disabled && /^m-[a-f0-9]{8}$/.test(row.member_id));
    if (!sessions.length) {
      const empty = document.createElement('p');
      empty.className = 'team-empty';
      empty.textContent = '暂无待审批会话';
      empty.title = '访客登录后刷新；展示名相同不会自动授权。';
      sessionList.append(empty);
    }
    for (const session of sessions) {
      const line = document.createElement('div');
      line.className = 'team-row team-form';
      const label = document.createElement('span');
      label.className = 'team-status';
      label.textContent = `${session.username} · 审批 ID ${session.id} · 到期 ${formatStamp(session.expires)}`;
      const select = document.createElement('select');
      select.setAttribute('aria-label', `${session.username} 的批准成员`);
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = enabled.length ? '请选择已核实的成员' : '请先添加或启用成员';
      select.append(placeholder);
      for (const member of enabled) {
        const option = document.createElement('option');
        option.value = member.member_id;
        option.textContent = `${member.name} · ${roleLabel(member.role)}`;
        select.append(option);
      }
      select.value = enabled.some(row => row.member_id === session.member_id) ? session.member_id : '';
      const approved = document.createElement('span');
      approved.className = 'team-note';
      const bound = members.find(row => row.member_id === session.member_id);
      approved.textContent = session.member_id ? `已关联：${bound?.name || '成员不可用'}${bound?.disabled ? '（已停用）' : ''}` : '未批准 · 只读';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'secondary';
      approve.textContent = '核实并批准';
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'secondary';
      revoke.textContent = '撤销';
      select.disabled = sessionBusy || !local || !enabled.length;
      const update = () => { approve.disabled = sessionBusy || !local || !enabled.some(row => row.member_id === select.value) || select.value === session.member_id; };
      select.onchange = update;
      update();
      revoke.disabled = sessionBusy || !local || !session.member_id;
      approve.onclick = () => select.value && saveSession(session, select.value);
      revoke.onclick = () => saveSession(session, '');
      line.append(label, approved, select, approve, revoke);
      sessionList.append(line);
    }
    sessionsRefresh.disabled = sessionBusy || !local;
  }

  async function loadSessions() {
    if (!local) return;
    const epoch = ++sessionEpoch;
    sessionsRefresh.disabled = true;
    try {
      const data = await call('/api/lan/sessions');
      if (!local || epoch !== sessionEpoch) return;
      sessionMigration.title = String(data.migration || '旧版同名自动授权已停用，现有访客需要主机重新核实批准。');
      sessionMigration.innerHTML = icon('help');
      renderSessions(data);
      setStatus(sessionStatus, `共 ${sessions.length} 个有效会话`);
    } catch (error) {
      if (epoch !== sessionEpoch) return;
      sessions = [];
      sessionList.replaceChildren();
      if (error.status === 403) hideSessions();
      else setStatus(sessionStatus, error.message, true);
    } finally { sessionsRefresh.disabled = sessionBusy || !local; }
  }

  async function saveSession(session, memberId) {
    if (!local || sessionBusy || session.expires <= Date.now()) return;
    if (memberId && !members.some(row => row.member_id === memberId && !row.disabled)) return;
    if (memberId && !confirmWith(`已通过可信渠道核实「${session.username}」的会话 ${session.id}？批准后将获得所选成员权限。`)) return;
    sessionBusy = true;
    renderSessions({sessions});
    setStatus(sessionStatus, '保存审批中…');
    try {
      const data = await call('/api/lan/sessions', {method: 'POST', body: {id: session.id, member_id: memberId}});
      if (!local) return;
      renderSessions(data);
      await loadMembers();
      setStatus(sessionStatus, memberId ? '已批准会话' : '已撤销会话权限');
    } catch (error) {
      if (error.status === 403) hideSessions();
      setStatus(sessionStatus, error.message, true);
    } finally {
      sessionBusy = false;
      if (local) renderSessions({sessions});
    }
  }

  /** 角色 / 停用 / 删除共用一条保存路径：整行提交，服务端按 member_id 覆盖。 */
  async function saveMember(row, message) {
    setStatus(memberStatus, '保存中…');
    try {
      const data = await call('/api/library/members', {method: 'POST', body: memberDraftToPayload(row)});
      // POST 现在把 me / canManage / canWrite 一起回（与 GET 同款），拿到就能就地渲染，
      // 不必再发一次 GET 刷新权限——否则保存后会把自己锁成只读，还多等一拍。
      renderMembers(data);
      await loadSessions();
      setStatus(memberStatus, message);
      toast(message);
    } catch (error) {
      setStatus(memberStatus, error.message, true);
      toast(error.message);
    }
  }

  function renderMembers(data) {
    permissions = permissionsOf(data);
    members = memberRows(data);
    if (data.me?.local === true) {
      local = true;
      sessionsPanel.hidden = false;
      renderSessions({sessions});
    } else hideSessions();
    identity.textContent = `当前身份：${permissions.identity}`;
    addButton.disabled = !permissions.manage;
    nameInput.disabled = !permissions.manage;
    roleInput.disabled = !permissions.manage;
    memberForm.hidden = !permissions.manage;
    memberList.replaceChildren();
    const rows = memberRows(data);
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'team-empty';
      empty.textContent = '暂无成员';
      empty.title = '添加成员仅创建权限档案，访客仍需主机核实会话并批准。';
      memberList.append(empty);
      return;
    }
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'team-member';
      line.dataset.state = row.disabled ? 'disabled' : 'active';

      const dot = document.createElement('span');
      dot.className = 'team-dot';
      dot.title = row.disabled ? '已停用' : '生效中';

      const name = document.createElement('span');
      name.className = 'team-member-name';
      name.textContent = row.isMe ? `${row.name}（我）` : row.name;

      const role = document.createElement('select');
      role.setAttribute('aria-label', `${row.name} 的角色`);
      for (const value of ROLES) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = roleLabel(value);
        role.append(option);
      }
      role.value = row.role;
      role.disabled = !permissions.manage;
      role.onchange = () => saveMember({...row, role: role.value}, `已把「${row.name}」设为${roleLabel(role.value)}`);

      const disabled = document.createElement('label');
      disabled.className = 'team-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = row.disabled;
      checkbox.disabled = !permissions.manage;
      checkbox.setAttribute('aria-label', `停用 ${row.name}`);
      checkbox.onchange = () => saveMember({...row, disabled: checkbox.checked}, checkbox.checked ? `已停用「${row.name}」` : `已启用「${row.name}」`);
      const toggleText = document.createElement('span');
      toggleText.textContent = '停用';
      disabled.append(checkbox, toggleText);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'team-remove';
      remove.title = `删除 ${row.name}`;
      remove.setAttribute('aria-label', `删除 ${row.name}`);
      remove.innerHTML = icon('trash');
      remove.disabled = !permissions.manage;
      remove.onclick = async () => {
        if (!confirmWith(`删除成员「${row.name}」？该访客下次访问会退回只读。`)) return;
        setStatus(memberStatus, '删除中…');
        try {
          await call('/api/library/members', {method: 'DELETE', search: `?id=${encodeURIComponent(row.member_id)}`});
          await loadMembers();
          setStatus(memberStatus, `已删除「${row.name}」`);
          toast(`已删除「${row.name}」`);
        } catch (error) {
          setStatus(memberStatus, error.message, true);
          toast(error.message);
        }
      };
      line.append(dot, name, role, disabled, remove);
      memberList.append(line);
    }
  }

  function renderBackups(data) {
    runButton.disabled = !permissions.write;
    const config = data.config || {};
    const hours = Number(config.intervalMs) > 0 ? Math.round(Number(config.intervalMs) / 3600000 * 10) / 10 : null;
    backupConfig.title = `备份目录：${String(config.dir || '默认')}`;
    backupConfig.textContent = `保留 ${Number(config.keep) || 0} 份`
      + (hours ? ` · 每 ${hours} 小时自动一次` : '');
    backupList.replaceChildren();
    const rows = backupRows(data);
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'team-empty';
      empty.textContent = '还没有备份。点「立即备份」先留一份现状。';
      backupList.append(empty);
      return;
    }
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'team-backup';
      const label = document.createElement('span');
      label.className = 'team-backup-label';
      label.textContent = row.caption;
      label.title = row.name;
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'secondary team-restore';
      restore.textContent = '恢复';
      restore.disabled = !permissions.restore;
      restore.onclick = async () => {
        if (!confirmWith(`把资产库恢复到 ${row.name} 这份快照？\n当前库会被覆盖，系统会先自动留一份「恢复前」的备份。所有设备需要刷新页面。`)) return;
        setStatus(backupStatus, '恢复中…');
        restore.disabled = true;
        try {
          const result = await call('/api/library/backups/restore', {method: 'POST', body: {name: row.name}});
          const safety = result.safety?.name ? `（恢复前快照 ${result.safety.name} 已保留）` : '';
          setStatus(backupStatus, `已恢复 ${result.restored || row.name}${safety}`);
          toast(`已恢复备份${safety}`);
          await loadBackups();
        } catch (error) {
          setStatus(backupStatus, error.message, true);
          toast(error.message);
        } finally { restore.disabled = !permissions.restore; }
      };
      line.append(label, restore);
      backupList.append(line);
    }
  }

  async function loadMembers() {
    const data = await call('/api/library/members');
    renderMembers(data);
    await loadSessions();
    return data;
  }

  async function loadBackups() {
    const data = await call('/api/library/backups');
    renderBackups(data);
    return data;
  }

  /** 切到这个分类时调用。成员权限先取到，备份卡片才知道该不该禁用按钮。 */
  async function load() {
    try {
      const data = await loadMembers();
      setStatus(memberStatus, `共 ${memberRows(data).length} 名成员`);
    } catch (error) {
      setStatus(memberStatus, error.message, true);
      renderMembers({});
      runButton.disabled = true;
    }
    try { await loadBackups(); }
    catch (error) { setStatus(backupStatus, error.message, true); }
  }

  sessionsRefresh.onclick = () => loadMembers()
    .catch(error => { renderMembers({}); setStatus(sessionStatus, error.message, true); });
  q(membersCard, '[data-team-members-refresh]').onclick = () => loadMembers()
    .then(data => { setStatus(memberStatus, `共 ${memberRows(data).length} 名成员`); toast('成员列表已刷新'); })
    .catch(error => { renderMembers({}); setStatus(memberStatus, error.message, true); toast(error.message); });
  q(backupsCard, '[data-team-backups-refresh]').onclick = () => loadBackups()
    .catch(error => { setStatus(backupStatus, error.message, true); toast(error.message); });

  memberForm.onsubmit = event => {
    event.preventDefault?.();
    const name = String(nameInput.value || '').trim();
    if (!name) return;
    // 返回 Promise：调用方（含测试）能等这次写入完成，别把异步结果丢在 void 里。
    return saveMember({name, role: roleInput.value, disabled: false}, `已添加「${name}」`)
      .then(() => { nameInput.value = ''; });
  };

  runButton.onclick = async () => {
    setStatus(backupStatus, '备份中…');
    runButton.disabled = true;
    try {
      const result = await call('/api/library/backups', {method: 'POST', body: {}});
      // 同上：POST 不返回 config，沿用「立即备份」前那一份，或重新拉一次保持一致。
      await loadBackups();
      setStatus(backupStatus, `已备份 ${result.backup?.name || '完成'}`);
      toast('备份完成');
    } catch (error) {
      setStatus(backupStatus, error.message, true);
      toast(error.message);
    } finally { runButton.disabled = !permissions.write; }
  };

  return {membersCard, backupsCard, load};
}
