// UI 元素预览模块的契约测试。
//
// 这里是纯 DOM 逻辑（Shadow DOM 挂载、占位、源码拼装），用最小 DOM 替身就能测：
// 关键是「代码没到位时不能白屏」「取不到代码要有话说」「复制出去的单文件能直接跑」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {uiSourceText, toShadowCss} from '../src/library/ui-element-preview.js';

test('源码拼成单文件形态：HTML 一段 + 内联 style 一段', () => {
  const text = uiSourceText(
    {name: '加载动画 · x', url: 'https://uiverse.io/a/b'},
    {html: '<div class="ball"></div>', css: '@keyframes spin{to{transform:rotate(360deg)}}'},
  );
  assert.match(text, /<div class="ball"><\/div>/);
  assert.match(text, /<style>/);
  assert.match(text, /@keyframes spin/);
  assert.match(text, /<!-- 加载动画 · x · https:\/\/uiverse\.io\/a\/b -->/, '注释里带标题与来源');
});

test('没有代码时给空串（不产出半截没用的东西）', () => {
  assert.equal(uiSourceText({name: 'x'}, {}), '');
  assert.equal(uiSourceText({}, {html: '', css: ''}), '');
});

test('模型上已有代码时不必再传第二份', () => {
  const text = uiSourceText({html: '<p>x</p>', css: 'p{color:red}'});
  assert.match(text, /<p>x<\/p>/);
  assert.match(text, /p\{color:red\}/);
});

test('标题里的尖括号不会破坏注释结构', () => {
  const text = uiSourceText({name: 'a --> b'}, {html: '<i></i>', css: ''});
  // 注释以 --> 收尾，标题里再出现一个 --> 会提前闭合注释，往后的内容就跑到注释外面了。
  const line = text.split('\n')[0];
  assert.equal((line.match(/-->/g) || []).length, 1, '整行只有一个注释闭合符');
});

test('卡片 Shadow DOM 里 :root 必须换成 :host（变量才不会失效）', () => {
  // 卡片挂在 Shadow DOM 里，:root 指向文档根、匹配不到，依赖它的 --tw-* 变量会全失效。
  // 换成 :host（指向挂载 Shadow 的那个元素）才是正确的样式根。弹窗文档不在此列。
  assert.equal(toShadowCss(':root{--x:1}'), ':host{--x:1}');
  assert.equal(toShadowCss(':root'), ':host');
  assert.equal(toShadowCss('.a{color:red}'), '.a{color:red}');
  // 只换 :root 这个选择器，别误伤 :root-ish 这种不存在的写法（正则 \b 边界保证）。
  assert.equal(toShadowCss(':rootish{color:blue}'), ':rootish{color:blue}');
});
