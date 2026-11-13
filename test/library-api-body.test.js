import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {createLibraryApi} from '../server/library-api.mjs';
import {PORTABLE_FORMAT} from '../server/library-portable.mjs';
import {SESSION_STATE_KEY} from '../server/library-schema.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-api-body-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const storage = createLibraryStorage(dir, null, {});
  const api = createLibraryApi({storage});
  t.after(() => api.dispose());
  return {storage, api};
}

async function call(api, pathname, buffer, chunkSize = 3) {
  let consumed = 0;
  const req = Readable.from((function* () {
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      const chunk = buffer.subarray(offset, offset + chunkSize);
      consumed += chunk.length;
      yield chunk;
    }
  })());
  req.method = 'POST';
  req.headers = {'x-sfx-local': '1'};
  const res = {status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; }};
  assert.equal(await api.handle(req, res, new URL(`http://127.0.0.1${pathname}`)), true);
  return {status: res.status, data: JSON.parse(res.body), consumed, ended: req.readableEnded};
}

test('小 Buffer 分片跨中文与 emoji 字节导入，名称/标签/备注原样入库', async t => {
  const {storage, api} = await fixture(t);
  const uid = 'c'.repeat(32);
  const model = {uid, name: '中文模型🐍🎨', tags: ['材质🪵', '石头'], userTags: ['我的标签🌟'], note: '备注：保留中文与emoji🚀'};
  const body = Buffer.from(JSON.stringify({mode: 'merge', snapshot: {format: PORTABLE_FORMAT, version: 1, assets: [model], trashed: [], collections: []}}));
  const result = await call(api, '/api/library/import', body, 1);
  assert.equal(result.status, 200);
  assert.equal(result.consumed, body.length);
  const catalog = await storage.withDb(conn => conn.readCatalog());
  assert.equal(catalog.models[0].name, model.name);
  assert.deepEqual(catalog.models[0].tags, model.tags);
  const user = await storage.withDb(conn => conn.readUserDomain());
  assert.equal(user.userMeta[uid].note, model.note);
  assert.deepEqual(user.userTags[uid], model.userTags);
});

const BODY_LIMIT = 2 * 1024 * 1024; // session 路由实际 readBody 上限
function sessionBody(size) {
  const overhead = Buffer.byteLength(JSON.stringify({options: {value: ''}}));
  const budget = size - overhead;
  return Buffer.from(JSON.stringify({options: {value: '中'.repeat(Math.floor(budget / 3)) + 'x'.repeat(budget % 3)}}));
}

test('session 精确原始字节边界合法，多字节分片不被替换字符误计超限', async t => {
  const {storage, api} = await fixture(t);
  const body = sessionBody(BODY_LIMIT);
  assert.equal(body.length, BODY_LIMIT);
  const result = await call(api, '/api/library/session', body, 1024);
  assert.equal(result.status, 200);
  assert.equal(result.consumed, body.length);
  const view = await storage.load();
  assert.equal(JSON.parse(view.values[SESSION_STATE_KEY]).options.value, JSON.parse(body.toString('utf8')).options.value);
});

test('原始字节超限返回413并排空后续分片，不调用写入或广播', async t => {
  const {storage, api} = await fixture(t);
  let writes = 0;
  storage.mutate = () => { writes += 1; throw Error('must not write'); };
  const seq = api.events.seq;
  const body = sessionBody(BODY_LIMIT + 8192);
  const result = await call(api, '/api/library/session', body, 1024);
  assert.equal(result.status, 413);
  assert.match(result.data.error, /请求体超过/);
  assert.equal(result.consumed, body.length, '超限之后的分片也必须全部消费');
  assert.equal(result.ended, true);
  assert.equal(writes, 0);
  assert.equal(api.events.seq, seq);
});

test('invalid JSON 和空请求继续返回原有400，均不写入', async t => {
  const {storage, api} = await fixture(t);
  let writes = 0;
  storage.mutate = () => { writes += 1; throw Error('must not write'); };
  const invalid = await call(api, '/api/library/session', Buffer.from('{"options":"中文🐍'), 1);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error, '无效的 JSON 请求');
  const empty = await call(api, '/api/library/session', Buffer.alloc(0));
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error, '没有会话数据');
  assert.equal(writes, 0);
});
