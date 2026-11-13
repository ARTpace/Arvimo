// 独立规则草稿：仅覆盖被修改字段，未知字段及未改过的旧条件原样保留。
import {createFilterState, EMPTY_FILTERS} from './filter-state.js';
import {createFormatFilterState} from './format-filter.js';
import {createFilterPanelDrawer} from './filter-panel-drawer.js';
import {ALL_DIMENSIONS} from './filter-dimensions.js';
const clone = value => JSON.parse(JSON.stringify(value ?? {}));
export function createBoardRuleFilters({host, esc, toast, models = () => [], onChange = () => {}, document: doc = globalThis.document}) {
  let draft = {}, previous, drawer;
  const input = value => { const node = doc.createElement('input'); node.value = value; return node; };
  const controls = {q: input(''), rating: input(''), favorite: input(''), sort: input('recent')};
  const notify = () => { drawer?.refresh(snapshot()); onChange(clone(draft)); };
  const formatFilter = createFormatFilterState({storage: null, onChange: () => {
    Object.assign(draft.filters, formatFilter.filter()); notify();
  }});
  controls.formatFilter = formatFilter;
  controls.q.addEventListener('input', () => { draft.q = controls.q.value; notify(); });
  const base = createFilterState({storage: null, restore: false, onChange: next => {
    for (const key of Object.keys(next)) {
      if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue;
      if (['sort','sortOrder','seed'].includes(key)) draft[key] = next[key];
      else draft.filters[key] = clone(next[key]);
    }
    if (JSON.stringify(previous.ratings) !== JSON.stringify(next.ratings)) delete draft.filters.rating;
    if (previous.favoriteMode !== next.favoriteMode) delete draft.filters.favorite;
    previous = next; notify();
  }});
  const snapshot = () => ({...base.get(), q: controls.q.value, formats: formatFilter.tokens()});
  const ctx = {controls, esc, toast, store: base, storage: null, probe: null, ruleEditing: true,
    state: {get models() { return models(); }}, recency: {list: () => [], used() {}},
    localScope: () => draft.filters.state === 'trashed' ? 'trash' : draft.filters.favoriteMode === 'yes' ? 'favorites' : 'all',
    setLocalScope: value => {
      draft.filters.state = value === 'trash' ? 'trashed' : 'active';
      base.set({favoriteMode: value === 'favorites' ? 'yes' : 'any'}); notify();
    },
    localStatus: () => '', setLocalStatus: () => toast?.('文件在线状态不能保存为智能规则'),
    onFormatChange: () => {Object.assign(draft.filters, formatFilter.filter()); notify();},
  };
  drawer = createFilterPanelDrawer({host, ctx, dimensions: ALL_DIMENSIONS.filter(dim => dim.id !== 'folders'), closable: false});
  function clearDimension(id) {
    base.clearDimension(id);
    // 即便面板值本来已归一化为空，也必须清掉原始草稿中同维度的旧值。
    const fields = {color:['colors','excludeColors','colorSwatches','colorSimilarity'],tags:['tags','excludeTags'],kinds:['kinds','ranges','excludeRanges'],source:['categories','platforms'],rating:['rating','ratings','excludeRating'],favorite:['favorite','favoriteMode','state'],format:['formats','excludeFormats'],more:[]};
    for (const key of fields[id] || []) delete draft.filters[key];
    if (id === 'more') { draft.q = ''; controls.q.value = ''; }
    if (id === 'format') formatFilter.clear(false);
    notify();
  }
  host.addEventListener('click', event => {
    const rail = event.target.closest?.('.fd-rail-btn');
    if (rail) {drawer.open(rail.dataset.id); notify(); return;}
    const chip = event.target.closest?.('.fd-active-chip');
    if (chip) return clearDimension(chip.dataset.dim);
    if (event.target.closest?.('.fd-pop-reset')) return clearDimension(drawer.id);
    if (event.target.closest?.('.fd-clear-all')) load({sort:draft.sort,sortOrder:draft.sortOrder,seed:draft.seed});
  });
  function load(rule) {
    draft = clone(rule); draft.filters ||= {};
    const f = draft.filters;
    previous = base.set({...EMPTY_FILTERS, ...f, favoriteMode:f.favoriteMode || (f.favorite ? 'yes' : 'any'),
      ratings:f.ratings || (Array.isArray(f.rating) ? [0,1,2,3,4,5].filter(n=>n>=f.rating[0] && n<=f.rating[1]) : []),
      sort:draft.sort,sortOrder:draft.sortOrder,seed:draft.seed}, {silent:true});
    controls.q.value = draft.q || '';
    formatFilter.setValue((f.formats || []).join(','), false); formatFilter.setExclude(f.excludeFormats, false);
    drawer.open('color'); notify();
  }
  return {load, getRule: () => clone(draft), clearDimension, store:base, controls, open: id => {drawer.open(id); notify();}};
}
