import {askText, askConfirm} from './ask-dialog.js';
// 设置「协作与数据」页里的「资源库」卡片（ADR-12）：多库登记与切换。
//
// 切库不是热切换：storage / 备份 / 采集 / 下载记录全绑在 dataDir 上，
// 进程内换目录等于让十几个模块各自重连，漏一个就是两个库串数据。
// 账号与机器令牌例外 —— 它们住在库外面（ADR-14），切库后人和会话都还在。
// 所以这里只改注册表里的 activeId，然后重启服务进程 —— 重启后所有模块自然拿到新目录。
const LOCAL = {'X-SFX-Local': '1'};

const fmtBytes = value => {
  const bytes = Number(value) || 0;
  if (!bytes) return '空';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const ago = ms => {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
};

// 路径只留盘符 + 末两级，中间折叠成 …，完整路径放 title 悬停看。
const shortPath = value => {
  const p = String(value || '');
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 4) return p;
  return `${parts[0]}\\…\\${parts.slice(-2).join('\\')}`;
};

export function createStorePanel({toast, esc = value => String(value ?? ''), isVisitor = false, pickFolder = null} = {}) {
  const card = document.createElement('section');
  card.className = 'settings-card';
  card.id = 'stores-card';
  const STORE_TIP='多库并存，切换后需重启服务才生效；磁盘资产不会被移动或删除，登录账号各库共用。';
  card.innerHTML = `<div class="settings-section-title"><span>资源库</span><i class="tip" tabindex="0" role="note" data-tip="${STORE_TIP}"></i></div>
    <div id="store-list" class="store-list"><p class="compact-note">正在读取…</p></div>
    <div class="backup-actions" id="store-create-row">
      <input type="text" id="store-name" placeholder="新资源库名称" maxlength="40" aria-label="新资源库名称">
      <button type="button" class="secondary" id="store-create">新建</button>
      <button type="button" class="secondary" id="store-pick-assets" hidden>资产目录…</button>
    </div>
    <p class="compact-note" id="store-assets-note" hidden></p>
    <p class="compact-note" id="store-status" role="status" aria-live="polite"></p>
    <div class="backup-actions" id="store-restart-row" hidden>
      <button type="button" class="secondary" id="store-restart">重启服务并切换</button>
    </div>`;

  const q = selector => card.querySelector(selector);
  const say = text => { const node = q('#store-status'); if (node) node.textContent = text || ''; };
  let busy = false;
  let pendingRestart = false;
  let newAssetsDir = '';
  let state = {activeId: '', stores: []};

  const post = (url, body) => fetch(url, {
    method: 'POST', cache: 'no-store', headers: {...LOCAL, 'Content-Type': 'application/json'}, body: JSON.stringify(body || {}),
  });

  /** 资产目录改动的统一说法：旧文件不搬，别让用户以为已经挪过去了。 */
  const relocateNote = store => {
    if (!store) return '';
    if (store.unchanged) return '资产目录没有变。';
    const root = shortPath(store.archiveRoot || '');
    return store.leftBehind
      ? `已把资产目录改为 ${root}；旧目录 ${shortPath(store.leftBehind)} 里的文件没有搬动，需要的话自己在资源管理器里移动。`
      : `已把资产目录改为 ${root}。`;
  };

  function render() {
    const list = q('#store-list');
    if (!list) return;
    const canPick = !!pickFolder && !isVisitor;
    if (!state.stores.length) { list.innerHTML = '<p class="compact-note">没有可用的资源库。</p>'; return; }
    const rows = state.stores.map(store => {
      const badge = store.active ? '<span class="store-badge">使用中</span>'
        : store.selected ? '<span class="store-badge is-pending">待重启生效</span>'
        : !store.exists ? '<span class="store-badge is-missing">目录丢失</span>' : '';
      const actions = [
        !store.active ? `<button type="button" class="secondary store-act" data-act="select" data-id="${esc(store.id)}">切换</button>` : '',
        canPick ? `<button type="button" class="secondary store-act" data-act="relocate" data-id="${esc(store.id)}">资产目录</button>` : '',
        `<button type="button" class="secondary store-act" data-act="rename" data-id="${esc(store.id)}">改名</button>`,
        !store.active && !store.builtin ? `<button type="button" class="secondary store-act" data-act="remove" data-id="${esc(store.id)}">移除</button>` : '',
      ].filter(Boolean).join('');
      return `<div class="store-row${store.active ? ' is-active' : ''}">
        <div class="store-main">
          <div class="store-title"><strong>${esc(store.name)}</strong>${badge}</div>
          <div class="store-path"><span class="store-dir" title="库目录：${esc(store.dataDir)}">${esc(shortPath(store.dataDir))}</span>${store.archiveRoot?`<span class="store-dl-tag" title="资产目录（跟随库名）：${esc(store.archiveRoot)}">资产 ${esc(shortPath(store.archiveRoot))}</span>`:''}</div>
        </div>
        <div class="store-meta"><span>${fmtBytes(store.bytes)}</span><span>${ago(store.updatedAt)}</span></div>
        <div class="store-actions">${actions}</div>
      </div>`;
    }).join('');
    // 进程目录不在清单里（旧启动器指过去、或多实例并行）时全行都没有「使用中」，
    // 那种状态下点「切换」永远只显示待重启，得把真实目录写出来才看得懂。
    const liveDir = state.stores.find(store => store.active)?.dataDir || state.currentDir || '';
    list.innerHTML = rows + (state.stores.some(store => store.active) ? ''
      : `<p class="compact-note">当前进程用的目录是 ${esc(shortPath(liveDir))}，不在上面的清单里；选中哪个库都要重启服务才会切过去。</p>`);
  }

  async function load() {
    try {
      const response = await fetch('/api/library/stores', {cache: 'no-store', headers: LOCAL});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      state = {activeId: data.activeId, stores: data.stores || [], currentDir: data.currentDir || ''};
      render();
      const selected = state.stores.find(store => store.selected);
      const active = state.stores.find(store => store.active);
      // active 缺失（进程目录不在清单里）时也算「待重启」—— 否则选中的库永远切不过去。
      if (selected && selected.id !== active?.id) {
        pendingRestart = true;
        q('#store-restart-row').hidden = isVisitor;
        say(`已选「${selected.name}」，重启后生效`);
      } else {
        pendingRestart = false;
        q('#store-restart-row').hidden = true;
        say('');
      }
    } catch (error) {
      q('#store-list').innerHTML = `<p class="compact-note">读取失败：${esc(error.message)}</p>`;
    }
  }

  async function act(button) {
    if (busy) return;
    const id = button.dataset.id;
    const action = button.dataset.act;
    const store = state.stores.find(item => item.id === id);
    if (!store) return;
    if (action === 'remove') {
      if (!await askConfirm({title: '移除资源库', message: `从清单里移除「${store.name}」？\n\n磁盘上的 ${store.dataDir} 不会被删除，随时可以再登记回来。`, confirmText: '移除', danger: true})) return;
    }
    let payload = {action, id};
    if (action === 'relocate') {
      if (!pickFolder) { say('当前环境不能打开文件夹选择器，请在桌面版里改资产目录。'); return; }
      const folder = await pickFolder(store.archiveRoot || '');
      if (!folder) return;
      payload.assetsDir = folder;
    }
    if (action === 'rename') {
      const name = await askText({title: '重命名资源库', message: '新的资源库名称', value: store.name, maxLength: 60});
      if (!name || name === store.name) return;
      payload.name = name;
    }
    busy = true;
    button.classList.add('is-busy');
    try {
      const response = await post('/api/library/stores', payload);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      state = {activeId: data.activeId, stores: data.stores || state.stores, currentDir: state.currentDir || ''};
      render();
      const note = relocateNote(data.store);
      if (data.restartRequired) {
        pendingRestart = true;
        q('#store-restart-row').hidden = isVisitor;
        if (action === 'rename') {
          say((data.store || {}).keptOld
            ? `已改名，但目标目录里已有同名文件夹，资产目录保持原样。重启服务后生效。`
            : `已改名，资产目录也跟着改了。重启服务后生效。`);
        } else if (action === 'relocate') {
          say(`${note}重启服务后生效。`);
        } else {
          const selected = state.stores.find(item => item.id === data.activeId);
          say(`已改选「${selected?.name || ''}」，重启服务后生效。`);
        }
      } else if (action === 'create') {
        say(`已登记「${(data.store || {}).name || ''}」。点「切换」再重启即可进去。`);
        toast?.('资源库已登记');
      } else if (action === 'relocate') {
        say(note || '资产目录已更新。');
        toast?.('资产目录已更新');
      } else {
        say('已更新。');
      }
    } catch (error) {
      say(`操作失败：${error.message}`);
    } finally {
      busy = false;
      button.classList.remove('is-busy');
    }
  }

  async function create() {
    const input = q('#store-name');
    const name = (input?.value || '').trim();
    if (!name) { say('先给新资源库起个名字。'); input?.focus(); return; }
    if (busy) return;
    busy = true;
    q('#store-create').classList.add('is-busy');
    try {
      const response = await post('/api/library/stores', {action: 'create', name, assetsDir: newAssetsDir || undefined});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      state = {activeId: data.activeId, stores: data.stores || state.stores, currentDir: state.currentDir || ''};
      input.value = '';
      newAssetsDir = '';
      q('#store-assets-note').hidden = true;
      render();
      say(`已登记「${(data.store || {}).name || ''}」，目录：${(data.store || {}).dataDir || ''}。点「切换」再重启即可进去。`);
      toast?.('资源库已登记');
    } catch (error) {
      say(`新建失败：${error.message}`);
    } finally {
      busy = false;
      q('#store-create').classList.remove('is-busy');
    }
  }

  /** 重启：服务端会 spawn 启动器并退出，这里轮询到它重新应答再刷新页面。 */
  async function restart() {
    const button = q('#store-restart');
    if (busy) return;
    busy = true;
    button.classList.add('is-busy');
    say('正在重启服务…（旧进程退出后新进程会自动接上，别关页面）');
    try {
      const response = await post('/api/library/stores/restart');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw Error(data.error || `HTTP ${response.status}`);
      }
    } catch (error) {
      busy = false;
      button.classList.remove('is-busy');
      say(`重启失败：${error.message}。请用 Stop-Library.cmd 停止后重新启动。`);
      return;
    }
    // 服务会先断开几秒。探测到健康检查重新应答就刷新；15 秒还不行就提示手动重启。
    const deadline = Date.now() + 20_000;
    let down = false;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 600));
      try {
        const health = await fetch('/api/health', {cache: 'no-store', headers: LOCAL});
        if (health.ok) {
          if (down) { location.reload(); return; }
          // 还没断开：可能正在关，继续等。
          continue;
        }
      } catch {
        down = true;
      }
    }
    busy = false;
    button.classList.remove('is-busy');
    say('服务没有在 20 秒内恢复。请用 Stop-Library.cmd 停止后重新启动，启动后就是新库了。');
  }

  function setup() {
    q('#store-list')?.addEventListener('click', event => {
      const button = event.target.closest('.store-act');
      if (button) act(button);
    });
    q('#store-create')?.addEventListener('click', create);
    q('#store-name')?.addEventListener('keydown', event => { if (event.key === 'Enter') create(); });
    const pickButton = q('#store-pick-assets');
    if (pickButton) {
      pickButton.hidden = !pickFolder || isVisitor;
      pickButton.addEventListener('click', async () => {
        const folder = await pickFolder(newAssetsDir || '');
        if (!folder) return;
        newAssetsDir = folder;
        const note = q('#store-assets-note');
        note.hidden = false;
        note.textContent = `资产将落在这里：${folder}（填个名字点「新建」）`;
      });
    }
    q('#store-restart')?.addEventListener('click', restart);
    load();
  }

  return {card, setup, reload: load};
}
