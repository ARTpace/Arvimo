// 标签面板：搜索 + 模式切换 + **按面分组的标签网格** + 数量滑条。
//
// 分组数据来自 `/api/library/tags/facets`（服务端词表 + 物化计数）。为什么不在前端数：
//   · 词表的面归属只有服务端有，前端自己猜面 = 让体系漂移；
//   · 50 万资产时前端遍历 state.models 数标签会卡死，服务端读 tag_counts 是一次索引查询。
// 拿不到分面（DB 不可用 / 接口失败）时退回原来的平铺模式，面板绝不会白屏。
//
// 一个词会出现在多个面下（木材 = 材质 ∩ 题材），这是有意的：面是边不是列。
// 计数按资产 uid 去重，所以同一个词在各面下的数字必然相等 —— 加得起来，不会让用户困惑。
import {listUserTags, tagsFor} from './asset-tags.js';
import {parseTokens, toggleToken} from './filter-dimensions.js';
import {icon} from './icon-set.js';
import {
  iconButton, segmented, sliderRow, bindSlider, syncChips, emptyState,
} from './filter-panel-common.js';

/** 分面数据一次取回后复用：面板反复开关不再打接口，词表版本变了才需要重取。 */
let facetsPromise = null;
export function invalidateTagFacets(){facetsPromise=null;}
function loadFacets() {
  if (!facetsPromise) {
    facetsPromise = fetch('/api/library/tags/facets?limit=200', {cache: 'no-store', headers: {'X-SFX-Local': '1'}})
      .then(response => response.ok ? response.json() : null)
      .catch(() => null);
    // 失败不缓存，下次打开面板再试一次（DB 可能只是这一瞬间没就绪）。
    facetsPromise.then(view => { if (!view) facetsPromise = null; });
  }
  return facetsPromise;
}

