// 资产画布：把资产库的资产铺到一块可平移 / 缩放的无限画布上，自由摆放成 moodboard。
//
// 结构照 Artflow 的相机层（components/MainCanvas.tsx，ADR-051）：
//   stage（固定，overflow:hidden）
//     └ world（唯一携带相机变换的层）transform: translate(pan) scale(zoom) / origin 0 0
//         └ .cv-el × N（世界坐标绝对定位）
// 相机只挂 world 一层、不挂 stage 根节点：挂根节点会让整个视口每帧重栅格。
//
// 与 Artflow 的区别（也是这里只用了它三成代码的原因）：那边是 SVG + React + LOD 分档 + 视口裁剪，
// 面向十万级元素；画布这里是 DOM + 原生 img，面向几百张资产卡，靠浏览器自己的图片缓存即可。
// 抄的是机制（相机数学、拖动写 transform 松手落坐标、手柄换算），不是它的骨架。
import {
  CANVAS_VERSION, createCanvas, createCanvasWriter, elementsBounds,
  gridLayout, newId, normalizeCamera, normalizeElement, readCanvasDoc,
} from './canvas-store.js';
import {thumbSrc} from './image-src.js';

const Z_MIN = 0.05;
const Z_MAX = 6;
const CARD_MIN = 48;
const DRAG_SLOP = 3;        // 按下到拖动的最小平移（px），小于它算点击
const SNAP_PX = 6;          // 吸附判定的屏幕像素；换算成世界单位时要除以 zoom
const GRID_STEP = 8;
const HANDLE_SIZE = 9;

const KIND_LABEL = {image: '图片', video: '视频', model: '3D 模型', material: '材质', hdri: 'HDRI', doc: '文档', audio: '音频', font: '字体', file: '文件', ui: 'UI 元素'};
const KIND_ICON = {image: 'image', video: 'play', model: 'cube', material: 'grid', hdri: 'image', doc: 'list', audio: 'music', font: 'type', file: 'file', ui: 'grid'};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

