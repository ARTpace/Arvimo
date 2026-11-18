import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {repairAiMeta} from '../server/ai-meta-repair.mjs';

const CRC_TABLE = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => { let c = 0xffffffff; for (const x of buf) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const textChunk = (k, v) => chunk('tEXt', Buffer.concat([Buffer.from(k), Buffer.from([0]), Buffer.from(v, 'utf8')]));

function storageWith(rows) {
  const applied = [];
  return {
    applied,
    withDb: async fn => fn({all: () => rows}),
    withDbWrite: async fn => fn({applyAssetOps: ops => { applied.push(...ops); return {applied: ops.length}; }}),
  };
}

test('只回填本地 PNG 且带生成信息的资产，跳过平台/普通图/已回填', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-fix-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const base = await sharp({create: {width: 2, height: 2, channels: 4, background: 'blue'}}).png().toBuffer();
  const iend = base.lastIndexOf(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44]));
  const aiFile = path.join(dir, 'ai.png');
  await fs.writeFile(aiFile, Buffer.concat([base.subarray(0, iend), textChunk('parameters', 'hero art\nSteps: 20, CFG scale: 7'), base.subarray(iend)]));
  const plainFile = path.join(dir, 'plain.png');
  await fs.writeFile(plainFile, base);
  const jpgFile = path.join(dir, 'x.jpg');
  await fs.writeFile(jpgFile, 'not png');

  const rows = [
    {uid: 'ai', payload: JSON.stringify({platform: 'local', ext: 'png', filePath: aiFile})},
    {uid: 'plain', payload: JSON.stringify({platform: 'local', ext: 'png', filePath: plainFile})},
    {uid: 'platform', payload: JSON.stringify({platform: 'polyhaven', ext: 'png', filePath: aiFile})},
    {uid: 'done', payload: JSON.stringify({platform: 'local', ext: 'png', aiMeta: {tool: 'x'}, filePath: aiFile})},
    {uid: 'jpg', payload: JSON.stringify({platform: 'local', ext: 'jpg', filePath: jpgFile})},
  ];
  const storage = storageWith(rows);
  const result = await repairAiMeta({storage});
  assert.equal(result.repaired, 1);
  assert.equal(result.scanned, 2); // ai + plain（平台/已回填/jpg 都不算候选）
  assert.equal(storage.applied.length, 1);
  assert.equal(storage.applied[0].uid, 'ai');
  assert.deepEqual(storage.applied[0].patch.aiMeta, {tool: 'Stable Diffusion', prompt: 'hero art'});
});

test('空库 / 无 storage 安全返回', async () => {
  assert.deepEqual(await repairAiMeta({}), {repaired: 0, scanned: 0});
  const storage = storageWith([]);
  assert.deepEqual(await repairAiMeta({storage}), {repaired: 0, scanned: 0});
});
