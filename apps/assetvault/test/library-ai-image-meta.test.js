import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import zlib from 'node:zlib';
import {readAiImageMeta} from '../server/ai-image-meta.mjs';

// 手写 PNG tEXt 块（sharp 不写文本块，只能自己拼）
const CRC_TABLE = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const x of buf) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const textChunk = (key, value) => chunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'utf8')]));
const zChunk = (key, value) => chunk('zTXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0, 0]), zlib.deflateSync(Buffer.from(value, 'utf8'))]));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-aimeta-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const base = await sharp({create: {width: 2, height: 2, channels: 4, background: 'red'}}).png().toBuffer();
  const iend = base.lastIndexOf(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44]));
  const build = async (name, ...chunks) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, Buffer.concat([base.subarray(0, iend), ...chunks, base.subarray(iend)]));
    return file;
  };
  return {dir, build, base};
}

test('SD WebUI parameters 提取正面提示词并识别工具', async t => {
  const {build} = await fixture(t);
  const file = await build('sd.png', textChunk('parameters',
    'epic cinematic castle\nNegative prompt: blurry, low quality\nSteps: 25, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 42'));
  assert.deepEqual(await readAiImageMeta(file), {tool: 'Stable Diffusion', prompt: 'epic cinematic castle'});
});

test('ComfyUI workflow JSON 抽取 CLIPTextEncode 提示词', async t => {
  const {build} = await fixture(t);
  const graph = {'6': {class_type: 'CLIPTextEncode', inputs: {text: 'a cute robot, 4k'}}, '3': {class_type: 'KSampler'}};
  const file = await build('comfy.png', textChunk('prompt', JSON.stringify(graph)));
  assert.deepEqual(await readAiImageMeta(file), {tool: 'ComfyUI', prompt: 'a cute robot, 4k'});
});

test('文本块在 IDAT 之后也能读到', async t => {
  const {build} = await fixture(t);
  // build 已把块插在 IEND 前（IDAT 之后），此用例与 SD 用例同构，强调位置无关
  const file = await build('late.png', textChunk('parameters', 'late block\nSteps: 20, CFG scale: 7'));
  assert.equal((await readAiImageMeta(file))?.prompt, 'late block');
});

test('压缩文本块 zTXt 可读', async t => {
  const {build} = await fixture(t);
  const file = await build('z.png', zChunk('parameters', 'compressed prompt\nSteps: 20, CFG scale: 5'));
  assert.equal((await readAiImageMeta(file))?.prompt, 'compressed prompt');
});

test('普通 PNG / 无生成信息的文本块返回 null', async t => {
  const {build} = await fixture(t);
  assert.equal(await readAiImageMeta(await build('plain.png')), null);
  assert.equal(await readAiImageMeta(await build('comment.png', textChunk('Comment', 'just a photo'))), null);
});

test('非 PNG 与不存在的文件返回 null，不抛错', async t => {
  const {dir, base} = await fixture(t);
  const jpg = path.join(dir, 'x.jpg');
  await fs.writeFile(jpg, base);
  assert.equal(await readAiImageMeta(jpg), null);
  assert.equal(await readAiImageMeta(path.join(dir, 'missing.png')), null);
});
