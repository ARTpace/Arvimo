import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveAutoTags, mergeAutoTags, hasTextSignal, boardFromName, metaOf, AUTO_TAG_CONFIG,
} from '../src/library/auto-tags.js';
import {deriveTagRows} from '../server/library-blob.mjs';

test('从画板名 / 分类 / 话题 / 来源派生客观标签，按优先级排序', () => {
  const model = {
    name: '来自相册',
    platform: 'huaban',
    meta: {
      board: '캐릭터 디자인',
      category: 'animals-pets / nature-plants',
      hashtags: ['原画', '角色设计'],
    },
  };
  const tags = deriveAutoTags(model);
  assert.equal(tags[0], '캐릭터 디자인');
  assert.ok(tags.includes('animals-pets'));
  assert.ok(tags.includes('nature-plants'));
  assert.ok(tags.includes('原画'));
  assert.ok(tags.includes('来源:花瓣'));
  assert.ok(!tags.includes('来自相册'), '名称占位词不能变成标签');
});

test('历史数据没有 meta 时，从 name 反解旧采集拼进去的画板名', () => {
  assert.equal(boardFromName('收藏到 캐릭터 디자인'), '캐릭터 디자인');
  assert.equal(boardFromName('Eastern Grey Squirrel'), '');
  const tags = deriveAutoTags({name: '收藏到 캐릭터 디자인', platform: 'huaban'});
  assert.equal(tags[0], '캐릭터 디자인');
  assert.ok(tags.includes('来源:花瓣'));
});

test('老 payload 的 categories 数组能被兜底读出，不必重新收藏', () => {
  const old = {
    name: 'Eastern Grey Squirrel', platform: 'sketchfab',
    categories: ['animals-pets', 'nature-plants'], tags: ['tree', 'squirrel'],
  };
  assert.equal(metaOf(old).category, 'animals-pets / nature-plants');
  const tags = deriveAutoTags(old);
  assert.ok(tags.includes('animals-pets'));
  assert.ok(tags.includes('nature-plants'));
  assert.ok(tags.includes('来源:Sketchfab'));
});

test('新采集的 meta 优先，metaOf 全空时返回 null', () => {
  const model = {meta: {board: '新画板'}, boardTitle: '旧画板'};
  assert.equal(metaOf(model).board, '新画板');
  assert.equal(metaOf({name: '随便'}), null);
  assert.ok(!deriveAutoTags(model).includes('旧画板'));
});

test('技术噪声（格式 / 分辨率 / 域名 / 占位词）一律不进标签', () => {
  const tags = deriveAutoTags({
    platform: 'sketchfab',
    meta: {
      category: 'image / high resolution / 762x39 / sketchfab.com',
      hashtags: ['jpg', '480', '#原画', '#', 'https://example.com/a'],
    },
  });
  for (const noise of ['image', 'high resolution', '762x39', 'jpg', '480', 'sketchfab.com']) {
    assert.ok(!tags.includes(noise), `${noise} 不该成为标签`);
  }
  assert.ok(tags.includes('原画'));
});

test('大小写去重、数量上限、同输入确定性', () => {
  const model = {
    platform: 'sketchfab',
    meta: {category: 'Wood / wood / WOOD / 金属 / 布料 / 石材 / 皮革 / 玻璃'},
  };
  const first = deriveAutoTags(model);
  assert.equal(first.filter(tag => tag.toLowerCase() === 'wood').length, 1);
  assert.ok(first.length <= AUTO_TAG_CONFIG.max);
  assert.deepEqual(first, deriveAutoTags(model));
});

test('空输入与开关关闭时返回空，不污染 payload 字节比较', () => {
  assert.deepEqual(deriveAutoTags({}), []);
  assert.deepEqual(deriveAutoTags(null), []);
  assert.deepEqual(deriveAutoTags({name: '未命名资产'}), []);
});

test('配置缝可单独关掉某一类来源，或整体停用', () => {
  const model = {platform: 'huaban', meta: {board: 'UI 灵感', category: 'interface'}};
  assert.ok(!deriveAutoTags(model, {includePlatform: false}).includes('来源:花瓣'));
  assert.ok(!deriveAutoTags(model, {includeBoard: false}).includes('UI 灵感'));
  assert.deepEqual(deriveAutoTags(model, {enabled: false}), []);
  assert.deepEqual(mergeAutoTags(['旧标签'], model, {enabled: false}), ['旧标签']);
});

test('mergeAutoTags 保留原有顺序、只补新词，重复调用幂等', () => {
  const model = {name: '收藏到 캐릭터 디자인', platform: 'huaban'};
  const once = mergeAutoTags(['762x39', 'wood'], model);
  assert.deepEqual(once.slice(0, 2), ['762x39', 'wood']);
  assert.deepEqual(mergeAutoTags(once, model), once);
});

test('三个接入点结果一致：采集层、前端 tagsFor、DB 派生层不产生分叉', () => {
  const model = {uid: 'a'.repeat(32), name: '收藏到 캐릭터 디자인', platform: 'huaban', tags: []};
  const collected = mergeAutoTags(model.tags, model);
  const withTags = {...model, tags: collected};
  const twice = mergeAutoTags(withTags.tags, withTags);
  assert.deepEqual(twice, collected);
  const rows = deriveTagRows({models: [withTags]}).map(row => row.tag);
  for (const tag of collected) assert.ok(rows.includes(tag), `DB 派生缺 ${tag}`);
});

test('hasTextSignal 只拦真正的空名，中文名与英文型号都算有信号', () => {
  assert.equal(hasTextSignal('来自相册'), false);
  assert.equal(hasTextSignal('IMG_5876'), false);
  assert.equal(hasTextSignal('DSC01234'), false);
  assert.equal(hasTextSignal('我的收藏 - 微博'), false);
  assert.equal(hasTextSignal('   '), false);
  assert.equal(hasTextSignal('机械臂'), true);
  assert.equal(hasTextSignal('Eastern Grey Squirrel'), true);
  assert.equal(hasTextSignal('Vintage_Crutch_01'), true);
});
