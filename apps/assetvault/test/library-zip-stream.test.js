import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { streamFolderZip, collectPackageFiles } from '../server/zip-stream.mjs';

function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  return {
    root,
    write(rel, content) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    },
  };
}

function sink() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  res.headers = null;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.buffer = () => Buffer.concat(chunks);
  return res;
}

/** 只认自己写出来的结构：从 EOCD 反查中央目录，再按 local header 取内容。 */
function readZip(buffer) {
  const eocdAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocdAt > 0, '缺少 EOCD');
  const count = buffer.readUInt16LE(eocdAt + 10);
  const cdOffset = buffer.readUInt32LE(eocdAt + 16);
  const entries = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50, '中央目录签名不对');
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 24);
    const nameLen = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const localAt = buffer.readUInt32LE(at + 42);
    const flags = buffer.readUInt16LE(at + 8);
    const localNameLen = buffer.readUInt16LE(localAt + 26);
    const localExtra = buffer.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLen + localExtra;
    entries.push({ name, crc, size, flags, data: buffer.subarray(dataAt, dataAt + size) });
    at += 46 + nameLen;
  }
  return entries;
}

test('把素材文件夹打成可解压的 ZIP', async () => {
  const dir = box();
  dir.write('a.png', 'alpha-one');
  dir.write('sub/b.png', 'alpha-two');
  dir.write('info.json', '{"uid":"local-x"}');

  const res = sink();
  await streamFolderZip(res, { dir: dir.root, name: '素材包.zip' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/zip');
  assert.match(res.headers['Content-Disposition'], /filename\*=UTF-8''/);

  const buffer = res.buffer();
  assert.equal(Number(res.headers['Content-Length']), buffer.length, 'Content-Length 要和实际字节一致');

  const entries = readZip(buffer);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['a.png', 'info.json', 'sub/b.png']);
  for (const entry of entries) {
    assert.equal(entry.flags & 0x0800, 0x0800, '文件名要标记 UTF-8');
    assert.equal(zlib.crc32(entry.data), entry.crc, `${entry.name} 的 CRC 对不上`);
  }
  assert.equal(entries.find((e) => e.name === 'a.png').data.toString(), 'alpha-one');
  assert.equal(entries.find((e) => e.name === 'sub/b.png').data.toString(), 'alpha-two');
});

test('中文与空格文件名保持原样（UTF-8 标记）', async () => {
  const dir = box();
  dir.write('日式纹饰/图案 01.png', 'x');

  const res = sink();
  await streamFolderZip(res, { dir: dir.root, name: '日式纹饰.zip' });
  const entries = readZip(res.buffer());
  assert.deepEqual(entries.map((e) => e.name), ['日式纹饰/图案 01.png']);
});

test('跳过点开头的目录和文件（.assetvault / .git）', async () => {
  const dir = box();
  dir.write('keep.png', 'k');
  dir.write('.assetvault/ai.json', '{}');
  dir.write('.DS_Store', 'junk');

  const files = await collectPackageFiles(dir.root);
  assert.deepEqual(files.map((f) => f.rel), ['keep.png']);

  const res = sink();
  await streamFolderZip(res, { dir: dir.root, name: 'p.zip' });
  assert.deepEqual(readZip(res.buffer()).map((e) => e.name), ['keep.png']);
});

test('空目录直接报错，不发半个包', async () => {
  const dir = box();
  fs.mkdirSync(path.join(dir.root, 'empty'), { recursive: true });
  fs.writeFileSync(path.join(dir.root, '.hidden'), 'x');
  const res = sink();
  await assert.rejects(() => streamFolderZip(res, { dir: dir.root, name: 'p.zip' }), /没有可以打包的文件/);
  assert.equal(res.headers, null, '报错前不该先写响应头');
});
