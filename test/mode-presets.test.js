import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
  MODE_PRESETS, modePresetById, platformPoolFor, fullPlatformPool,
  pickModePlatform, loadModePlatforms, rememberModePlatform, MODE_PLATFORM_KEY,
} from '../src/library/mode-presets.js';
import {paths} from '../src/library/icon-set.js';
import {activeModeId} from '../src/library/content-kind-tabs.js';
import {ALL} from '../src/library/platforms.js';

const read = name => readFileSync(new URL(`../src/library/${name}`, import.meta.url), 'utf8');
const ids = pool => pool.map(item => item.id);

test('模式契约：常驻模式各一枚图标，每个都声明平台池 / 默认站 / 布局 / 本地类型', () => {
  assert.deepEqual(MODE_PRESETS.map(preset => preset.id), ['images', 'models', 'ui', 'documents', 'videos']);
  assert.equal(Object.isFrozen(MODE_PRESETS), true);
  for (const preset of MODE_PRESETS) {
    assert.ok(paths[preset.icon], `${preset.id} 缺图标`);
    assert.ok(typeof preset.localKind === 'string' && preset.localKind, `${preset.id} 缺本地类型`);
    assert.equal(typeof preset.localOnly, 'boolean');
    assert.equal(typeof preset.gallery, 'boolean');
  }
  assert.equal(modePresetById('nope'), null);
  // 2026-11-12：视频已经有在线源（Pexels / Coverr / Civitai / Pixabay）→ 不再 localOnly；
  // 文本仍然只有链接解析，localOnly + linkOnly 都要点明。
  assert.equal(modePresetById('videos').localOnly, false, '视频模式有在线源，不该再被当成纯本地类型');
  assert.equal(modePresetById('videos').linkOnly, undefined, '视频不走链接解析兜底');
  assert.ok(modePresetById('documents').localOnly && modePresetById('documents').linkOnly);
});

test('UI 模式：下拉只有 Uiverse 一站，不再被排除在外', () => {
  const preset = modePresetById('ui');
  const pool = platformPoolFor(preset);
  assert.deepEqual(ids(pool), ['uiverse'], 'UI 模式只能选 Uiverse');
  assert.ok(!ids(pool).includes(ALL), '单站不需要「全部平台」');
  assert.equal(pickModePlatform(preset, '', pool), 'uiverse', '默认停在 Uiverse');
  assert.equal(preset.gallery, false, 'UI 卡片不是瀑布流');
  assert.equal(preset.localKind, 'uielement');
});

test('模型模式：下拉只列 3D 平台，不掺图站 / UI 代码站', () => {
  const pool = platformPoolFor(modePresetById('models'));
  assert.ok(pool.some(item => item.id === ALL));
  assert.equal(pool.find(item => item.id === ALL).label, '全部 3D 平台');
  for (const id of ['sketchfab', 'polyhaven', 'polypizza', 'kenney', 'freestylized', 'polyfork', 'simready']) {
    assert.ok(ids(pool).includes(id), `${id} 应该出现在模型模式下拉里`);
  }
  for (const id of ['huaban', 'pixiv', 'wallhaven', '500px', 'uiverse']) {
    assert.ok(!ids(pool).includes(id), `${id} 不是 3D 平台，不该混进来`);
  }
});

test('图片模式：下拉只列图片平台，不含纯 3D 站与「全部平台」', () => {
  const pool = platformPoolFor(modePresetById('images'));
  assert.ok(!ids(pool).includes(ALL), '图片模式没有跨站整合流');
  for (const id of ['huaban', 'pixiv', 'wallhaven', 'pexels', '500px', 'artstation']) {
    assert.ok(ids(pool).includes(id), `${id} 应该出现在图片模式下拉里`);
  }
  for (const id of ['sketchfab', 'polypizza', 'freestylized', 'polyfork', 'simready', 'uiverse']) {
    assert.ok(!ids(pool).includes(id), `${id} 不该出现在图片模式下拉里`);
  }
});

