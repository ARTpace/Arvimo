// 已有资产卡片提供 model；仅更新 locator，不重写模型库或复制/覆盖文件。
let active = false;

export async function openRelinkFile(options) {
  try { await showRelinkFile(options); }
  catch (error) { active = false; options?.toast?.(`无法打开重新定位：${error.message}`); }
}

async function showRelinkFile({model, toast, onChanged, reload = () => globalThis.location?.reload()}) {
  if (active || !model?.uid || model.storageMode !== 'linked') return;
  active = true;
  const uid = model.uid;
  const dialog = document.createElement('dialog'); dialog.className = 'settings-dialog';
  dialog.setAttribute('aria-label', '重新定位链接文件');
  const make = (tag, text, className) => {const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;};
  const heading = make('div', `重新定位链接文件：${model.name || uid}`, 'dialog-header');
  const body = make('div', '', 'dialog-body');
  const form = make('div', '', 'team-form');
  const folder = make('select'); folder.setAttribute('aria-label', '选择已登记的在线目录');
  const file = make('select'); file.setAttribute('aria-label', '选择同内容文件（相对路径）');
  const apply = make('button', '确认重新定位', 'text-button'); apply.type = 'button'; apply.disabled = true;
  const close = make('button', '取消', 'text-button'); close.type = 'button';
  const refresh = make('button', '刷新资产库', 'text-button'); refresh.type = 'button'; refresh.hidden = true;
  const note = make('p', '仅重新定位同内容原件，保留资产标识、标注与合集；不复制、不覆盖。', 'compact-note');
  const status = make('p', '正在读取已登记目录…', 'compact-note'); status.setAttribute('role', 'status');
  [folder,file,apply,close,refresh].forEach(node => form.appendChild(node));
  [form,note,status].forEach(node => body.appendChild(node)); dialog.appendChild(heading); dialog.appendChild(body);
  let submitting = false, closed = false, files = [];
  const controller = new AbortController();
  const finish = () => {if (submitting) return; closed = true; controller.abort(); dialog.close(); dialog.remove(); active = false;};
  close.addEventListener('click', finish);
  dialog.addEventListener('cancel', event => {event.preventDefault(); finish();});
  refresh.addEventListener('click', () => reload());
  document.body.appendChild(dialog); dialog.showModal();
  const option = (select, value, text) => {const node = make('option', text); node.value = value; select.appendChild(node);};
  const request = async (url, payload, signal) => {
    const response = await fetch(url, {method:payload ? 'POST' : 'GET',cache:'no-store',headers:{'Content-Type':'application/json','x-sfx-local':'1'},...(payload ? {body:JSON.stringify(payload)} : {}),...(signal ? {signal} : {})});
    const data = await response.json();
    if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
    return data;
  };
  const loadFiles = async () => {
    if (closed || submitting) return;
    folder.disabled = true; file.disabled = true; apply.disabled = true; files = []; file.replaceChildren();
    status.textContent = '正在读取目录中的可选文件…';
    try {
      const data = await request('/api/library/browse-folder', {folder:folder.value,limit:4000}, controller.signal);
      if (closed) return;
      files = (Array.isArray(data.files) ? data.files : []).filter(row => typeof row?.rel === 'string' && row.rel);
      files.forEach(row => option(file,row.rel,row.rel)); file.value = files[0]?.rel || '';
      apply.disabled = !files.length;
      status.textContent = files.length ? `请选择同内容文件，服务端会校验原 SHA256 和字节数。${data.truncated || data.scanned?.skipped > 0 ? '扫描已截断或有跳过，列表不完整（最多4000文件、8层）。' : ''}` : '这个目录没有可选文件。';
    } catch (error) {if (!closed) status.textContent = `读取文件失败：${error.message}`;}
    finally {if (!closed) {folder.disabled = false; file.disabled = false;}}
  };
  folder.addEventListener('change', loadFiles);
  apply.addEventListener('click', async () => {
    if (closed || submitting || apply.disabled || !files.some(row => row.rel === file.value)) return;
    submitting = true; [folder,file,apply,close].forEach(node => {node.disabled = true;});
    status.textContent = '正在提交重新定位；提交后不能取消，请等待结果。';
    try {
      const data = await request('/api/library/relink-file', {uid,folder:folder.value,rel:file.value});
      if (data.ok !== true || data.status !== 'relinked') throw Error(data.error || '响应状态未知');
      status.textContent = '重新定位已保存，原资产标识、标注与合集保留。请先保存其他编辑，再刷新资产库。';
      refresh.hidden = false;
      try {await onChanged?.(data);} catch (error) {status.textContent += ` 刷新回调失败：${error.message}，请手动刷新核实，勿重复提交。`;}
      toast?.('链接文件已重新定位');
    } catch (error) {
      status.textContent = `重新定位失败或结果待核实：${error.message}。内容不匹配或目标已被引用时不可覆盖；网络或响应异常可能已保存，请先刷新核实，勿直接重试。`;
      refresh.hidden = false;
    } finally {submitting = false; close.disabled = false; close.textContent = '关闭';}
  });
  try {
    const data = await request('/api/library/import-roots', null, controller.signal);
    if (closed) return;
    const online = new Set((data.entries || []).filter(row => row.online === true).map(row => row.path));
    const roots = (data.roots || []).filter(root => typeof root === 'string' && online.has(root));
    roots.forEach(root => option(folder,root,root)); folder.value = roots[0] || '';
    if (roots.length) await loadFiles();
    else {folder.disabled = true; file.disabled = true; status.textContent = '没有已登记的在线目录，请先在「导入文件夹」中登记目标目录。';}
  } catch (error) {if (!closed) status.textContent = `无法读取本机目录：${error.message}。仅主机可重新定位链接文件。`;}
}
