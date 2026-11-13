// 画布数据层：只负责「把画布这份文档存下来」，不碰 DOM、不认识资产。
//
// 为什么单独一层：画布的写入频率极高（拖一次元素会连写几十次），而读取只在进页面时发生一次。
// 把节流、版本迁移、脏数据兜底收在这里，渲染层就能安心地「每次交互结束就 commit 一次」。
//
// 元素模型（世界坐标，单位 px）：
//   {id, uid, kind, x, y, w, h, rot, z, src, name, mime}
//   uid  → 远端/本地资产的唯一 id，渲染时回资产库查；查不到说明资产被删了，画布显示失效占位。
//   src  → 直接可显示的 URL（本地文件、拖进来的外链），与 uid 二选一。
// 相机模型：{x, y, z}，world 层 transform = translate(x,y) scale(z)。
export const CANVAS_KEY = 'sfx-canvas-v1';
export const CANVAS_VERSION = 1;
export const ELEMENT_LIMIT = 3000;
const WRITE_DELAY = 400;
const Z_MIN = 0.02;
const Z_MAX = 8;

const isNum = v => Number.isFinite(Number(v));
const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
const text = v => typeof v === 'string' ? v : '';

export function newId(prefix = 'c') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 相机归一化：z 夹在可用区间，x/y 必须是有限数，否则回落到原点。 */
export function normalizeCamera(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    x: isNum(raw.x) ? Number(raw.x) : 0,
    y: isNum(raw.y) ? Number(raw.y) : 0,
    z: clamp(isNum(raw.z) ? raw.z : 1, Z_MIN, Z_MAX) || 1,
  };
}

/** 单个元素归一化。缺 id/坐标的元素直接丢，避免一条脏记录把整块画布拖坏。 */
export function normalizeElement(input) {
  if (!input || typeof input !== 'object') return null;
  const id = text(input.id);
  if (!id) return null;
  const kind = text(input.kind) || 'image';
  const element = {
    id,
    uid: text(input.uid),
    kind,
    x: isNum(input.x) ? Number(input.x) : 0,
    y: isNum(input.y) ? Number(input.y) : 0,
    w: clamp(isNum(input.w) ? input.w : 240, 16, 20000),
    h: clamp(isNum(input.h) ? input.h : 180, 16, 20000),
    rot: isNum(input.rot) ? Number(input.rot) % 360 : 0,
    z: isNum(input.z) ? Math.round(Number(input.z)) : 0,
    src: text(input.src),
    name: text(input.name).slice(0, 200),
    mime: text(input.mime).slice(0, 60),
  };
  if (!element.uid && !element.src) return null;
  return element;
}

export function normalizeCanvas(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const elements = (Array.isArray(raw.elements) ? raw.elements : [])
    .map(normalizeElement).filter(Boolean).slice(0, ELEMENT_LIMIT);
  const now = Date.now();
  return {
    id: text(raw.id) || newId(),
    name: text(raw.name).slice(0, 60) || '未命名画布',
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    camera: normalizeCamera(raw.camera),
    elements,
  };
}

export function createCanvas(name = '') {
  const now = Date.now();
  return {id: newId(), name: name || '未命名画布', createdAt: now, updatedAt: now, camera: {x: 0, y: 0, z: 1}, elements: []};
}

export function readCanvasDoc(storage) {
  let parsed = null;
  try {
    const raw = storage?.getItem?.(CANVAS_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch { parsed = null; }
  const doc = parsed && typeof parsed === 'object' ? parsed : {};
  let canvases = (Array.isArray(doc.canvases) ? doc.canvases : []).map(normalizeCanvas);
  if (!canvases.length) canvases = [createCanvas('我的画布')];
  const activeId = canvases.some(c => c.id === doc.activeId) ? doc.activeId : canvases[0].id;
  return {version: CANVAS_VERSION, activeId, canvases};
}

/** 节流写盘。同一毫秒内的多次 commit 合并成一次 JSON.stringify —— 拖拽期间这是主要开销。 */
export function createCanvasWriter(storage, {delay = WRITE_DELAY, onError = () => {}} = {}) {
  let timer = 0;
  let pending = null;
  const flush = () => {
    timer = 0;
    if (!pending) return;
    const payload = pending;
    pending = null;
    try { storage?.setItem?.(CANVAS_KEY, JSON.stringify(payload)); }
    catch (error) { onError(error); }
  };
  return {
    write(doc) {
      pending = doc;
      if (timer) return;
      timer = setTimeout(flush, delay);
    },
    flush() {
      if (timer) clearTimeout(timer);
      flush();
    },
  };
}

/** 元素在画布上的几何包围盒（忽略旋转，用于框选与「适应窗口」；旋转后略大一圈可以接受）。 */
export function elementBounds(element) {
  return {x: element.x, y: element.y, w: element.w, h: element.h};
}

export function elementsBounds(elements = []) {
  if (!elements.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const element of elements) {
    minX = Math.min(minX, element.x);
    minY = Math.min(minY, element.y);
    maxX = Math.max(maxX, element.x + element.w);
    maxY = Math.max(maxY, element.y + element.h);
  }
  return {x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY)};
}

/** 把一组元素按目标列数排成网格，返回新坐标。整理画布 / 一键铺开资产都用它。 */
export function gridLayout(elements, {gap = 24, columns = 0, startX = 0, startY = 0, maxWidth = 0} = {}) {
  if (!elements.length) return [];
  const cellW = Math.max(...elements.map(e => e.w));
  const cellH = Math.max(...elements.map(e => e.h));
  const cols = columns > 0 ? columns : Math.max(1, Math.floor((maxWidth || cellW * Math.ceil(Math.sqrt(elements.length))) / (cellW + gap)));
  return elements.map((element, index) => ({
    ...element,
    x: startX + (index % cols) * (cellW + gap),
    y: startY + Math.floor(index / cols) * (cellH + gap),
    z: index,
  }));
}
