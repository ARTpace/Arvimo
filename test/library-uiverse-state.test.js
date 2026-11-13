// Uiverse 解析层的契约测试。
//
// 这一层全是纯函数，所以用合成 fixture 覆盖「站点会怎么变脸」就够：
// 链接的四种形态、类型路径的复数映射（站点只认路径段）、
// Shadow DOM 里 :root 必须换成 :host、@import 要提前、预览文档与落盘文件的形态。
//
// 真实站点结构变了，先在这里补一条 fixture —— 比对着线上 JSON 猜要快得多。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UIVERSE_TYPES, UIVERSE_TYPE_PATHS, UIVERSE_TYPE_LABELS,
  parseUiverseUrl, parseUiverseList, parseUiversePost, parseUiverseCode,
  toShadowCss, splitCssImports, buildPreviewDocument, buildStandaloneFiles,
  uiverseTitle, uiverseListPath,
} from '../server/uiverse-state.mjs';

test('链接的四种形态都能认出来', () => {
  assert.deepEqual(
    {type: parseUiverseUrl('https://uiverse.io/alexruix/tame-fly-42').type, user: parseUiverseUrl('https://uiverse.io/alexruix/tame-fly-42').username},
    {type: 'element', user: 'alexruix'},
  );
  assert.equal(parseUiverseUrl('https://uiverse.io/profile/alexruix').type, 'profile');
  assert.equal(parseUiverseUrl('https://uiverse.io/profile/alexruix').username, 'alexruix');
  assert.equal(parseUiverseUrl('https://uiverse.io/loaders').type, 'category');
  assert.equal(parseUiverseUrl('https://uiverse.io/loaders').elementType, 'loader');
  assert.equal(parseUiverseUrl('https://uiverse.io/elements?search=button&theme=dark').type, 'list');
  assert.equal(parseUiverseUrl('https://uiverse.io/elements?search=button').search, 'button');
  assert.equal(parseUiverseUrl('https://uiverse.io/elements?theme=dark').theme, 'dark');
});

test('认不出来的链接返回 unknown 而不是抛错', () => {
  assert.equal(parseUiverseUrl('').type, 'unknown');
  assert.equal(parseUiverseUrl('不是网址').type, 'unknown');
  assert.equal(parseUiverseUrl('https://example.com/a/b').type, 'unknown');
  assert.equal(parseUiverseUrl('https://uiverse.io/').type, 'unknown');
});

test('类型只认路径段：类型过滤必须换路径，不能加参数', () => {
  // 站点实测：/elements?type=loader 照样返回全部条目，只有 /loaders 才真的只出 loader。
  assert.equal(uiverseListPath({elementType: 'loader'}), '/loaders');
  assert.equal(uiverseListPath({elementType: 'button'}), '/buttons');
  assert.equal(uiverseListPath({elementType: 'radio'}), '/radio-buttons');
  assert.equal(uiverseListPath({}), '/elements');
  assert.equal(uiverseListPath({search: 'button'}), '/elements', '只给关键词时走总列表');
});

test('类型路径表必须是复数，不能由单数别名取反', () => {
  // loaders 与 loader 都映射到 loader，取反会让单数别名胜出 → 请求 /loader → 站点不认。
  assert.equal(UIVERSE_TYPE_PATHS.loader, 'loaders');
  for (const type of UIVERSE_TYPES) {
    assert.ok(UIVERSE_TYPE_PATHS[type], `${type} 缺路径`);
    assert.ok(UIVERSE_TYPE_PATHS[type].endsWith('s') || UIVERSE_TYPE_PATHS[type].includes('-'), `${type} 的路径不是复数`);
  }
  assert.ok(UIVERSE_TYPE_LABELS.loader, '每个类型都有中文标签');
});

test('列表 JSON → 条目：缺关键字段的条目被丢掉', () => {
  const parsed = parseUiverseList({
    posts: [
      {id: 'id-1', friendlyId: 'cuddly-dingo-93', type: 'loader', theme: 'light', isTailwind: false, version: 2, user: {username: 'Mahmoud-walid'}},
      {id: '', friendlyId: 'no-id', type: 'loader', user: {username: 'x'}},
      {id: 'id-2', friendlyId: '', type: 'loader', user: {username: 'x'}},
    ],
    currentPage: 0, hasNextPage: true, postsCount: 1217,
  });
  assert.equal(parsed.items.length, 1, '缺 id 或 slug 的条目被丢掉');
  assert.equal(parsed.items[0].slug, 'cuddly-dingo-93');
  assert.equal(parsed.items[0].username, 'Mahmoud-walid');
  assert.equal(parsed.items[0].version, 2);
  assert.equal(parsed.total, 1217);
  assert.equal(parsed.hasNextPage, true);
});

test('列表 payload 形状不对时返回空列表而不是崩', () => {
  assert.deepEqual(parseUiverseList(null).items, []);
  assert.deepEqual(parseUiverseList({}).items, []);
  assert.deepEqual(parseUiverseList({posts: '不是数组'}).items, []);
});

