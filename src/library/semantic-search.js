// 语义搜索 / 找相似（ADR-15）。
//
// 它**不接管**搜索框的原有流程：关键词过滤仍然由 search-translation.js 的
// bindLocalSearch 负责，这里只多做一件事 —— 让服务端按向量先筛出候选 uid 集合，
// 再交给 app.js 的 filtered() 走既有的 collect / 排序 / 卡片渲染。
//
// 这也是为什么必须有 state.semanticMode：命中集合是「按意思」来的，如果同时
// 还让 filterLocalAssets 用原始关键词再筛一遍，用户输入「能跑的坐骑」就会
// 因为资产名里没有「坐骑」二字而全被清掉。
import {mergeRemoteModels} from './library-page-fetch.js';

export function createSemanticSearch({$,state,renderGrid,toast=()=>{}}) {
  const KEY = 'av_semantic_search';
  const input = $('#asset-query');
  const panel = $('#search-panel');
  let on = false;
  try { on = localStorage.getItem(KEY) === '1'; } catch { /* 隐私模式下读不到，当作关闭 */ }
  let timer = 0, seq = 0, button = null;

  const say = text => {
    const node = $('#local-translation');
    if (!node) return;
    node.textContent = text || '';
    node.title = text || '';
    node.hidden = !text;
  };

  async function api(route, {query = {}, body = null} = {}) {
    const search = new URLSearchParams(query).toString();
    const response = await fetch(`/api/library/semantic/${route}${search ? `?${search}` : ''}`, {
      method: body ? 'POST' : 'GET',
      headers: {'X-SFX-Local': '1', 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || '语义搜索不可用');
    return data;
  }

  /**
   * 把命中 uid 灌进既有过滤通道。顺序按相似度，不按 state.sort 再排一次。
   * items 必须一起合并：命中可能落在首屏之外，state.models 里没有它，卡片就画不出来。
   */
  function apply(uids, note, items = []) {
    if (items.length) mergeRemoteModels(state, items);
    state.semanticMode = true;
    state.semanticApplied = true;
    state.queryUids = new Set(uids);
    state.queryOrder = [...uids];
    // 语义结果一次性给全，不再走服务端分页（否则 filtered() 看到 remotePaging 会以为还有下一页）。
    state.remotePaging = null;
    state.selected.clear();
    renderGrid();
    say(note);
  }

  function clear() {
    clearTimeout(timer);
    seq += 1;
    state.semanticMode = false;
    if (state.semanticApplied) {
      state.semanticApplied = false;
      state.queryUids = null;
      state.queryOrder = null;
    }
    say('');
  }

  async function search(query) {
    if (!on || state.route !== 'library') return;
    const text = String(query || '').trim();
    if (!text) { clear(); return; }
    const token = ++seq;
    try {
      const data = await api('search', {query: {q: text, limit: 120}});
      if (token !== seq) return;
      if (!data.uids?.length) {
        apply([], data.reason || '语义索引里没有相近的资产');
        return;
      }
      const best = Number(data.scores?.[0] || 0);
      apply(data.uids, `语义命中 ${data.uids.length} 个 · 最相似 ${best.toFixed(2)}`, data.items || []);
    } catch (error) {
      // 输入过程中失败只写在提示行：每敲一次就弹一个窗没人受得了。
      if (token === seq) say(error.message);
    }
  }

  async function similar(uid) {
    if (!uid) return;
    const token = ++seq;
    try {
      const data = await api('similar', {query: {uid, limit: 120}});
      if (token !== seq) return;
      if (!data.uids?.length) { toast('没有找到相似的资产'); return; }
      const name = document.querySelector(`.model-card[data-uid="${CSS.escape(uid)}"] .model-name`)?.textContent?.trim() || '这个资产';
      apply(data.uids, `与「${name}」相似 ${data.uids.length} 个`, data.items || []);
    } catch (error) {
      toast(error.message);
    }
  }

  /** 构建索引：按批往后推，直到 remaining=0。每批都是一个可计费请求，所以由用户点触发。 */
  async function build({batch = 16, maxBatches = 8} = {}) {
    const status = $('#ai-status');
    const note = message => { if (status) status.textContent = message; };
    let total = 0;
    for (;;) {
      const data = await api('build', {body: {batch, maxBatches}});
      total += data.embedded || 0;
      const left = Number(data.status?.pending || 0);
      note(`语义索引：已向量化 ${total} 个${left ? `，还剩 ${left} 个…` : '，全部完成'}`);
      if (data.error) throw Error(data.error);
      if (!left) return {...data, embeddedTotal: total};
      if (!data.embedded) throw Error('这一轮没有写入任何向量，请检查向量模型是否可用');
    }
  }

  async function status() {
    try { return await api('status'); }
    catch (error) { return {ready: false, reason: error.message, pending: 0}; }
  }

  function paint() {
    if (!button) return;
    button.setAttribute('aria-pressed', String(on));
    button.classList.toggle('is-on', on);
    button.title = on ? '语义搜索已开启（按意思找，不按字面）' : '语义搜索（按意思找，不按字面）';
    // 只改资产库页的占位：发现页的占位由平台配置决定，不该被这里覆盖。
    if (state.route === 'library') {
      input.placeholder = on
        ? '描述你想要的，例如「能骑的幻想坐骑、暗色调」'
        : '搜索本地资产名称、作者、标签…';
    }
  }

  function toggle(next = !on) {
    // 语义只服务于「本地资产库」：在线发现页的结果不存在向量里，开着它只会给空网格。
    if (state.route !== 'library') { toast('语义搜索只在资产库页可用'); return; }
    on = next === true;
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* 存不下只影响下次记忆 */ }
    if (!on) clear();
    else if (input.value.trim()) search(input.value);
    paint();
    panel?.dispatchEvent(new CustomEvent('search-motion-state', {detail: {busy: false, ok: true}}));
  }

  function setup() {
    const host = input?.closest('.global-search');
    if (host && !$('#semantic-toggle')) {
      button = document.createElement('button');
      button.id = 'semantic-toggle';
      button.type = 'button';
      button.className = 'ai-breakdown semantic-toggle';
      button.setAttribute('aria-label', '语义搜索');
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 15c2.5 0 2.5-6 5-6s2.5 6 5 6 2.5-6 5-6"/><path d="M4 19h16"/></svg>';
      button.addEventListener('click', event => { event.preventDefault(); toggle(); });
      // 放在「AI 拆解」左边，视觉上同属搜索增强，不另起一栏。
      const anchor = host.querySelector('#theme-breakdown-btn');
      if (anchor) host.insertBefore(button, anchor);
      else host.appendChild(button);
    }
    paint();

    input?.addEventListener('input', () => {
      if (!on) return;
      const text = input.value.trim();
      clearTimeout(timer);
      if (!text) { clear(); return; }
      timer = setTimeout(() => search(text), 600);
    });
    // Enter 时不拦截默认行为：语义只是加压一次立即查询，关键词路径照旧跑完。
    input?.addEventListener('keydown', event => {
      if (!on || event.key !== 'Enter' || event.isComposing) return;
      clearTimeout(timer);
      search(input.value);
    });
  }

  return {setup, toggle, search, similar, build, status, clear, repaint: paint, enabled: () => on};
}
