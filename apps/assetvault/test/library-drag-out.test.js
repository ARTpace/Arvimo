import test from 'node:test';
import assert from 'node:assert/strict';
import {setupDragOut} from '../src/library/drag-out.js';

// ---- 为什么这批用例存在 ----
//
// 旧实现挂在 HTML5 dragstart 上：先取消网页拖拽，再等一次服务端解析，最后才起系统拖放。
// 这一圈走完鼠标通常已经松开了，Rust 的 QueryContinueDrag 一看左键不在就立刻 DROP，
// 拖拽当场消失 —— 用户看到的就是「资产库卡片完全拖不出去」。
//
// 现在改为指针驱动：按下预热、移过 5px 才起拖放。这里用最小 DOM 替身把这几条行为钉住，
// 免得以后又退回「点了没反应」或「点一下就被当成拖」。

function fakeTarget({card = null, img = null, blocked = false} = {}) {
  const self = {
    draggable: true,
    closest(selector) {
      if (blocked) {
        // 卡片底部按钮：命中 NO_DRAG 的第一个分支（button:not(.preview-hit)）
        if (/^button:not/.test(selector)) return {tagName: 'BUTTON'};
      }
      if (selector === '.model-card' && card) return card;
      if (selector === 'img' && img) return img;
      if (selector.startsWith('.local-gallery-photo')) return null;
      return null;
    },
    matches() { return false; },
  };
  return self;
}

function fakeCard(uid) {
  return {
    dataset: {uid},
    draggable: true,
    querySelector(selector) {
      if (selector.includes('img[data-url]')) return null;
      if (selector === '.card-title') return {textContent: '夜色参考'};
      return null;
    },
    querySelectorAll() { return []; },
  };
}

/** 装一次最小 window/document，返回派发事件的工具。 */
function mount({post, jobs = () => [], download = async () => {}, deferNativeDrag} = {}) {
  const handlers = new Map();
  const calls = [];
  const classList = new Set();
  const document = {
    documentElement: {classList: {add: name => classList.add(name), remove: (...names) => names.forEach(n => classList.delete(n))}},
    getElementById: () => null,
    addEventListener(type, handler) { handlers.set(type, handler); },
    removeEventListener(type) { handlers.delete(type); },
  };
  const invoke = async (name, args) => { calls.push({name, args}); return {exe: '', dropped: true, path: '', title: ''}; };
  globalThis.window = {__TAURI__: {core: {invoke}}};
  globalThis.document = document;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const teardown = setupDragOut({
    toast: () => {},
    jobs,
    download,
    send: async () => {},
    targetById: () => null,
    packages: () => [],
    deferNativeDrag,
    post: post || (async () => ({files: ['H:/library/packs/foo/01.png']})),
  });

  const fire = (type, event = {}) => {
    const handler = handlers.get(type);
    if (!handler) return;
    handler({
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 10,
      pointerType: 'mouse',
      preventDefault() {},
      stopPropagation() {},
      ...event,
    });
  };
  return {fire, calls, teardown, classList};
}

const flush = () => new Promise(resolve => setTimeout(resolve, 30));

test('桌面拦截器放行分类内部排序，仍阻止资产缩略图的网页拖动',()=>{
  const h=mount();let prevented=0;
  try{
    const category={closest:selector=>selector==='[data-category-order]'?{}:null};
    h.fire('dragstart',{target:category,preventDefault(){prevented++;}});
    assert.equal(prevented,0,'分类 dragstart 必须能继续触发 dragover/drop');
    h.fire('dragstart',{target:fakeTarget({card:fakeCard('a'.repeat(32))}),preventDefault(){prevented++;}});
    assert.equal(prevented,1,'资产仍交给原生真实文件拖出');
  }finally{h.teardown();}
});

test('原文件解析出错不能向外部软件拖出文件名文字', async () => {
  const target = fakeTarget({card:fakeCard('a'.repeat(32))});
  const h = mount({post:async()=>{throw Error('storage is not defined');}});
  try {
    h.fire('pointerdown',{target});
    h.fire('pointermove',{target,clientX:40});
    await flush();
    assert.equal(h.calls.length,0,'解析错误应提示失败，不发起文本拖放');
  } finally { h.teardown(); }
});

