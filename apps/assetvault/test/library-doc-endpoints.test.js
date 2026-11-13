// 文档预览的服务端端点：守卫、静态 bundle 放行、能力位、root 白名单。
// 与 library-doc-convert.test.js 的分工：那边测纯逻辑，这边测真 HTTP 路由。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLibraryServer} from '../server/library.mjs';
import {SERVER_CAPABILITIES, SERVER_VERSION} from '../server/capabilities.mjs';
import {DOC_PDF_EXTS} from '../server/doc-convert.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = {'X-SFX-Local': '1'};

async function serve() {
  const server = createLibraryServer({
    downloads: {close: async () => {}},
    search: async () => ({models: []}),
    scan: async () => ({models: []}),
    artsearch: async () => ({models: []}),
    polyhaven: async () => ({models: []}),
    staticRoot: path.join(root, 'dist/library'),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {base, close: async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }};
}

test('/api/doc/status 是内部接口：必须有 x-sfx-local，且如实报告无 LibreOffice', async () => {
  const {base, close} = await serve();
  try {
    assert.equal((await fetch(base + '/api/doc/status')).status, 403, '缺守卫要拒绝');
    const response = await fetch(base + '/api/doc/status', {headers: local});
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(typeof status.available, 'boolean');
    assert.ok(Array.isArray(status.exts));
    assert.ok(status.exts.includes('pptx'));
    assert.deepEqual(status.exts, DOC_PDF_EXTS);
    // 本机没装 LO 时 path 必须是 null，不能编一个路径骗前端。
    if (!status.available) assert.equal(status.path, null);
  } finally { await close(); }
});

test('/api/doc/pdf 按「索引过的 root」鉴权：没索引的文件夹一律 403', async () => {
  const {base, close} = await serve();
  try {
    const url = base + '/api/doc/pdf?root=' + encodeURIComponent(root) + '&rel=deck.pptx';
    const response = await fetch(url);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /索引/);
  } finally { await close(); }
});

test('能力位与版本号：旧进程会被启动器换掉，静态 bundle 走同源白名单', async () => {
  // 只校验「只升不降」而不是钉死具体版本：每加一个能力位就升一次版，写死会让测试无谓变红。
  const [major, minor] = SERVER_VERSION.split('.').map(Number);
  assert.ok(major === 3 && minor >= 17, `SERVER_VERSION 必须 >= 3.17.0，实际 ${SERVER_VERSION}`);
  assert.equal(SERVER_CAPABILITIES.version, SERVER_VERSION);
  assert.equal(SERVER_CAPABILITIES.docRenderBundle, true);
  assert.equal(SERVER_CAPABILITIES.docConvertPdf, true);
  const {base, close} = await serve();
  try {
    const response = await fetch(base + '/api/downloads/capabilities', {headers: local});
    assert.equal(response.status, 200);
    const cap = await response.json();
    assert.equal(cap.docRenderBundle, true);
    assert.equal(cap.docConvertPdf, true);
    assert.equal(cap.version, SERVER_VERSION);
    // 独立 bundle 必须能同源加载，否则 CSP 会拦、import() 直接失败。
    const bundle = await fetch(base + '/doc-render.js');
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') || '', /javascript/);
    assert.match(await bundle.text(), /renderDocument/);
  } finally { await close(); }
});
