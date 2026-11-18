// 拖入导入只接「从窗口外面拖进来的文件」。
//
// 站内自己拖出去的东西（桌面版走原生拖放、网页版走 HTML5 拖拽）落回窗口时，drop 里的
// dataTransfer 同样是 Files —— 若不分家，在发现页打开大图、按住拖一下画面（本意是平移看
// 细节），松手就会弹出「导入到资产库」。这里用两条标记把这条岔路钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {setupDropImport} from '../src/library/drop-import.js';

/** 最小装配：只要 body / 事件 / 一句 toast 就够判断「这次 drop 有没有被当成导入」。 */
function mount(className = '') {
  const {document, window} = parseHTML(`<html class="${className}"><body></body></html>`);
  // drop-import 用 `instanceof Element` 判断落点，Node 里没有这个全局，用桩补上。
  globalThis.Element = window.Element;
  const notes = [];
  const store = {flat: () => [], refresh: async () => {}, addItems: async () => {}, create: async () => 'board'};
  setupDropImport({toast: text => notes.push(text), visitor: false, store, document});
  const drop = async () => {
    const event = new window.Event('drop', {bubbles: true});
    Object.assign(event, {
      dataTransfer: {types: ['Files'], items: [], files: []},
      preventDefault() {},
      stopPropagation() {},
    });
    document.dispatchEvent(event);
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return {document, notes, drop};
}

test('站内原生拖放（drag-out-active）落回窗口不算导入', async () => {
  const {notes, drop} = mount('drag-out-active');
  await drop();
  assert.deepEqual(notes, []);
});

test('网页版站内拖拽（self-drag）落回窗口不算导入', async () => {
  const {notes, drop} = mount('self-drag');
  await drop();
  assert.deepEqual(notes, []);
});

test('从外面拖进来仍然走导入（这里以「没有可导入的文件」作为进入分支的凭证）', async () => {
  const {notes, drop} = mount('');
  await drop();
  assert.deepEqual(notes, ['没有可导入的文件']);
});
