// 设置 → 协作与数据 → 云同步（WebDAV）。
//
// 交互上有意做成「填完先测、测通再存」：WebDAV 的失败原因很难从一次同步的报错里看出来
// （401 是密码错、404 是目录没建、405 是服务不支持某方法），所以给一个独立的「测试连接」，
// 让用户在存凭据之前就知道能不能通。
//
// 密码输入框永远是空的：服务端只回「存过没有」，不回密码本身。留空保存 = 沿用旧密码，
// 这样用户改个自动同步间隔不会被要求重新输一遍应用密码。
const jsonHeaders = {'Content-Type': 'application/json', 'X-SFX-Local': '1'};

const timeText = value => {
  const time = Number(value);
  if (!time) return '从未同步';
  const diff = Date.now() - time;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
  return new Date(time).toLocaleString();
};

const ACTION_TEXT = {
  uploaded: '已上传本机改动',
  downloaded: '已拉取远端改动',
  merged: '已合并远端改动并上传',
  noop: '两端一致，未做改动',
};

export function createCloudSyncCard({toast = () => {}} = {}) {
  const card = document.createElement('section');
  card.className = 'settings-card';
  card.innerHTML = `
    <div class="settings-section-title"><span>云同步</span><small>把整库快照同步到你自己的 WebDAV</small></div>
    <p class="compact-note">支持坚果云、Nextcloud、群晖、Alist 等。同步的是资产库快照（资产、标签、评分、备注、合集），不含磁盘上的原始文件与缩略图缓存。</p>
    <div class="settings-grid">
      <label class="field"><span>服务器地址</span><input type="url" data-sync-url placeholder="https://dav.example.com/remote.php/dav/files/me" spellcheck="false"></label>
      <label class="field"><span>账号</span><input type="text" data-sync-user placeholder="邮箱或用户名" spellcheck="false"></label>
      <label class="field"><span>密码 / 应用密码</span><input type="password" data-sync-password placeholder="留空表示不修改" spellcheck="false"></label>
      <label class="field"><span>远端目录</span><input type="text" data-sync-dir placeholder="AssetVault" spellcheck="false"></label>
    </div>
    <div class="settings-grid compact">
      <label class="field"><span>自动同步</span><select data-sync-auto><option value="1">开启</option><option value="0">关闭</option></select></label>
      <label class="field"><span>间隔</span><select data-sync-interval><option value="1">每 1 分钟</option><option value="5">每 5 分钟</option><option value="10">每 10 分钟</option><option value="30">每 30 分钟</option><option value="60">每 1 小时</option></select></label>
    </div>
    <div class="settings-inline-actions">
      <button class="secondary" type="button" data-sync-test>测试连接</button>
      <button class="primary" type="button" data-sync-run>立即同步</button>
      <button class="text-button" type="button" data-sync-save>只保存配置</button>
      <span data-sync-status>读取中…</span>
    </div>`;

  const pick = selector => card.querySelector(selector);
  const urlInput = pick('[data-sync-url]');
  const userInput = pick('[data-sync-user]');
  const passwordInput = pick('[data-sync-password]');
  const dirInput = pick('[data-sync-dir]');
  const autoSelect = pick('[data-sync-auto]');
  const intervalSelect = pick('[data-sync-interval]');
  const statusLabel = pick('[data-sync-status]');
  let busy = false;

  function fields() {
    return {
      url: urlInput.value.trim(),
      username: userInput.value.trim(),
      password: passwordInput.value,
      remoteDir: dirInput.value.trim(),
      auto: autoSelect.value === '1',
      intervalMin: Number(intervalSelect.value) || 10,
    };
  }

  function paint(state) {
    if (!state) return;
    urlInput.value = state.url || '';
    userInput.value = state.username || '';
    dirInput.value = state.remoteDir || 'AssetVault';
    autoSelect.value = state.auto === false ? '0' : '1';
    const known = ['1', '5', '10', '30', '60'];
    intervalSelect.value = known.includes(String(state.intervalMin)) ? String(state.intervalMin) : '10';
    if (!known.includes(String(state.intervalMin))) {
      const option = document.createElement('option');
      option.value = String(state.intervalMin);
      option.textContent = `每 ${state.intervalMin} 分钟`;
      intervalSelect.append(option);
      intervalSelect.value = option.value;
    }
    passwordInput.placeholder = state.hasPassword ? '已保存，留空表示不修改' : '应用密码';
    if (!state.configured) {
      statusLabel.textContent = '未配置';
      return;
    }
    const last = state.lastResult?.action ? ACTION_TEXT[state.lastResult.action] || state.lastResult.action : '';
    statusLabel.textContent = state.lastError
      ? `上次失败：${state.lastError}`
      : `${timeText(state.lastAt)}${last ? ` · ${last}` : ''}`;
  }

  async function call(payload) {
    const response = await fetch('/api/library/sync', {method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload)});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function load() {
    try {
      const response = await fetch('/api/library/sync', {cache: 'no-store'});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      paint(data);
    } catch (error) {
      statusLabel.textContent = `读取失败：${error.message}`;
    }
  }

  async function withBusy(label, task) {
    if (busy) return;
    busy = true;
    const previous = statusLabel.textContent;
    statusLabel.textContent = label;
    for (const button of card.querySelectorAll('button')) button.disabled = true;
    try {
      await task();
    } catch (error) {
      statusLabel.textContent = `${label.replace(/…$/, '')}失败：${error.message}`;
      toast(`${label.replace(/…$/, '')}失败：${error.message}`);
      if (previous) setTimeout(() => { if (!busy) statusLabel.textContent = previous; }, 6000);
    } finally {
      busy = false;
      for (const button of card.querySelectorAll('button')) button.disabled = false;
    }
  }

  pick('[data-sync-test]').addEventListener('click', () => withBusy('正在连接…', async () => {
    const result = await call({action: 'test', ...fields()});
    statusLabel.textContent = `连接成功 · ${result.base}`;
    toast('WebDAV 连接成功');
  }));

  pick('[data-sync-save]').addEventListener('click', () => withBusy('正在保存…', async () => {
    paint(await call({action: 'save', ...fields()}));
    toast('云同步配置已保存');
  }));

  pick('[data-sync-run]').addEventListener('click', () => withBusy('正在同步…', async () => {
    // 先存再跑：run 从磁盘读配置，用户刚改的地址不先落盘就等于没改。
    paint(await call({action: 'save', ...fields()}));
    const result = await call({action: 'run'});
    const text = ACTION_TEXT[result.action] || result.action;
    statusLabel.textContent = `${timeText(Date.now())} · ${text}`;
    toast(`云同步完成：${text}`);
    await load();
  }));

  load();
  return {card, refresh: load};
}
