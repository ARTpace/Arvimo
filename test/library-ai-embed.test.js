// ADR-15：AI 接入里的向量（/embeddings）通道契约。
//
// 只测「请求发对了、响应解析对了、错的响应会明确失败」这三件事。
// 真实 HTTP 由单测里的 fetchImpl 注入，不出网、不花钱。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAIService} from '../server/ai.mjs';

const json = data => new Response(JSON.stringify(data), {status: 200, headers: {'Content-Type': 'application/json'}});

async function service(t, fetchImpl) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'assetvault-ai-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return createAIService({file: path.join(dir, 'ai-settings.json'), fetchImpl});
}

test('向量模型与对话模型分开保存，互不覆盖', async t => {
  const ai = await service(t, async () => json({data: []}));
  const saved = await ai.configure({enabled: true, baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', embedModel: 'text-embedding-3-small', apiKey: 'k'});
  assert.equal(saved.model, 'gpt-4o-mini');
  assert.equal(saved.embedModel, 'text-embedding-3-small');
  // 只提交对话模型（老前端）时，向量模型必须保留 —— 否则每次改模型都要重建整库向量。
  const again = await ai.configure({model: 'gpt-4.1-mini'});
  assert.equal(again.embedModel, 'text-embedding-3-small');
});

test('embed 打的是 /embeddings，按 index 排序，返回 Float32Array', async t => {
  let seen = null;
  const ai = await service(t, async (url, init) => {
    seen = {url: String(url), body: JSON.parse(init.body)};
    // 故意倒序返回，验证调用方按 index 还原，而不是盲信数组顺序。
    return json({data: [{index: 1, embedding: [0, 1]}, {index: 0, embedding: [1, 0]}]});
  });
  await ai.configure({enabled: true, baseUrl: 'https://api.example.com/v1', model: 'chat', embedModel: 'emb', apiKey: 'k'});

  const vectors = await ai.embed(['第一条', '第二条']);
  assert.equal(seen.url, 'https://api.example.com/v1/embeddings');
  assert.equal(seen.body.model, 'emb');
  assert.deepEqual(seen.body.input, ['第一条', '第二条']);
  assert.ok(vectors[0] instanceof Float32Array);
  assert.deepEqual([...vectors[0]], [1, 0]);
  assert.deepEqual([...vectors[1]], [0, 1]);
});

test('没填向量模型 / 返回条数不符 / 向量非数字 都要明确报错', async t => {
  const noModel = await service(t, async () => json({data: []}));
  await noModel.configure({enabled: true, baseUrl: 'https://api.example.com/v1', model: 'chat'});
  await assert.rejects(() => noModel.embed(['x']), /向量模型/);

  const short = await service(t, async () => json({data: [{index: 0, embedding: [1]}]}));
  await short.configure({enabled: true, baseUrl: 'https://api.example.com/v1', model: 'chat', embedModel: 'emb'});
  await assert.rejects(() => short.embed(['a', 'b']), /条数不符/);

  const bad = await service(t, async () => json({data: [{index: 0, embedding: ['NaN']}]}));
  await bad.configure({enabled: true, baseUrl: 'https://api.example.com/v1', model: 'chat', embedModel: 'emb'});
  await assert.rejects(() => bad.embed(['a']), /无效的向量/);
});
