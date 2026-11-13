// 资产画布：tldraw 引擎 + 资产库的资产 shape。
//
// 为什么是 tldraw 而不是手写：画布上的交互面极宽（选择/框选/多选/吸附/编队/锁定/撤销/
// 复制粘贴/绘制/文字/便签/箭头/图层顺序/导出…），手写只能一条一条补，永远补不完。
// tldraw 是一套完整白板内核，这些全在里面；我们只负责两件它不知道的事：
//   1. 一种自定义 shape（av-asset），把资产库的资产画成卡、并且知道它引用的 uid；
//   2. 与资产库的连接（资产被删 → 卡片显示失效；缩略图走 /api/image 代理）。
//
// 打包：单独 bundle（canvas-app.js），由 app.js 动态 import。tldraw + react 约 1MB，
// 不能拖进首屏 —— 只有进「画布」这一屏才会下载。
import React, {useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {
  Tldraw, BaseBoxShapeUtil, HTMLContainer, createShapeId, T,
  getSnapshot, loadSnapshot,
} from 'tldraw';
import tldrawCss from 'tldraw/tldraw.css';

const KIND_LABEL = {image: '图片', video: '视频', model: '3D 模型', material: '材质', hdri: 'HDRI', doc: '文档', audio: '音频', font: '字体', file: '文件', ui: 'UI 元素'};
const ASSET_TYPE = 'av-asset';
const CARD_W = 260;
const CARD_H = 200;

// 资产解析走 context：shape 组件拿不到外部闭包，但每个 shape 都要问「这个 uid 现在是什么」。
const ResolveContext = React.createContext(() => null);

function styleOnce(id, css) {
  if (document.getElementById(id)) return;
  const tag = document.createElement('style');
  tag.id = id;
  tag.textContent = css;
  document.head.appendChild(tag);
}

/** 自定义资产卡：图片 + 类型角标 + 名称条 + 失效态。
 *  BaseBoxShapeUtil 给了框选、缩放、旋转、对齐吸附、编队等全部行为，
 *  这里只需要决定「框里画什么」。 */
class AssetShapeUtil extends BaseBoxShapeUtil {
  static type = ASSET_TYPE;
  // tldraw 5.x 用 static props 声明这张卡有哪些字段：schema 靠它建立，
  // 少写会让 createShapes 的记录通不过校验 —— 表现是「shape 计数有了，屏幕上什么都没有」。
  static props = {
    w: T.number,
    h: T.number,
    uid: T.string,
    src: T.string,
    kind: T.string,
    name: T.string,
  };

  getDefaultProps() {
    return {w: CARD_W, h: CARD_H, uid: '', src: '', kind: 'image', name: ''};
  }

  canResize() { return true; }
  canEdit() { return false; }
  hideResizeHandles() { return false; }
  isAspectRatioLocked() { return false; }
  getShapeName() { return '资产'; }

  component(shape) {
    const resolve = useContext(ResolveContext);
    const {uid, src, kind, name} = shape.props;
    const live = useMemo(() => (resolve ? resolve(uid) : null), [resolve, uid]);
    const url = live?.src || src || '';
    const label = live?.name || name || '资产';
    const missing = Boolean(uid) && !live && !src;
    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          borderRadius: 11,
          overflow: 'hidden',
          background: '#151c25',
          border: '1px solid ' + (missing ? '#5a3a3a' : '#2a3543'),
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'all',
        }}
      >
        <div style={{position: 'relative', flex: 1, minHeight: 0, background: '#1a222c'}}>
          {url
            ? <img src={url} alt="" draggable={false}
                style={{width: '100%', height: '100%', objectFit: kind === 'material' || kind === 'hdri' || kind === 'model' ? 'contain' : 'cover', display: 'block'}}/>
            : <div className="avc-ph">{KIND_LABEL[kind] || '资产'}</div>}
          {kind && kind !== 'image'
            ? <span className="avc-badge">{KIND_LABEL[kind] || kind}</span>
            : null}
          {missing
            ? <span className="avc-badge avc-missing">已从资产库移除</span>
            : null}
        </div>
        <div className="avc-name" title={label}>{label}</div>
      </HTMLContainer>
    );
  }

  // tldraw 5.x 不再渲染 SVG indicator，改用 getIndicatorPath 返回 Path2D。
  getIndicatorPath(shape) {
    const path = new Path2D();
    const {w, h} = shape.props;
    path.roundRect(0, 0, w, h, 11);
    return path;
  }
}

const SHAPE_UTILS = [AssetShapeUtil];

