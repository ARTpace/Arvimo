import {showActionCard} from './action-card.js';
// 智能收集面板：规则 CRUD / 试运行 / 立即收集 / 运行记录 / 待合并队列合并。
// 所有写操作经 board-api；合并必须经 mergeModels → persistNow → confirmSave → ack。
// 保存失败保留服务端 pending，不提前确认。
import {boardCollectHtml, hourOptions, ruleCardHtml, ruleDetailHtml, previewHtml} from './board-collect-template.js';

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const tokens = value => text(value).split(/[,，;；\s]+/).map(item => item.trim()).filter(Boolean).slice(0, 64);

export function createBoardCollect({
  esc, icon, toast, api, store, state,
  mergeModels, persistNow, confirmSave = async()=>{}, renderGrid = () => {},
  document: doc = globalThis.document,
} = {}) {
  if (!api || !store || !state || !mergeModels || !persistNow) throw Error('智能收集面板缺少依赖');
  const dialog = doc.createElement('dialog');
  dialog.className = 'bd-dialog bd-collect';
  dialog.setAttribute('aria-label', '智能收集画板');
  dialog.innerHTML = boardCollectHtml({icon, esc});
  doc.body.appendChild(dialog);

  const $ = selector => dialog.querySelector(selector);
  const rulesBox = $('.bd-rules');
  const preview = $('.bd-preview');
  const alertBox = $('.bd-alert');
  let platforms = [];
  let rules = [];
  let runs = [];
  let editingId = '';
  let ready = false;
  let merging = null;
  let pendingDelete = '';

  $('.bd-hour').innerHTML = hourOptions();
  $('.bd-hour').value = '9';

  const warn = message => {
    alertBox.hidden = !message;
    alertBox.querySelector('span').textContent = message || '';
  };

  function formRule() {
    const chosen = [...$('.bd-platforms').querySelectorAll('.on')].map(node => node.dataset.id);
    return {
      ...(rules.find(rule=>rule.id===editingId)||{}),
      ...(editingId ? {id: editingId} : {}),
      boardId: $('.bd-board').value,
      boardName: $('.bd-board').selectedOptions?.[0]?.textContent || '',
      name: $('.bd-query').value.trim().slice(0, 60) || '未命名收集规则',
      platforms: chosen,
      query: $('.bd-query').value.trim(),
      scope: $('.bd-scope').value,
      queries: $('.bd-queries').value.split(/[;；\n]/).map(q=>q.trim()).filter(Boolean),
      maxCalls: Number($('.bd-budget').value),
      limit: Number($('.bd-limit').value) || 20,
      frequency: $('.bd-seg .on')?.dataset.value || 'manual',
      hour: Number($('.bd-hour').value) || 9,
      enabled: $('.bd-enabled').checked,
      filters: {
        formats: tokens($('.bd-formats').value),
        tags: tokens($('.bd-tags').value),
        excludeTags: tokens($('.bd-exclude').value),
        kinds: rules.find(rule=>rule.id===editingId)?.filters?.kinds||[],
      },
    };
  }

  function fillForm(rule) {
    editingId = rule?.id || '';
    $('.bd-board').value = rule?.boardId || store.activeId || '';
    $('.bd-query').value = rule?.query || '';
    $('.bd-scope').value=rule?.scope||'platform';
    $('.bd-queries').value=(rule?.queries||[]).join('; ');
    $('.bd-budget').value=String(rule?.maxCalls||12);
    $('.bd-scope').onchange();
    $('.bd-limit').value = rule?.limit || 20;
    $('.bd-limit-value').textContent = $('.bd-limit').value;
    $('.bd-hour').value = String(rule?.hour ?? 9);
    $('.bd-enabled').checked = rule?.enabled !== false;
    $('.bd-formats').value = (rule?.filters?.formats || []).join(', ');
    $('.bd-tags').value = (rule?.filters?.tags || []).join(', ');
    $('.bd-exclude').value = (rule?.filters?.excludeTags || []).join(', ');
    const chosen = new Set(rule?.platforms || []);
    $('.bd-platforms').querySelectorAll('.bd-platform').forEach(node => node.classList.toggle('on', chosen.has(node.dataset.id)));
    const frequency = rule?.frequency || 'manual';
    $('.bd-seg').querySelectorAll('button').forEach(node => node.classList.toggle('on', node.dataset.value === frequency));
    $('.bd-save span').textContent = editingId ? '更新规则' : '保存规则';
  }

  function renderPlatforms() {
    $('.bd-platforms').innerHTML = platforms.map(item => `<button type="button" class="bd-platform${item.searchable === false ? ' off' : ''}"
      data-id="${esc(item.id)}" title="${esc(item.hint || item.label)}${item.searchable === false ? ' · 不支持关键词搜索' : ''}"
      aria-label="${esc(item.label)}">${icon(item.kind === 'picture' ? 'image' : 'cube')}<span>${esc(item.label)}</span></button>`).join('');
    $('.bd-platform-note').textContent = `可搜索 ${platforms.filter(item => item.searchable !== false).length} 站`;
  }

  function renderBoards() {
    const current = $('.bd-board').value;
    // 智能画板也能当目标：规则命中的资产 + 采集进来的资产会并成一个画板（服务端 resolve 里求并集）。
    // ⚡ 只是提示，不改变可选性 —— 否则「采到智能画板」这条需求就没有入口。
    const rows = store.flat();
    $('.bd-board').innerHTML = rows.length
      ? rows.map(row => `<option value="${esc(row.id)}">${esc('　'.repeat(row.depth) + (row.smart ? '⚡ ' : '') + row.name)}</option>`).join('')
      : '<option value="">（还没有画板）</option>';
    if (current) $('.bd-board').value = current;
    else if (store.activeId) $('.bd-board').value = store.activeId;
  }

  function renderRules() {
    rulesBox.innerHTML = rules.length
      ? rules.map(rule => ruleCardHtml({rule, icon, esc})).join('')
      : `<div class="bd-empty">${icon('zap')}<span>还没有收集规则，填好上面的表单点保存</span></div>`;
    renderDetail();
  }

  function renderDetail(ruleId = '') {
    // 不用属性选择器拼字符串：规则 id 可能带特殊字符，且测试环境没有 CSS.escape。
    const target = ruleId ? [...rulesBox.querySelectorAll('.bd-rule')].find(node => node.dataset.id === ruleId) : null;
    if (!target) return;
    const detail = target.querySelector('.bd-rule-detail');
    detail.hidden = !detail.hidden;
    if (!detail.hidden) detail.innerHTML = ruleDetailHtml({runs: runs.filter(run => run.ruleId === ruleId), icon, esc});
  }

  async function load({silent = false} = {}) {
    try {
      const [data, status, boards] = await Promise.all([
        api.rules(), api.collectStatus().catch(() => ({})), store.refresh().catch(() => store.list()),
      ]);
      rules = data.rules || [];
      runs = data.runs || [];
      platforms = data.platforms?.length ? data.platforms : (status.platforms || []);
      renderPlatforms();
      renderBoards();
      renderRules();
      $('.bd-engine').textContent = status.scheduler?.running ? '自动巡检已开启' : '';
      updatePending(status.pending?.count ?? data.pending ?? 0);
      ready = true;
      if (!silent) warn('');
    } catch (error) {
      warn(error?.status === 404 ? '请重启服务到 3.15.0：当前进程没有 /api/collect/*' : (error?.message || '采集服务不可用'));
    }
  }

  function updatePending(count) {
    $('.bd-pending').textContent = count > 0 ? `${count} 条待合并` : '暂无待合并';
    $('.bd-pending').dataset.count = String(count || 0);
  }

  /** 幂等：mergeModels 按 uid 覆盖，ack 失败可重放；必须保存成功后再 ack。 */
  async function syncPending({quiet = false,strict = false} = {}) {
    if(!merging)merging=(async()=>{
      const data = await api.pending();
      const models = Array.isArray(data.models) ? data.models : [];
      updatePending(models.length);
      if (!models.length) return 0;
      state.models = mergeModels(state.models, models);
      if(persistNow()===false)throw Error('资产记录未保存，已保留待合并结果');
      await confirmSave();
      await api.ack(models.map(model => model.uid));
      renderGrid();
      updatePending(0);
      if (!quiet) toast(`已合并 ${models.length} 个采集资产`);
      doc.dispatchEvent?.(new CustomEvent('assetvault:collect-changed', {detail: {merged: models.length}}));
      return models.length;
    })().finally(()=>{merging=null;});
    try {return await merging;
    } catch (error) {
      if (!quiet) toast(error?.message || '合并采集结果失败');
      if(strict)throw error;
      return 0;
    }
  }

  async function saveRule() {
    const rule = formRule();
    if (!rule.boardId) { toast('先选择或新建一个目标画板'); return; }
    if (rule.scope!=='local'&&!rule.platforms.length) { toast('至少选一个平台'); return; }
    if (!rule.query) { toast('填一个收集关键词'); return; }
    if(rule.queries.length>2||rule.queries.some(q=>q.length>300)||!Number.isInteger(rule.maxCalls)||rule.maxCalls<1||rule.maxCalls>12){toast('扩展词最多两项，平台调用上限为 1–12');return;}
    try {
      await api.saveRule(rule);
      toast(editingId ? '规则已更新' : '规则已保存');
      fillForm(null);
      await load({silent: true});
    } catch (error) { toast(error?.message || '保存失败'); }
  }

  async function runRule(id, dryRun) {
    try {
      toast(dryRun ? '正在试运行…' : '正在采集，可能需要几十秒…');
      const data = await api.runRule(id, dryRun);
      const run = data.run || {};
      if (dryRun) {
        preview.hidden = false;
        preview.innerHTML = `<div class="bd-preview-head"><strong>试运行预览</strong><small>找到 ${run.found} · 可新增 ${run.added}，不会写入任何状态</small>
          <button type="button" class="icon-button" data-act="close-preview" aria-label="关闭预览">${icon('close')}</button></div>`
          + previewHtml({items: run.preview || [], icon, esc});
        preview.scrollIntoView?.({block: 'nearest'});
      } else {
        preview.hidden = true;
        toast(`采集完成：新增 ${run.added} / 跳过 ${run.skipped}${run.failed ? ` · ${run.failed} 站异常` : ''}`);
        await syncPending({quiet: true});
      }
      await load({silent: true});
    } catch (error) { toast(error?.message || '采集失败'); }
  }

  dialog.addEventListener('click', async event => {
    const action = event.target.closest?.('[data-act]')?.dataset.act;
    const button = event.target.closest?.('button');
    if (action === 'close') return dialog.close();
    if (action === 'close-preview') { preview.hidden = true; return; }
    if (action === 'more') { $('.bd-more').hidden = !$('.bd-more').hidden; return; }
    if (action === 'reload') return load();
    if (action === 'merge') return syncPending();
    if (action === 'save') return saveRule();
    if (action === 'new-board') { $('.bd-inline-new').hidden = false; $('.bd-new-board-name').focus(); return; }
    if (action === 'create-board') {
      const name = $('.bd-new-board-name').value.trim();
      if (!name) { toast('请输入画板名称'); return; }
      try {
        const id = await store.create({name});
        renderBoards();
        $('.bd-board').value = id;
        $('.bd-new-board-name').value = '';
        $('.bd-inline-new').hidden = true;
        toast('画板已创建');
      } catch (error) { toast(error?.message || '新建失败'); }
      return;
    }
    if (button?.closest('.bd-seg')) {
      const value = button.dataset.value;
      $('.bd-seg').querySelectorAll('button').forEach(node => node.classList.toggle('on', node === button));
      $('.bd-hour').disabled = value !== 'daily';
      return;
    }
    if (button?.classList.contains('bd-platform')) {
      if (button.classList.contains('off')) { toast('这个平台不支持关键词搜索'); return; }
      button.classList.toggle('on');
      return;
    }
    if (action === 'dry' || action === 'run') return runRule(button.dataset.id, action === 'dry');
    if (action === 'toggle') {
      const rule = rules.find(item => item.id === button.dataset.id);
      if (!rule) return;
      try { await api.saveRule({...rule, enabled: !rule.enabled}); await load({silent: true}); } catch (error) { toast(error?.message || '操作失败'); }
      return;
    }
    if (action === 'edit') {
      const rule = rules.find(item => item.id === button.dataset.id);
      if (rule) { fillForm(rule); $('.bd-query').focus(); }
      return;
    }
    if (action === 'delete') {
      const rule = rules.find(item => item.id === button.dataset.id);
      if (!rule) return;
      // 二次点击确认，不用系统弹窗（阻塞 + 破坏视觉一致性）。
      if (pendingDelete !== rule.id) {
        pendingDelete = rule.id;
        button.classList.add('confirm');
        button.title = '再点一次确认删除';
        toast('再点一次删除按钮确认');
        setTimeout(() => { pendingDelete = ''; button.classList.remove('confirm'); button.title = '删除规则'; }, 4000);
        return;
      }
      pendingDelete = '';
      try { await api.deleteRule(rule.id); if (editingId === rule.id) fillForm(null); await load({silent: true}); } catch (error) { toast(error?.message || '删除失败'); }
      return;
    }
    const card = event.target.closest?.('.bd-rule-top');
    if (card && !event.target.closest?.('[data-act]')) renderDetail(card.closest('.bd-rule').dataset.id);
  });

  $('.bd-scope').onchange=()=>{const local=$('.bd-scope').value==='local';$('.bd-platforms').parentElement.hidden=local;$('.bd-budget').disabled=local;};
  dialog.addEventListener('input', event => {
    if (event.target.classList.contains('bd-limit')) $('.bd-limit-value').textContent = event.target.value;
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.classList.contains('bd-new-board-name'))
      dialog.querySelector('[data-act="create-board"]').click();
  });

  return {
    async open() {
      showActionCard(dialog);
      await store.refresh().catch(() => {});
      await load();
      await syncPending({quiet: true});
    },
    close: () => dialog.close(),
    syncPending,
    load,
    get dialog() { return dialog; },
    get ready() { return ready; },
  };
}
