// 资产库「导入文件夹」面板：把用户指定的本机目录登记成扫描根。
// 扫描只读认领（不复制文件），移除也只改配置，磁盘上的素材原样留着。
const ROOTS = '/api/library/import-roots';

async function post(url, payload) {
  const response = await fetch(url, {method: 'POST', cache: 'no-store', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload || {})});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
  return data;
}

const samePath = (a, b) => String(a || '').replace(/\\/g, '/').toLowerCase() === String(b || '').replace(/\\/g, '/').toLowerCase();

export function createLocalImport({$, esc, toast, visitor, onChanged, reload = () => globalThis.location?.reload()}) {
  let roots = [];
  let entries = [];
  let checking = null;
  let refreshNotice = null;
  const say = text => {const node = $('#local-import-status'); if (node) node.textContent = text || '';};

  /** 打开面板时顺手读一次扫描结果（走服务端缓存），好让每个目录显示认领到几个资产包。 */
  async function scanSnapshot() {
    try {
      const response = await fetch('/api/library/scan', {method: 'POST', cache: 'no-store', headers: {'Content-Type': 'application/json'}, body: '{}'});
      return response.ok ? await response.json() : {};
    } catch { return {}; }
  }

  async function describe(root, index, scan) {
    const node = $('#local-import-meta-' + index);
    if (!node) return;
    const packs = (scan.packages || []).filter(pkg => samePath(pkg.root, root)).length;
    try {
      const info = await post('/api/library/browse-folder', {folder: root, limit: 4000});
      node.textContent = `${(info.files || []).length} 个素材文件 · ${packs} 个资产包`;
    } catch { node.textContent = `${packs} 个资产包（目录暂时读不到）`; }
  }

  function render(scan, entries = []) {
    const box = $('#local-import-roots');
    if (!box) return;
    if (!roots.length) {
      box.innerHTML = '<p class="compact-note">还没有导入过文件夹。选一个装素材的目录，里面的资产包会自动出现在资产库里。</p>';
      return;
    }
    const state = new Map(entries.map(item => [item.path, item]));
    const offline = root => state.get(root)?.online === false;
    const reason = root => {
      const code = state.get(root)?.reason;
      return code === 'denied' ? '没有读取权限' : '磁盘未连接或目录已移动';
    };
    box.innerHTML = roots.map((root, index) => `<div class="li-root${offline(root) ? ' is-offline' : ''}"><span class="li-path" title="${esc(root)}">${esc(root)}</span><span class="li-meta" id="local-import-meta-${index}">${offline(root) ? esc(reason(root)) : '统计中…'}</span>${offline(root) ? `<button type="button" class="text-button" data-import-relink="${index}" title="选择素材搬家后的新位置，重新扫描">重新定位</button>` : ''}${offline(root) ? '' : `<button type="button" class="text-button" data-import-file="${index}">导入文件</button>`}<button type="button" class="text-button" data-import-check="${index}"${offline(root) ? ' disabled' : ''}>重复检查</button><button type="button" class="text-button" data-import-remove="${index}" aria-label="移除这个目录">移除</button></div>`).join('');
    // 离线根不去读目录：那只会再失败一次，还把「统计中…」闪一下。
    roots.forEach((root, index) => { if (!offline(root)) describe(root, index, scan); });
  }

  async function refresh() {
    try {
      const response = await fetch(ROOTS, {cache: 'no-store'});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      roots = Array.isArray(data.roots) ? data.roots : [];
      entries = Array.isArray(data.entries) ? data.entries : [];
      render(await scanSnapshot(), entries);
    } catch (error) { say(error.message); }
  }

  async function add(folder) {
    if (!folder) { say('先选一个文件夹，或粘贴完整路径'); return; }
    say('正在导入…');
    try {
      const data = await post(ROOTS, {action: 'add', folder});
      roots = Array.isArray(data.roots) ? data.roots : roots;
      say(data.added ? '已加入导入目录，正在重新扫描…' : '这个目录已经在列表里了');
      if (data.added) {
        toast?.(`已导入 ${folder}，正在扫描资产`);
        await onChanged?.();
      }
      await refresh();
    } catch (error) { say(`导入失败：${error.message}`); }
  }

  async function remove(index) {
    const folder = roots[index];
    if (!folder) return;
    try {
      const data = await post(ROOTS, {action: 'remove', folder});
      roots = Array.isArray(data.roots) ? data.roots : roots;
      say(data.removed ? '已移除目录，正在重新扫描…' : '这个目录已经不在列表里了');
      if (data.removed) await onChanged?.();
      await refresh();
    } catch (error) { say(`移除失败：${error.message}`); }
  }

  /**
   * 重新定位：素材搬到了新盘 / 新目录时，把旧根换成新位置。
   * 只改扫描根 + 重扫 —— 本地包是按「根 + 相对路径」实时读盘的，不需要改写任何资产。
   */
  async function relink(index) {
    const from = roots[index];
    if (!from) return;
    say('请选择素材的新位置…');
    try {
      const picked = await post('/api/library/pick-folder', {});
      if (!picked.folder) { say('已取消选择'); return; }
      if (samePath(picked.folder, from)) { say('还是原来的位置'); return; }
      const data = await post(ROOTS, {action: 'relink', from, to: picked.folder});
      roots = Array.isArray(data.roots) ? data.roots : roots;
      entries = Array.isArray(data.entries) ? data.entries : entries;
      say(`已重新定位到 ${picked.folder}，正在重扫…`);
      toast?.('目录已重新定位');
      await onChanged?.();
      await refresh();
    } catch (error) { say(`重新定位失败：${error.message}`); }
  }

  async function importFile(index) {
    if (checking || visitor) return;
    const folder = roots[index];
    if (!folder || entries.find(item => item.path === folder)?.online === false) return;
    const controller = new AbortController(); checking = controller;
    const box = $('#local-import-roots');
    const buttons = Array.from(box?.querySelectorAll('button') || []);
    const disabled = buttons.map(button => button.disabled);
    buttons.forEach(button => {button.disabled = true;});
    const panel = document.createElement('div'); panel.className = 'team-form';
    const file = document.createElement('select'); file.multiple = true; file.size = 8; file.setAttribute('aria-label', '选择导入文件（相对路径，可多选）');
    const mode = document.createElement('select'); mode.setAttribute('aria-label', '导入模式');
    const duplicate = document.createElement('select'); duplicate.setAttribute('aria-label', '重复文件处理');
    const addOptions = (select, rows) => rows.forEach(([value, text]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option);
    });
    addOptions(mode, [['linked', '链接原文件（默认，不复制）'], ['managed', '托管副本（复制入库，保留原件）']]);
    addOptions(duplicate, [['skip', '同内容重复：跳过（默认）'], ['keep-both', '同内容重复：保留两份']]);
    mode.value = 'linked'; duplicate.value = 'skip';
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'text-button'; confirm.textContent = '导入所选文件'; confirm.disabled = true;
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'text-button'; cancel.textContent = '取消选择';
    const note = document.createElement('p'); note.className = 'compact-note';
    note.textContent = '按住 Ctrl / Command 或 Shift 多选，逐件串行导入。同名异内容始终保留两份，绝不覆盖。链接依赖原件路径；托管复制保留原件。取消只停止下一件，已完成不会回滚。';
    [file, mode, duplicate, confirm, cancel, note].forEach(node => panel.appendChild(node)); box?.appendChild(panel);
    const close = () => {panel.remove(); buttons.forEach((button, i) => {button.disabled = disabled[i];}); if (checking === controller) checking = null;};
    let submitting = false, stopRequested = false;
    cancel.addEventListener('click', () => {
      if (submitting) {
        stopRequested = true; cancel.disabled = true;
        note.textContent = '已请求停止：当前提交仍在等待结果，不会中断或回滚；不再启动下一件。';
        return;
      }
      controller.abort(); close(); say('已取消文件选择，未提交导入。');
    });
    say('正在读取可选文件…');
    try {
      const response = await fetch('/api/library/browse-folder', {method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({folder,limit:4000}),signal:controller.signal});
      const data = await response.json();
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      if (controller.signal.aborted) return;
      const files = (Array.isArray(data.files) ? data.files : []).filter(row => typeof row?.rel === 'string' && row.rel);
      addOptions(file, files.map(row => [row.rel, row.rel]));
      file.value = files[0]?.rel || '';
      confirm.disabled = !files.length;
      say(files.length ? `请选择文件；已列出 ${files.length} 件。${data.truncated || data.scanned?.skipped > 0 ? '扫描已截断或有跳过，列表不完整。' : ''}` : '这个目录没有可导入的文件。');
      confirm.addEventListener('click', async () => {
        if (submitting || controller.signal.aborted) return;
        const selected = Array.from(file.selectedOptions || []).map(option => option.value);
        const queue = [...new Set(file.selectedOptions ? selected : [file.value])].filter(rel => files.some(row => row.rel === rel));
        if (!queue.length) return;
        const selectedMode = mode.value, selectedDuplicate = duplicate.value;
        submitting = true;
        [file, mode, duplicate, confirm].forEach(node => {node.disabled = true;});
        cancel.textContent = '停止后续导入';
        const stats = {total:queue.length, completed:0, imported:0, skipped:0, failed:0};
        const failures = []; let lastResult, lastMessage = '';
        const report = () => `${stopRequested ? '已停止后续导入' : stats.completed === stats.total ? '批量导入完成' : '正在导入'}：完成 ${stats.completed}/${stats.total}；imported（入库）${stats.imported}，skipped（跳过）${stats.skipped}，failed（失败/待核实）${stats.failed}。已完成保留，不会回滚。${lastMessage ? `\n${lastMessage}` : ''}${failures.length ? `\n失败明细（仅前 20 项）：\n${failures.join('\n')}\n网络或响应异常可能已入库，请先刷新核实，尤其「保留两份」；不会自动重试。` : ''}`;
        say(report());
        for (const rel of queue) {
          if (stopRequested) break;
          try {
            const result = await fetch('/api/library/import-file', {method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({folder,rel,mode:selectedMode,duplicate:selectedDuplicate,nameConflict:'keep-both'})});
            const data = await result.json();
            if (!result.ok || data.ok !== true) throw Error(data.error || `HTTP ${result.status}`);
            if (data.status !== 'imported' && data.status !== 'skipped') throw Error('导入状态未知，请刷新后核实。');
            stats[data.status]++; lastResult = data;
            lastMessage = data.status === 'imported' ? `已${selectedMode === 'managed' ? '复制入库（原件保留）' : '链接入库（未复制）'}：${rel}`
              : data.reason === 'same-linked-path' ? '已跳过：这个原文件路径已链接入库，不重复创建。' : '已跳过同内容重复文件；需要另一份时请明确选择「保留两份」。';
          } catch (error) {
            stats.failed++;
            if (failures.length < 20) failures.push(`${rel}：${error.message}`);
          }
          stats.completed++; say(report());
        }
        close();
        refreshNotice?.remove();
        refreshNotice = document.createElement('div'); refreshNotice.className = 'team-form';
        const hint = document.createElement('span'); hint.className = 'compact-note';
        hint.textContent = `${stats.imported || stats.skipped ? '已确认完成的导入结果已保存。' : '尚无已确认的成功结果。'}刷新资产库后显示新资产；请先保存其他未提交的编辑。失败项请先刷新核实，勿直接重复提交。`;
        const refreshButton = document.createElement('button'); refreshButton.type = 'button'; refreshButton.className = 'text-button'; refreshButton.textContent = '刷新资产库';
        refreshButton.addEventListener('click', () => reload());
        refreshNotice.appendChild(hint); refreshNotice.appendChild(refreshButton); box?.appendChild(refreshNotice);
        if (stats.imported || stats.skipped) {
          try { await onChanged?.({...lastResult, stats:{...stats}, cancelled:stopRequested}); }
          catch (error) { say(`${report()}\n资产库刷新失败：${error.message}。请刷新页面核实，勿重复提交。`); return; }
        }
        say(report()); toast?.(`完成 ${stats.completed}/${stats.total}；入库 ${stats.imported}，跳过 ${stats.skipped}，失败/待核实 ${stats.failed}`);
      });
    } catch (error) {
      close();
      if (!controller.signal.aborted) say(`读取文件失败：${error.message}`);
    }
  }

  async function check(index) {
    if (checking) return;
    const folder = roots[index];
    if (!folder) return;
    const controller = new AbortController(); checking = controller;
    const box = $('#local-import-roots');
    const buttons = Array.from(box?.querySelectorAll('button') || []);
    const disabled = buttons.map(button => button.disabled);
    buttons.forEach(button => {button.disabled = true;});
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'text-button'; cancel.textContent = '取消重复检查';
    cancel.addEventListener('click', () => controller.abort()); box?.appendChild(cancel);
    say('正在只读计算 SHA256，可取消；不会复制或删除素材…');
    try {
      const response = await fetch('/api/library/import-preflight', {method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({folder}),signal:controller.signal});
      const data = await response.json();
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      const issues = (data.results || []).filter(row => row.status !== 'new');
      const labels = {'exact-duplicate':'同内容重复','same-name-different-content':'同名异内容','unreadable':'不可读取','changed-during-read':'读取期间发生变化'};
      say(`只读 SHA256 检查：${data.stats?.total || 0} 个文件，同内容重复 ${data.stats?.['exact-duplicate'] || 0}，同名异内容 ${data.stats?.['same-name-different-content'] || 0}。仅比较本次目录批内，未与全库比较；不自动删除、复制或入库。扫描范围最多 4000 个文件、8 层目录；扫描器跳过项 ${data.scanned?.skipped || 0} 个（含目录/非普通文件等）。${data.truncated || data.scanned?.skipped > 0 ? '扫描已截断或有跳过，结果不完整。' : ''}\n${issues.slice(0,50).map(row => `${labels[row.status] || row.status}：${row.path}${row.reason ? `（${row.reason}）` : ''}`).join('\n')}${issues.length > 50 ? '\n仅显示前 50 个问题。' : ''}`);
    } catch (error) {say(error.name === 'AbortError' ? '已取消重复检查，素材未作修改。' : `检查失败：${error.message}`);}
    finally {cancel.remove(); buttons.forEach((button,i) => {button.disabled = disabled[i];});checking = null;}
  }

  function setup() {
    if (visitor) $('#local-import')?.setAttribute('hidden', '');
    $('#local-import')?.addEventListener('click', () => {
      say('');
      refresh();
      const dialog = $('#local-import-dialog');
      if (dialog && !dialog.open) dialog.showModal();
    });
    $('#local-import-pick')?.addEventListener('click', async () => {
      say('正在打开文件夹选择器…');
      try {
        const data = await post('/api/library/pick-folder', {});
        if (data.folder) await add(data.folder);
        else say('已取消选择');
      } catch (error) { say(`打不开文件夹选择器：${error.message}。可以手动粘贴完整路径。`); }
    });
    $('#local-import-add')?.addEventListener('click', () => {
      const input = $('#local-import-path');
      const value = input?.value.trim();
      if (input) input.value = '';
      add(value);
    });
    $('#local-import-path')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); $('#local-import-add')?.click(); }
    });
    $('#local-import-roots')?.addEventListener('click', event => {
      const importButton = event.target.closest('[data-import-file]');
      if (importButton) return importFile(Number(importButton.dataset.importFile));
      const checkButton = event.target.closest('[data-import-check]');
      if (checkButton) return check(Number(checkButton.dataset.importCheck));
      if (checking) return;
      const relinkButton = event.target.closest('[data-import-relink]');
      if (relinkButton) { relink(Number(relinkButton.dataset.importRelink)); return; }
      const button = event.target.closest('[data-import-remove]');
      if (button) remove(Number(button.dataset.importRemove));
    });
  }

  return {setup, refresh};
}
