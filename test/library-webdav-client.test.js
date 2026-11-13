import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebdav} from '../server/webdav-client.mjs';

const client = (fetchImpl, timeoutMs = 100) => createWebdav({url: 'https://dav.invalid/root', fetchImpl, timeoutMs});
const xml = etag => `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/root/file</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag></d:prop></d:propstat></d:response></d:multistatus>`;

test('HEAD/PUT 保留旧 etag 字段并提供原始 quoted / weak ETag，缺失不伪造', async () => {
  for (const raw of ['"quoted"', 'W/"weak"', null]) {
    const dav = client(async () => new Response(null, {headers: raw ? {etag: raw} : {}}));
    const stat = await dav.stat('file');
    const put = await dav.put('file', Buffer.from('x'));
    assert.equal(stat.rawEtag, raw);
    assert.equal(put.rawEtag, raw);
    assert.equal(stat.etag, raw?.replace(/"/g, '') || null);
    assert.equal(put.etag, stat.etag);
  }
});

test('getWithMetadata 单次GET绑定同版本buffer/rawEtag，不调用HEAD，旧get仍返回Buffer', async () => {
  let version = 0;
  const methods = [];
  const dav = client(async (_, {method}) => {
    methods.push(method);
    assert.equal(method, 'GET', '不能用HEAD和GET拼接版本');
    version++;
    return new Response(`版本${version}🐍`, {headers: {etag: `"version-${version}"`}});
  });
  const first = await dav.getWithMetadata('head.json');
  assert.ok(Buffer.isBuffer(first.buffer));
  assert.equal(first.buffer.toString('utf8'), '版本1🐍');
  assert.equal(first.rawEtag, '"version-1"');
  const second = await dav.getWithMetadata('head.json');
  assert.equal(second.buffer.toString('utf8'), '版本2🐍');
  assert.equal(second.rawEtag, '"version-2"');
  assert.deepEqual(methods, ['GET', 'GET']);
  const legacy = await dav.get('head.json');
  assert.ok(Buffer.isBuffer(legacy));
  assert.equal(legacy.toString(), '版本3🐍');
});

test('getWithMetadata 缺etag为null且弱令牌原样保留，404为null，HTTP错误不冒充成功', async () => {
  for (const rawEtag of [null, 'W/"weak"', '"quoted"']) {
    const dav = client(async () => new Response('body', {headers: rawEtag ? {etag: rawEtag} : {}}));
    assert.deepEqual(await dav.getWithMetadata('head'), {buffer: Buffer.from('body'), rawEtag});
  }
  const empty = client(async () => new Response(null, {status: 200, headers: {etag: '"empty"'}}));
  assert.deepEqual(await empty.getWithMetadata('head'), {buffer: Buffer.alloc(0), rawEtag: '"empty"'});
  const absent = client(async () => new Response(null, {status: 404}));
  assert.equal(await absent.getWithMetadata('head'), null);
  const denied = client(async () => new Response(null, {status: 403}));
  await assert.rejects(() => denied.getWithMetadata('head'), {code: 'WEBDAV_HTTP', status: 403});
});

test('getWithMetadata 同样覆盖流超时取消及重定向失败关闭，无第二请求', async () => {
  let cancelled = 0, signal, calls = 0;
  const hung = client(async (_, options) => {
    calls++;
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
      cancel() { cancelled++; },
    }), {headers: {etag: '"partial"'}});
  }, 20);
  await assert.rejects(() => hung.getWithMetadata('head'), {code: 'WEBDAV_TIMEOUT'});
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, 1);
  assert.equal(calls, 1);
  calls = 0;
  const redirect = client(async (_, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return new Response(null, {status: 302, headers: {location: 'https://other.invalid/'}});
  });
  await assert.rejects(() => redirect.getWithMetadata('head'), {code: 'WEBDAV_REDIRECT', status: 302});
  assert.equal(calls, 1);
});

