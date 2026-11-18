// 卡片 → 拖放描述，再由 /api/drag/files 换成磁盘绝对路径。
//
// 这一层只认 DOM 和注册表，不认识 OLE、也不发系统拖放：桌面版由 drag-out.js 拿描述换到
// 真实文件后交给 Rust 的 DoDragDrop，网页版则完全不加载它。新增一类可拖卡片 = 往
// CARD_SOURCES 加一条，别在 drag-out.js 里堆 if。
//
// 描述有两种：
//   · {type:'local',  root, rel}  已索引的本地文件（高清原文件，不是 /api/local/thumb 缩略图）
//   · {type:'remote', url, name}  图站高清原图（服务端 full=1 档落盘，最多 64MB）
// 版权与越界校验都在服务端，前端给不出也不该给绝对路径。
import {FORMATS} from './format-registry.js';

/** 一次最多交给系统的文件数，与服务端 createDragStage 的 maxItems 对齐。
 *  64 = 图片包单包上限（IMAGE_MAX 60）+ 余量：图集要能「一次全给」，
 *  24 张会在 60 张的画板里被截掉，用户拿到的就不是全部图片。 */
export const MAX_DRAG_FILES = 64;
/** 图片扩展名从格式注册表派生：PSD / RAW / TIFF 也照原文件拖，PS 拿到的是可编辑源文件。 */
const IMAGE_EXTS = new Set(Object.values(FORMATS)
  .filter(format => format.group === 'image' || format.kind === 'image')
  .map(format => `.${format.ext}`));
const isImageName = name => IMAGE_EXTS.has(`.${String(name || '').split('.').pop().toLowerCase()}`);
const isHttp = url => /^https?:\/\//i.test(String(url || ''));

/** 预览大图：本地包给 root/rel，图站包给原图 URL，两种来源都在 showGalleryImage 里写好 dataset。 */
function previewSource(img) {
  const label = img.dataset.dragName || '图片';
  if (isHttp(img.dataset.dragUrl)) {
    return {uid: '', label, items: [{type: 'remote', url: img.dataset.dragUrl, name: label}]};
  }
  if (img.dataset.dragRoot && img.dataset.dragRel) {
    return {uid: '', label, items: [{type: 'local', root: img.dataset.dragRoot, rel: img.dataset.dragRel}]};
  }
  return null;
}

/** 本地图片素材包：单图给原图，多图集合给包内全部图片（PureRef 一次收一排、PS 开多文档）。 */
function packageSource(card, {packages}) {
  const key = card.dataset.package;
  const pkg = packages().find(item => `${item.root}|${item.rel}` === key);
  if (!pkg) return null;
  const label = pkg.title || '图片素材';
  const relOf = inner => pkg.rel ? `${pkg.rel}/${inner}` : inner;
  if (pkg.type === 'zip') return {uid: '', label, items: [{type: 'local', root: pkg.root, rel: pkg.rel}]};
  const images = (pkg.entries || []).filter(item => item?.rel && isImageName(item.name));
  if (images.length) {
    return {
      uid: '', label,
      items: images.slice(0, MAX_DRAG_FILES)
        .map(item => ({type: 'local', root: pkg.root, rel: relOf(item.rel)})),
    };
  }
  if (pkg.cover) return {uid: '', label, items: [{type: 'local', root: pkg.root, rel: relOf(pkg.cover)}]};
  return null;
}

/** 图站结果卡：data-url 是原图，卡片显示的 src 才是缩略图。视频不接管，留给网页版兜底。 */
function pictureSource(card) {
  const media = card.querySelector?.('.card-media img[data-url], .card-media video[data-url]');
  if (!media || media.dataset.type === 'video' || !isHttp(media.dataset.url)) return null;
  const label = media.dataset.title || '图片';
  return {uid: '', label, items: [{type: 'remote', url: media.dataset.url, name: label}]};
}

/** 资产库资产卡（3D 导出包 / 已下载的图集）：只说 uid，路径由服务端从任务记录里取。
 *  items 不再留空 —— 留空时前端只能把「一个文件夹」交出去，PS / PureRef 拿着目录没法用；
 *  交给服务端后，图集会摊成里面的每一张图，3D 导出包仍是那个 zip / glb。 */
function uidSource(card) {
  const uid = card.dataset.uid || '';
  if (!uid) return null;
  return {uid, label: card.querySelector?.('.card-title')?.textContent?.trim() || 'Arvimo · 艺团 资产', items: [{type: 'asset', uid}]};
}

/** 匹配顺序即优先级：本地包与图站卡互不重叠，uid 放最后兜底。 */
const CARD_SOURCES = [
  {match: card => !!card.querySelector?.('.card-media img[data-url]'), describe: pictureSource},
  {match: card => !!card.dataset.package, describe: packageSource},
  {match: card => !!card.dataset.uid, describe: uidSource},
];

const defaultPost = async items => {
  const response = await fetch('/api/drag/files', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-sfx-local': '1'},
    body: JSON.stringify({items}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
  return data;
};

/**
 * @param {object} options
 * @param {() => Array} options.packages  本地素材包快照（createLocalFiles().packages）
 * @param {(items:Array) => Promise<{files:string[]}>} [options.post] 注入，便于测试
 * @param {number} [options.warmDelay]    默认预热延迟，纯点击不该拉一张 4K 原图
 * @param {number} [options.ttl]          解析结果缓存多久（资产重下会换路径，别一直用旧的）
 */
export function createDragPayload({packages = () => [], post = defaultPost, warmDelay = 120, ttl = 30000} = {}) {
  const deps = {packages};
  const cache = new Map();
  let warmTimer = null;

  function sourceOf(target) {
    if (target?.closest?.('[data-preview-pan]')) return null;
    const preview = target?.closest?.('.local-gallery-photo[data-drag-url], .local-gallery-photo[data-drag-root]');
    if (preview) return previewSource(preview);
    const card = target?.closest?.('.model-card');
    if (!card) return null;
    for (const source of CARD_SOURCES) {
      if (!source.match(card)) continue;
      const described = source.describe(card, deps);
      if (described) return described;
    }
    return null;
  }

  /** 描述 → 绝对路径。同一批描述复用同一个 Promise：预热与真正拖拽只回源一次。 */
  function resolve(items) {
    const key = JSON.stringify(items);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    const promise = Promise.resolve(post(items)).then(data => {
      const files = Array.isArray(data?.files) ? data.files : [];
      if (!files.length) throw Error('没有可拖出的文件');
      return files;
    }).catch(error => { cache.delete(key); throw error; });
    cache.set(key, {at: Date.now(), promise});
    return promise;
  }

  function cancelWarm() {
    if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
  }

  /** 按下就预热：指针还要移动几像素才被判定成拖拽，这点时间足够把本地路径算好。 */
  function warm(target, {delay = warmDelay} = {}) {
    cancelWarm();
    const source = sourceOf(target);
    if (!source?.items.length) return;
    const prime = () => { warmTimer = null; void resolve(source.items).catch(() => {}); };
    if (delay <= 0) prime();
    else warmTimer = setTimeout(prime, delay);
  }

  /** 悬停预热：只对资产卡（本地路径换算，不联网）做，图站卡悬停就抓 4K 原图太浪费。 */
  function prefetch(target) {
    const source = sourceOf(target);
    if (!source?.items.length) return;
    if (source.items[0]?.type !== 'asset') return;
    void resolve(source.items).catch(() => {});
  }

  return {sourceOf, resolve, warm, prefetch, cancelWarm};
}