export function createBoardCanvas(ctx = {}) {
  const {
    icon, esc, toast = () => {}, state, storage, findModel,
    localFiles, openPreview, doc = globalThis.document, win = globalThis.window,
    resolveModel, resolveLocalThumb, currentAssets,
  } = ctx;
  if (!doc) throw Error('画布缺少 document');

  const writer = createCanvasWriter(storage, {onError: () => toast?.('画布保存失败：本地存储空间可能已满')});
  let docState = readCanvasDoc(storage);
  let canvasEl = null;       // .cv-stage
  let worldEl = null;
  let layerEl = null;        // 元素层（手柄、选区单独一层，避免被元素裁切）
  let hudEl = null;
  let nodes = new Map();     // elementId -> DOM
  let selection = new Set();
  let camera = {x: 0, y: 0, z: 1};
  let activeId = docState.activeId;
  let spaceDown = false;
  let mounted = false;
  let lastPointer = {x: 0, y: 0};
  let interaction = null;
  let raf = 0;
  let guides = {x: [], y: []};

  const canvas = () => docState.canvases.find(item => item.id === activeId) || docState.canvases[0];
  const elements = () => canvas().elements;

  // ── 资产解析：uid 有可能指向资产库里已删除的条目，这里必须能返回 null，
  //    让画布画出「已失效」占位而不是整块崩掉。
  function modelOf(uid) {
    if (!uid) return null;
    if (/^local:/.test(uid)) return null;
    return resolveModel?.(uid) || findModel?.(uid) || state?.models?.find?.(m => m.uid === uid) || null;
  }

  function thumbUrl(element) {
    // 本地文件用 local:<root>|<rel> 作 uid（与 local-files.js 的 keyOf 同形），
    // 缩略图走它自己的 /api/local/thumb，不经过远端图床代理。
    const local = /^local:(.+)$/.exec(element.uid || '');
    if (local) {
      const [root, ...rest] = local[1].split('|');
      const rel = rest.join('|');
      return `/api/local/thumb?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}&w=512`;
    }
    if (element.src && /^(blob:|data:|https?:|\/)/.test(element.src)) {
      if (/^local:/.test(element.src)) return resolveLocalThumb?.(element.src) || '';
      return element.src;
    }
    const model = modelOf(element.uid);
    if (!model) return '';
    const raw = model.thumbnail || model.thumb || '';
    if (!raw) return '';
    return thumbSrc(raw);
  }

  function labelOf(element) {
    if (element.name) return element.name;
    const local = /^local:(.+)$/.exec(element.uid || '');
    if (local) {
      const parts = local[1].split('|');
      return parts[parts.length - 1] || '本地文件';
    }
    const model = modelOf(element.uid);
    return model?.name || model?.title || (element.uid ? '资产已移除' : '未命名');
  }

  /** 引用失效 = 有 uid 但资产库里查不到，且没有可直接显示的 src。本地文件永远不算失效。 */
  function isMissing(element) {
    if (!element.uid || /^local:/.test(element.uid) || element.src) return false;
    return !modelOf(element.uid);
  }

  // ── 相机 ────────────────────────────────────────────────────────────────────
  function applyCamera() {
    if (!worldEl) return;
    worldEl.style.transform = `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.z})`;
    paintHud();
  }

  function scheduleCamera() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; applyCamera(); });
  }

  /** 屏幕坐标 → 世界坐标。stage 的 rect 每帧取，避免侧边栏折叠后偏移。 */
  function toWorld(clientX, clientY) {
    const rect = canvasEl.getBoundingClientRect();
    return {x: (clientX - rect.left - camera.x) / camera.z, y: (clientY - rect.top - camera.y) / camera.z};
  }

  /** 以 (clientX,clientY) 为锚点缩放：锚点下的世界坐标在缩放前后必须落在同一屏幕位置。 */
  function zoomAt(clientX, clientY, factor) {
    const rect = canvasEl.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const next = clamp(camera.z * factor, Z_MIN, Z_MAX);
    if (Math.abs(next - camera.z) < 1e-4) return;
    const wx = (sx - camera.x) / camera.z;
    const wy = (sy - camera.y) / camera.z;
    camera.z = next;
    camera.x = sx - wx * next;
    camera.y = sy - wy * next;
    scheduleCamera();
    saveSoon();
  }

  function fitTo(bounds, {padding = 80, maxZoom = 1.4} = {}) {
    if (!bounds || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const availableW = Math.max(120, rect.width - padding * 2);
    const availableH = Math.max(120, rect.height - padding * 2);
    const zoom = clamp(Math.min(availableW / bounds.w, availableH / bounds.h), Z_MIN, maxZoom);
    camera.z = zoom;
    camera.x = (rect.width - bounds.w * zoom) / 2 - bounds.x * zoom;
    camera.y = (rect.height - bounds.h * zoom) / 2 - bounds.y * zoom;
    applyCamera();
    saveSoon();
  }

  function fitAll() {
    const all = elements();
    if (!all.length) { camera = {x: 0, y: 0, z: 1}; applyCamera(); return; }
    fitTo(elementsBounds(all));
  }

  function zoomTo(z) {
    if (!canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, clamp(z, Z_MIN, Z_MAX) / camera.z);
  }

  // ── 持久化 ─────────────────────────────────────────────────────────────────
  function saveSoon() {
    const current = canvas();
    current.camera = {...camera};
    current.updatedAt = Date.now();
    writer.write({version: CANVAS_VERSION, activeId, canvases: docState.canvases});
  }

  function commit() {
    const current = canvas();
    current.camera = {...camera};
    current.updatedAt = Date.now();
    writer.write({version: CANVAS_VERSION, activeId, canvases: docState.canvases});
    writer.flush();
    renderCanvasPicker();
  }

  // ── 渲染：元素 ──────────────────────────────────────────────────────────────
  function mediaHtml(element) {
    const url = thumbUrl(element);
    const kind = element.kind || 'image';
    if (url) {
      const contain = kind === 'material' || kind === 'hdri' || kind === 'model' ? ' is-contain' : '';
      return `<img class="cv-img${contain}" src="${esc(url)}" alt="" draggable="false" loading="lazy">`;
    }
    return `<div class="cv-ph" data-kind="${esc(kind)}">${icon(KIND_ICON[kind] || 'file')}<span>${esc(KIND_LABEL[kind] || '资产')}</span></div>`;
  }

  function badgeHtml(element) {
    const kind = element.kind || 'image';
    if (kind === 'image') return '';
    return `<span class="cv-badge">${icon(KIND_ICON[kind] || 'file')}${esc(KIND_LABEL[kind] || '')}</span>`;
  }

  function elementHtml(element) {
    return `<div class="cv-el${isMissing(element) ? ' is-missing' : ''}" data-el="${esc(element.id)}"
      style="left:${element.x}px;top:${element.y}px;width:${element.w}px;height:${element.h}px;transform:rotate(${element.rot || 0}deg);z-index:${element.z || 0}">
      <div class="cv-media">${mediaHtml(element)}${badgeHtml(element)}</div>
      <div class="cv-name">${esc(labelOf(element))}</div>
    </div>`;
  }

  function paintElement(node, element) {
    node.className = `cv-el${isMissing(element) ? ' is-missing' : ''}`;
    node.style.left = `${element.x}px`;
    node.style.top = `${element.y}px`;
    node.style.width = `${element.w}px`;
    node.style.height = `${element.h}px`;
    node.style.transform = `rotate(${element.rot || 0}deg)`;
    node.style.zIndex = String(element.z || 0);
  }

  /** 增量渲染：只增删差异节点。拖动期间不调用它（拖动直接改 style），松手才落一次。 */
  function renderElements() {
    if (!layerEl) return;
    const list = elements();
    const alive = new Set();
    for (const element of list) {
      alive.add(element.id);
      let node = nodes.get(element.id);
      if (!node) {
        const holder = doc.createElement('div');
        holder.innerHTML = elementHtml(element).trim();
        node = holder.firstElementChild;
        layerEl.appendChild(node);
        nodes.set(element.id, node);
      } else {
        paintElement(node, element);
        const media = node.querySelector('.cv-media');
        const url = thumbUrl(element);
        const img = media?.querySelector('img');
        if (url && !img) media.innerHTML = mediaHtml(element) + badgeHtml(element);
        else if (url && img && img.getAttribute('src') !== url) img.src = url;
        else if (!url && img) media.innerHTML = mediaHtml(element) + badgeHtml(element);
        const nameNode = node.querySelector('.cv-name');
        if (nameNode) nameNode.textContent = labelOf(element);
      }
      node.classList.toggle('is-selected', selection.has(element.id));
    }
    for (const [id, node] of nodes) if (!alive.has(id)) { node.remove(); nodes.delete(id); }
    paintHandles();
    paintHud();
    updateEmptyState();
  }

  function refresh() {
    if (!mounted) return;
    renderElements();
  }

  // ── 手柄与参考线 ────────────────────────────────────────────────────────────
  function selectedElements() {
    return elements().filter(element => selection.has(element.id));
  }

  function paintHandles() {
    const layer = canvasEl?.querySelector('#cv-overlay');
    if (!layer) return;
    const picked = selectedElements();
    if (!picked.length) { layer.innerHTML = ''; return; }
    const box = elementsBounds(picked);
    const single = picked.length === 1 ? picked[0] : null;
    const rotate = single ? `<button type="button" class="cv-handle cv-rotate" data-handle="rotate" aria-label="旋转"></button>` : '';
    layer.innerHTML = `<div class="cv-frame" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px">${rotate}</div>`;
  }

  function paintGuides() {
    const layer = canvasEl?.querySelector('#cv-guides');
    if (!layer) return;
    const bounds = elementsBounds(elements()) || {x: 0, y: 0, w: 1, h: 1};
    const pad = 4000;
    layer.innerHTML = [
      ...guides.x.map(x => `<i class="cv-guide-v" style="left:${x}px;top:${bounds.y - pad}px;height:${bounds.h + pad * 2}px"></i>`),
      ...guides.y.map(y => `<i class="cv-guide-h" style="top:${y}px;left:${bounds.x - pad}px;width:${bounds.w + pad * 2}px"></i>`),
    ].join('');
  }

  // ── 选中 ───────────────────────────────────────────────────────────────────
  function setSelection(ids, {silent = false} = {}) {
    selection = new Set(ids);
    for (const [id, node] of nodes) node.classList.toggle('is-selected', selection.has(id));
    paintHandles();
    paintHud();
    if (!silent) return;
  }

  function selectAll() { setSelection(elements().map(element => element.id)); }

  // ── 元素增删 ───────────────────────────────────────────────────────────────
  function elementFromAsset(asset, position) {
    if (!asset) return null;
    return normalizeElement({
      id: newId('e'),
      uid: asset.uid || '',
      src: asset.src || '',
      kind: asset.kind || 'image',
      name: asset.name || '',
      mime: asset.mime || '',
      x: position?.x ?? 0,
      y: position?.y ?? 0,
      w: num(asset.w, 260),
      h: num(asset.h, 200),
      z: elements().length,
    });
  }

  /** 往画布加资产。不传 position 时按网格排在既有内容右侧，避免全叠在原点。 */
  function addAssets(assets = [], {position = null, fit = true} = {}) {
    const list = (Array.isArray(assets) ? assets : [assets]).filter(Boolean);
    if (!list.length) return 0;
    const created = [];
    let cursor = position;
    if (!cursor) {
      const bounds = elementsBounds(elements());
      const startX = bounds ? bounds.x + bounds.w + 80 : 0;
      cursor = {x: startX, y: bounds ? bounds.y : 0};
    }
    const perColumn = 4;
    list.forEach((asset, index) => {
      const element = elementFromAsset(asset, {
        x: cursor.x + Math.floor(index / perColumn) * 300,
        y: cursor.y + (index % perColumn) * 240,
      });
      if (element) created.push(element);
    });
    if (!created.length) return 0;
    canvas().elements.push(...created);
    renderElements();
    if (fit) fitAll();
    commit();
    return created.length;
  }

  /** 把资产库当前筛选结果整批铺到画布（一次性铺开是 moodboard 的主流起点）。
   *  筛选结果在画布路由下可能是空数组（那一套筛选只对资产库视图求值），
   *  空数组是 truthy，所以不能光靠 `||` 回落 —— 必须显式看长度。 */
  function addFromLibrary({limit = 60, layout = true} = {}) {
    const picked = currentAssets?.() || [];
    const source = (picked.length ? picked : (state?.models || [])).slice(0, limit);
    const assets = source.map(model => ({
      uid: model.uid,
      kind: kindOfModel(model),
      name: model.name || model.title || '',
      w: 260,
      h: 200,
    }));
    if (!assets.length) { toast?.('资产库里没有可放进画布的资产'); return 0; }
    const bounds = elementsBounds(elements());
    const startX = bounds ? bounds.x + bounds.w + 80 : 0;
    const created = [];
    assets.forEach((asset, index) => {
      const element = elementFromAsset(asset, {
        x: startX + Math.floor(index / 4) * 292,
        y: (bounds?.y || 0) + (index % 4) * 232,
      });
      if (element) created.push(element);
    });
    canvas().elements.push(...created);
    if (layout) {
      const laid = gridLayout(canvas().elements, {gap: 28, columns: 0, startX: 0, startY: 0, maxWidth: 1600});
      canvas().elements = laid;
    }
    renderElements();
    fitAll();
    commit();
    toast?.(`已把 ${created.length} 个资产铺到画布`);
    return created.length;
  }

  function kindOfModel(model) {
    if (!model) return 'image';
    if (model.kind && KIND_LABEL[model.kind]) return model.kind;
    const platform = String(model.platform || '');
    const type = String(model.assetType || '');
    if (platform === 'uiverse') return 'ui';
    if (type === 'textures') return 'material';
    if (type === 'hdris') return 'hdri';
    if (type === 'models' || platform === 'sketchfab') return 'model';
    if (isVideoModel(model)) return 'video';
    const thumb = String(model.thumbnail || '');
    if (/\.(mp4|webm|mov)(\?|$)/i.test(thumb)) return 'video';
    return 'image';
  }

  function isVideoModel(model) {
    const platform = String(model.platform || '');
    return ['pexels', 'coverr', 'civitai', 'pixabay'].includes(platform) && String(model.assetType || '') === 'videos';
  }

  function removeSelection() {
    if (!selection.size) return;
    const current = canvas();
    current.elements = current.elements.filter(element => !selection.has(element.id));
    for (const id of selection) { nodes.get(id)?.remove(); nodes.delete(id); }
    const count = selection.size;
    selection.clear();
    paintHandles();
    paintHud();
    commit();
    toast?.(`已从画布移除 ${count} 个元素`);
  }

  function duplicateSelection() {
    const picked = selectedElements();
    if (!picked.length) return;
    const copies = picked.map(element => ({...element, id: newId('e'), x: element.x + 32, y: element.y + 32, z: elements().length}));
    canvas().elements.push(...copies);
    setSelection(copies.map(item => item.id));
    renderElements();
    commit();
  }

  function raiseSelection(toTop = true) {
    const picked = selectedElements();
    if (!picked.length) return;
    const zs = elements().map(element => element.z || 0);
    const base = toTop ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
    picked.forEach((element, index) => { element.z = base + index; });
    renderElements();
    commit();
  }

  function arrange() {
    const current = canvas();
    if (!current.elements.length) return;
    current.elements = gridLayout(current.elements, {gap: 28, columns: 0, startX: 0, startY: 0, maxWidth: 1600});
    renderElements();
    fitAll();
    commit();
  }

  // ── 交互：命中与坐标系 ──────────────────────────────────────────────────────
  function elementAt(clientX, clientY) {
    const target = doc.elementFromPoint(clientX, clientY);
    const hit = target?.closest?.('.cv-el');
    if (!hit || !layerEl?.contains(hit)) return null;
    return hit.dataset.el || null;
  }

  function beginInteraction(event) {
    if (event.button === 2) return;
    const handle = event.target.closest?.('.cv-handle');
    const hitId = handle ? [...selection][0] : elementAt(event.clientX, event.clientY);
    const start = toWorld(event.clientX, event.clientY);
    lastPointer = {x: event.clientX, y: event.clientY};

    // 中键 / 空格 / 右键拖动 = 平移（Artflow 同一套：空白拖动留给框选）。
    const panning = event.button === 1 || spaceDown || event.button === 2;
    if (panning) {
      interaction = {type: 'pan', startClient: {x: event.clientX, y: event.clientY}, startCam: {...camera}};
      canvasEl.classList.add('is-panning');
      event.preventDefault();
      return;
    }

    if (handle) {
      const picked = selectedElements();
      if (!picked.length) return;
      const box = elementsBounds(picked);
      interaction = {
        type: handle.dataset.handle === 'rotate' ? 'rotate' : 'resize',
        startWorld: start,
        box,
        items: picked.map(element => ({...element})),
        center: {x: box.x + box.w / 2, y: box.y + box.h / 2},
      };
      event.preventDefault();
      return;
    }

    if (hitId) {
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (additive) {
        if (selection.has(hitId)) selection.delete(hitId); else selection.add(hitId);
        setSelection([...selection]);
        if (!selection.has(hitId)) return;
      } else if (!selection.has(hitId)) {
        setSelection([hitId]);
      }
      const picked = selectedElements();
      interaction = {
        type: 'drag',
        startWorld: start,
        startClient: {x: event.clientX, y: event.clientY},
        moved: false,
        lastDelta: {dx: 0, dy: 0},
        items: picked.map(element => ({id: element.id, x: element.x, y: element.y, rot: element.rot || 0})),
      };
      return;
    }

    // 空白：开始框选；不清选区（按住 shift 追加）。
    if (!event.shiftKey) setSelection([]);
    interaction = {type: 'marquee', startWorld: start, startClient: {x: event.clientX, y: event.clientY}, base: [...selection]};
    const box = canvasEl.querySelector('#cv-marquee');
    if (box) { box.hidden = false; box.style.left = `${event.clientX - canvasEl.getBoundingClientRect().left}px`; box.style.top = `${event.clientY - canvasEl.getBoundingClientRect().top}px`; box.style.width = '0px'; box.style.height = '0px'; }
  }

  /** 拖动时的对齐吸附：拿被拖元素的外框与其他元素的三条竖线/横线比对，命中就推齐并亮参考线。 */
  function snapMove(items, dx, dy, activeId0) {
    const threshold = SNAP_PX / camera.z;
    const others = elements().filter(element => !items.some(item => item.id === element.id));
    if (!others.length) return {dx, dy};
    const ref = items.find(item => item.id === activeId0) || items[0];
    const source = elements().find(element => element.id === ref.id);
    if (!source) return {dx, dy};
    const w = source.w, h = source.h;
    const moving = {
      x: ref.x + dx, y: ref.y + dy,
      cx: ref.x + dx + w / 2, cy: ref.y + dy + h / 2,
      r: ref.x + dx + w, b: ref.y + dy + h,
    };
    let bestX = null, bestY = null;
    const vLines = [], hLines = [];
    for (const other of others) {
      vLines.push(other.x, other.x + other.w / 2, other.x + other.w);
      hLines.push(other.y, other.y + other.h / 2, other.y + other.h);
    }
    for (const line of vLines) {
      for (const [key, value] of [['x', moving.x], ['cx', moving.cx], ['r', moving.r]]) {
        const diff = line - value;
        if (Math.abs(diff) <= threshold && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) bestX = {diff, line};
      }
    }
    for (const line of hLines) {
      for (const [key, value] of [['y', moving.y], ['cy', moving.cy], ['b', moving.b]]) {
        const diff = line - value;
        if (Math.abs(diff) <= threshold && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) bestY = {diff, line};
      }
    }
    guides = {x: bestX ? [bestX.line] : [], y: bestY ? [bestY.line] : []};
    return {dx: dx + (bestX?.diff || 0), dy: dy + (bestY?.diff || 0)};
  }

  function onPointerMove(event) {
    if (!interaction) return;
    const start = interaction.startWorld;
    const now = toWorld(event.clientX, event.clientY);

    if (interaction.type === 'pan') {
      camera.x = interaction.startCam.x + (event.clientX - interaction.startClient.x);
      camera.y = interaction.startCam.y + (event.clientY - interaction.startClient.y);
      scheduleCamera();
      return;
    }

    if (interaction.type === 'drag') {
      const dx = now.x - start.x;
      const dy = now.y - start.y;
      if (!interaction.moved && Math.hypot(event.clientX - interaction.startClient.x, event.clientY - interaction.startClient.y) < DRAG_SLOP) return;
      interaction.moved = true;
      // 吸附只按「被按住的那张卡」算，其余选中项跟着同一个位移走 —— 逐个吸附会让多选散架。
      const snapped = snapMove(interaction.items, dx, dy, interaction.items[0]?.id);
      interaction.lastDelta = snapped;
      for (const item of interaction.items) {
        const node = nodes.get(item.id);
        if (!node) continue;
        node.style.transform = `translate(${snapped.dx}px, ${snapped.dy}px) rotate(${item.rot || 0}deg)`;
      }
      paintGuides();
      return;
    }

    if (interaction.type === 'marquee') {
      const rect = canvasEl.getBoundingClientRect();
      const x0 = Math.min(interaction.startClient.x, event.clientX) - rect.left;
      const y0 = Math.min(interaction.startClient.y, event.clientY) - rect.top;
      const w = Math.abs(event.clientX - interaction.startClient.x);
      const h = Math.abs(event.clientY - interaction.startClient.y);
      const box = canvasEl.querySelector('#cv-marquee');
      if (box) { box.hidden = false; box.style.left = `${x0}px`; box.style.top = `${y0}px`; box.style.width = `${w}px`; box.style.height = `${h}px`; }
      const a = {x: Math.min(start.x, now.x), y: Math.min(start.y, now.y), w: Math.abs(now.x - start.x), h: Math.abs(now.y - start.y)};
      const hits = elements().filter(element => !(element.x > a.x + a.w || element.x + element.w < a.x || element.y > a.y + a.h || element.y + element.h < a.y)).map(element => element.id);
      setSelection([...new Set([...interaction.base, ...hits])], {silent: true});
      return;
    }

    if (interaction.type === 'resize') {
      const box = interaction.box;
      const dx = now.x - start.x;
      const dy = now.y - start.y;
      const ratio = box.h / box.w;
      const nextW = Math.max(CARD_MIN, box.w + dx);
      const nextH = Math.max(CARD_MIN, nextW * ratio);
      const scaleX = nextW / box.w;
      const scaleY = nextH / box.h;
      for (const item of interaction.items) {
        const element = elements().find(entry => entry.id === item.id);
        if (!element) continue;
        element.x = box.x + (item.x - box.x) * scaleX;
        element.y = box.y + (item.y - box.y) * scaleY;
        element.w = Math.max(CARD_MIN, item.w * scaleX);
        element.h = Math.max(CARD_MIN, item.h * scaleY);
        const node = nodes.get(element.id);
        if (node) paintElement(node, element);
      }
      paintHandles();
      return;
    }

    if (interaction.type === 'rotate') {
      const center = interaction.center;
      const angle = Math.atan2(now.y - center.y, now.x - center.x) * 180 / Math.PI - 90;
      const element = elements().find(entry => entry.id === interaction.items[0].id);
      if (element) {
        element.rot = Math.round(((angle % 360) + 360) % 360);
        const node = nodes.get(element.id);
        if (node) paintElement(node, element);
        paintHandles();
      }
      return;
    }
  }

  function onPointerUp() {
    if (!interaction) return;
    const finished = interaction;
    interaction = null;
    canvasEl.classList.remove('is-panning');
    const marquee = canvasEl.querySelector('#cv-marquee');
    if (marquee) marquee.hidden = true;
    guides = {x: [], y: []};
    paintGuides();

    if (finished.type === 'drag' && finished.moved) {
      const {dx, dy} = finished.lastDelta || {dx: 0, dy: 0};
      for (const item of finished.items) {
        const element = elements().find(entry => entry.id === item.id);
        if (!element) continue;
        element.x = Math.round(item.x + dx);
        element.y = Math.round(item.y + dy);
        const node = nodes.get(element.id);
        if (node) paintElement(node, element);
      }
      renderElements();
      commit();
      return;
    }
    if (finished.type === 'pan') { saveSoon(); return; }
    if (finished.type === 'resize' || finished.type === 'rotate') { commit(); return; }
    if (finished.type === 'drag' && !finished.moved) { paintHandles(); }
  }

  // ── HUD / 工具条 ────────────────────────────────────────────────────────────
  function paintHud() {
    if (!hudEl) return;
    const zoom = Math.round(camera.z * 100);
    const zoomNode = hudEl.querySelector('#cv-zoom-value');
    if (zoomNode) zoomNode.textContent = `${zoom}%`;
    const count = hudEl.querySelector('#cv-count');
    if (count) count.textContent = String(elements().length);
    const sel = hudEl.querySelector('#cv-sel-count');
    if (sel) sel.textContent = selection.size ? `已选 ${selection.size}` : '';
  }

  function renderCanvasPicker() {
    const select = hudEl?.querySelector('#cv-picker');
    if (!select) return;
    select.innerHTML = docState.canvases
      .map(item => `<option value="${esc(item.id)}"${item.id === activeId ? ' selected' : ''}>${esc(item.name)} · ${item.elements.length}</option>`)
      .join('');
  }

  // ── 拖入 ───────────────────────────────────────────────────────────────────
  function onDragOver(event) {
    if (!event.dataTransfer?.types?.includes?.('application/x-av-uid') && !event.dataTransfer?.types?.includes?.('text/plain')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    canvasEl.classList.add('is-drop');
  }

  function onDrop(event) {
    canvasEl.classList.remove('is-drop');
    const raw = event.dataTransfer?.getData('application/x-av-uid') || event.dataTransfer?.getData('text/plain') || '';
    if (!raw) return;
    event.preventDefault();
    const position = toWorld(event.clientX, event.clientY);
    const payloads = parseDragPayload(raw);
    const assets = payloads.map(item => toAsset(item)).filter(Boolean);
    if (!assets.length) { toast?.('没有识别到可放进画布的资产'); return; }
    // 落点居中：把第一张卡放在指针位置的中心，其余向右下错开。
    const first = assets[0];
    const originX = position.x;
    const originY = position.y;
    const placed = assets.map((asset, index) => elementFromAsset(asset, {
      x: originX + index * 28, y: originY + index * 28,
    })).filter(Boolean);
    canvas().elements.push(...placed);
    renderElements();
    setSelection(placed.map(item => item.id));
    commit();
    toast?.(`已放入 ${placed.length} 个资产`);
  }

  function parseDragPayload(raw) {
    const value = String(raw || '').trim();
    if (!value) return [];
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch { return []; }
    }
    return value.split(/\s+/).filter(Boolean).map(token => ({uid: token}));
  }

  function toAsset(item) {
    const uid = item.uid || item.id || '';
    if (uid) {
      const model = modelOf(uid);
      if (!model) return {uid, kind: item.kind || 'image', name: item.name || '', w: 260, h: 200};
      return {uid, kind: item.kind || kindOfModel(model), name: model.name || model.title || '', w: 260, h: 200};
    }
    if (item.url) return {src: item.url, kind: item.kind || 'image', name: item.name || '', w: 260, h: 200};
    return null;
  }

  // ── 打开原预览 ─────────────────────────────────────────────────────────────
  function openElement(element) {
    const model = modelOf(element.uid);
    if (openPreview) {
      try { openPreview(model || {uid: element.uid, name: labelOf(element), thumbnail: element.src}); return; }
      catch { /* 预览层不可用时退回新窗口 */ }
    }
    if (element.src) { win?.open?.(element.src, '_blank', 'noopener'); return; }
    if (model) {
      const raw = model.thumbnail || '';
      if (raw) win?.open?.(thumbSrc(raw, {full: true}), '_blank', 'noopener');
      else toast?.('这个资产没有可打开的缩略图');
    }
  }

  // ── 键盘 ───────────────────────────────────────────────────────────────────
  function onKeyDown(event) {
    if (state?.route !== 'canvas') return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
    if (event.code === 'Space') { spaceDown = true; canvasEl?.classList.add('is-space'); }
    if (event.key === 'Escape') { setSelection([]); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection.size) { event.preventDefault(); removeSelection(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); selectAll(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection(); return; }
    if (event.key === '0' && !event.ctrlKey && !event.metaKey) { fitAll(); return; }
    if (event.key === '1' && !event.ctrlKey && !event.metaKey) { zoomTo(1); return; }
    if (event.key.startsWith('Arrow') && selection.size) {
      event.preventDefault();
      const step = event.shiftKey ? GRID_STEP * 2 : 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      for (const element of selectedElements()) { element.x += dx; element.y += dy; }
      renderElements();
      commit();
    }
  }

  function onKeyUp(event) {
    if (event.code === 'Space') { spaceDown = false; canvasEl?.classList.remove('is-space'); }
  }

  // ── 装配 ───────────────────────────────────────────────────────────────────
  function buildStage() {
    return `<div class="cv-stage" id="cv-stage">
      <div class="cv-world" id="cv-world">
        <div class="cv-layer" id="cv-layer"></div>
        <div class="cv-overlay" id="cv-overlay"></div>
        <div class="cv-guides" id="cv-guides"></div>
      </div>
      <div class="cv-marquee" id="cv-marquee" hidden></div>
      <div class="cv-empty" id="cv-empty" hidden>
        <div class="cv-empty-ico">${icon('layers')}</div>
        <h3>这块画布还是空的</h3>
        <p>把资产库里的卡片拖进来，或点右上角「铺开当前筛选」，一次把一屏素材摆成 moodboard。</p>
      </div>
    </div>`;
  }

  function mount() {
    if (mounted) return;
    const host = doc.querySelector('#canvas-view');
    if (!host) return;
    activeId = docState.activeId;
    camera = normalizeCamera(canvas().camera);
    host.innerHTML = `<div class="cv-shell">
      <div class="cv-bar" id="cv-bar">
        <label class="cv-picker-wrap" title="切换画布">
          <i data-icon="layers"></i>
          <select id="cv-picker" aria-label="选择画布"></select>
        </label>
        <button type="button" class="tb-btn" id="cv-new" title="新建一块空画布">${icon('plus')}<span class="tb-label">新建</span></button>
        <button type="button" class="tb-btn" id="cv-rename" title="重命名当前画布">${icon('edit')}<span class="tb-label">重命名</span></button>
        <span class="cv-sep"></span>
        <button type="button" class="tb-btn" id="cv-add" title="把资产库当前筛选结果一次铺到画布">${icon('grid')}<span class="tb-label">铺开当前筛选</span></button>
        <button type="button" class="tb-btn" id="cv-arrange" title="把所有元素重新排成网格（快捷键 0 前先整理）">${icon('sliders')}<span class="tb-label">整理</span></button>
        <button type="button" class="tb-btn" id="cv-delete" title="删除选中元素（Delete）">${icon('trash')}<span class="tb-label">删除</span></button>
        <span class="cv-grow"></span>
        <span class="cv-count-wrap"><b id="cv-count">0</b> 个元素 <em id="cv-sel-count"></em></span>
        <span class="cv-sep"></span>
        <button type="button" class="cv-zoom-btn" id="cv-zoom-out" title="缩小">${icon('minus')}</button>
        <button type="button" class="cv-zoom-value" id="cv-zoom-value" title="点击回到 100%（快捷键 1）">100%</button>
        <button type="button" class="cv-zoom-btn" id="cv-zoom-in" title="放大">${icon('plus')}</button>
        <button type="button" class="tb-btn" id="cv-fit" title="适应窗口（快捷键 0）">${icon('refresh')}<span class="tb-label">适应</span></button>
      </div>
      ${buildStage()}
    </div>`;
    hudEl = host.querySelector('#cv-bar');
    canvasEl = host.querySelector('#cv-stage');
    worldEl = host.querySelector('#cv-world');
    layerEl = host.querySelector('#cv-layer');

    renderCanvasPicker();
    renderElements();
    applyCamera();

    canvasEl.addEventListener('pointerdown', event => {
      if (event.target.closest?.('.cv-bar')) return;
      // capture 只是为了指针移出 stage 后仍能收到 move；个别合成事件（自动化驱动、
      // 某些触控笔）给不出有效 pointerId，这里失败不能连累后面的命中判定。
      try { canvasEl.setPointerCapture?.(event.pointerId); } catch {}
      beginInteraction(event);
    });
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', onPointerUp);
    canvasEl.addEventListener('pointercancel', onPointerUp);
    canvasEl.addEventListener('wheel', event => {
      event.preventDefault();
      if (event.shiftKey) { camera.x -= event.deltaY; scheduleCamera(); saveSoon(); return; }
      if (event.altKey) { camera.y -= event.deltaY; scheduleCamera(); saveSoon(); return; }
      const factor = Math.exp(-event.deltaY * 0.0016);
      zoomAt(event.clientX, event.clientY, factor);
    }, {passive: false});
    canvasEl.addEventListener('dragover', onDragOver);
    canvasEl.addEventListener('dragleave', () => canvasEl.classList.remove('is-drop'));
    canvasEl.addEventListener('drop', onDrop);
    canvasEl.addEventListener('dblclick', event => {
      const id = elementAt(event.clientX, event.clientY);
      const element = elements().find(entry => entry.id === id);
      if (element) openElement(element);
    });
    canvasEl.addEventListener('contextmenu', event => {
      // 右键留给平移；在元素上右键则弹一个精简菜单。
      const id = elementAt(event.clientX, event.clientY);
      if (!id) { event.preventDefault(); return; }
      event.preventDefault();
      if (!selection.has(id)) setSelection([id]);
      showContextMenu(event.clientX, event.clientY);
    });

    hudEl.addEventListener('click', event => {
      const target = event.target.closest('button, .cv-zoom-value');
      if (!target) return;
      const id = target.id;
      if (id === 'cv-new') { createNewCanvas(); return; }
      if (id === 'cv-rename') { renameCanvas(); return; }
      if (id === 'cv-add') { addFromLibrary(); return; }
      if (id === 'cv-arrange') { arrange(); return; }
      if (id === 'cv-delete') { removeSelection(); return; }
      if (id === 'cv-zoom-in') { zoomTo(camera.z * 1.25); return; }
      if (id === 'cv-zoom-out') { zoomTo(camera.z / 1.25); return; }
      if (id === 'cv-zoom-value') { zoomTo(1); return; }
      if (id === 'cv-fit') { fitAll(); return; }
    });
    hudEl.querySelector('#cv-picker')?.addEventListener('change', event => {
      activeId = event.target.value;
      docState.activeId = activeId;
      camera = normalizeCamera(canvas().camera);
      nodes.forEach(node => node.remove());
      nodes.clear();
      selection.clear();
      renderElements();
      applyCamera();
      commit();
    });

    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('keyup', onKeyUp);
    // 从资产库拖卡片进画布：卡片本身早就是 draggable=true（library-view.js 里设的），
    // 这里只补一次「把 uid 写进 dataTransfer」的委托，不改卡片的渲染。
    // 桌面版 drag-out.js 会摘掉 HTML5 draggable（它自己接管拖到系统），那条路径下用「铺开当前筛选」。
    doc.addEventListener('dragstart', event => {
      const card = event.target?.closest?.('.model-card[data-uid], .local-file-card[data-file]');
      if (!card || !event.dataTransfer) return;
      const uid = card.dataset.uid || (card.dataset.file ? `local:${card.dataset.file}` : '');
      if (!uid) return;
      event.dataTransfer.setData('application/x-av-uid', uid);
      event.dataTransfer.setData('text/plain', uid);
      event.dataTransfer.effectAllowed = 'copy';
    });
    win?.addEventListener('resize', () => applyCamera());
    mounted = true;
    updateEmptyState();
  }

  function updateEmptyState() {
    const empty = doc.querySelector('#cv-empty');
    if (empty) empty.hidden = elements().length > 0;
  }

  function createNewCanvas() {
    const created = createCanvas(`画布 ${docState.canvases.length + 1}`);
    docState.canvases.push(created);
    activeId = created.id;
    docState.activeId = activeId;
    camera = {x: 0, y: 0, z: 1};
    nodes.forEach(node => node.remove());
    nodes.clear();
    selection.clear();
    renderElements();
    applyCamera();
    renderCanvasPicker();
    commit();
    updateEmptyState();
  }

  function renameCanvas() {
    const current = canvas();
    const name = win?.prompt?.('画布名称', current.name);
    if (!name) return;
    current.name = String(name).slice(0, 60);
    renderCanvasPicker();
    commit();
  }

  function showContextMenu(clientX, clientY) {
    doc.querySelector('.cv-menu')?.remove();
    const menu = doc.createElement('div');
    menu.className = 'cv-menu';
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    menu.innerHTML = `
      <button type="button" data-cv-act="top">${icon('layers')}置顶</button>
      <button type="button" data-cv-act="bottom">${icon('layers')}置底</button>
      <button type="button" data-cv-act="duplicate">${icon('copy')}复制一份</button>
      <button type="button" data-cv-act="open">${icon('image')}打开原资产</button>
      <button type="button" data-cv-act="remove" class="is-danger">${icon('trash')}从画布移除</button>`;
    doc.body.appendChild(menu);
    const close = () => { menu.remove(); doc.removeEventListener('pointerdown', outside, true); };
    const outside = event => { if (!menu.contains(event.target)) close(); };
    setTimeout(() => doc.addEventListener('pointerdown', outside, true), 0);
    menu.addEventListener('click', event => {
      const action = event.target.closest('[data-cv-act]')?.dataset.cvAct;
      if (!action) return;
      if (action === 'top') raiseSelection(true);
      if (action === 'bottom') raiseSelection(false);
      if (action === 'duplicate') duplicateSelection();
      if (action === 'remove') removeSelection();
      if (action === 'open') { const element = selectedElements()[0]; if (element) openElement(element); }
      close();
    });
  }

  return {
    mount,
    refresh: () => { if (mounted) renderElements(); },
    addAssets,
    addFromLibrary,
    fitAll,
    get elementCount() { return elements().length; },
  };
}
