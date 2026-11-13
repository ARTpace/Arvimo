// 画板中枢：唯一的装配点。app.js 只调一次 createBoardHub()，其余模块互不 import。
// 对外暴露 actions 缝给右键菜单与批量栏，避免它们直接依赖画板实现。
import {createBoardApi} from './board-api.js';
import {createBoardStore, BOARD_EVENTS} from './board-store.js';
import {createBoardPicker} from './board-picker.js';
import {createBoardCollect} from './board-collect.js';
import {createBoardDeck} from './board-deck.js';
import {createBoardActions} from './board-actions.js';
import {createBoardRule} from './board-rule.js';
import {mergeModels} from './library-state.js';
import {createBatchEdit} from './batch-edit.js';

export const BOARD_SYNC_MS = 60_000;

export function createBoardHub({
  $, state, esc, icon, toast, storage, persistNow, renderGrid, controls,
  document: doc = globalThis.document,
  window: win = globalThis.window,
} = {}) {
  if (!state || !storage || !persistNow) throw Error('画板中枢缺少依赖');
  const api = createBoardApi();
  const emit = (name, detail) => { try { win?.dispatchEvent(new CustomEvent(name, {detail})); } catch {} };
  const store = createBoardStore({api, storage, emit});
  const picker = createBoardPicker({esc, icon, toast, store, document: doc});
  const collect = createBoardCollect({esc, icon, toast, api, store, state, mergeModels, persistNow, renderGrid, document: doc});
  // 画板就是合集实体：进入画板 = 把主网格限定到该合集的成员（服务端 filters.collection）。
  // 走 controls 的既有缝，不在这里另造一套过滤逻辑 —— 两处各写一套必然走样。
  const gotoLibrary = () => doc.querySelector('[data-route="library"]')?.click();
  // 进出画板都同步 store.activeId：它是「当前画板」的持久化真值，
  // 断线重开要能回到原处，删除当前板时也靠它判断要不要退回全部资产。
  const openBoard = (id,options) => { store.setActive(id); gotoLibrary(); return controls?.applyCollection?.(id,options); };
  const openAll = () => { store.setActive(''); gotoLibrary(); controls?.clearCollection?.(); };
  const actions = createBoardActions({store, win, toast, openBoard});
  // 智能画板规则：新建 / 用当前筛选覆盖，走同一个对话框；保存后按新规则重算并进入该板。
  const rule = createBoardRule({
    esc, icon, toast, store, controls,
    onSaved: (id, {created} = {}) => {
      store.setActive(id);
      gotoLibrary();
      controls?.applyCollection?.(id, {force: true, refresh: true});
      if (created) toast?.('已进入新建的智能画板');
    },
  });
  // 画板卡片区：主网格上方一排「大封面 + 小图条」的画板卡，进入画板后由面包屑接管返回。
  const deck = createBoardDeck({
    doc, win, esc, icon, toast, store, api,
    onOpen: openBoard,
    onCanvas: id => { store.use(id);emit('assetvault:open-canvas-board',{id}); },
    onAll: openAll,
    onNew: () => actions.createManual(),
    onSmart: () => { gotoLibrary(); rule.openNew(); },
    onRule: id => rule.open(id),
    onRename: id => actions.rename(id),
    onDelete: async id => { const done = await actions.remove(id); if (done?.wasActive) openAll(); },
  });

  // 工具栏常驻入口：与筛选图标条共存，用 bd-* 前缀避免撞图站画板。
  const toolbar = $?.('#local-toolbar') || doc.querySelector('#local-toolbar');
  if (toolbar) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'tb-btn bd-toolbar-btn';
    button.title = '智能收集画板：按规则自动从平台采集资产';
    button.setAttribute('aria-label', '智能收集画板');
    button.innerHTML = `${icon('zap')}<span class="tb-label">画板</span>`;
    button.addEventListener('click', () => collect.open());
    toolbar.appendChild(button);
  }

  // 批量栏入口：先快照选中集合，避免打开选择器期间网格重绘把 state.selected 清空。
  const selectionBar = doc.querySelector('#selection-bar');
  if (selectionBar) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'secondary bd-selection-btn';
    button.title = '把选中的资产加入画板';
    button.innerHTML = `${icon('layers')}加入画板`;
    button.addEventListener('click', () => picker.open([...state.selected]));
    selectionBar.appendChild(button);
  }
  // 批量整理：打标 / 评分 / 收藏 / 备注，自建面板并往同一个批量栏挂按钮。
  // 与「加入画板」共用 state.selected 快照语义，不引入第二份选择真值。
  const batchEdit = createBatchEdit({state, esc, toast, persistNow, renderGrid, document: doc});

  // 服务端调度器在后台采集完前端不会收到推送，用低频轮询 + 聚焦补一次即可，
  // 不需要 WebSocket；syncPending 幂等，重复拉取没有副作用。
  const sync = () => collect.syncPending({quiet: true}).catch(() => {});
  win?.setInterval?.(sync, BOARD_SYNC_MS);
  win?.addEventListener?.('focus', sync);
  win?.addEventListener?.(BOARD_EVENTS.collect, event => { if (!event.detail?.merged) sync(); });

  // 能力位：老进程没有 /api/collect/*，明确提示重启，避免面板打开后静默 404。
  // /api/downloads/capabilities 在下载服务未启动时可能 503，所以拿不到能力位时
  // 再直接探一次采集路由；只有 404 才说明进程真的旧，不误报。
  const probeBackend = async () => {
    try { const cap = await api.capabilities(); if (cap?.collectRules) return; } catch {}
    try { await api.collectStatus(); } catch (error) {
      if (error?.status === 404) toast('智能收集需要新后台：请重启服务到 3.15.0');
    }
  };
  probeBackend();

  // 启动时合并一次上次停机期间攒下的采集结果；画板树刷新失败（纯文件模式）降级为不提示。
  store.refresh().catch(() => {});
  sync();

  // 「更多」面板的 ⚡ 键只发一条事件：规则对话框单点持有，新建智能画板只有一条路径。
  win?.addEventListener?.('assetvault:smart-board-new', () => { gotoLibrary(); rule.openNew(); });
  // 查询层新建手动画板后，侧栏那一行要跟着出现。
  controls?.setOnBoardDirty?.(() => { store.refresh().catch(() => {}); });

  return {
    api, store, picker, collect, deck, rule, actions, batchEdit, openBoard,
    pickBoards: (uids, options) => picker.open(uids, options),
    openCollect: () => collect.open(),
    syncPending: sync,
  };
}
