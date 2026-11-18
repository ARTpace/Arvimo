// 以图搜相似资产（发现页 + 资产库共用同一个搜索框）。
// 流程：粘贴/拖入图片 → 搜索框下方出现参考图 → 点「搜索」才调视觉模型识别 →
// 资产库：关键词交给本地过滤并加权排序；发现页：英文检索词填进搜索框并开跑。
const MAX_EDGE = 768;
const ACCEPT = /^image\/(?:png|jpe?g|webp|gif|bmp)$/i;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(Error('这张图片无法解码')); };
    img.src = url;
  });
}

function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file).catch(() => loadImage(file));
  return loadImage(file);
}

/** 压到视觉模型够用的尺寸，避免 base64 把请求体撑爆（服务端上限 8MB）。 */
export async function toDataUrl(file, edge = MAX_EDGE) {
  const bitmap = await loadBitmap(file);
  const width = bitmap.width || 1;
  const height = bitmap.height || 1;
  const scale = Math.min(1, edge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('无法读取这张图片');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (typeof bitmap.close === 'function') bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.86);
}

/** 从剪贴板里挑出第一张图片；没有就返回 null。 */
function imageFromClipboard(clipboard) {
  if (!clipboard) return null;
  const items = clipboard.items ? Array.from(clipboard.items) : [];
  for (const item of items) {
    if (item.kind !== 'file' || !ACCEPT.test(item.type || '')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  // 有些环境不给 items，只能退到 files。
  const files = clipboard.files ? Array.from(clipboard.files) : [];
  return files.find(file => ACCEPT.test(file.type || '')) || null;
}

/** 卡片拖进搜索栏用的自定义 MIME，和外部文件（Files）区分开。 */
const CARD_MIME = 'application/x-assetvault-card';

export function bindImageSearch({ $, state, renderGrid, writeSearch, startSearch, inputSelector = '#asset-query', onState = () => {} } = {}) {
  let version = 0;
  let pending = null; // 已粘好、还没识别的参考图
  let busy = false;
  const chip = () => $('#search-image-query');
  const thumbEl = () => $('#search-image-thumb');
  const captionEl = () => $('#search-image-caption');
  const hintEl = () => $('#local-translation');

  function hint(text) {
    const el = hintEl();
    if (!el) return;
    el.textContent = text;
    el.title = text;
    el.hidden = !text;
  }

  function clear({ silent = false } = {}) {
    version++;
    pending = null;
    busy = false;
    state.imageTerms = [];
    state.imageQuery = '';
    const box = chip();
    if (box) { box.hidden = true; box.dataset.state = ''; }
    const thumb = thumbEl();
    if (thumb) thumb.removeAttribute('src');
    const caption = captionEl();
    if (caption) caption.textContent = '';
    if (!silent) hint('');
    if (state.route === 'library') renderGrid();
  }

  function showQuery(dataUrl, label, state_) {
    const box = chip();
    if (!box) return;
    box.hidden = false;
    box.dataset.state = state_ || '';
    const thumb = thumbEl();
    if (thumb) thumb.src = dataUrl;
    const caption = captionEl();
    if (caption) caption.textContent = label || '已载入参考图';
  }

  async function load(file) {
    if (!file) return;
    if (!ACCEPT.test(file.type || '')) return hint('只支持 PNG / JPG / WebP / GIF 图片');
    const token = ++version;
    hint('正在压缩图片…');
    let dataUrl;
    try {
      dataUrl = await toDataUrl(file);
    } catch (error) {
      return hint(error.message || '图片读取失败');
    }
    if (token !== version) return;
    pending = { dataUrl };
    showQuery(dataUrl, '已载入参考图，点「搜索」开始识别', 'pending');
    hint('已载入参考图，点「搜索」（或回车）开始识别');
    const input = $(inputSelector);
    if (input) input.focus();
  }

  /** 把一张已经能访问到的图（卡片缩略图、本地文件预览图）拉成 File 再走同一条链路。 */
  async function loadFromUrl(url, name = '') {
    if (!url) return;
    hint('正在读取缩略图…');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Error(`缩略图读取失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      const type = ACCEPT.test(blob.type || '') ? blob.type : 'image/jpeg';
      const file = new File([blob], `${name || 'asset'}.jpg`, { type });
      await load(file);
    } catch (error) {
      hint(error.message || '缩略图读取失败');
    }
  }

  async function recognize() {
    if (!pending || !pending.dataUrl) return false;
    if (busy) return true;
    const token = ++version;
    const dataUrl = pending.dataUrl;
    busy = true;
    showQuery(dataUrl, '正在识别…', 'busy');
    hint('正在用视觉模型识别图片…');
    onState({ busy: true });

    let result;
    try {
      const response = await fetch('/api/ai/vision-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SFX-Local': '1' },
        body: JSON.stringify({ image: dataUrl }),
        signal: AbortSignal.timeout(150000),
      });
      result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.error || `识别失败（HTTP ${response.status}）`);
    } catch (error) {
      if (token === version) {
        busy = false;
        onState({ busy: false, ok: false });
        showQuery(dataUrl, '识别失败，可再点一次「搜索」重试', 'error');
        hint(error.message || '图片识别失败');
      }
      return true;
    }
    if (token !== version) return true;
    busy = false;
    onState({ busy: false, ok: true });

    const terms = [...(result.keywords || []), ...(result.english || [])].filter(Boolean);
    const label = result.caption || result.material || '已载入参考图';
    if (!terms.length && !result.searchQuery) {
      showQuery(dataUrl, result.reason || '没有识别出可用关键词', 'error');
      hint(result.reason || '没有识别出可用关键词');
      return true;
    }
    pending = null; // 识别完成，下一次点搜索回到普通文本检索
    showQuery(dataUrl, label, 'done');

    if (state.route === 'library') {
      state.imageTerms = terms;
      state.imageQuery = label;
      state.search = '';
      state.searchEnglish = '';
      const kind = $('#local-kind');
      if (kind && result.kind) kind.value = result.kind;
      renderGrid();
      hint(`图搜：${label}${terms.length ? `　关键词 ${terms.slice(0, 6).join(' / ')}` : ''}`);
      return true;
    }

    state.imageTerms = [];
    state.imageQuery = label;
    const query = result.searchQuery || (result.english || []).join(' ') || result.search || '';
    const input = $(inputSelector);
    if (input) input.value = query;
    if (typeof writeSearch === 'function') writeSearch({ q: query });
    if (typeof startSearch === 'function') startSearch({ record: true });
    hint(`图搜：${label}${query ? `　检索词 ${query}` : ''}`);
    return true;
  }

  /** 由表单提交调用：手上有待识别的图就吞掉这次提交，交给识别流程。 */
  function submit() {
    if (!pending || !pending.dataUrl) return false;
    recognize();
    return true;
  }

  const input = $(inputSelector);
  if (input) {
    input.addEventListener('paste', event => {
      const file = imageFromClipboard(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      load(file);
    });
    // 用户改成打字搜索时，图搜条件要一起退场，否则两种条件会互相打架。
    input.addEventListener('input', () => {
      if (pending || (state.imageTerms || []).length || state.imageQuery) clear({ silent: true });
    });
  }

  // 快捷键：焦点不在任何输入框时，Ctrl+V 直接喂给搜索栏（不用先点一下搜索框）。
  document.addEventListener('paste', event => {
    if (event.defaultPrevented) return;
    const target = event.target;
    // 别的输入框里的粘贴归它自己管，别抢。
    if (target && target.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
    const file = imageFromClipboard(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    load(file);
  });

  // 拖拽入口统一挂在整个搜索面板上：外部文件（资源管理器/桌面）和资产卡片的缩略图都收。
  const panel = $('#search-panel');
  if (panel) {
    const accepts = dataTransfer => {
      if (!dataTransfer) return '';
      const types = Array.from(dataTransfer.types || []);
      if (types.includes(CARD_MIME)) return 'card';
      if (types.includes('Files')) return 'file';
      return '';
    };
    const highlight = on => panel.classList.toggle('image-drop', on);

    panel.addEventListener('dragover', event => {
      if (!accepts(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      highlight(true);
    });
    panel.addEventListener('dragleave', event => {
      // 在面板内部的元素之间移动也会触发 dragleave，用 relatedTarget 过滤掉。
      if (event.relatedTarget && panel.contains(event.relatedTarget)) return;
      highlight(false);
    });
    panel.addEventListener('drop', event => {
      highlight(false);
      const kind = accepts(event.dataTransfer);
      if (!kind) return;
      event.preventDefault();
      event.stopPropagation();
      if (kind === 'card') {
        let payload = null;
        try { payload = JSON.parse(event.dataTransfer.getData(CARD_MIME) || 'null'); } catch { payload = null; }
        if (!payload || !payload.url) return hint('这张卡没有可用的缩略图');
        loadFromUrl(payload.url, payload.name);
        return;
      }
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) load(file);
    });
  }

  // 把资产卡片做成可拖的源头（仅网页版）：桌面版的拖出由 drag-out.js 接管系统拖放，这边不掺和。
  if (!window.__TAURI__?.core?.invoke) {
    // 只有真带缩略图的卡片才可拖：3D 卡封面是占位块，拖了也没东西可以喂给视觉模型。
    const markCard = card => { if (card?.classList?.contains('model-card')) card.draggable = !!card.querySelector('.card-media img'); };
    const markCards = root => {
      if (!root || root.nodeType !== 1) return;
      if (root.matches?.('.model-card')) markCard(root);
      root.querySelectorAll?.('.model-card').forEach(markCard);
    };
    const grid = document.getElementById('grid');
    if (grid) {
      markCards(grid);
      const observer = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) markCards(node);
      });
      observer.observe(grid, { childList: true, subtree: true });
    }
    document.addEventListener('dragstart', event => {
      const card = event.target?.closest?.('.model-card');
      if (!card) return;
      // 用卡片上真实渲染的缩略图，不依赖各平台的字段名。
      const media = card.querySelector('.card-media img');
      const url = media?.currentSrc || media?.src || '';
      if (!url) return;
      const name = card.querySelector('.card-title')?.textContent?.trim() || '';
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(CARD_MIME, JSON.stringify({ url, name }));
      try { event.dataTransfer.setDragImage(media, media.width / 2, media.height / 2); } catch { /* 某些浏览器不给设拖影 */ }
    });
  }

  $('#search-image-clear')?.addEventListener('click', () => {
    clear();
    const field = $(inputSelector);
    if (field) { field.value = ''; field.focus(); }
  });
  // 清空搜索框时，图搜条件一起退场。
  $('#search-clear')?.addEventListener('click', () => clear({ silent: true }));

  return { load, loadFromUrl, recognize, submit, clear, reset: () => clear({ silent: true }) };
}