test('窗口内让位画板拖动，接近边缘后原生拖出真实文件',async()=>{
  const target=fakeTarget({card:fakeCard('a'.repeat(32))});
  const captures=[];
  target.setPointerCapture=id=>captures.push(['set',id]);
  target.releasePointerCapture=id=>captures.push(['release',id]);
  const h=mount({deferNativeDrag:event=>event.clientX<100});
  try{
    h.fire('pointerdown',{target,pointerId:7});h.fire('pointermove',{target,clientX:50});await flush();
    assert.equal(h.calls.length,0);
    assert.deepEqual(captures,[['set',7]],'窗口内拖动必须保留鼠标捕获');
    h.fire('pointermove',{target,clientX:100});await flush();
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'start_file_drag');
    assert.deepEqual(captures,[['set',7],['release',7]],'交给系统前释放捕获');
    h.fire('pointerup');
    h.fire('pointerdown',{target});
    h.fire('pointerout',{target,relatedTarget:null,clientX:110});await flush();
    assert.equal(h.calls.length,2,'快速跨出窗口也接续原生拖放');
  }finally{h.teardown();}
});

test('按住并移过阈值才起系统拖放，交给 Rust 的是解析出的真实路径', async () => {
  const card = fakeCard('a'.repeat(32));
  const target = fakeTarget({card, img: {draggable: true}});
  const asked = [];
  const {fire, calls, teardown} = mount({post: items => { asked.push(items); return {files: ['H:/library/01.png', 'H:/library/02.png']}; }});
  try {
    fire('pointerdown', {target});
    fire('pointermove', {target, clientX: 40, clientY: 10});
    await flush();
    assert.equal(calls.length, 1, '移过 5px 就应该起拖放');
    assert.equal(calls[0].name, 'start_file_drag');
    assert.deepEqual(calls[0].args.files, ['H:/library/01.png', 'H:/library/02.png']);
    assert.equal(calls[0].args.text, '', '有原件时仅发布文件，不混入卡片名称文本');
    assert.deepEqual(asked, [[{type: 'asset', uid: 'a'.repeat(32)}]]);
  } finally { teardown(); }
});

test('只是点一下卡片不会拖：没有位移就不调系统拖放', async () => {
  const card = fakeCard('b'.repeat(32));
  const target = fakeTarget({card});
  const {fire, calls, teardown} = mount();
  try {
    fire('pointerdown', {target});
    fire('pointermove', {target, clientX: 12, clientY: 11}, );
    fire('pointermove', {target, clientX: 12, clientY: 11});
    fire('pointerup', {target});
    await flush();
    assert.equal(calls.length, 0, '2px 的抖动仍然算点击');
  } finally { teardown(); }
});

test('卡片底部的下载 / 导出按钮按下时不会被抢走', async () => {
  const card = fakeCard('c'.repeat(32));
  const target = fakeTarget({card, blocked: true});
  const {fire, calls, teardown} = mount();
  try {
    fire('pointerdown', {target});
    fire('pointermove', {target, clientX: 40, clientY: 40});
    await flush();
    assert.equal(calls.length, 0);
  } finally { teardown(); }
});

test('已经松手才解析完的，不会再补一个「立刻取消」的拖拽', async () => {
  const card = fakeCard('d'.repeat(32));
  const target = fakeTarget({card});
  let release;
  const {fire, calls, teardown} = mount({post: () => new Promise(resolve => { release = () => resolve({files: ['H:/slow.png']}); })});
  try {
    fire('pointerdown', {target});
    fire('pointermove', {target, clientX: 40, clientY: 10});
    fire('pointerup', {target});
    release();
    await flush();
    assert.equal(calls.length, 0, '手已经松开，这时候拖放只会当场取消');
  } finally { teardown(); }
});

test('长按进入多选后取消待拖出状态，继续移动不触发系统拖放', async () => {
  const target=fakeTarget({card:fakeCard('f'.repeat(32))});
  const h=mount();
  try{
    h.fire('pointerdown',{target});
    h.fire('assetvault:selection-start');
    h.fire('pointermove',{target,clientX:80});
    await flush();
    assert.equal(h.calls.length,0);
  }finally{h.teardown();}
});

test('解析好的路径会被缓存，同一张卡第二次拖不再回源', async () => {
  let hits = 0;
  const card = fakeCard('e'.repeat(32));
  const target = fakeTarget({card});
  const {fire, calls, teardown} = mount({post: async () => { hits += 1; return {files: ['H:/x.png']}; }});
  try {
    for (let round = 0; round < 2; round += 1) {
      fire('pointerdown', {target});
      fire('pointermove', {target, clientX: 40, clientY: 10});
      await flush();
      fire('pointerup', {target});
    }
    assert.equal(hits, 1, '缓存 30 秒内同一批描述只解析一次');
    assert.equal(calls.length, 2);
  } finally { teardown(); }
});
