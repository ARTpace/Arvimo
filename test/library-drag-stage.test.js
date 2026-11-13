import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createDragStage, IMAGE_MIMES_FULL} from '../server/drag-stage.mjs';

const remote = (bytes, mime = 'image/jpeg', status = 200) => ({
  status,
  headers: {'content-type': mime},
  stream: Readable.from([Buffer.from(bytes)]),
});

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-drag-test-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

const stageFor = (dir, overrides = {}) => createDragStage({
  dir,
  fetchRemote: async () => remote('JPEG-BYTES'),
  resolveLocal: async ({rel}) => `H:/library/${rel}`,
  isAllowedHost: () => true,
  ...overrides,
});

const picture = {type: 'remote', url: 'https://cdn.example.com/origin_4k.jpg', name: '落日.jpg'};

test('local 描述换成绝对路径，remote 描述落盘成真文件', async t => {
  const dir = await scratch(t);
  const stage = stageFor(dir);
  const result = await stage.resolve([
    {type: 'local', root: 'H:/library', rel: 'packs/foo/a.png'},
    picture,
  ]);
  assert.equal(result.files[0], 'H:/library/packs/foo/a.png');
  assert.ok(result.files[1].startsWith(dir), '远端原图必须落在拖放缓存目录里');
  assert.equal((await fs.readFile(result.files[1])).toString(), 'JPEG-BYTES');
  assert.match(result.files[1], /落日.*\.jpg$/, '拖到 PS 里要保留有意义的文件名');
});

test('同一张原图第二次直接复用缓存，不重复回源', async t => {
  const dir = await scratch(t);
  let calls = 0;
  const stage = stageFor(dir, {fetchRemote: async () => { calls += 1; return remote('ABC'); }});
  const first = await stage.resolve([picture]);
  const second = await stage.resolve([picture]);
  assert.equal(calls, 1);
  assert.deepEqual(first.files, second.files);
});

test('本地文件失效只跳过它，全失效才报错', async t => {
  const dir = await scratch(t);
  const stage = stageFor(dir, {resolveLocal: async ({rel}) => {
    if (rel.endsWith('gone.png')) throw Error('文件被移走');
    return `H:/library/${rel}`;
  }});
  const result = await stage.resolve([
    {type: 'local', root: 'H:/library', rel: 'gone.png'},
    {type: 'local', root: 'H:/library', rel: 'ok.png'},
  ]);
  assert.deepEqual(result.files, ['H:/library/ok.png']);
  await assert.rejects(stage.resolve([{type: 'local', root: 'H:/library', rel: 'gone.png'}]), /没有可拖出的文件/);
});

test('非图片 MIME / 不在白名单的域名 / 超上限一律拒绝', async t => {
  const dir = await scratch(t);
  const badMime = stageFor(dir, {fetchRemote: async () => remote('<html>', 'text/html')});
  await assert.rejects(badMime.resolve([picture]), /不是可拖出的图片/);
  const badHost = stageFor(dir, {isAllowedHost: () => false});
  await assert.rejects(badHost.resolve([picture]), /不在允许清单/);
  const tooBig = stageFor(dir, {fetchRemote: async () => remote('12345678'), limits: {cap: 4}});
  await assert.rejects(tooBig.resolve([picture]), /超过大小上限/);
});

test('条目类型与数量有边界，图片 MIME 清单与协议一致', async t => {
  const dir = await scratch(t);
  const stage = stageFor(dir);
  await assert.rejects(stage.resolve([{type: 'whatever'}]), /未知的拖放条目类型/);
  await assert.rejects(stage.resolve(Array.from({length: 100}, () => ({type: 'local', rel: 'a.png'}))), /一次最多拖/);
  assert.ok(IMAGE_MIMES_FULL.includes('image/tiff'));
  assert.ok(!IMAGE_MIMES_FULL.includes('text/html'));
});
