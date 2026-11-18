// 阶段 3 建、阶段 4 扩展：本地资产库「按需渲染 / 按需取数」窗口。
//
// 两条模式共用同一个「加载更多」按钮：
//  - 普通浏览：state.models 全量在内存，只控制一次画多少张卡片（绘制层分页）；
//  - 高级检索：state.remotePaging 激活，rows 已是服务端已加载页（queryUids 限定），
//    按钮转发到 onRemoteMore 让服务端按页取数，不再一次传上万个 uid。
// state.models 仍是写入契约的工作集：把它裁成当前页会让评分、标签、回收站、全选、
// findModel 全部丢数据，所以这里只控制「画多少 / 取多少」，不动数据本体。
const PAGE_SIZE = 60;

export function createLibraryPaging({$, state, onMore, onRemoteMore, icon}) {
  const grid = $('#grid');
  if (!grid) return {slice: rows => rows, reset() {}};

  const bar = document.createElement('div');
  bar.id = 'library-paging';
  bar.className = 'library-paging';
  bar.hidden = true;
  bar.innerHTML = `<span id="library-paging-info" role="status" aria-live="polite"></span>
    <button type="button" class="secondary" id="library-paging-more">加载更多 ${icon ? icon('arrow-down') : '↓'}</button>`;
  grid.insertAdjacentElement('afterend', bar);
  const info = $('#library-paging-info');
  const moreButton = $('#library-paging-more');

  let visible = PAGE_SIZE;
  let signature = '', busy = false;
  let currentScope='library';const pages=new Map();
  let nearBottom=false,pendingAuto=false;
  const autoLoad=()=>{
    if(!nearBottom||document.hidden||state.route!=='library'){pendingAuto=false;return;}
    if(document.documentElement.classList.contains('av-scrolling')){pendingAuto=true;return;}
    pendingAuto=false;void loadMore();
  };
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    nearBottom=entries.some(entry => entry.isIntersecting);autoLoad();
  }, {rootMargin: '320px 0px'}) : null;
  document.addEventListener('assetvault:scroll-idle',()=>{if(pendingAuto)autoLoad();});
  function observe() {
    observer?.disconnect();
    if (!bar.hidden && !moreButton.hidden && state.route === 'library') observer?.observe(bar);
  }
  async function loadMore() {
    if (busy || bar.hidden || moreButton.hidden || state.route !== 'library') return;
    pendingAuto=false;
    busy = true; moreButton.disabled = true;
    const before = state.remotePaging?.loaded ?? visible;
    try {
      if (state.remotePaging) {
        if (state.remotePaging.hasMore) await onRemoteMore?.();
      } else { visible += PAGE_SIZE; await onMore?.(); }
    } finally {
      busy = false; moreButton.disabled = false;
      // 只有确实加载了新一批才重挂哨兵；失败不在底部无限重试。
      if ((state.remotePaging?.loaded ?? visible) > before) observe();
    }
  }

  /**
   * 筛选 / 排序一变就回到第一页，否则换个关键词会停在「第 5 页」看不到新结果。
   * queryUids 是集合：只取 size + 首个元素做轻量签名，完整重置由 reset() 兜底。
   */
  function fingerprint() {
    const query = state.queryUids;
    return JSON.stringify([
      state.route, state.filter, state.search, state.sort,
      state.localCategory || '', state.imageTerms?.length || 0,
      query ? [query.size, [...query][0] || ''] : '',
      $('#local-kind')?.value || '', $('#local-status')?.value || '', $('#local-feature')?.value || '',
    ]);
  }

  function slice(rows,{local=false,scope='library'}={}) {
    if(scope!==currentScope){pages.set(currentScope,{visible,signature});const previous=pages.get(scope);pages.delete(scope);currentScope=scope;visible=previous?.visible||PAGE_SIZE;signature=previous?.signature||'';while(pages.size>3)pages.delete(pages.keys().next().value);}
    if (state.route === 'discover') { bar.hidden = true; return rows; }
    const next = fingerprint();
    if (next !== signature) { signature = next; visible = PAGE_SIZE; }

    const remote = local?null:state.remotePaging;
    if (remote) {
      bar.hidden = false;
      moreButton.hidden = !remote.hasMore;
      info.textContent = `已显示 ${rows.length} / ${remote.total} 项 · ${remote.hasMore ? '服务端按需取数' : '已取完'}`;
      if (!busy) observe();
      return rows;
    }

    moreButton.hidden = false;
    const shown = rows.slice(0, visible);
    bar.hidden = rows.length <= visible;
    if (!bar.hidden) info.textContent = `已显示 ${shown.length} / ${rows.length} 项 · 大库分批绘制`;
    if (!busy) observe();
    return shown;
  }

  bar.addEventListener('click', event => {
    if (!event.target.closest('#library-paging-more')) return;
    void loadMore();
  });

  return {
    slice,
    reset() { visible = PAGE_SIZE; signature = ''; pages.clear(); },
  };
}
