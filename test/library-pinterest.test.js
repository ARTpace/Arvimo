import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { collectPictureAssets } from '../server/picture-sites.mjs';

test('Pinterest 主页和 saved 页返回画板，点击画板仍提取图片', async t => {
  t.mock.method(net, 'connect', () => {
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  const board = { id: '123', title: '参考', count: 3, cover: 'https://i.pinimg.com/cover.jpg', url: 'https://www.pinterest.com/cihangelerli/reference/' };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('/api/boards?')) return Response.json({ ok: true, author: 'cihangelerli', boards: [board] });
    if (String(url).endsWith('/api/collect')) {
      assert.equal(JSON.parse(options.body).text, board.url);
      return Response.json({ ok: true });
    }
    if (String(url).endsWith('/api/status')) return Response.json({ state: 'preview', images: [{ orig: 'https://i.pinimg.com/originals/test.jpg', pid: '456' }] });
    throw new Error(`Unexpected request: ${url}`);
  });
  for (const suffix of ['', '_saved/', 'boards/']) {
    const result = await collectPictureAssets('pinterest', { url: `https://www.pinterest.com/cihangelerli/${suffix}` }, { maxItems: 1 });
    assert.equal(result.mode, 'boards');
    assert.deepEqual(result.boards, [board]);
    assert.deepEqual(result.items, []);
    assert.equal(result.total, 1);
    assert.equal(result.truncated, false);
  }
  assert.equal(calls.length, 3);
  const images = await collectPictureAssets('pinterest', { url: board.url }, { maxItems: 48 });
  assert.equal(images.items[0].pid, '456');
  assert.equal(images.boards, undefined);
});
