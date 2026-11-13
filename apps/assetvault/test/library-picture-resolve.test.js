// /api/picture-site/resolve 的分页契约：前端滑一屏就加 60，服务端不能每次都从第一页重翻。
//
// 这个端点是图站页面唯一的图片数据来源，它的返回决定三件事：
//  · 首屏能不能马上出来（不能为了 total 先翻二十页）；
//  · 滚下去会不会越滑越慢（每屏都回源就一定会）；
//  · 卡片上「共 N 张」是不是真的（没翻完就不许报数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryServer} from '../server/library.mjs';
import {forgetPictureIndex} from '../server/picture-index.mjs';

const BOARD = 'https://huaban.com/boards/777001';
const TOTAL = 200;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const boardCollect = calls => async (platform, args, {maxItems} = {}) => {
  calls.push(maxItems);
  if ((maxItems ?? 0) > 1000) await sleep(120); // 全量那一轮慢一点，模拟真实翻页
  const count = Math.min(TOTAL, maxItems ?? TOTAL);
  return {
    items: Array.from({length: count}, (_, index) => ({url: `https://img.example/${index}.jpg`, width: 1200, height: 800})),
    truncated: count < TOTAL,
    title: '美宣 插画',
    author: '某人',
    platform,
  };
};

test('滚一屏加 60：第二屏只切片，不重翻第一页；总量等翻完才报', async () => {
  forgetPictureIndex('huaban', BOARD);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sfx-picresolve-'));
  const calls = [];
  const server = createLibraryServer({cacheDir: path.join(dir, 'cache'), pictureCollect: boardCollect(calls)});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (limit, headers = {'x-sfx-local': '1'}) => fetch(`${base}/api/picture-site/resolve?platform=huaban&limit=${limit}&url=${encodeURIComponent(BOARD)}`, {headers});
  try {
    assert.equal((await get(60, {})).status, 403, '没有本地标识一律拒绝');
    assert.equal((await fetch(`${base}/api/picture-site/resolve?platform=nope&url=${encodeURIComponent(BOARD)}`, {headers: {'x-sfx-local': '1'}})).status, 400);

    const first = await (await get(60)).json();
    assert.equal(first.items.length, 60);
    assert.equal(first.truncated, true);
    assert.equal(first.total, 0, '还没翻完，不能报总数（那会是「共 72 张」这种假数字）');

    await sleep(260); // 让后台把整块画板翻完

    const second = await (await get(120)).json();
    assert.equal(second.items.length, 120);
    assert.equal(second.total, TOTAL, '翻完之后给真实总量');
    assert.equal(second.truncated, true);

    const all = await (await get(400)).json();
    assert.equal(all.items.length, TOTAL);
    assert.equal(all.truncated, false);
    assert.equal(all.complete, true);

    // 三次请求只回源两次：首屏一次 + 后台全量一次。每屏都回源的话这里会是 4 次以上。
    assert.deepEqual(calls, [72, 6000]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(dir, {recursive: true, force: true});
  }
});
