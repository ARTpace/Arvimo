// 筛选面板的共用视觉零件（图标按钮 / 图标 chip / 滑条 / 分段 / 探测进度）。
//
// 改版原则：文字只进 tooltip，参数只走滑条，状态只靠颜色与图标，面板自己不写说明段落。
// 所有函数都产出 HTML 字符串或做 DOM 绑定，不含业务语义；换一套皮肤只改 CSS 令牌。
import {icon} from './icon-set.js';

const html = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));

export const triggerInput = element => element.dispatchEvent(new Event('input', {bubbles: true}));

const attrs = (data, esc) => Object.entries(data || {})
  .map(([key, value]) => `data-${key}="${esc(value)}"`).join(' ');

/** 纯图标按钮：默认零文字，title 同时承担 aria-label 与 tooltip。 */
export function iconButton({icon: name, title = '', label = '', cls = '', active = false,
  tone = '', data = {}, esc = html, disabled = false} = {}) {
  const text = title || label;
  return `<button type="button" class="fv-btn ${cls}${active ? ' is-on' : ''}" ${attrs(data, esc)}
    title="${esc(text)}" aria-label="${esc(text)}" aria-pressed="${active}"${disabled ? ' disabled' : ''}
    ${tone ? `style="--fv-tone:${esc(tone)}"` : ''}>${icon(name)}${label ? `<span>${esc(label)}</span>` : ''}</button>`;
}

/** 图标 chip：图标 + 最多两三个字，选中态用 --fv-tone 发光。 */
export function iconChip({value, icon: name = '', label = '', title = '', active = false,
  cls = '', tone = '', data = {}, esc = html} = {}) {
  return `<button type="button" class="fv-chip ${cls}${active ? ' is-on' : ''}"
    data-value="${esc(value)}" ${attrs(data, esc)} title="${esc(title || label)}"
    aria-pressed="${active}"${tone ? ` style="--fv-tone:${esc(tone)}"` : ''}>
    ${name ? icon(name) : ''}${label ? `<span>${esc(label)}</span>` : ''}</button>`;
}

/** 滑条行：图标 + 渐变轨道 + 数值气泡。--fd-fill 由 fillSlider() 实时写。 */
export function sliderRow({id, icon: name = 'sliders', min = 0, max = 100, step = 1,
  value = 0, display = '', title = '', esc = html} = {}) {
  const pct = max > min ? Math.round((Number(value) - min) / (max - min) * 100) : 0;
  return `<div class="fv-slider" data-slider="${esc(id)}" style="--fd-fill:${pct}%">
    <span class="fv-slider-ic" title="${esc(title)}">${icon(name)}</span>
    <input type="range" class="fv-slider-input" min="${min}" max="${max}" step="${step}"
      value="${value}" aria-label="${esc(title)}">
    <output class="fv-slider-out">${esc(display || String(value))}</output></div>`;
}

const sliderParts = (host, selector) => {
  const input = host.querySelector(selector);
  return {input, row: input?.closest('.fv-slider'), out: input?.closest('.fv-slider')?.querySelector('.fv-slider-out')};
};

/** 把 value 写回滑条（含填充比例与气泡文字），不触发 input，避免回环。 */
export function setSlider(host, value, {selector = '.fv-slider-input', display} = {}) {
  const {input, row, out} = sliderParts(host, selector);
  if (!input) return;
  const min = Number(input.min), max = Number(input.max);
  input.value = String(value);
  row?.style.setProperty('--fd-fill', `${max > min ? Math.round((Number(value) - min) / (max - min) * 100) : 0}%`);
  if (out) out.textContent = display === undefined ? String(value) : display;
}

/** 绑定滑条：拖动即写回 store，format 决定气泡文案。 */
export function bindSlider(host, onValue, {selector = '.fv-slider-input', format = value => String(value)} = {}) {
  const {input} = sliderParts(host, selector);
  if (!input) return () => {};
  const handler = () => {
    const value = Number(input.value);
    setSlider(host, value, {selector, display: format(value)});
    onValue(value);
  };
  input.addEventListener('input', handler);
  return handler;
}

/** 图标分段：一组互斥模式，如包含 / 排除、收藏三态。 */
export function segmented(items, active, {esc = html, cls = ''} = {}) {
  return `<div class="fv-segment ${cls}" role="group">${items.map(item => iconButton({
    icon: item.icon, title: item.title || item.label, label: item.short || '',
    cls: `fv-seg${item.value === active ? ' is-on' : ''}`,
    active: item.value === active, tone: item.tone, data: {value: item.value}, esc,
  })).join('')}</div>`;
}

export function syncChips(host, selected, selector = '.fv-chip[data-value]') {
  const list = (Array.isArray(selected) ? selected : []).map(String);
  for (const button of host.querySelectorAll(selector)) {
    const active = list.includes(button.dataset.value);
    button.classList.toggle('is-on', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

export function emptyState(text, name = 'sparkle2', esc = html) {
  return `<div class="fv-empty">${icon(name)}<span>${esc(text)}</span></div>`;
}

/** 封面探测：一行进度条 + 两个图标按钮，不再有大段说明。 */
export function probeStatusHtml() {
  return `<div class="fd-probe"><span class="fd-probe-text" role="status"></span>
    <span class="fv-probe-bar"><i></i></span>
    <button type="button" class="fv-btn fd-probe-scan" title="扫描封面，补充颜色与尺寸">${icon('scan')}</button>
    <button type="button" class="fv-btn fd-probe-stop" title="停止扫描" hidden>${icon('close')}</button></div>`;
}

export function updateProbeStatus(host, ctx) {
  const node = host.querySelector('.fd-probe');
  if (!node) return;
  const stats = ctx.probe?.stats?.() || {total: 0, missing: 0, running: false, done: 0};
  const done = Math.max(0, stats.total - stats.missing);
  const text = node.querySelector('.fd-probe-text');
  const scan = node.querySelector('.fd-probe-scan');
  const stop = node.querySelector('.fd-probe-stop');
  if (text) text.textContent = ctx.probe ? `${done}/${stats.total}` : '未启用';
  const bar = node.querySelector('.fv-probe-bar i');
  if (bar) bar.style.width = `${stats.total ? done / stats.total * 100 : 0}%`;
  if (scan) { scan.disabled = !ctx.probe || stats.running; scan.title = stats.running ? '扫描中…' : '扫描封面，补充颜色与尺寸'; }
  if (stop) stop.hidden = !stats.running;
}

export function bindProbeControls(host, ctx) {
  host.addEventListener('click', event => {
    if (event.target.closest?.('.fd-probe-scan')) { ctx.scanProbe?.(); updateProbeStatus(host, ctx); }
    else if (event.target.closest?.('.fd-probe-stop')) { ctx.stopProbe?.(); updateProbeStatus(host, ctx); }
  });
}
