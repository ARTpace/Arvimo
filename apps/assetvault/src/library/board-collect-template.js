// 智能收集面板的静态骨架：只出 HTML，逻辑全在 board-collect.js。
// 视觉契约与筛选面板一致：少文字、图标按钮、滑条调参、类名一律 bd-*。
export function boardCollectHtml({icon, esc}) {
  return `
  <div class="bd-head"><span class="bd-head-ic">${icon('zap')}</span>
    <strong>智能收集画板</strong><span class="bd-engine" role="status"></span>
    <button type="button" class="icon-button" data-act="close" aria-label="关闭">${icon('close')}</button></div>
  <div class="bd-alert" hidden><span></span></div>
  <div class="bd-collect-body">
    <div class="bd-form">
      <div class="bd-row-line">
        <label class="bd-field bd-grow"><span>目标画板</span>
          <select class="bd-board" aria-label="目标画板"></select></label>
        <button type="button" class="icon-button" data-act="new-board" title="新建画板" aria-label="新建画板">${icon('plus')}</button>
      </div>
      <div class="bd-inline-new" hidden><input type="text" class="bd-new-board-name" maxlength="60" placeholder="新画板名称" aria-label="新画板名称">
        <button type="button" class="primary" data-act="create-board">创建</button></div>
      <label class="bd-field"><span>收集关键词</span>
        <input type="text" class="bd-query" maxlength="300" placeholder="stone texture / 角色原画" aria-label="收集关键词"></label>
      <div class="bd-field"><span>平台 <small class="bd-platform-note"></small></span>
        <div class="bd-platforms" role="group" aria-label="采集平台"></div></div>
      <div class="bd-row-line">
        <label class="bd-field bd-grow"><span>每次上限 <b class="bd-limit-value">20</b></span>
          <input type="range" class="bd-limit" min="1" max="60" value="20" aria-label="每次收集上限"></label>
        <label class="bd-field"><span>每日时间</span>
          <select class="bd-hour" aria-label="每日执行小时"></select></label>
      </div>
      <div class="bd-row-line">
        <div class="bd-seg" data-group="frequency" role="group" aria-label="触发频率">
          <button type="button" data-value="manual" class="on" title="只手动触发">${icon('play')}<span>手动</span></button>
          <button type="button" data-value="daily" title="每天自动执行一次">${icon('clock')}<span>每天</span></button>
        </div>
        <label class="bd-switch" title="暂停后不再自动采集"><input type="checkbox" class="bd-enabled" checked><span>启用</span></label>
        <button type="button" class="primary bd-save" data-act="save">${icon('save')}<span>保存规则</span></button>
      </div>
      <button type="button" class="bd-more-toggle" data-act="more">${icon('sliders')}<span>过滤条件（可选）</span></button>
      <div class="bd-more" hidden>
        <label class="bd-field"><span>格式（逗号分隔）</span><input type="text" class="bd-formats" placeholder="glb, png" aria-label="格式过滤"></label>
        <label class="bd-field"><span>包含标签</span><input type="text" class="bd-tags" placeholder="stone, pbr" aria-label="包含标签"></label>
        <label class="bd-field"><span>排除标签</span><input type="text" class="bd-exclude" placeholder="nsfw" aria-label="排除标签"></label>
      </div>
    </div>
    <div class="bd-rules" aria-label="收集规则列表"></div>
    <div class="bd-preview" hidden></div>
  </div>
  <div class="bd-foot"><span class="bd-pending" role="status"></span>
    <button type="button" class="secondary" data-act="merge">${icon('refresh')}<span>合并到资产库</span></button>
    <button type="button" class="secondary" data-act="reload">${icon('history')}<span>刷新</span></button></div>`;
}

export function hourOptions() {
  return Array.from({length: 24}, (_, hour) => `<option value="${hour}">${String(hour).padStart(2, '0')}:00</option>`).join('');
}

/** 规则卡片：状态用色点表达，操作全是图标按钮，说明进 title。 */
export function ruleCardHtml({rule, icon, esc}) {
  const status = rule.lastStatus || 'idle';
  const freq = rule.frequency === 'daily' ? `${String(rule.hour).padStart(2, '0')}:00` : '手动';
  return `<article class="bd-rule" data-id="${esc(rule.id)}" data-status="${esc(status)}">
    <div class="bd-rule-top"><i class="bd-status-dot"></i>
      <strong title="${esc(rule.name)}">${esc(rule.name)}</strong>
      <small class="bd-rule-meta" title="${esc((rule.platforms || []).join(' / '))}">${esc(rule.boardName || '画板')} · ${esc(freq)} · ${rule.platforms?.length || 0} 站 · ${rule.totalAdded || 0} 条</small>
      <span class="bd-rule-actions">
        <button type="button" class="icon-button" data-act="dry" data-id="${esc(rule.id)}" title="试运行预览（不写入）" aria-label="试运行">${icon('eye')}</button>
        <button type="button" class="icon-button" data-act="run" data-id="${esc(rule.id)}" title="立即收集一次" aria-label="立即收集">${icon('zap')}</button>
        <button type="button" class="icon-button" data-act="toggle" data-id="${esc(rule.id)}" title="${rule.enabled ? '暂停' : '恢复'}" aria-label="暂停或恢复">${icon(rule.enabled ? 'pause' : 'play')}</button>
        <button type="button" class="icon-button" data-act="edit" data-id="${esc(rule.id)}" title="编辑" aria-label="编辑">${icon('edit')}</button>
        <button type="button" class="icon-button danger" data-act="delete" data-id="${esc(rule.id)}" title="删除规则" aria-label="删除">${icon('trash')}</button>
      </span></div>
    <div class="bd-rule-detail" hidden></div></article>`;
}

export function ruleDetailHtml({runs, icon, esc}) {
  if (!runs.length) return `<div class="bd-empty">${icon('history')}<span>还没有运行记录</span></div>`;
  return runs.slice(0, 5).map(run => {
    const at = new Date(run.at || 0).toLocaleString('zh-CN', {hour12: false});
    const errors = Object.entries(run.platforms || {}).filter(([, row]) => row?.error);
    return `<div class="bd-run"><i class="bd-run-dot" data-status="${esc(run.dryRun ? 'dry' : run.failed ? 'partial' : 'ok')}"></i>
      <span>${esc(at)}</span><small>${run.dryRun ? '试运行' : ''} 找到 ${run.found} · 新增 ${run.added} · 跳过 ${run.skipped}</small>
      ${errors.length ? `<span class="bd-run-warn" title="${esc(errors.map(([k, v]) => `${k}: ${v.error}`).join('；'))}">${icon('sparkle')} ${errors.length} 站异常</span>` : ''}</div>`;
  }).join('');
}

export function previewHtml({items, icon, esc}) {
  if (!items.length) return `<div class="bd-empty">${icon('search')}<span>没有命中的新资产</span></div>`;
  return `<div class="bd-preview-grid">${items.slice(0, 24).map(item => `<a class="bd-preview-card" href="${esc(item.url || '#')}" target="_blank" rel="noreferrer">
    ${item.thumbnail ? `<img src="${esc(item.thumbnail)}" alt="" loading="lazy">` : `<i class="bd-preview-ph">${icon('file')}</i>`}
    <span title="${esc(item.name)}">${esc(item.name)}</span><small>${esc(item.platform)}</small></a>`).join('')}</div>`;
}
