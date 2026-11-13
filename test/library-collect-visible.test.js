import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// 批量入库：「搜完一屏 → 一次收完」。它原先只存在于卡片右上角那颗 opacity:0 的勾选框里
// ——必须先 hover 才看得见，用户会直接判定「这个功能没有」。这几条断言钉住：入口常驻、
// 只收未入库的、明确不触发下载。最后一条防止库上限文案再次和真实常量分叉。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('src/library/index.html');
const app = read('src/library/app.js');
const view = read('src/library/library-view.js');
const css = read('src/library/app.css');

test('结果区常驻批量入库入口，不再只靠卡片 hover 勾选', () => {
  assert.ok(html.includes('id="result-actions"'), '要有独立的结果操作条');
  assert.ok(html.includes('id="collect-visible"'), '要有批量入库按钮');
  assert.ok(html.includes('id="result-collectible"'), '要显示还能收多少条');
  assert.ok(/id="result-actions"[^>]*hidden/.test(html), '默认隐藏，交给渲染层按路由决定');
  assert.ok(css.includes('.result-actions{'), '样式要跟着进 app.css');
});

test('批量入库只收未入库的资产，并明确说明不下载文件', () => {
  assert.ok(app.includes("$('#collect-visible').onclick"), '按钮要绑点击事件');
  assert.ok(app.includes('const collected=new Set(state.models.map(model=>model.uid))'),
    '先算出已入库集合，避免重复收集');
  assert.ok(app.includes('filter(model=>!collected.has(model.uid))'), '只挑未入库的');
  assert.ok(app.includes('不下载文件'), '确认弹窗必须写明只保存记录 —— 收藏不等于下载');
  assert.ok(app.includes('collect(pick.map(model=>model.uid))'),
    '复用现成的 collect()，不要另写一套入库逻辑');
});

test('顶部功能栏不再摆批量入库（2026-11-12），节点与事件契约保留', () => {
  assert.ok(view.includes("$('#result-actions').hidden=true"), '图站解析结果有自己的操作条，要隐藏');
  assert.ok(view.includes('actions.hidden=true'), '按反馈撤下「全部入库」，渲染层一律保持隐藏');
  assert.ok(!view.includes('actions.hidden=!online||!models.length'), '旧的「有结果就点亮」逻辑不能留');
});

test('库上限文案跟随常量，不再写死 1000', () => {
  assert.ok(app.includes('模型库已达 ${LIBRARY_LIMIT} 个'), '上限要引用 LIBRARY_LIMIT');
  assert.ok(!app.includes('模型库已达 1000 个'), '写死的 1000 会和真实上限分叉');
});