test('详情 JSON → 元数据：标签去重，作者与页面地址齐全', () => {
  const post = parseUiversePost({
    post: {
      id: 'id-1', friendlyId: 'tame-fly-42', type: 'loader', theme: 'dark',
      isTailwind: true, version: 3, viewCount: 9412,
      user: {username: 'alexruix', name: 'Alex Rui'},
      post_tag: [{tag: {value: 'animated'}}, {tag: {value: 'shadow'}}, {tag: {value: 'animated'}}],
      backgroundColor: '#111827',
    },
  });
  assert.equal(post.username, 'alexruix');
  assert.equal(post.authorName, 'Alex Rui');
  assert.deepEqual(post.tags, ['animated', 'shadow'], '重复标签被去掉');
  assert.equal(post.viewCount, 9412);
  assert.equal(post.isTailwind, true);
  assert.equal(post.pageUrl, 'https://uiverse.io/alexruix/tame-fly-42');
  assert.equal(post.authorUrl, 'https://uiverse.io/profile/alexruix');
});

test('详情 payload 没有 post 时返回 null', () => {
  assert.equal(parseUiversePost(null), null);
  assert.equal(parseUiversePost({}), null);
});

test('代码 JSON → html + css，缺字段时给空串而不是 undefined', () => {
  assert.deepEqual(parseUiverseCode({html: '<div class="a"></div>', css: '.a{}'}), {html: '<div class="a"></div>', css: '.a{}'});
  assert.deepEqual(parseUiverseCode({}), {html: '', css: ''});
  assert.deepEqual(parseUiverseCode(null), {html: '', css: ''});
});

test('Shadow DOM 里 :root 匹配不到东西，必须换成 :host', () => {
  // 不换的话，写在 :root 里的 CSS 变量全部失效 —— Uiverse 的元素大量依赖它们定义主题色。
  assert.equal(toShadowCss(':root{--x:1}'), ':host{--x:1}');
  assert.equal(toShadowCss(':root'), ':host');
  assert.equal(toShadowCss('.a{color:red}'), '.a{color:red}');
});

test('@import 被摘出来单独放前面（Shadow DOM 里没有 link 可挂）', () => {
  const {imports, css} = splitCssImports('@import url("https://x/a.css");.a{color:red}');
  assert.equal(imports.length, 1);
  assert.match(imports[0], /a\.css/);
  assert.equal(css.trim(), '.a{color:red}');
});

test('预览文档是完整的一份 HTML，代码与样式都在里面', () => {
  const doc = buildPreviewDocument({html: '<div class="a"></div>', css: '.a{color:red}'});
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /<div class="a"><\/div>/);
  assert.match(doc, /\.a\{color:red\}/);
  assert.match(doc, /<style>/);
});

test('预览文档带上元素自己的背景色', () => {
  const doc = buildPreviewDocument({html: '<b></b>', css: '', backgroundColor: '#111827'});
  assert.match(doc, /background:#111827/);
});

test('预览文档（弹窗用）必须保留 :root，绝不能转成 :host', () => {
  // 弹窗是独立 iframe 文档，:root 指向文档根、照常生效；
  // 若误转 :host（只在 Shadow DOM 里有效），Tailwind 的 --tw-* 等变量会全部失效。
  const css = ':root{--tw-bg-opacity:1;--primary:#fbca1f;}\n.box{background:var(--primary);opacity:var(--tw-bg-opacity);}';
  const doc = buildPreviewDocument({html: '<div class="box"></div>', css});
  assert.ok(doc.includes(':root'), '弹窗文档应保留 :root 变量定义');
  assert.ok(!doc.includes(':host'), '弹窗文档绝不能有 :host');
  assert.ok(doc.includes('--tw-bg-opacity'), 'CSS 变量应原样保留');
});

test('落盘文件是 index.html + style.css 两份，样式走相对路径 link', () => {
  const {html, css} = buildStandaloneFiles({html: '<div class="a"></div>', css: '.a{color:red}', title: '加载动画 · x'});
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.match(html, /<title>加载动画 · x<\/title>/);
  assert.match(html, /<div class="a"><\/div>/);
  assert.match(css, /\.a\{color:red\}/);
});

test('落盘文件的 title 里的尖括号被剥掉（不能注入 HTML）', () => {
  const {html} = buildStandaloneFiles({html: '', css: '', title: '<script>alert(1)</script>'});
  assert.doesNotMatch(html, /<script>/);
});

test('标题用类型 + slug 拼出来', () => {
  assert.equal(uiverseTitle({elementType: 'loader', slug: 'cuddly-dingo-93'}), '加载动画 · cuddly-dingo-93');
  assert.equal(uiverseTitle({elementType: 'unknown-type', slug: 'x'}), 'UI 组件 · x');
  assert.equal(uiverseTitle({}), 'UI 组件');
});
