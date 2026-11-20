import assert from 'node:assert/strict';
import test from 'node:test';
import {SHORT_VIDEO_SITES} from '../src/library/short-video-platforms.js';
import {PICTURE_SITES, VIDEO_SITE_IDS, isPictureSite} from '../server/picture-sites.mjs';
import {PICTURE_SITES as FRONT_SITES, platformsForMode, platformKinds, isVideoSite, pictureSiteSearchable, pictureSiteHome, PICTURE_SITE_GROUPS} from '../src/library/platforms.js';

// 视频四站的接线只要错一处，症状都很像「网络问题」：池子里没有它们 → 视频模式一个站都选不到；
// 混进图片池 → 选了却搜不到图；server/front 两份 id 对不上 → 解析直接 400「不支持抓取」。
// 这里把这些不联网就能验证的约束钉住，真实抓取交给离线冒烟（scratch，不入库）。

const STOCK_VIDEO_IDS = ['pexels-video', 'coverr', 'civitai-video', 'pixabay-video'];
const VIDEO_IDS = [...STOCK_VIDEO_IDS, ...Object.keys(SHORT_VIDEO_SITES)];

test('素材视频与短视频在服务端与前端注册表里一一对应', () => {
  assert.deepEqual([...VIDEO_SITE_IDS], VIDEO_IDS);
  for (const id of VIDEO_IDS) {
    const server = PICTURE_SITES[id];
    assert.ok(server, `服务端缺 ${id}`);
    assert.equal(typeof server.resolve, 'function', `${id} 必须有 resolve`);
    assert.equal(server.id, id, `${id} 的 id 与键名要一致（下载与设置页都按它查）`);
    const front = FRONT_SITES[id];
    assert.ok(front, `前端注册表缺 ${id}（粘链接与设置页读这份）`);
    assert.equal(front.kind, 'video', `${id} 在前端要标成视频站`);
    assert.ok(isPictureSite(id), `${id} 要走图站解析链路（视频卡复用同一套瀑布流）`);
    assert.ok(isVideoSite(id));
    assert.deepEqual(platformKinds(id), ['video']);
  }
});

test('视频站只进视频模式的池子，不污染图片 / 全量池', () => {
  const video = platformsForMode('video').map(item => item.id);
  assert.deepEqual(video.slice().sort(), VIDEO_IDS.slice().sort());
  const image = platformsForMode('image').map(item => item.id);
  for (const id of VIDEO_IDS) assert.ok(!image.includes(id), `${id} 不该出现在图片模式`);
  const all = platformsForMode('').map(item => item.id);
  for (const id of VIDEO_IDS) assert.ok(!all.includes(id), `${id} 不该出现在无模式全量池`);
  // 视频站没有模型流，不能被当成 3D 平台列出来。
  assert.ok(!platformsForMode('model').map(item => item.id).includes('coverr'));
});

test('设置页包含所有视频站，素材视频提供首页、短视频提供分享入口', () => {
  const group = PICTURE_SITE_GROUPS.find(item => item.name === '视频素材');
  assert.ok(group, '设置页要有「视频素材」分组，否则用户找不到视频站开关');
  assert.deepEqual(group.sites.map(site => site.id).sort(), [...VIDEO_IDS].sort());
  for (const id of STOCK_VIDEO_IDS) {
    assert.equal(typeof pictureSiteHome(id), 'string');
    assert.ok(pictureSiteHome(id).startsWith('http'), `${id} 的空关键词入口要是个真地址`);
  }
  for (const id of Object.keys(SHORT_VIDEO_SITES)) assert.ok(FRONT_SITES[id].example.startsWith('https://'), `${id} 必须提供分享入口`);
});

test('哪些视频站能搜关键词，必须在注册表里写明', () => {
  // Civitai 的 images API 没有关键词维度（只有 username / modelId / postId），
  // 前端据此把空状态改成「粘作者主页」，所以这个标志不能漏。
  assert.equal(pictureSiteSearchable('pexels-video'), true);
  assert.equal(pictureSiteSearchable('coverr'), true);
  assert.equal(pictureSiteSearchable('pixabay-video'), true);
  assert.equal(pictureSiteSearchable('civitai-video'), false);
});