test('getWithMetadata 严格实际字节边界，多字节未知长度及伪造长度均受限', async () => {
  const bytes = Buffer.from('中文🐍');
  for (const declared of [null, '1', '999999']) {
    let cancelled = 0, signal;
    const dav = client(async (_, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); },
        cancel() { cancelled++; },
      }), {headers: declared ? {'content-length': declared} : {}});
    });
    await assert.rejects(() => dav.getWithMetadata('head', {maxBytes: bytes.length - 1}), {code: 'WEBDAV_TOO_LARGE', status: 200});
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, 1);
  }
  const exact = client(async () => new Response(bytes));
  assert.deepEqual((await exact.getWithMetadata('head', {maxBytes: bytes.length})).buffer, bytes);
});

test('getWithMetadata 默认8MiB精确边界通过，+1字节取消与abort；旧get不限此阈值', async () => {
  const limit = 8 * 1024 * 1024;
  const exact = Buffer.alloc(limit, 97);
  const bounded = client(async () => new Response(exact), 1000);
  assert.equal((await bounded.getWithMetadata('head')).buffer.length, limit);
  let cancelled = 0, signal;
  const oversized = client(async (_, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(exact); controller.enqueue(Uint8Array.of(1)); },
      cancel() { cancelled++; },
    }));
  }, 1000);
  await assert.rejects(() => oversized.getWithMetadata('head'), {code: 'WEBDAV_TOO_LARGE', status: 200});
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, 1);
  const legacy = client(async () => new Response(Buffer.alloc(limit + 1)), 1000);
  assert.equal((await legacy.get('head')).length, limit + 1);
});

test('getWithMetadata 非法limit零fetch，无reader响应失败关闭且不全量arrayBuffer', async () => {
  let calls = 0;
  const dav = client(async () => { calls++; return new Response('ok'); });
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, '10', null, 8 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => dav.getWithMetadata('head', {maxBytes}), {code: 'WEBDAV_INVALID_LIMIT'});
  }
  assert.equal(calls, 0);
  let fullReads = 0, signal;
  const fallback = client(async (_, options) => {
    signal = options.signal;
    return {status: 200, headers: new Headers(), arrayBuffer: async () => { fullReads++; return new ArrayBuffer(0); }};
  });
  await assert.rejects(() => fallback.getWithMetadata('head'), {code: 'WEBDAV_UNBOUNDED_BODY', status: 200});
  assert.equal(fullReads, 0);
  assert.equal(signal.aborted, true);
  assert.ok(Buffer.isBuffer(await fallback.get('head')));
  assert.equal(fullReads, 1, '旧get兼容非流式fake响应');
});

test('PROPFIND list/stat 原始 ETag 解码 XML 引号且保留 weak 标识', async () => {
  const dav = client(async (_, {method}) => method === 'HEAD'
    ? new Response(null, {status: 405}) : new Response(xml('W/&quot;weak&amp;token&quot;'), {status: 207}));
  assert.equal((await dav.stat('file')).rawEtag, 'W/"weak&token"');
  assert.equal((await dav.list('folder'))[0].rawEtag, 'W/"weak&token"');
});

test('条件写必须唯一强 ETag / create-only，412 单次请求明确冲突不覆盖', async () => {
  const calls = [];
  const dav = client(async (url, options) => {
    calls.push({url, ...options});
    return new Response(null, {status: 412});
  });
  for (const options of [{}, {ifMatch: 'unquoted'}, {ifMatch: 'W/"weak"'}, {ifMatch: '*'},
    {ifMatch: '"a", "b"'}, {ifMatch: '"a"\r\nX: y'}, {ifMatch: '"a"', ifNoneMatch: '*'}, {ifNoneMatch: '"a"'}, {ifMatch: null}]) {
    await assert.rejects(() => dav.putConditional('head.json', Buffer.from('x'), options), {code: 'WEBDAV_INVALID_CONDITION', status: 0});
  }
  assert.equal(calls.length, 0);
  await assert.rejects(() => dav.putConditional('head.json', Buffer.from('x'), {ifMatch: '"exact"'}), {code: 'WEBDAV_CONFLICT', status: 412});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['If-Match'], '"exact"');
  assert.equal(calls[0].headers['If-None-Match'], undefined);
  await assert.rejects(() => dav.putConditional('head.json', Buffer.from('x'), {ifNoneMatch: '*'}), {code: 'WEBDAV_CONFLICT', status: 412});
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers['If-None-Match'], '*');
});