/** 候选：我的标签优先，再补平台 / AI 标签；大库只扫前 2000 项，打开面板才算一次。 */
export function tagCandidates(state, limit = 60) {
  const counts = new Map();
  const add = (tag, weight) => {
    const key = String(tag || '').trim().toLocaleLowerCase();
    if (!key) return;
    const entry = counts.get(key) || {name: String(tag).trim(), score: 0};
    entry.score += weight;
    counts.set(key, entry);
  };
  for (const item of listUserTags(state)) add(item.name, 100 + item.count);
  for (const model of (state.models || []).slice(0, 2000)) {
    for (const tag of tagsFor(state, model)) add(tag, 1);
  }
  return [...counts.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh'))
    .slice(0, limit).map(item => item.name);
}

/** 计数版候选：每个标签后面的数字来自真实资产数（前端兜底路径）。 */
export function tagCounts(state, limit = 80) {
  const counts = new Map();
  for (const model of state.models || []) {
    for (const tag of tagsFor(state, model)) {
      const key = String(tag).trim().toLocaleLowerCase();
      if (!key) continue;
      const entry = counts.get(key) || {name: String(tag).trim(), count: 0};
      entry.count++;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh')).slice(0, limit);
}

/** 服务端分面 → 面板的分组结构。空面不占位置，序保持词表定义序（风格→题材→材质→用途→氛围→技术）。 */
function toGroups(view) {
  const groups = (view?.facets || []).map(facet => ({
    key: facet.key,
    label: facet.label,
    items: (facet.values || []).map(item => ({name: item.value, count: item.count})),
  }));
  const unfiled = (view?.unfiled || []).map(item => ({name: item.value, count: item.count}));
  if (unfiled.length) groups.push({key: 'unfiled', label: '未归类', items: unfiled});
  return groups.filter(group => group.items.length);
}

export function tagsPanel(host, ctx) {
  const {esc, store, state, recency} = ctx;
  let mode = 'include', sortMode = 'count', sortDesc = true, limit = 20;
  let groups = null;
  let recent = new Set();
  const fallback = [{key: '', label: '', items: tagCounts(state, 120)}];

  host.innerHTML = `<div class="fv-search-row"><span class="fv-search-ic">${icon('search')}</span>
      <input type="search" class="fd-search-input" autocomplete="off" spellcheck="false" placeholder="标签" aria-label="搜索标签">
      ${iconButton({icon: 'sort', cls: 'fv-tag-sort', title: '排序：次数 ↓ / 名称 ↑ / 名称 ↓', esc})}
      ${iconButton({icon: 'plus', cls: 'fv-tag-add-toggle', title: '手动添加标签（当前模式）', esc})}</div>
    <div class="fv-tag-manual" hidden><input type="text" class="fv-tag-input" autocomplete="off"
      placeholder="输入标签后回车" aria-label="手动添加标签"></div>
    <div class="fv-mode-row">
      ${segmented([
        {value: 'include', icon: 'plus', title: '包含模式：点击标签加入', short: '含', tone: '#C9F581'},
        {value: 'exclude', icon: 'minus', title: '排除模式：点击标签排除', short: '排', tone: '#FB7185'},
      ], mode, {esc})}
      ${sliderRow({id: 'tagLimit', icon: 'hash', min: 10, max: 80, step: 10, value: limit,
        display: `${limit}`, title: '每个分类显示的标签数量', esc})}
    </div>
    <div class="fd-tag-sections"></div>
    <div class="fd-selected-tags"></div>`;

  const include = () => store.get().tags;
  const exclude = () => store.get().excludeTags;
  const field = () => mode === 'exclude' ? 'excludeTags' : 'tags';

  const sortItems = items => {
    const sorted = [...items].sort((a, b) => {
      const diff = sortMode === 'count' ? a.count - b.count : a.name.localeCompare(b.name, 'zh');
      return sortDesc ? -diff : diff;
    });
    return sorted;
  };

  const chip = item => {
    const name = item.name;
    const kind = include().includes(name) ? 'is-include' : exclude().includes(name) ? 'is-exclude' : '';
    return `<button type="button" class="fd-tag-chip ${kind}" data-tag="${esc(name)}"
      title="${esc(`${name} · ${item.count} 个 · 左键按当前模式，右键排除`)}">
      ${recent.has(name.toLocaleLowerCase()) ? `<span class="fv-recent">${icon('clock')}</span>` : ''}
      <span>${esc(name)}</span><small>${item.count}</small></button>`;
  };

  function renderSections() {
    const box = host.querySelector('.fd-tag-sections');
    const needle = String(host.querySelector('.fd-search-input').value || '').trim().toLocaleLowerCase();
    const source = groups || fallback;
    recent = new Set((recency?.list?.() || []).map(name => String(name).toLocaleLowerCase()));

    if (needle) {
      // 搜索跨所有面：用户找的是词，不是面。
      const hits = source.flatMap(group => group.items)
        .filter(item => item.name.toLocaleLowerCase().includes(needle));
      box.innerHTML = hits.length
        ? `<div class="fv-chips">${sortItems(hits).slice(0, limit * 2).map(chip).join('')}</div>`
        : emptyState('没有匹配的标签', 'tag', esc);
      return;
    }

    // 平铺模式（无分面数据）不显示空词条；分组模式下也不显示 —— 计数为 0 的标签点了什么都不会发生。
    const blocks = source.map(group => {
      const items = sortItems(group.items).filter(item => item.count > 0).slice(0, limit);
      if (!items.length) return '';
      const label = group.label
        ? `<div class="fv-group-label">${esc(group.label)}<span class="fv-count"> · ${items.length}</span></div>`
        : '';
      return `<div class="fv-group">${label}<div class="fv-chips">${items.map(chip).join('')}</div></div>`;
    }).filter(Boolean);
    box.innerHTML = blocks.length ? blocks.join('') : emptyState('库里还没有可用的标签', 'tag', esc);
  }

  function renderSelected() {
    const list = [...include().map(name => ({name, kind: 'tags'})), ...exclude().map(name => ({name, kind: 'excludeTags'}))];
    host.querySelector('.fd-selected-tags').innerHTML = list.length
      ? list.map(item => `<span class="fd-selected-tag ${item.kind === 'excludeTags' ? 'exclude' : ''}">
          ${esc(item.name)}<button type="button" data-field="${item.kind}" data-tag="${esc(item.name)}"
            aria-label="移除 ${esc(item.name)}">×</button></span>`).join('')
      : '';
  }

  function refresh() {
    renderSections();
    renderSelected();
  }

  const applyChip = (name, forceExclude = false) => {
    const target = forceExclude ? 'excludeTags' : field();
    const other = target === 'tags' ? 'excludeTags' : 'tags';
    // 一次提交：包含与排除互斥，不能分成两次写让中间态被面板刷新看到。
    store.set({[target]: toggleToken(store.get()[target], name, true),
      [other]: store.get()[other].filter(item => item !== name)});
    recency?.used?.(name);
  };

  host.addEventListener('click', event => {
    const remove = event.target.closest?.('.fd-selected-tag button');
    if (remove) {
      store.set({[remove.dataset.field]: store.get()[remove.dataset.field].filter(item => item !== remove.dataset.tag)});
      return;
    }
    const target = event.target.closest?.('.fd-tag-chip[data-tag]');
    if (target) { applyChip(target.dataset.tag); return; }
    const seg = event.target.closest?.('.fv-seg[data-value]');
    if (seg) { mode = seg.dataset.value; syncChips(host, [mode], '.fv-seg[data-value]'); renderSections(); return; }
    if (event.target.closest?.('.fv-tag-add-toggle')) {
      const row = host.querySelector('.fv-tag-manual');
      row.hidden = !row.hidden;
      if (!row.hidden) row.querySelector('input').focus();
      return;
    }
    if (event.target.closest?.('.fv-tag-sort')) {
      if (sortMode === 'count') { sortMode = 'name'; sortDesc = false; }
      else if (!sortDesc) { sortDesc = true; }
      else { sortMode = 'count'; sortDesc = true; }
      host.querySelector('.fv-tag-sort').title = sortMode === 'count' ? '次数 ↓' : `名称 ${sortDesc ? '↓' : '↑'}`;
      renderSections();
    }
  });
  host.addEventListener('contextmenu', event => {
    const target = event.target.closest?.('.fd-tag-chip[data-tag]');
    if (!target) return;
    event.preventDefault();
    applyChip(target.dataset.tag, true);
  });
  host.querySelector('.fd-search-input').addEventListener('input', renderSections);
  host.querySelector('.fv-tag-input').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const tokens = parseTokens(event.target.value);
    if (!tokens.length) return;
    store.set({[field()]: [...new Set([...store.get()[field()], ...tokens])]});
    for (const tag of tokens) recency?.used?.(tag);
    event.target.value = '';
  });
  bindSlider(host, value => { limit = value; renderSections(); }, {selector: '[data-slider="tagLimit"] .fv-slider-input', format: value => `${value}`});
  refresh();

  // 分面数据晚到：先出平铺，到货后原地升级成分组，不阻塞面板打开。
  loadFacets().then(view => {
    if (!view || !host.isConnected) return;
    const next = toGroups(view);
    if (!next.length) return;
    groups = next;
    refresh();
  });

  return {refresh};
}
