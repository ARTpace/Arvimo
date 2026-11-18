import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
  MODE_TABS, CONTENT_KINDS, FORMAT_TO_ID, LOCAL_KINDS_OF_MODE, modeAllowsLocalKind, modeTabs, modeTabById, kindById,
  contentKindsOf, activeModeId, savedMode, rememberMode, createContentKindTabs,
} from '../src/library/content-kind-tabs.js';
import {paths} from '../src/library/icon-set.js';
import {modePresetById} from '../src/library/mode-presets.js';

const read = name => readFileSync(new URL(`../src/library/${name}`, import.meta.url), 'utf8');

test('模式轨：固定 5 个常驻图标，没有「全部」、没有计数、没有平台', () => {
  // 2026-11 新增 ui 模式（Uiverse），顺序即 mode-presets.js 的 MODE_PRESETS。
  assert.deepEqual(MODE_TABS.map(entry => entry.id), ['images', 'models', 'ui', 'documents', 'videos', 'audio']);
  assert.deepEqual(MODE_TABS.map(entry => entry.label), ['图片', '3D 资产', 'UI', '文档', '视频', '音频']);
  assert.ok(!MODE_TABS.some(entry => entry.id === 'all'));
  assert.equal(Object.isFrozen(MODE_TABS), true);
  assert.equal(modeTabs(), MODE_TABS, '常驻集合不认 route / counts，永远是这 4 个');
  assert.equal(modeTabById('all'), null);
  assert.equal(modeTabById('images').mode, 'image');
  assert.equal(modeTabById('models').mode, 'model');
  for (const entry of MODE_TABS) assert.ok(paths[entry.icon], `${entry.id} 缺图标 ${entry.icon}`);
  for (const entry of CONTENT_KINDS) assert.ok(paths[entry.icon], `${entry.id} 缺图标 ${entry.icon}`);
  assert.equal(new Set(CONTENT_KINDS.map(entry => entry.id)).size, CONTENT_KINDS.length);
  assert.equal(kindById('nope'), null);
  assert.equal(FORMAT_TO_ID.video, 'videos');
});

test('远程收藏的 .jpg 缩略图不能把 3D 模型误判成图片', () => {
  const model = {platform: 'sketchfab', assetType: 'model', thumbnail: 'https://cdn.example/a.jpg', url: 'https://sketchfab.com/3d-models/a'};
  assert.deepEqual(contentKindsOf(model), ['models']);
});

test('本地文件扩展名派生视频 / 音频 / HDRI，附带文档不污染主类型，且允许多值', () => {
  assert.ok(contentKindsOf({assetType: 'image', filePath: 'C:/lib/clip.mp4'}).includes('videos'));
  // 2026-11 新规格：主类型明确（base=images）时，附带文档不再把资产拖进 documents ——
  // 预览页 / 元数据文件几乎每条资产都有，否则「文本」模式会被全部资产淹没。
  assert.equal(contentKindsOf({assetType: 'image', filePath: 'C:/lib/readme.docx'}).includes('documents'), false, '主类型明确时附带文档要被抑制');
  assert.ok(contentKindsOf({assetType: 'other', filePath: 'C:/lib/readme.docx'}).includes('documents'), '纯文档资产仍能归位');
  assert.ok(contentKindsOf({assetType: 'image', filePath: 'C:/lib/ambience.wav'}).includes('audio'));
  assert.ok(contentKindsOf({assetType: 'image', filePath: 'C:/lib/studio.hdr'}).includes('hdris'));
  const pack = contentKindsOf({assetType: 'model', entries: [{rel: 'robot.fbx'}, {rel: 'albedo.png'}]});
  assert.deepEqual(pack,['models'], '模型贴图不再重复计入图片分类');
  assert.deepEqual(contentKindsOf(null), []);
});

test('激活态：显式模式 > 内容模式 > 本地类型下拉；都没有就返回空串（＝全部）', () => {
  assert.equal(activeModeId({route: 'library', contentKind: 'videos'}), 'videos');
  assert.equal(activeModeId({route: 'library', libraryMode: 'model'}), 'models');
  assert.equal(activeModeId({}, () => 'models'), 'models');
  assert.equal(activeModeId({route: 'library', contentKind: 'audio'}), 'audio', '音频已升为母类，要能点亮自己的图标');
  assert.equal(activeModeId({route: 'library', contentKind: 'textures'}), '', '非常驻类型不该点亮任何图标');
  assert.equal(activeModeId({}, () => ''), '');
  assert.equal(activeModeId({}, () => 'textures'), '');
});

