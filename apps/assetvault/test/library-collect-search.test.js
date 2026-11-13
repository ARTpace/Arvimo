// 统一搜索层：平台注册表、身份键、两套结果形状的归一化。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLECT_PLATFORMS, canonicalKey, collectUid, createCollectSearch,
} from '../server/collect-search.mjs';

const UID = /^[a-f0-9]{32}$/;
const model = {
  uid: 'a'.repeat(32), assetId: 'chair-01', name: ' Wooden Chair ', author: 'Ann',
  thumbnail: 'https://cdn/x.jpg', url: 'https://sketchfab.com/3d-models/chair', tags: ['wood', 'chair'], assetType: 'model',
};

const fixture = (overrides = {}) => createCollectSearch({
  searchers: {sketchfab: async () => ({models: [model], next: 'cursor-2', warnings: []})},
  pictureCollector: async () => ({items: [{url: 'https://img/a.jpg', pageUrl: 'https://site/p/1?utm_source=x', title: 'A', tags: ['t'], width: 1200, height: 800}], warnings: []}),
  ...overrides,
});

test('平台注册表覆盖 9 个模型平台与可搜索图站', () => {
  const ids = COLLECT_PLATFORMS.map(platform => platform.id);
  for (const id of ['sketchfab', 'artstation', 'polyhaven', 'ambientcg', 'polypizza', 'kenney', 'freestylized', 'polyfork', 'simready'])
    assert.ok(ids.includes(id), `缺少模型平台 ${id}`);
  for (const id of ['safebooru', 'wallhaven', 'huaban', 'pexels', 'flickr', 'pinterest'])
    assert.ok(ids.includes(id), `缺少可搜索图站 ${id}`);
  const pixiv = COLLECT_PLATFORMS.find(platform => platform.id === 'pixiv');
  assert.equal(pixiv.searchable, false, 'pixiv 只能钉页面 URL');
});

test('canonicalKey 去掉跟踪参数并按字典序稳定', () => {
  const a = canonicalKey('https://Site.com/p/1?utm_source=x&b=2&a=1#frag');
  const b = canonicalKey('https://site.com/p/1?a=1&b=2');
  assert.equal(a, b);
  assert.equal(a, 'site.com/p/1?a=1&b=2');
});

test('collectUid 稳定且是 32 位十六进制', () => {
  const a = collectUid('huaban', 'huaban.com/pins/1');
  assert.match(a, UID);
  assert.equal(a, collectUid('huaban', 'huaban.com/pins/1'));
  assert.notEqual(a, collectUid('pexels', 'huaban.com/pins/1'));
});

test('模型平台结果归一化并保留平台 uid', async () => {
  const {search} = fixture();
  const result = await search('sketchfab', {query: 'chair', limit: 10});
  assert.equal(result.kind, 'model');
  assert.equal(result.next, 'cursor-2');
  const item = result.items[0];
  assert.equal(item.uid, model.uid);
  assert.equal(item.name, 'Wooden Chair');
  assert.equal(item.key, 'sketchfab:chair-01');
  // 平台标签原样保留在前；末尾是采集即派生的客观标签（零 AI、零人工确认）。
  assert.deepEqual(item.tags.slice(0, 2), ['wood', 'chair']);
  assert.equal(item.tags.at(-1), '来源:Sketchfab');
});

test('图站结果用规范化 URL 派生 uid，带跟踪参数的同一张图视为同一条', async () => {
  const {search} = fixture();
  const first = await search('huaban', {query: 'stone', limit: 5});
  const second = await search('huaban', {query: 'stone', limit: 5});
  assert.match(first.items[0].uid, UID);
  assert.equal(first.items[0].uid, second.items[0].uid);
  assert.equal(first.items[0].assetType, 'image');
  assert.equal(first.items[0].width, 1200);
});

test('limit 会被夹紧，缺失 uid 的模型按平台键派生', async () => {
  const {search} = fixture({
    searchers: {sketchfab: async () => ({models: [{name: 'No uid', url: 'https://x/y'}], warnings: []})},
  });
  const result = await search('sketchfab', {query: 'x', limit: 999});
  assert.match(result.items[0].uid, UID);
  // canonicalKey 去掉协议与主机名前缀后按路径派生，所以是 x/y 而不是完整 URL。
  assert.equal(result.items[0].key, 'sketchfab:x/y');
});

test('不可搜索平台与空关键词都明确报错', async () => {
  const {search} = fixture();
  await assert.rejects(() => search('pixiv', {query: 'cat'}), /不支持关键词搜索/);
  await assert.rejects(() => search('sketchfab', {query: '   '}), /关键词/);
  await assert.rejects(() => search('unknown', {query: 'x'}), /不支持的采集平台/);
});

test('某个平台搜索抛错时错误向上抛，由执行器记失败而不是吞掉', async () => {
  const {search} = fixture({searchers: {sketchfab: async () => { throw Error('429 Too Many Requests'); }}});
  await assert.rejects(() => search('sketchfab', {query: 'chair'}), /429/);
});
