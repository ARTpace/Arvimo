// 网页版兜底：浏览器里没有原生拖放，但可以「预取原文件字节 → 塞进 HTML5 拖拽」。
// 桌面版由 drag-out.js 的原生 CF_HDROP 接管（真实文件、最稳），这里只在浏览器里生效，
// 两边不会同时挂 —— dragstart 只有一个赢家，同时挂会互相抢 dataTransfer。
//
// 两个落点各走各的通道：
//   · 拖到 ArtStation 这类网页上传 → 落点读 dataTransfer.files，dragstart 时把预取的 File
//     用 items.add 塞进去（网页落点只认真实字节，DownloadURL 在网页落点上无效）。
//   · 拖到资源管理器 / PS / PureRef 等桌面软件 → DownloadURL（Chromium 专有）让浏览器按
//     URL 下载成本地文件再交给系统，等于「从资源管理器拖过去」。
// 预取必须早于 dragstart（dragstart 不能 await），所以按下 / 悬停就先抓；没抓到字节时
// 退化成只有 DownloadURL（桌面软件落点仍可用，网页上传要再拖一次）。
const MAX_PREFETCH = 16;
const MAX_PREFETCH_BYTES = 48 * 1024 * 1024;
const CACHE_TTL = 30000;
const CARD = '.model-card[data-uid]';

const absolute = url => {
  try { return new URL(url, location.origin).href; } catch { return String(url || ''); }
};

/**
 * 装配网页版拖出。只在浏览器里有效，桌面版（有 Tauri invoke）直接跳过。
 * @returns {() => void} 卸载函数
 */
export function setupLibraryDragWeb() {
  // 桌面版交给 drag-out.js 的原生拖放；这里完全不挂，避免抢同一次鼠标动作。
  if (globalThis.window?.__TAURI__?.core?.invoke) return () => {};

  /** uid → {urls:[{name,mime,url,size}], files:[{name,mime,blob}], at}。
   *  urls 一到就先存（DownloadURL 立刻可用），files 边抓边填（网页上传要等它）。 */
  const cache = new Map();
  const inflight = new Map();

  async function prefetch(uid) {
    if (!uid) return;
    const hit = cache.get(uid);
    if (hit && Date.now() - hit.at < CACHE_TTL) return;
    if (inflight.has(uid)) return inflight.get(uid);
    const task = (async () => {
      let list;
      try {
        const response = await fetch('/api/drag/urls', {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'x-sfx-local': '1'},
          body: JSON.stringify({uid}),
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => ({}));
        list = Array.isArray(data?.files) ? data.files : [];
      } catch { return; }
      if (!list.length) return;
      const picked = list.slice(0, MAX_PREFETCH)
        .filter(item => item && item.url)
        .map(item => ({
          name: item.name || 'asset',
          mime: item.mime || 'application/octet-stream',
          url: item.url,
          size: Number(item.size) || 0,
        }));
      if (!picked.length) return;
      // URL 先落缓存：即便字节还没抓完，DownloadURL 也能让桌面软件落点拿到文件。
      const entry = {urls: picked, files: [], at: Date.now()};
      cache.set(uid, entry);
      let bytes = 0;
      for (const item of picked) {
        if (item.size && bytes + item.size > MAX_PREFETCH_BYTES) break;
        try {
          const response = await fetch(absolute(item.url));
          if (!response.ok) continue;
          const blob = await response.blob();
          if (!blob.size) continue;
          bytes += blob.size;
          entry.files.push({name: item.name, mime: item.mime, blob});
        } catch { /* 单张失败就跳过，别拖垮整批 */ }
      }
      entry.at = Date.now();
    })().catch(() => {}).finally(() => { inflight.delete(uid); });
    inflight.set(uid, task);
    return task;
  }

  const uidOf = node => node?.closest?.(CARD)?.dataset.uid || '';

  // 资产卡是 <article>，默认不可拖；卡里的媒体 <img> 默认可拖（会拖出缩略图）—— 一开一关。
  const arm = root => {
    if (!root || root.nodeType !== 1) return;
    const cards = [];
    if (root.matches?.(CARD)) cards.push(root);
    root.querySelectorAll?.(CARD).forEach(node => cards.push(node));
    for (const card of cards) {
      card.draggable = true;
      card.querySelectorAll('img').forEach(img => { img.draggable = false; });
    }
  };
  const grid = document.getElementById('grid');
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) arm(node);
  });
  if (grid) {
    arm(grid);
    observer.observe(grid, {childList: true, subtree: true});
  }

  let hoverTimer = null;
  function onPointerOver(event) {
    const uid = uidOf(event.target);
    if (!uid) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { hoverTimer = null; prefetch(uid); }, 140);
  }
  function onPointerDown(event) {
    const uid = uidOf(event.target);
    if (uid) prefetch(uid);
  }

  function onDragStart(event) {
    const card = event.target?.closest?.(CARD);
    if (!card) return;
    const uid = card.dataset.uid;
    const transfer = event.dataTransfer;
    if (!uid || !transfer) return;
    try { transfer.effectAllowed = 'copy'; } catch { /* 个别壳不让写 */ }
    const entry = cache.get(uid);
    if (!entry) { prefetch(uid); return; }   // 还没预热：这次来不及塞字节，先抓下一次
    // 1) 网页上传落点：必须给真实 File 字节。
    for (const file of entry.files) {
      try { transfer.items.add(new File([file.blob], file.name, {type: file.mime})); }
      catch { /* items 只读时靠 DownloadURL 兜底 */ }
    }
    // 2) 桌面软件落点：DownloadURL 让浏览器按 URL 下载成本地文件（Chromium 专有）。
    const first = entry.urls[0];
    if (first?.url) {
      try { transfer.setData('DownloadURL', `${first.mime}:${first.name}:${absolute(first.url)}`); }
      catch { /* 忽略 */ }
    }
  }

  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('dragstart', onDragStart, true);

  return () => {
    document.removeEventListener('pointerover', onPointerOver, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('dragstart', onDragStart, true);
    observer.disconnect();
  };
}
