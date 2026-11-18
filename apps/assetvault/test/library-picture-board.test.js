// 「只入库」＝ 远程收藏卡：只写 info.json，图片一张都不下。
//
// 这里钉住三条契约：
//  1. 写出的目录能被扫描器当成正式资产卡（有标题/作者/远程封面/来源/张数，分类是图片）；
//  2. 清单里**不许出现 images 数组** —— 一旦声明了图片，校验器就要求文件真在磁盘上；
//  3. 之后点「下载原图」时，队列接管同一个目录，不会在旁边长出 `(1)` 变成两张卡。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  writePictureBoardCard, findBoardDir, findRemoteBoardDir, isBoardUid, REMOTE_STATUS,
} from '../server/picture-board.mjs';
import {scanLibraryPackages} from '../server/local-assets.mjs';
import {recoverDownloads} from '../server/download-recovery.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {createLibraryServer} from '../server/library.mjs';
import {assetFolder} from '../server/asset-folders.mjs';
import {fixturePng} from './download-fixture.mjs';

const UID = 'd'.repeat(32);
const OTHER = 'e'.repeat(32);
const BOARD = 'https://huaban.com/boards/123456';
const COVER = 'https://gd-hbimg.huaban.com/abcdef_fw658';
const readInfo = dir => JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf8'));
const temp = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sfx-boardcard-'));
  const download = path.join(dir, 'downloads');
  await fsp.mkdir(download, {recursive: true});
  return {dir, download};
};
// 分类与真实生产一致（library.mjs 写卡 + 下载任务都走 assetFolder），否则「接管不另建 (1)」无从谈起。
const CATEGORY = assetFolder({title: '美宣 插画', platform: 'huaban', assetType: 'images'});
const card = (download, over = {}) => writePictureBoardCard({
  folder: download, category: CATEGORY, uid: UID, platform: 'huaban', url: BOARD,
  title: '美宣 插画', author: '某人', cover: COVER, imageCount: 1923, ...over,
});
const REMOTE_ITEMS = [
  {url: 'https://img/1.jpg', thumb: 'https://img/1_fw480.jpg', title: '第一张', pageUrl: 'https://huaban.com/pin/1', width: 800, height: 600},
  {url: 'https://img/2.jpg', title: '第二张'},
];

test('远程收藏卡是一张真正的资产卡：有远程封面和张数，但磁盘上一张图都没有', async () => {
  const {dir, download} = await temp();
  try {
    const written = await card(download);
    assert.equal(written.skipped, false);
    const info = readInfo(written.dir);
    assert.equal(info.status, REMOTE_STATUS);
    assert.equal(info.remote, true);
    assert.equal(info.imageCount, 1923);
    assert.equal(info.thumbnail, COVER);
    assert.equal(info.platform, 'huaban');
    // 声明了图片就等于承诺磁盘上有它们 —— 远程卡必须一个字都不声明。
    assert.equal('images' in info, false);
    assert.deepEqual(fs.readdirSync(written.dir), ['info.json']);

    const pkg = (await scanLibraryPackages({roots: [download]})).packages.find(item => item.uid === UID);
    assert.ok(pkg, '扫描器要把它当正式包出卡，而不是一堆零散文件');
    assert.equal(pkg.remote, true);
    assert.equal(pkg.status, REMOTE_STATUS);
    assert.equal(pkg.category, 'images');
    assert.equal(pkg.thumb, COVER, '封面走后端 /api/image 代理出图');
    assert.equal(pkg.imageCount, 1923);
    assert.equal(pkg.fileCount, 0);
    assert.equal(pkg.sourceUrl, BOARD, '卡片要靠出处回填「下载原图」的任务');
    assert.equal(pkg.hasMeta, true, '有清单就不该再挂「登记」按钮');
  } finally { await fsp.rm(dir, {recursive: true, force: true}); }
});

