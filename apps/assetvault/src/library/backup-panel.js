// 设置「协作与数据」页里的「导出与迁移」卡片：整库导出 / 快照导入。
//
// 分工：自动备份、备份列表与恢复在 team-settings.js 的「自动备份」卡片里，这里**不重复**；
// 这块只管「把库搬走」——换机、合并工作室库、事故后重建。语义全在 server/library-portable.mjs：
// 导出是 DB 权威的一份可移植 JSON；导入走 asset:* 定点 op，新资产吃快照标注，已有资产保留本机标注。
const LOCAL = {'X-SFX-Local': '1'};
import {askConfirm} from './ask-dialog.js';

const fmtBytes = value => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

function stamp() {
  const date = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function createBackupPanel({toast, isVisitor = false} = {}) {
  const card = document.createElement('section');
  card.className = 'settings-card';
  card.id = 'migrate-card';
  card.innerHTML = `<div class="settings-section-title"><span>导出与迁移</span><small>换机、合并工作室库</small></div>
    <div class="backup-actions">
      <button type="button" class="secondary" id="migrate-export">导出整库</button>
      <button type="button" class="secondary" id="migrate-import">导入快照</button>
      <select id="migrate-mode" aria-label="导入方式"><option value="merge">合并到现有库</option><option value="replace">替换整库</option></select>
      <input type="file" id="migrate-file" accept="application/json,.json" hidden>
    </div>
    <p class="compact-note" id="migrate-status" role="status" aria-live="polite">快照只含资产索引、回收站、合集与评分备注收藏，<b>不含素材文件本体</b>。换机请一并复制素材目录，导入后用「重连文件」修复路径；合并导入时已存在的资产保留本机标注。</p>
    <div class="backup-actions" id="migrate-eagle-row">
      <button type="button" class="secondary" id="migrate-eagle">导入 Eagle / Billfish 库</button>
    </div>
    <p class="compact-note" id="eagle-status" role="status" aria-live="polite">从 Eagle 或 Billfish 搬整库：原图复制进 Arvimo · 艺团，标签、星级、备注和文件夹跟着过来。</p>`;

  const q = selector => card.querySelector(selector);
  const say = text => { const node = q('#migrate-status'); if (node) node.textContent = text || ''; };
  const sayEagle = text => { const node = q('#eagle-status'); if (node) node.textContent = text || ''; };
  let busy = false;

  /** Eagle / Billfish：选目录 → 探测数量 → 确认 → 整库复制入库。 */
  async function importEagle(button) {
    if (busy) return;
    const post = (url, body) => fetch(url, {
      method: 'POST', cache: 'no-store', headers: {...LOCAL, 'Content-Type': 'application/json'}, body: JSON.stringify(body || {}),
    });
    busy = true;
    button.classList.add('is-busy');
    try {
      sayEagle('请选择 Eagle 或 Billfish 资源库目录…');
      const picked = await post('/api/library/pick-folder').then(r => r.json()).catch(() => ({}));
      const folder = picked?.folder;
      if (!folder) { sayEagle('没选目录，已取消。'); return; }
      sayEagle('正在探测资源库…');
      const probeResponse = await post('/api/library/import/eagle/probe', {folder});
      const probe = await probeResponse.json().catch(() => ({}));
      if (!probeResponse.ok) throw Error(probe.error || `HTTP ${probeResponse.status}`);
      if (!probe.items) { sayEagle('这个库里没有条目。'); return; }
      const sample = (probe.samples || []).map(item => item.name).filter(Boolean).slice(0, 3).join('、');
      const ok = await askConfirm({title: '导入 Eagle 库', message: `发现 Eagle 兼容库「${probe.name}」\n\n${probe.items} 个项目 · ${probe.folders} 个文件夹${sample ? `\n例如：${sample}` : ''}\n\n原图会复制到 Arvimo · 艺团 的 imports 目录，标签 / 星级 / 备注 / 文件夹一并导入。继续？`, confirmText: '导入'});
      if (!ok) { sayEagle('已取消。'); return; }
      sayEagle(`正在复制并入库，共 ${probe.items} 项…（大库要几分钟，别关页面）`);
      const response = await post('/api/library/import/eagle', {folder});
      const report = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(report.error || `HTTP ${response.status}`);
      sayEagle(`导入完成：新增 ${report.added} 个资产、${report.collections} 个合集${report.skipped ? `、跳过 ${report.skipped}` : ''}。正在重载…`);
      toast?.(`已导入 ${report.added} 个资产`);
      setTimeout(() => location.reload(), 1500);
    } catch (error) {
      sayEagle(`导入失败：${error.message}`);
    } finally {
      busy = false;
      button.classList.remove('is-busy');
    }
  }

  async function exportAll(button) {
    if (busy) return;
    busy = true;
    button.classList.add('is-busy');
    say('正在打包整库快照…');
    try {
      const response = await fetch('/api/library/export', {cache: 'no-store', headers: LOCAL});
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw Error(data.error || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `assetvault-${stamp()}.json`;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      say(`已导出 ${fmtBytes(blob.size)} 的索引快照（不含素材文件）。换机时请一并复制素材目录，导入后按需「重连文件」。`);
      toast?.('整库快照已下载');
    } catch (error) {
      say(`导出失败：${error.message}`);
    } finally {
      busy = false;
      button.classList.remove('is-busy');
    }
  }

  async function importFile(file) {
    if (!file) return;
    const mode = q('#migrate-mode')?.value === 'replace' ? 'replace' : 'merge';
    if (mode === 'replace' && !await askConfirm({title: '替换整库', message: '「替换整库」会先清空当前资产目录，只保留快照里的内容。\n\n系统会先自动备份一份现状，但请确认这是你要的结果。继续？', confirmText: '替换', danger: true})) return;
    say(`正在读取 ${file.name}…`);
    let snapshot;
    try {
      snapshot = JSON.parse(await file.text());
    } catch {
      say('这个文件不是有效的 JSON');
      return;
    }
    say(mode === 'replace' ? '正在替换整库…（大库需要一点时间）' : '正在合并导入…（大库需要一点时间）');
    try {
      const response = await fetch('/api/library/import', {
        method: 'POST',
        cache: 'no-store',
        headers: {...LOCAL, 'Content-Type': 'application/json'},
        body: JSON.stringify({snapshot, mode, confirm: mode === 'replace'}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
      say(`导入完成：新增 ${data.added}、回收站 ${data.trashed}、合集 ${data.collections}${data.removed ? `、清理 ${data.removed}` : ''}。正在重载…`);
      toast?.(`导入完成，新增 ${data.added} 个资产`);
      setTimeout(() => location.reload(), 1200);
    } catch (error) {
      say(`导入失败：${error.message}`);
    }
  }

  function setup() {
    if (isVisitor) return;
    q('#migrate-export')?.addEventListener('click', event => exportAll(event.currentTarget));
    q('#migrate-import')?.addEventListener('click', () => q('#migrate-file')?.click());
    q('#migrate-eagle')?.addEventListener('click', event => importEagle(event.currentTarget));
    q('#migrate-file')?.addEventListener('change', event => {
      const file = event.target.files?.[0] || null;
      event.target.value = '';
      importFile(file);
    });
  }

  return {card, setup};
}