test('无模式＝全量池；文本＝只给「链接解析」，视频＝只给视频站', () => {
  const all = fullPlatformPool();
  assert.ok(ids(all).includes(ALL));
  assert.ok(ids(all).includes('sketchfab'));
  assert.ok(ids(all).includes('huaban'), '无模式时图站也要能在下拉里找到');
  assert.ok(ids(all).includes('uiverse'), '无模式时 UI 平台也能直接被选到');
  assert.equal(new Set(ids(all)).size, all.length, '全量池不能出现重复项');
  // 文本：没有可搜关键词的在线源，下拉只给「链接解析」一枚（feeds 必须为空）。
  const docs = platformPoolFor(modePresetById('documents'));
  assert.deepEqual(ids(docs), ['link'], '文本的平台池只该有链接解析');
  assert.deepEqual(docs[0].feeds, [], '文本不能假装有在线检索流');
  assert.equal(typeof docs[0].placeholder, 'string');
  assert.ok(docs[0].link, 'link 标记是空状态与搜索提示的分流依据');
  // 视频：已接四个在线站，池子里只该有视频站，默认停在 Pexels 视频。
  const videos = modePresetById('videos');
  const videoPool = platformPoolFor(videos);
  assert.deepEqual(ids(videoPool), ['pexels-video', 'coverr', 'civitai-video', 'pixabay-video']);
  for (const item of videoPool) {
    assert.ok(item.picture, `${item.id} 要走图站解析链路（视频卡复用同一套瀑布流）`);
    assert.equal(item.kind, 'video');
  }
  assert.equal(pickModePlatform(videos, '', videoPool), 'pexels-video');
  // 视频站不能混进图片 / 全量池，否则图片模式里会冒出「选了却搜不到图」的站。
  for (const item of videoPool) assert.ok(!ids(all).includes(item.id), `${item.id} 不该出现在全量池`);
  assert.deepEqual(platformPoolFor(null), all);
});

test('被关掉的平台不进池；记住的站失效时退回默认站', () => {
  const enabled = id => id !== 'sketchfab';
  const pool = platformPoolFor(modePresetById('models'), {enabled});
  assert.ok(!ids(pool).includes('sketchfab'));
  const preset = modePresetById('models');
  assert.ok(!ids(pool).includes('sketchfab'), '这个用例里默认站被关掉了');
  assert.equal(pickModePlatform(preset, 'polyhaven', pool), 'polyhaven', '模式内记住的站优先');
  assert.equal(pickModePlatform(preset, 'sketchfab', pool), ALL, '记住的站已关掉 → 退回池首项');
  assert.equal(pickModePlatform(preset, '', pool), ALL, '默认站也不可用 → 退回池首项');
  assert.equal(pickModePlatform(preset, '', platformPoolFor(preset)), 'sketchfab', '默认停在纯 3D 站');
  const images = modePresetById('images');
  assert.equal(pickModePlatform(images, '', platformPoolFor(images)), 'artstation');
});

test('模式各自记住上次选的站，且只记有在线源的模式', () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(String(key), String(value)),
    removeItem: key => store.delete(key),
  };
  rememberModePlatform(storage, 'images', 'huaban');
  rememberModePlatform(storage, 'models', 'sketchfab');
  rememberModePlatform(storage, 'videos', 'pexels-video');
  rememberModePlatform(storage, 'documents', 'huaban');   // 文本只有链接解析一枚，没有「上次的站」可记
  const data = loadModePlatforms(storage);
  assert.deepEqual(data, {images: 'huaban', models: 'sketchfab', videos: 'pexels-video'});
  assert.equal(store.has(MODE_PLATFORM_KEY), true);
  store.set(MODE_PLATFORM_KEY, '{坏数据');
  assert.deepEqual(loadModePlatforms(storage), {}, '损坏的快照不能让启动崩掉');
});

test('图标高亮读显式主状态：手动换平台不再是「模式退出」', () => {
  assert.equal(activeModeId({mode: 'models', contentKind: 'videos'}), 'models');
  assert.equal(activeModeId({mode: 'images', route: 'library', libraryMode: 'model'}), 'images');
  assert.equal(activeModeId({mode: 'videos', platform: 'sketchfab'}), 'videos');
  assert.equal(activeModeId({mode: 'ui', platform: 'uiverse'}), 'ui', 'UI 模式是显式主状态');
  assert.equal(activeModeId({mode: '', contentKind: 'documents'}), 'documents', '旧字段仍兼容');
  assert.equal(activeModeId({mode: 'audio'}), '', '非法模式不点亮任何图标');
});

test('接线：模式是 app.js 的主状态，点图标会重建下拉并换结果流', () => {
  const app = read('app.js');
  assert.ok(app.includes('mode:savedMode()'), '显式主状态');
  assert.ok(app.includes('platformPoolFor(preset'), '下拉池按模式重建');
  assert.ok(app.includes('loadModeResults(target)'), '点图标要换展示区');
  assert.ok(app.includes('startSearch()') && app.includes('openPictureHome'), '3D 重搜 / 图站首页两条出口');
  assert.ok(!app.includes('platformsForMode(activeMode(state))'), '不能再从平台反推模式');
  assert.ok(!app.includes('function applyContentMode('), '旧三态函数已退休');
  assert.ok(app.includes("if(id==='library')return;"), '本地占位项不能被当成在线平台');
  const view = read('library-view.js');
  assert.ok(view.includes('modeTitlePrefix(state)'), '展示区标题也要说明当前是哪一类资源');
  const server = readFileSync(new URL('../server/library.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes("'/content-kind-tabs.css'"));
});