test('远程卡存下每张图的地址，扫描器透传给「不下载翻图集」', async () => {
  const {dir, download} = await temp();
  try {
    const written = await card(download, {remoteImages: [
      ...REMOTE_ITEMS,
      {url: 'https://img/1.jpg'},                       // 重复地址去重
      {url: 'ftp://bad/3.jpg'},                          // 非 http(s) 丢掉
      {url: 'https://img/v.mp4', type: 'video'},         // 视频条目丢掉
      {url: 'https://img/play', play: 'https://img/v'},  // 播放源条目丢掉
      {url: 'javascript:alert(1)'},                      // 危险协议丢掉
    ]});
    const info = readInfo(written.dir);
    assert.equal(info.remoteImages.length, 2, '只留有效的 http(s) 图片地址并去重');
    assert.equal(info.remoteImages[0].url, 'https://img/1.jpg');
    assert.equal(info.remoteImages[0].thumb, 'https://img/1_fw480.jpg');
    assert.equal(info.remoteImages[0].title, '第一张');
    assert.equal(info.remoteImages[1].url, 'https://img/2.jpg');
    assert.equal('images' in info, false, '远程地址不能塞进 images 清单触发磁盘校验');
    assert.deepEqual(fs.readdirSync(written.dir), ['info.json'], '仍然一张图都不下');

    const pkg = (await scanLibraryPackages({roots: [download]})).packages.find(item => item.uid === UID);
    assert.equal(pkg.remoteImages.length, 2, '扫描器要把远程地址透传到卡片');
    assert.equal(pkg.remoteImages[0].thumb, 'https://img/1_fw480.jpg');

    // 重复点「只入库」这次没解析到地址：沿用上次的，别把能翻的图集翻回去只剩封面。
    const again = await card(download, {remoteImages: []});
    assert.equal(readInfo(again.dir).remoteImages.length, 2, '空清单不该抹掉已存的图集');
  } finally { await fsp.rm(dir, {recursive: true, force: true}); }
});

test('同一个画板重复入库复用同一张卡，标题改了也不新建目录', async () => {
  const {dir, download} = await temp();
  try {
    const first = await card(download);
    const again = await card(download, {title: '改过的标题', imageCount: 2000});
    assert.equal(again.dir, first.dir);
    assert.equal(again.imageCount, 2000, '重记一次应该刷新张数');
    assert.equal(readInfo(first.dir).title, '改过的标题');
    const dirs = fs.readdirSync(path.join(download, CATEGORY));
    assert.equal(dirs.length, 1, '一张资产一张卡，不能长成两份目录');
  } finally { await fsp.rm(dir, {recursive: true, force: true}); }
});

test('已经下载过图的包不会被远程卡覆盖', async () => {
  const {dir, download} = await temp();
  try {
    const first = await card(download);
    // 模拟一次真实的下载结果：清单里声明了图片，磁盘上真有那个文件。
    await fsp.mkdir(path.join(first.dir, 'images'), {recursive: true});
    await fsp.writeFile(path.join(first.dir, 'images', '01-shot.png'), fixturePng());
    await fsp.writeFile(path.join(first.dir, 'info.json'), JSON.stringify({
      uid: UID, kind: 'images', title: '美宣 插画', imageCount: 1, images: [{file: 'images/01-shot.png'}],
    }));
    const again = await card(download, {imageCount: 1923});
    assert.equal(again.skipped, true);
    const info = readInfo(first.dir);
    assert.equal(info.status, undefined, '真包的清单不该被塞回 remote');
    assert.equal(info.images.length, 1);
    assert.equal(await findRemoteBoardDir(path.join(download, CATEGORY), UID), null, '已下载的包不是可接管目标');
  } finally { await fsp.rm(dir, {recursive: true, force: true}); }
});

test('只认 32 位十六进制 uid，同一个 uid 才能查到目录', async () => {
  const {dir, download} = await temp();
  try {
    assert.equal(isBoardUid(UID), true);
    assert.equal(isBoardUid('abc'), false);
    await assert.rejects(card(download, {uid: '../../evil'}), /资产标识无效/);

    const written = await card(download);
    const parent = path.join(download, CATEGORY);
    assert.equal(await findBoardDir(parent, UID), written.dir);
    assert.equal(await findRemoteBoardDir(parent, UID), written.dir);
    assert.equal(await findBoardDir(parent, OTHER), null);
  } finally { await fsp.rm(dir, {recursive: true, force: true}); }
});

test('启动恢复不会把远程收藏卡当成「已完成的下载」', async () => {
  const {dir, download} = await temp();
  try {
    await card(download);
    const jobs = [];
    const skipped = [];
    const recovered = await recoverDownloads(jobs, [download], {onSkipped: (file, why) => skipped.push(why)});
    assert.equal(recovered, 0);
    assert.equal(jobs.length, 0);
    assert.deepEqual(skipped, [], '远程卡不该在校验器上刷一行没用的失败记录');
  } finally { await fsp.rm(dir, {recursive: true, force: true}); }
});

