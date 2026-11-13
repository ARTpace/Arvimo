// 封面探测缓存：给颜色 / 宽高比筛选补上缺失的元数据层。
//
// 为什么在浏览器做：服务端没有 sharp/ffprobe，装新原生依赖会破坏 Tauri sidecar 的装配体积；
// 卡片封面本来就走同源 /api/image 代理，用 canvas 取 64×64 像素即可，零新依赖、零后端改动。
// 取色算法移植自 Serpent src/worker/palette-extractor.ts（MIT）：4096-bin 量化直方图 +
// 确定性 k-means，取占比最大的代表色；查询只比对这一个主色，不逐样本比整张色卡。
//
// 结果写进主状态 state.assetProbe[uid]（走既有差量写入通道），服务端派生索引把它注入
// payload 供查询层读；它是可重建的缓存，删掉不影响资产本身。
import {hexToHsl} from './color-filter.js';

export const PROBE_VERSION = 1;
export const PROBE_DEFAULTS = Object.freeze({
  size: 64, concurrency: 3, batchSize: 16, saveDelayMs: 1200, maxPerRun: 600,
});

const BINS = 4096;
const hexOf = (r, g, b) => `#${[r, g, b]
  .map(value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/**
 * RGBA 像素 → 代表主色。先按每通道高 4 bit 量化成 4096 个 bin，再对 bin 中心做加权 k-means，
 * 最后取权重最大簇的中心色。返回 {hex,h,s,l}，取不到颜色返回 null。
 */
export function probeFromPixels(data, width, height, channels = 4) {
  const count = Math.max(1, Math.min(Number(width) || 1, 4096)) * Math.max(1, Math.min(Number(height) || 1, 4096));
  const bins = new Array(BINS);
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1] || 0, b = data[i + 2] || 0;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const entry = bins[key] || (bins[key] = {r: (key >> 8) * 16 + 8, g: ((key >> 4) & 15) * 16 + 8,
      b: (key & 15) * 16 + 8, weight: 0});
    entry.weight++;
  }
  const seeds = bins.filter(Boolean).sort((a, b) => b.weight - a.weight).slice(0, 6)
    .map(item => ({r: item.r, g: item.g, b: item.b, weight: 0}));
  if (!seeds.length) return null;
  let winner = seeds[0];
  for (let round = 0; round < 4; round++) {
    const next = seeds.map(seed => ({r: seed.r, g: seed.g, b: seed.b, weight: 0, sr: 0, sg: 0, sb: 0}));
    for (const item of bins) {
      if (!item) continue;
      let best = 0, bestDistance = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const dr = item.r - seeds[i].r, dg = item.g - seeds[i].g, db = item.b - seeds[i].b;
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) { bestDistance = distance; best = i; }
      }
      const target = next[best];
      target.weight += item.weight;
      target.sr += item.r * item.weight;
      target.sg += item.g * item.weight;
      target.sb += item.b * item.weight;
    }
    for (const cluster of next) {
      if (!cluster.weight) continue;
      cluster.r = cluster.sr / cluster.weight;
      cluster.g = cluster.sg / cluster.weight;
      cluster.b = cluster.sb / cluster.weight;
    }
    winner = [...next].sort((a, b) => b.weight - a.weight)[0] || winner;
    seeds.splice(0, seeds.length, ...next.map(item => ({r: item.r, g: item.g, b: item.b, weight: item.weight})));
  }
  const hex = hexOf(winner.r, winner.g, winner.b);
  const hsl = hexToHsl(hex);
  return hsl ? {hex, ...hsl, samples: count} : null;
}

/** 缩略图 URL：已经是本地代理就直接用，远程/裸路径统一包一层同源代理。 */
export function probeUrl(thumbnail) {
  const value = String(thumbnail || '').trim();
  if (!value) return '';
  if (/^(data:|blob:|\/api\/image\?)/i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return `/api/image?url=${encodeURIComponent(value)}`;
  return value;
}

/** 校验写回前的探测结果：与 state-mutations.js 的 validateProbe 语义保持一致。 */
export function isValidProbe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!/^#[0-9a-f]{6}$/i.test(value.hex || '')) return false;
  return [value.h, value.s, value.l, value.width, value.height, value.at]
    .every(item => Number.isFinite(Number(item)));
}

async function loadImage(url, ImageCtor) {
  const image = new ImageCtor();
  image.decoding = 'async';
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(Error('封面加载失败'));
    image.src = url;
  });
  return image;
}

/** 从一张图片（URL 或已加载的 <img>）取样；canvas 被跨域图污染时安静跳过。 */
export async function probeImage(input, {doc = globalThis.document, ImageCtor = globalThis.Image,
  size = PROBE_DEFAULTS.size} = {}) {
  if (!doc || typeof doc.createElement !== 'function') return null;
  const image = typeof input === 'string' ? await loadImage(input, ImageCtor) : input;
  if (!image?.naturalWidth || !image?.naturalHeight) return null;
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext?.('2d', {willReadFrequently: true});
  if (!context) return null;
  context.drawImage(image, 0, 0, size, size);
  let pixels;
  try { pixels = context.getImageData(0, 0, size, size); }
  catch { return null; }
  const color = probeFromPixels(pixels.data, size, size, 4);
  if (!color) return null;
  return {
    v: PROBE_VERSION, hex: color.hex, h: color.h, s: color.s, l: color.l,
    width: image.naturalWidth, height: image.naturalHeight, at: Date.now(),
  };
}

/**
 * 探测调度器。state/save 由 app.js 注入；doc/ImageCtor 可替换以便单测。
 * 可见卡片优先（DOM 里已经解码过的图，零额外请求），全库后台扫描按需手动启动。
 */
export function createAssetProbe({state, save = () => {}, models = () => state.models || [],
  doc = globalThis.document, ImageCtor = globalThis.Image,
  config = {}, onProgress = () => {}} = {}) {
  const options = {...PROBE_DEFAULTS, ...config};
  const map = () => (state.assetProbe && typeof state.assetProbe === 'object' ? state.assetProbe : (state.assetProbe = {}));
  let timer = null, running = false, stopFlag = false, done = 0, saved = 0;

  const has = uid => !!uid && !!map()[uid];
  const total = () => models().filter(model => model?.uid && model?.thumbnail).length;
  const missing = () => models().filter(model => model?.uid && model?.thumbnail && !has(model.uid));

  const scheduleSave = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; save(); }, options.saveDelayMs);
  };
  const flush = () => { if (timer) { clearTimeout(timer); timer = null; save(); } };
  const progress = extra => onProgress({done, saved, total: total(), running, ...extra});

  async function probeOne(model, element = null) {
    if (has(model.uid)) return false;
    const source = element?.src || probeUrl(model.thumbnail);
    if (!source) return false;
    let probe = null;
    try { probe = await probeImage(element || source, {doc, ImageCtor, size: options.size}); }
    catch { return false; }
    if (!probe || !isValidProbe(probe)) return false;
    map()[model.uid] = probe;
    saved++;
    scheduleSave();
    return true;
  }

  /** renderGrid 之后调：只采当前已渲染的卡片，命中已解码的 <img>，不额外发请求。 */
  async function scanVisible(root = doc?.querySelector?.('#grid')) {
    if (!root) return 0;
    const byUid = new Map(models().map(model => [model.uid, model]));
    const nodes = [...root.querySelectorAll('.model-card[data-uid]')].map(card => ({
      uid: card.dataset.uid, img: card.querySelector('img.thumbnail'),
    })).filter(item => item.uid && item.img && byUid.has(item.uid) && !has(item.uid));
    let added = 0;
    for (let i = 0; i < nodes.length; i += options.concurrency) {
      const batch = nodes.slice(i, i + options.concurrency);
      const results = await Promise.all(batch.map(item => probeOne(byUid.get(item.uid), item.img).catch(() => false)));
      added += results.filter(Boolean).length;
    }
    flush();
    progress();
    return added;
  }

  /** 全库后台扫描：分批 + 并发上限 + 可停止；默认一次最多 maxPerRun 项，避免首启烧带宽。 */
  async function scanAll({limit = options.maxPerRun} = {}) {
    if (running) return 0;
    running = true; stopFlag = false; done = 0;
    const queue = missing().slice(0, Math.max(0, Number(limit) || options.maxPerRun));
    let index = 0;
    const worker = async () => {
      while (!stopFlag && index < queue.length) {
        const model = queue[index++];
        await probeOne(model);
        done++;
        if (done % options.batchSize === 0) progress();
      }
    };
    try {
      await Promise.all(Array.from({length: Math.min(options.concurrency, queue.length)}, worker));
    } finally {
      flush(); running = false; progress();
    }
    return saved;
  }

  return {
    has, total, missing: () => missing().length,
    get running() { return running; },
    probeOne, scanVisible, scanAll,
    stop() { stopFlag = true; },
    stats: () => ({done, saved, total: total(), missing: missing().length, running}),
  };
}
