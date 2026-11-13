import test from 'node:test';
import assert from 'node:assert/strict';
import {createDragPayload} from '../src/library/drag-payload.js';

/** 最小 DOM 替身：sourceOf 只用 closest / dataset / querySelector，不需要引 jsdom。 */
function node({dataset = {}, media = null, card = false, preview = false, title = ''} = {}) {
  const self = {
    dataset,
    closest(selector) {
      if (preview && selector.startsWith('.local-gallery-photo')) return self;
      if (card && selector === '.model-card') return self;
      return null;
    },
    querySelector(selector) {
      if (media && selector.includes('img[data-url]')) return media;
      if (selector === '.card-title') return {textContent: title};
      return null;
    },
    querySelectorAll() { return []; },
  };
  return self;
}

const folderPkg = () => ({
  root: 'H:/library', rel: 'packs/foo', title: '落日素材', type: 'folder',
  entries: [
    {rel: 'a.png', name: 'a.png'},
    {rel: 'b.psd', name: 'b.psd'},
    {rel: 'readme.txt', name: 'readme.txt'},
  ],
});

test('图站卡拖原图 URL，不是卡片显示的缩略图地址', () => {
  const media = {dataset: {url: 'https://cdn.example.com/origin_4k.jpg', title: '落日'}};
  const card = node({dataset: {pid: 'p1'}, media, card: true});
  const source = createDragPayload().sourceOf(card);
  assert.equal(source.uid, '');
  assert.deepEqual(source.items, [{type: 'remote', url: 'https://cdn.example.com/origin_4k.jpg', name: '落日'}]);
});

test('视频卡不接管，留给网页版的 DownloadURL 兜底', () => {
  const media = {dataset: {url: 'https://cdn.example.com/clip.mp4', type: 'video', title: '短片'}};
  const card = node({dataset: {pid: 'p2'}, media, card: true});
  assert.equal(createDragPayload().sourceOf(card), null);
});

test('本地多图集合把包内全部图片交出去，rel 带包目录前缀', () => {
  const pkg = folderPkg();
  const card = node({dataset: {package: `${pkg.root}|${pkg.rel}`}, card: true});
  const source = createDragPayload({packages: () => [pkg]}).sourceOf(card);
  assert.equal(source.label, '落日素材');
  assert.deepEqual(source.items, [
    {type: 'local', root: 'H:/library', rel: 'packs/foo/a.png'},
    {type: 'local', root: 'H:/library', rel: 'packs/foo/b.psd'},
  ]);
});

test('单图包退回封面，ZIP 包给整包文件', () => {
  const pkg = {...folderPkg(), entries: [], cover: 'only.tif'};
  const single = createDragPayload({packages: () => [pkg]}).sourceOf(node({dataset: {package: `${pkg.root}|${pkg.rel}`}, card: true}));
  assert.deepEqual(single.items, [{type: 'local', root: 'H:/library', rel: 'packs/foo/only.tif'}]);
  const zip = {...folderPkg(), type: 'zip'};
  const packed = createDragPayload({packages: () => [zip]}).sourceOf(node({dataset: {package: `${zip.root}|${zip.rel}`}, card: true}));
  assert.deepEqual(packed.items, [{type: 'local', root: 'H:/library', rel: 'packs/foo'}]);
});

test('预览大图：本地包给 root/rel，图站包给原图 URL', () => {
  const local = node({preview: true, dataset: {dragRoot: 'H:/library', dragRel: 'packs/foo/a.png', dragName: 'a.png'}});
  assert.deepEqual(createDragPayload().sourceOf(local).items, [
    {type: 'local', root: 'H:/library', rel: 'packs/foo/a.png'},
  ]);
  const remote = node({preview: true, dataset: {dragUrl: 'https://cdn.example.com/origin_4k.jpg', dragName: '落日'}});
  assert.deepEqual(createDragPayload().sourceOf(remote).items, [
    {type: 'remote', url: 'https://cdn.example.com/origin_4k.jpg', name: '落日'},
  ]);
});

test('资产库资产卡只说 uid，路径由服务端从任务记录里取（图集会摊成整组图片）', () => {
  const card = node({dataset: {uid: 'u'.repeat(32)}, card: true, title: 'Robot'});
  const source = createDragPayload().sourceOf(card);
  assert.equal(source.uid, 'u'.repeat(32));
  assert.equal(source.label, 'Robot');
  // 关键：items 不能为空。留空时前端只能把「一个文件夹」交给系统，PS / PureRef 拿着目录没法用；
  // 交给服务端后，图片包会摊成 images/ 里的每一张图，3D 导出包仍是那个 zip / glb。
  assert.deepEqual(source.items, [{type: 'asset', uid: 'u'.repeat(32)}]);
});

test('同一批描述只回源一次；失败后可以重试', async () => {
  const items = [{type: 'remote', url: 'https://cdn.example.com/a.jpg', name: 'a'}];
  let calls = 0;
  const payload = createDragPayload({post: async () => {
    calls += 1;
    if (calls === 1) throw Error('网络抖了一下');
    return {files: ['H:/drag/a.jpg']};
  }});
  await assert.rejects(payload.resolve(items), /网络抖了一下/);
  assert.deepEqual(await payload.resolve(items), ['H:/drag/a.jpg']);
  assert.deepEqual(await payload.resolve([...items]), ['H:/drag/a.jpg']);
  assert.equal(calls, 2, '第一次失败清缓存，之后两次复用同一个结果');
});

test('按下后延迟预热，纯点击不拉原图', async () => {
  let calls = 0;
  const payload = createDragPayload({warmDelay: 10, post: async () => { calls += 1; return {files: ['x.jpg']}; }});
  const media = {dataset: {url: 'https://cdn.example.com/a.jpg', title: 'a'}};
  const card = node({dataset: {pid: 'p1'}, media, card: true});
  payload.warm(card);
  payload.cancelWarm();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 0, '快速点击不该触发原图落盘');
  payload.warm(card);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 1, '按住准备拖时才预热');
});