test('点「下载原图」接管远程卡目录，不新建 (1)，卡片也不变成两张', async () => {
  const {dir, download} = await temp();
  const m = await new DownloadManager({
    dataDir: dir, defaultFolder: download, autoStart: false,
    // 替代 runImageJob 的产物：一个真能通过 verifyFolder 的图片包目录。
    imageRunner: async input => {
      await fsp.mkdir(path.join(input.output, 'images'), {recursive: true});
      await fsp.writeFile(path.join(input.output, 'images', '01-shot.png'), fixturePng());
      await fsp.writeFile(path.join(input.output, 'info.json'), JSON.stringify({
        uid: input.uid, kind: 'images', platform: 'huaban', url: input.url, imageCount: 1,
        images: [{file: 'images/01-shot.png', bytes: fixturePng().length}],
      }));
      return {folder: true, bytes: fixturePng().length, fileCount: 2, zipName: 'board', imageCount: 1};
    },
    blenderImporter: () => ({ok: true}),
  }).init();
  try {
    const written = await card(download);
    m.start('http://127.0.0.1:1');
    const {added} = await m.enqueue({
      authorized: true, kind: 'images', options: {output: 'folder'},
      models: [{uid: UID, name: '美宣 插画', platform: 'huaban', url: BOARD}],
    });
    assert.equal(added.length, 1);
    const end = Date.now() + 8000;
    let job = null;
    while (Date.now() < end) {
      job = m.snapshot().jobs.find(item => item.id === added[0]);
      if (job && ['saved', 'failed'].includes(job.state)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(job?.state, 'saved', job?.message);
    assert.equal(path.resolve(job.filePath), path.resolve(written.dir), '必须原地接管，不能另建 (1)');
    assert.equal(fs.readdirSync(path.join(download, CATEGORY)).length, 1);
    const info = readInfo(written.dir);
    assert.equal(info.status, undefined, '下完就该是真包，不再是远程收藏');
    assert.equal(info.images.length, 1);
  } finally {
    await m.close();
    await fsp.rm(dir, {recursive: true, force: true});
  }
});

test('只入库接口：要本地标识、只写下载根、张数按全量清单算', async () => {
  const {dir, download} = await temp();
  const state = path.join(dir, 'state');
  const m = await new DownloadManager({dataDir: state, defaultFolder: download, autoStart: false}).init();
  // 解析注入缝：这些测试不碰网络，也就能断言「张数来自全量清单」而不是当前屏幕那几张。
  const server = createLibraryServer({
    downloads: m, cacheDir: path.join(dir, 'cache'),
    boardCollect: async () => ({
      items: [{url: 'https://x/1.jpg'}, {url: 'https://x/2.jpg'}],
      skipped: [{url: 'https://x/3.mp4'}],
      title: '美宣 插画', author: '某人', cover: COVER,
    }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/library/picture-board`, {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-SFX-Local': '1', ...headers}, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post({uid: UID, platform: 'huaban', url: BOARD}, {'X-SFX-Local': ''})).status, 403, '没有本地标识一律拒绝');
    assert.equal((await post({uid: UID, platform: 'nope', url: BOARD})).status, 400, '非图站平台不许写');
    assert.equal((await post({uid: 'short', platform: 'huaban', url: BOARD})).status, 400);
    assert.equal((await post({uid: UID, platform: 'huaban', url: 'file:///etc/passwd'})).status, 400);

    // root 参数不存在：写哪儿由服务端定，前端传什么都不影响。
    const res = await post({uid: UID, platform: 'huaban', url: BOARD, root: path.join(dir, 'elsewhere'), imageCount: 2});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.imageCount, 3, '可下载的 2 张 + 不可下载的 1 项，才是这块画板的真实规模');
    assert.equal(path.dirname(data.dir), path.join(download, CATEGORY));
    const info = readInfo(data.dir);
    assert.equal(info.title, '美宣 插画');
    assert.equal(info.thumbnail, COVER);
    assert.equal(info.remoteImages.length, 2, '全量解析的每张图地址都写进远程卡');
    assert.equal(info.remoteImages[0].url, 'https://x/1.jpg');
    assert.equal('images' in info, false);
    assert.equal(fs.existsSync(path.join(dir, 'elsewhere')), false, '不接受前端指定路径');

    // 第二次点：解析走缓存，写卡走幂等 —— 目录还是一张卡。
    const again = await (await post({uid: UID, platform: 'huaban', url: BOARD})).json();
    assert.equal(again.dir, data.dir);
    assert.equal(fs.readdirSync(path.join(download, CATEGORY)).length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await m.close();
    await fsp.rm(dir, {recursive: true, force: true});
  }
});