test('持久化：只恢复常驻模式，兼容旧键并清掉旧值', () => {
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  };
  try {
    store.set('av:content-kind:v1', 'videos');
    assert.equal(savedMode(), 'videos', '旧键要能读出来');
    rememberMode('videos');
    assert.equal(store.get('av:content-mode:v1'), 'videos');
    assert.equal(store.has('av:content-kind:v1'), false);
    store.set('av:content-mode:v1', 'media');
    assert.equal(savedMode(), '', '已下线的模式值（旧的「影音」）不能恢复成无图标的空筛选');
    rememberMode('');
    assert.equal(store.has('av:content-mode:v1'), false);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

/** 最小 DOM 替身：只需覆盖组件用到的几个方法，不引入 jsdom。 */
function fakeHost() {
  const listeners = {};
  const host = {
    html: '', buttons: [],
    set innerHTML(value) {
      this.html = value;
      this.buttons = [...value.matchAll(/<button[^>]*>/g)].map(match => {
        const tag = match[0];
        const classes = new Set();
        return {
          dataset: {mode: (tag.match(/data-mode="([^"]+)"/) || [])[1]},
          attrs: {},
          classList: {
            add: name => classes.add(name), remove: name => classes.delete(name),
            toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
            contains: name => classes.has(name),
          },
          setAttribute(key, value) { this.attrs[key] = value; },
        };
      });
    },
    get innerHTML() { return this.html; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelectorAll: selector => selector === '.ck-tab' ? host.buttons : [],
    contains: () => true,
    fire(type, event) { for (const fn of listeners[type] || []) fn(event); },
  };
  return host;
}

test('组件：5 个图标常驻、无计数 / 分隔线 / 平台，DOM 只建一次', () => {
  const host = fakeHost();
  const state = {route: 'library'};
  const tabs = createContentKindTabs({host, state, readKind: () => ''});
  tabs.render();
  assert.deepEqual(host.buttons.map(button => button.dataset.mode), ['images', 'models', 'ui', 'documents', 'videos', 'audio']);
  assert.ok(host.html.includes('<svg'), '每个键都要是 SVG 图标');
  assert.ok(!host.html.includes('ck-count'), '不显示数量');
  assert.ok(!host.html.includes('ck-sep'), '不显示分组线');
  assert.ok(!host.html.includes('ck-platform'), '不显示平台图标');
  assert.ok(!host.html.includes('data-mode="all"'), '不显示「全部」键');
  assert.ok(host.buttons.every(button => button.attrs['aria-pressed'] === 'false'), '默认无激活＝全部');
  const before = host.buttons[0];
  tabs.render();
  assert.equal(host.buttons[0], before, '常驻集合不变时不应重建 DOM，否则 hover 动效会断');
});

test('组件：点未激活键进入模式，再点激活键 / Esc 退出，各自只回调一次', () => {
  const host = fakeHost();
  const state = {route: 'library', contentKind: ''};
  const picked = [], exits = [];
  const tabs = createContentKindTabs({
    host, state, readKind: () => '',
    onPick: entry => { picked.push(entry.id); state.mode=entry.id; state.contentKind = modePresetById(entry.id).groupId; tabs.render(); },
    onExit: () => { exits.push(1); state.mode=''; state.contentKind = ''; tabs.render(); },
  });
  tabs.render();
  const images = host.buttons.find(button => button.dataset.mode === 'images');
  const videos = host.buttons.find(button => button.dataset.mode === 'videos');
  host.fire('click', {target: {closest: () => videos}});
  assert.deepEqual(picked, ['videos']);
  assert.equal(videos.attrs['aria-pressed'], 'true');
  assert.equal(videos.attrs['aria-label'], '视频，再点一次退出模式');
  assert.equal(images.attrs['aria-pressed'], 'false');
  host.fire('click', {target: {closest: () => videos}});
  assert.deepEqual(picked, ['videos'], '再点当前键不能重复进入');
  assert.deepEqual(exits, [1]);
  assert.equal(videos.attrs['aria-pressed'], 'false');
  host.fire('click', {target: {closest: () => images}});
  assert.deepEqual(picked, ['videos', 'images']);
  host.fire('keydown', {key: 'Escape'});
  assert.deepEqual(exits, [1, 1], 'Escape 也能退回全部');
  assert.equal(images.attrs['aria-pressed'], 'false');
});

test('接线：横栏在 index.html、侧栏旧键移除、平台维度已从图标轨解绑', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="content-kind-tabs" class="ck-tabs"'));
  assert.ok(html.includes('aria-label="内容模式切换"'));
  assert.ok(html.includes('content-kind-tabs.css'));
  assert.ok(!html.includes('id="side-modes"'), '侧栏那两个键不能留在原处');
  const app = read('app.js');
  assert.ok(app.includes('createContentKindTabs('));
  assert.ok(app.includes('onPick:applyModeTab'));
  assert.ok(app.includes('onExit:exitContentMode'));
  assert.ok(!app.includes('createContentModes('));
  assert.ok(!app.includes("from './platform-tabs.js'"), '平台图标模块已无消费方');
  assert.ok(!app.includes('getPlatformTabs'), '平台图标不能再注入图标轨');
  assert.ok(!app.includes('platformFilter'), '不留没有入口的筛选状态');
  const css = read('content-kind-tabs.css');
  assert.ok(css.includes(':hover'));
  assert.ok(css.includes('prefers-reduced-motion'));
  assert.ok(!css.includes('.ck-count') && !css.includes('.ck-sep') && !css.includes('.ck-platform'));
  assert.ok(!css.includes('data-route="downloads"'), '模式轨要常驻，不能按页面整条隐藏');
  // 位置：贴在搜索卡片上沿之外、卡片之前（主人圈定的位置），靠 max-content + auto 外边距居中。
  // 若挪进卡片内部，视觉上会多出一圈内衬，与「整块搜索区只有一个容器」的观感冲突。
  const panelAt = html.indexOf('id="search-panel"');
  const tabsAt = html.indexOf('id="content-kind-tabs"');
  assert.ok(panelAt > -1 && tabsAt > -1 && tabsAt < panelAt, '模式轨必须排在 #search-panel 之前（卡片上沿之外）');
  assert.ok(/width:max-content/.test(css) && /margin:[^;]*auto/.test(css), '按内容宽度居中，而不是整宽铺开');
  // 卡片本身是容器，轨道不能再套外框/底色，否则视觉上被切成两层；默认态只留图标。
  const railRule = (css.match(/\.ck-tabs\{[^}]*\}/) || [''])[0];
  assert.ok(/border:0/.test(railRule) && /background:none/.test(railRule), '图标轨不要外框和底色');
  assert.ok(/padding:0/.test(railRule), '轨道自身不留内边距，上下间距交给外边距收紧');
  assert.ok(!css.includes('.ck-spacer'), '不要再加弹性占位：它会把居中图标组顶偏');
  // 全局 button{justify-content:center} 在固定 36px 宽的键里会把 SVG 挤出左边；
  // 现在键宽由内容决定（图标始终是 flex 流的第一个子项），再加 flex-start 双保险。
  assert.ok(css.includes('justify-content:flex-start'));
  assert.ok(/\.ck-tab i\{flex:0 0 auto/.test(css), '图标要留在 flex 流内，键宽才能跟着内容走');
  // 展开宽度必须由文字决定：label 用 max-width:0 → 内容宽的过渡，不能再写死一个 108px。
  assert.ok(/\.ck-tab \.ck-label\{[^}]*max-width:0/.test(css), '收起时文字不占宽，键才是纯图标大小');
  // 目标宽度必须是 JS 量出来的文字实宽：写死大上限会让宽度在前 15% 就冲到顶，
  // 后面整段静止，旁边的键等于被「啪」地顶开 —— 展开与位移不再同步。
  assert.ok(/\.ck-tab:hover[^{]*\.ck-label[^{]*\{[^}]*max-width:var\(--label-w/.test(css),
    '展开宽度用 --label-w（文字实宽），不要写死上限');
  assert.ok(/measureLabelWidths/.test(read('content-kind-tabs.js')), '文字实宽要在挂载后量一次写入变量');
  assert.ok(!/\.ck-tab:hover[^{]*\{[^}]*width:108px/.test(css), '不要写死展开宽度');
  assert.ok(!css.includes('position:absolute;left:10px'), '图标不再绝对定位，否则文字宽度算不进键宽');
  // 独立 CSS 不在 esbuild 主包里：服务端白名单与构建复制清单都得登记，否则上线后样式 404。
  const server = readFileSync(new URL('../server/library.mjs', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../scripts/build-library.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes("'/content-kind-tabs.css'"));
  assert.ok(build.includes("'content-kind-tabs.css'"));
});

test('资产库页里，模式图标只筛本地类型，不把人踢去发现页', () => {
  const app = read('app.js');
  const start = app.indexOf('function applyModeTab(entry){');
  assert.ok(start > -1, 'applyModeTab 必须存在');
  const body = app.slice(start, app.indexOf('\n}', start));
  // 资产库页没有在线结果流可换：图标只拨本地类型（#local-kind / state.contentKind），原地重画。
  const branchAt = body.indexOf("if(state.route==='library'){");
  assert.ok(branchAt > -1, '必须有资产库分支：图标在库里是类型筛选，不是「去发现页搜这个」');
  const branch = body.slice(branchAt, body.indexOf('return;', branchAt));
  assert.ok(branch.includes('applyLocalKind(preset)'), '类型要落到本地类型筛选（下拉或 contentKind）');
  assert.ok(branch.includes('renderGrid()'), '原地重画网格，不换页');
  assert.ok(!/route\(|setPlatform\(|loadModeResults\(|startSearch\(/.test(branch),
    '资产库分支里不许换路由 / 拨平台 / 发检索');
  // 发现页那一套完整上下文切换要原样保留。
  assert.ok(body.includes("if(state.route!=='discover')route('discover');"),
    '发现页仍要落到结果流对应的页面');
  assert.ok(body.includes('loadModeResults(target)'), '发现页仍要立刻取该模式的卡片');
  // 退出模式（再点一次 / Esc）在库里也只清本地筛选。
  const exitStart = app.indexOf('function exitContentMode(){');
  const exitBody = app.slice(exitStart, app.indexOf('\n}', exitStart));
  const exitBranch = exitBody.indexOf("if(state.route==='library')");
  assert.ok(exitBranch > -1, '退出模式也要按路由分叉');
  assert.ok(/if\(state\.route==='library'\)\{renderGrid\(\);persist\(\);return;\}/.test(exitBody),
    '库里退出模式只重画网格，不去碰在线平台池');
});

test('类型模式也要压住磁盘上的额外卡片与空状态文案', () => {
  // 只有下拉里没有的类型（文本 / 视频 / 音频）才会走 state.contentKind，
  // 这类筛选过去漏掉了两张表：磁盘零散文件（file.kind）与资产包（pkg.category）。
  assert.equal(modeAllowsLocalKind('', 'files', 'image'), true, '没选模式就一律放行');
  assert.equal(modeAllowsLocalKind('documents', 'files', 'document'), true);
  assert.equal(modeAllowsLocalKind('documents', 'files', 'image'), false, '筛文本时图片文件不能混进来');
  assert.equal(modeAllowsLocalKind('videos', 'files', 'video'), true);
  assert.equal(modeAllowsLocalKind('documents', 'packages', 'images'), false, '图片资产包也不该出现在文本模式');
  assert.equal(modeAllowsLocalKind('images', 'packages', 'images'), true);
  // 2026-11 新增 ui 模式后，MODE_TABS 的 id 不再等于磁盘类型词表的键：
  // app.js:138 把 state.contentKind 设成 modePresetById(state.mode).localKind（ui → uielement）。
  // 判据必须按 localKind 查表，否则会误报「ui 缺映射」，也会漏掉真正漏配的模式。
  for (const entry of MODE_TABS) {
    const kind = modePresetById(entry.id).localKind;
    const map = LOCAL_KINDS_OF_MODE[kind];
    assert.ok(map, `${entry.id}(${kind}) 缺磁盘类型映射：额外卡片会漏筛`);
    assert.ok(Array.isArray(map.files) && Array.isArray(map.packages), `${entry.id} 的两个面都要给数组`);
  }
  assert.equal(modePresetById('ui').localKind, 'uielement', 'UI 模式走 uielement 磁盘类型');
  assert.equal(modeAllowsLocalKind('uielement', 'files', 'document'), true);
  const app = read('app.js');
  const extra = app.slice(app.indexOf('function extraCards(){'), app.indexOf("/** 远程收藏卡上的「下载原图」"));
  assert.ok(extra.includes("modeAllowsLocalKind(modeKind,'packages'"), '资产包要过一次模式类型');
  assert.ok(extra.includes("modeAllowsLocalKind(modeKind,'files'"), '零散文件要过一次模式类型');
  // 空状态：类型模式筛空了要说「这一类还没有」，不能显示「收集第一项资产」+ 跳发现页的按钮。
  const view = read('library-view.js');
  assert.ok(/const narrowed=[^;]*state\.contentKind/.test(view), 'narrowed 要认 contentKind');
  assert.ok(view.includes('本地还没有「'), '类型模式要有专用空状态文案');
  assert.ok(view.includes('再点一次顶部同一个图标即可退出类型筛选'), '要告诉用户怎么退出');
});