/** 快照读写：每个画布一条 localStorage key，tldraw 的 document + session 一起存。 */
function readSnapshot(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function CanvasApp({resolve, canvasKey, onReady, onCountChange}) {
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const saveTimer = useRef(0);

  const persist = useCallback((editor) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try { localStorage.setItem(canvasKey, JSON.stringify(getSnapshot(editor.store))); }
      catch { /* 配额满时放弃这一轮，画布本身仍在内存里 */ }
    }, 400);
  }, [canvasKey]);

  const handleMount = useCallback((editor) => {
    editorRef.current = editor;
    const snap = readSnapshot(canvasKey);
    if (snap) {
      try { loadSnapshot(editor.store, snap); } catch { /* 旧快照结构不兼容时从空画布开始 */ }
    }
    editor.store.listen(() => persist(editor), {scope: 'document', source: 'user'});
    editor.store.listen(() => onCountChange?.(editor.getCurrentPageShapeIds().size), {scope: 'document'});

    // 从资产库拖卡片进来：卡片 dragstart 写的是 application/x-av-uid。
    // 必须在捕获阶段接住 —— tldraw 自己也监听 drop，让它先拿到就变成「上传文件」了。
    const host = hostRef.current;
    const onDrop = event => {
      const uid = event.dataTransfer?.getData('application/x-av-uid') || '';
      if (!uid) return;
      event.preventDefault();
      event.stopPropagation();
      const point = editor.screenToPage({x: event.clientX, y: event.clientY});
      const asset = resolve?.(uid);
      const id = createShapeId();
      editor.createShapes([{
        id, type: ASSET_TYPE,
        x: point.x - CARD_W / 2, y: point.y - CARD_H / 2,
        props: {w: CARD_W, h: CARD_H, uid, src: asset?.src || '', kind: asset?.kind || 'image', name: asset?.name || ''},
      }]);
      editor.select(id);
    };
    const onDragOver = event => {
      if (event.dataTransfer?.types?.includes?.('application/x-av-uid')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    };
    host?.addEventListener('dragover', onDragOver, true);
    host?.addEventListener('drop', onDrop, true);

    onReady?.({
      editor,
      addAssets(list, {center = true} = {}) { return addAssets(editor, list, {center}); },
      fit() { editor.zoomToFit({animation: {duration: 220}}); },
      arrange() {
        // tldraw 没有「一键排成网格」，但缩放适配 + 对齐到网格已经够用；
        // 这里做的是把所有资产卡按当前顺序重排成 4 列（用户要的是「整理」）。
        const ids = editor.getCurrentPageShapeIds();
        const shapes = [...ids].map(id => editor.getShape(id)).filter(s => s && s.type === ASSET_TYPE);
        if (!shapes.length) return;
        const gap = 28;
        editor.updateShapes(shapes.map((shape, index) => ({
          id: shape.id,
          type: shape.type,
          x: Math.floor(index / 4) * (CARD_W + gap),
          y: (index % 4) * (CARD_H + gap),
        })));
        editor.zoomToFit({animation: {duration: 220}});
      },
      count() { return editor.getCurrentPageShapeIds().size; },
    });

    return () => {
      host?.removeEventListener('dragover', onDragOver, true);
      host?.removeEventListener('drop', onDrop, true);
    };
  }, [canvasKey, persist, resolve, onReady, onCountChange]);

  return (
    <div ref={hostRef} style={{position: 'absolute', inset: 0}}>
      <Tldraw
        shapeUtils={SHAPE_UTILS}
        onMount={handleMount}
        inferDarkMode
        autoFocus
      />
    </div>
  );
}

function addAssets(editor, list, {center = true} = {}) {
  const assets = (Array.isArray(list) ? list : [list]).filter(Boolean);
  if (!assets.length) return 0;
  // 铺开坐标：tldraw 的默认相机停在页面原点附近，直接从 0 开始铺，
  // 后面统一 zoomToFit 把它们收进视野 —— 比自己算视口中心稳。
  const originX = 0;
  const originY = 0;
  const shapes = assets.map((asset, index) => ({
    id: createShapeId(),
    type: ASSET_TYPE,
    x: originX + Math.floor(index / 4) * (CARD_W + 28),
    y: originY + (index % 4) * (CARD_H + 28),
    props: {
      w: CARD_W, h: CARD_H,
      uid: asset.uid || '',
      src: asset.src || '',
      kind: asset.kind || 'image',
      name: asset.name || '',
    },
  }));
  editor.createShapes(shapes);
  editor.select(...shapes.map(shape => shape.id));
  // 选区取的是「刚建好的这些」，不依赖 getSelectionPageBounds 的返回值形态。
  const bounds = editor.getSelectionPageBounds?.();
  if (bounds) editor.zoomToBounds?.(bounds, {animation: {duration: 220}});
  else editor.zoomToFit?.({animation: {duration: 220}});
  return shapes.length;
}

const CSS = `
.avc-ph{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#6d7e91;font-size:12px;font-weight:500}
.avc-badge{position:absolute;left:8px;top:8px;display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:6px;
  background:#0b1119cc;backdrop-filter:blur(6px);font-size:10px;color:#c6d2df;letter-spacing:.2px}
.avc-badge.avc-missing{left:auto;right:8px;background:#3a1f1fcc;color:#f0b4a6}
.avc-name{padding:7px 9px;font-size:11px;line-height:1.5;color:#dfe7ef;background:#111820;border-top:1px solid #222c38;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;

/** 挂载到 #canvas-view。返回一个手柄对象，外部只通过它操作画布。 */
export function mountCanvas(host, {resolve, canvasId = 'default', onChange} = {}) {
  if (!host) throw Error('画布容器不存在');
  styleOnce('av-canvas-tldraw', tldrawCss);
  styleOnce('av-canvas-shape', CSS);
  const canvasKey = `sfx-tldraw-${canvasId}-v1`;
  let api = null;
  const root = createRoot(host);
  root.render(
    <CanvasApp
      resolve={resolve}
      canvasKey={canvasKey}
      onReady={handle => { api = handle; onChange?.({count: handle.count()}); }}
      onCountChange={count => onChange?.({count})}
    />
  );
  return {
    get ready() { return Boolean(api); },
    get editor() { return api?.editor || null; },
    addAssets(list, options) { return api?.addAssets(list, options) || 0; },
    fit() { api?.fit(); },
    arrange() { api?.arrange(); },
    count() { return api?.count?.() || 0; },
    unmount() { root.unmount(); },
  };
}