test('条件写拒绝ETag实际尾换行且不调用fetch', async () => {
  let calls = 0;
  const dav = client(async () => { calls++; return new Response(null, {status: 201}); });
  for (const ifMatch of ['"a"\n', '"a"\r\n']) {
    await assert.rejects(() => dav.putConditional('head.json', Buffer.from('x'), {ifMatch}), {code: 'WEBDAV_INVALID_CONDITION'});
  }
  assert.equal(calls, 0);
});

test('条件写保持合法opaque逗号反斜杠与obs-text且拒绝quoted列表', async () => {
  const calls = [];
  const dav = client(async (_, options) => { calls.push(options); return new Response(null, {status: 201}); });
  const ifMatch = '"a,b\\opaque-ÿ"';
  await dav.putConditional('head.json', Buffer.from('x'), {ifMatch});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['If-Match'], ifMatch);
  await assert.rejects(() => dav.putConditional('head.json', Buffer.from('x'), {ifMatch: '"a", "b"'}), {code: 'WEBDAV_INVALID_CONDITION'});
  assert.equal(calls.length, 1);
});

test('条件写成功不推断支持能力或捏造缺失 ETag', async () => {
  const dav = client(async (_, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(null, {status: 201});
  });
  assert.deepEqual(await dav.putConditional('head.json', Buffer.from('x'), {ifNoneMatch: '*'}), {etag: null, rawEtag: null});
});

test('真实挂起 Response 流：GET/list/HEAD fallback 从 headers 到 body 受 deadline 并取消', async () => {
  for (const method of ['get', 'list', 'stat']) {
    let cancelled = 0, signal;
    const dav = client(async (_, options) => {
      if (method === 'stat' && options.method === 'HEAD') return new Response(null, {status: 405});
      signal = options.signal;
      return new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('partial')); }, cancel() { cancelled++; }}),
        {status: method === 'get' ? 200 : 207});
    }, 20);
    await assert.rejects(() => dav[method]('file'), {code: 'WEBDAV_TIMEOUT'});
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, 1);
  }
});

test('fetch 本身挂起同样超时，成功后定时器释放不会再 abort signal', async () => {
  let signal;
  const hung = client(async (_, options) => { signal = options.signal; return new Promise(() => {}); }, 20);
  await assert.rejects(() => hung.get('file'), {code: 'WEBDAV_TIMEOUT', status: 0});
  assert.equal(signal.aborted, true);
  const success = client(async (_, options) => { signal = options.signal; return new Response('ok'); }, 20);
  assert.equal((await success.get('file')).toString(), 'ok');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(signal.aborted, false);
});

test('重定向 fail-closed，无跨站请求 / HEAD fallback，普通错误稳定 code/status', async () => {
  let calls = 0;
  const dav = client(async (_, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    return new Response(null, {status: 302, headers: {location: 'http://other.invalid/'}});
  });
  await assert.rejects(() => dav.stat('file'), {code: 'WEBDAV_REDIRECT', status: 302});
  assert.equal(calls, 1);
  const denied = client(async () => new Response(null, {status: 403}));
  await assert.rejects(() => denied.get('file'), {code: 'WEBDAV_HTTP', status: 403});
  const network = client(async () => { throw Error('offline'); });
  await assert.rejects(() => network.get('file'), {code: 'WEBDAV_NETWORK', status: 0});
});
