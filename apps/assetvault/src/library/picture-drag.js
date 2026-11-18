// 网页版兜底：图站图片卡片拖出去的必须是原图，不是屏幕上那张缩略图。
//
// 桌面版不走这里 —— drag-out.js 会掐掉网页拖拽，由 Rust 的 CF_HDROP 举着真实文件
// （server/drag-stage.mjs 负责把原图落盘），PS / PureRef 收到的就是磁盘文件本身。
//
// 卡片上的 <img> 是 /api/image?url=<thumb>（花瓣的 _fw480 之类），只有几百像素。Chromium 拖
// img 时会把「这张图」当文件交出去，所以网页版拖进 PS / ComfyUI / Blender 的永远是小图。
// 这里在 dragstart 把拖拽数据改挂原图：
//   · DownloadURL —— 浏览器按这段地址去取文件，落到资源管理器 / 桌面软件就是原尺寸文件；
//   · text/uri-list —— 给只认链接的落点；
//   · 按下鼠标时顺手预取原图字节，取到了就把真文件塞进 items，网页里的落点（ComfyUI 之类）
//     拿到的也是原尺寸 byte，不用它再跑一趟网络。
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
/** 预取缓存上限：拖拽前用户通常只看得到几张，多了纯属白占内存。 */
const PREFETCH_LIMIT = 6;

const isVideoUrl = url => /\.(mp4|webm|mov)(?:[?#]|$)/i.test(String(url || ''));

function extOf(url) {
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(url || ''));
  const ext = (match ? match[1] : '').toLowerCase();
  return MIME_BY_EXT[ext] ? ext : 'jpg';
}
const mimeOf = url => MIME_BY_EXT[extOf(url)] || 'image/jpeg';

function nameOf(url, title) {
  const stemOfUrl = () => {
    const tail = String(url || '').split('?')[0].split('/').pop() || '';
    try { return decodeURIComponent(tail); } catch { return tail; }
  };
  const stem = String(title || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .trim()
    .slice(0, 80)
    || stemOfUrl().replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 60)
    || 'assetvault';
  return `${stem}.${extOf(url)}`;
}

/** 原图经本地代理取：图站 CDN 认 Referer，直连会被 403；full=1 解开缩略图的 8MB 上限。
 *  视频没有 full 档，走 /api/video 直通原文件（Range 透传，落点按需分段取）。 */
const proxyUrl = url => new URL(isVideoUrl(url)
  ? `/api/video?url=${encodeURIComponent(url)}`
  : `/api/image?url=${encodeURIComponent(url)}&full=1`, location.origin).href;

/** 网页版兜底：桌面版一律走 drag-out.js 的原生 CF_HDROP（真实文件），这里不掺和。
 *  两边同时挂会在 dragstart 抢 dataTransfer，桌面版预热也由 drag-payload.js 自己负责。 */
export function setupPictureDrag() {
  if (globalThis.window?.__TAURI__?.core?.invoke) return;
  const cache = new Map();

  const prefetch = url => {
    if (!url || cache.has(url)) return;
    if (cache.size >= PREFETCH_LIMIT) cache.delete(cache.keys().next().value);
    const pending = fetch(proxyUrl(url), { cache: 'force-cache' })
      .then(response => (response.ok ? response.blob() : null))
      .catch(() => null);
    cache.set(url, pending);
    pending.then(blob => {
      if (cache.get(url) !== pending) return;
      if (blob && blob.size) cache.set(url, blob); else cache.delete(url);
    });
  };

  // 视频卡片也是一个可拖的封面元素：拖出去给原视频文件，不预取（几十 MB 全塞内存不值当）。
  const cardOf = node => node?.closest?.('.picture-site-results img[data-url],.picture-site-results video[data-url]') || null;

  // 按下就先取：拖拽真正开始时（通常 200ms 后）原图字节往往已经在了。
  document.addEventListener('pointerdown', event => {
    const image = cardOf(event.target);
    if (image && !isVideoUrl(image.dataset.url)) prefetch(image.dataset.url);
  }, true);

  document.addEventListener('dragstart', event => {
    const image = cardOf(event.target);
    const original = image?.dataset.url || '';
    if (!original) return;
    const transfer = event.dataTransfer;
    if (!transfer) return;

    // 站内发起的拖拽：落回窗口时 drop 里也是 Files，drop-import 靠这个标记跳过。
    document.documentElement.classList.add('self-drag');
    const name = nameOf(original, image.dataset.title || '');
    const source = proxyUrl(original);
    try {
      transfer.effectAllowed = 'copy';
      // DownloadURL 是 Chromium 专有的拖放格式：落到文件系统 / 桌面软件时按这段地址取文件，
      // 而不是把 <img> 当前显示的那张缩略图存下来。
      transfer.setData('DownloadURL', `${mimeOf(original)}:${name}:${source}`);
      transfer.setData('text/uri-list', source);
    } catch { /* 个别壳不让写自定义格式，退回浏览器默认行为 */ }

    const ready = cache.get(original);
    if (ready instanceof Blob) {
      try { transfer.items.add(new File([ready], name, { type: mimeOf(original) })); }
      catch { /* items 只读时靠 DownloadURL 兜底 */ }
    }
  }, true);
  // 只摘标记、不碰 dataTransfer：dragend 一定晚于 drop，摘早了 drop-import 就认不出站内拖拽。
  document.addEventListener('dragend', () => document.documentElement.classList.remove('self-drag'), true);
}
