// 平台收藏夹通用契约：注册 / 能力位 / 统一分发 / META 透传。
// 这是所有平台收藏夹（小红书及后续）的公共层，跟具体平台无关，用 mock adapter 测。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerCollectionPlatform, collectionCaps, collectionPlatformIds, isCollectionPlatform,
  probeCollectionOps, withCollectionCaps, isCollectView, collectionCommand,
} from '../server/platform-collections.mjs';

const calls = [];
registerCollectionPlatform({
  id: 'mock-site',
  label: '测试站点',
  homeUrl: 'https://mock.example/explore',
  collectUrl: 'https://mock.example/favorites',
  collectDetect: /\/favorites/,
  ops: ['create', 'add'],
  defaultItemOps: ['add', 'removeItem'],
  async probeOps() { return { ops: ['create', 'add', 'rename', 'removeItem'], signatures: { rename: 'web改名接口' } }; },
  mutate: async (input) => { calls.push(input); return { ok: true, action: input.action }; },
});

test('注册后可按 id 查询，未注册平台返回 null/false', () => {
  assert.ok(collectionPlatformIds().includes('mock-site'));
  assert.equal(isCollectionPlatform('mock-site'), true);
  assert.equal(isCollectionPlatform('nope'), false);
  assert.equal(collectionCaps('nope'), null);
});

test('collectionCaps 下发入口 url、标签、静态 ops 与收藏视图正则', () => {
  const caps = collectionCaps('mock-site');
  assert.equal(caps.collectionPlatform, 'mock-site');
  assert.equal(caps.collectionLabel, '测试站点');
  assert.equal(caps.collectionHomeUrl, 'https://mock.example/explore');
  assert.equal(caps.collectionCollectUrl, 'https://mock.example/favorites');
  assert.deepEqual(caps.collectionOps, ['create', 'add']);
  assert.equal(caps.collectionCollectDetect, '\\/favorites');
});

test('isCollectView 用平台自己的正则判断，不写死域名', () => {
  assert.equal(isCollectView('mock-site', 'https://mock.example/favorites'), true);
  assert.equal(isCollectView('mock-site', 'https://mock.example/explore'), false);
  assert.equal(isCollectView('nope', 'https://mock.example/favorites'), false);
});

test('withCollectionCaps 注入能力位，非收藏平台原样返回', () => {
  const wrapped = withCollectionCaps({ mode: 'boards', boards: [] }, 'mock-site');
  assert.equal(wrapped.collectionPlatform, 'mock-site');
  assert.deepEqual(wrapped.collectionOps, ['create', 'add']);
  const plain = { items: [1] };
  assert.equal(withCollectionCaps(plain, 'nope'), plain);
});

test('probeCollectionOps 用运行时探测覆盖静态 ops，并带出 signatures', async () => {
  const live = await probeCollectionOps('mock-site');
  assert.deepEqual(live.ops, ['create', 'add', 'rename', 'removeItem']);
  assert.equal(live.signatures.rename, 'web改名接口');
  assert.deepEqual(live.defaultItemOps, ['add', 'removeItem']);
});

test('collectionCommand 校验 action 白名单与平台能力，再分发到 mutate', async () => {
  const res = await collectionCommand('mock-site', { action: 'create', name: '新专辑' });
  assert.deepEqual(res, { ok: true, action: 'create' });
  assert.equal(calls.at(-1).name, '新专辑');
  await assert.rejects(collectionCommand('mock-site', { action: 'drop_tables' }), /不支持/);
  await assert.rejects(collectionCommand('mock-site', { action: 'remove' }), /暂不支持/);
  await assert.rejects(collectionCommand('nope', { action: 'create' }), /不支持收藏夹/);
});
