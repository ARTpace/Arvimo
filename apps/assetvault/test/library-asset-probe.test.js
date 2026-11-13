// 封面探测缓存：像素取色、差量协议校验、blob 派生索引注入、查询端到端。
import test from 'node:test';
import assert from 'node:assert/strict';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';
import {deriveAssetRows} from '../server/library-blob.mjs';
import {rowsFromState, queryAssets} from '../server/library-query.mjs';
import {validateProbe, diffMainState, applyMutations} from '../src/library/state-mutations.js';
import {loadLibrary, saveLibrary} from '../src/library/library-state.js';
import {probeFromPixels, probeUrl, isValidProbe, createAssetProbe} from '../src/library/asset-probe.js';

const uid = 'a'.repeat(32);
const pixels = (rgb, count = 64 * 64) => {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  }
  return data;
};

test('纯色取主色：红 / 蓝 / 灰的色相与亮度正确', () => {
  const red = probeFromPixels(pixels([230, 20, 50]), 64, 64);
  assert.equal(red.hex.startsWith('#'), true);
  assert.ok(red.h < 15 || red.h > 345, `红色相应跨 0°，实际 ${red.h}`);
  assert.ok(red.s > 0.6);
  assert.ok(probeFromPixels(pixels([30, 90, 220]), 64, 64).h > 190);
  assert.equal(probeFromPixels(pixels([128, 128, 128]), 64, 64).s, 0);
  assert.equal(probeFromPixels(new Uint8ClampedArray(0), 64, 64), null);
});

test('URL 归一化：代理直链不重复包一层，远程链接统一走同源代理', () => {
  assert.equal(probeUrl(''), '');
  assert.equal(probeUrl('/api/image?url=x'), '/api/image?url=x');
  assert.equal(probeUrl('data:image/png;base64,AA'), 'data:image/png;base64,AA');
  assert.match(probeUrl('https://cdn.example/cover.jpg'), /^\/api\/image\?url=/);
  assert.equal(probeUrl('/local/cover.png'), '/local/cover.png');
});

test('差量协议：合法 probe 走键级 op，非法值被拒且可重放', () => {
  const good = {v: 1, hex: '#E11D48', h: 348, s: 0.82, l: 0.5, width: 2000, height: 1000, at: 1};
  assert.equal(validateProbe(good), true);
  assert.equal(validateProbe({...good, hex: 'red'}), false);
  assert.equal(validateProbe({...good, width: 0}), false);
  assert.equal(validateProbe({...good, injected: 'x'}), false);
  assert.equal(isValidProbe(good), true);
  const base = {version: 2, models: [{uid}], userMeta: {}, userTags: {}, aiTags: {}, favorites: [], trashed: []};
  const after = {...base, assetProbe: {[uid]: good}};
  const diff = diffMainState(JSON.stringify(base), JSON.stringify(after));
  assert.ok(diff && diff.ops.length === 1);
  assert.equal(diff.ops[0].field, 'assetProbe');
  assert.deepEqual(applyMutations(base, diff.ops).assetProbe[uid], good);
  assert.equal(diffMainState(JSON.stringify(base), JSON.stringify({...after, assetProbe: {[uid]: {...good, hack: 1}}})), null,
    '非法 probe 必须退回整块写入，不能悄悄丢字段');
});

test('blob 派生：probe 注入 payload，无缓存时字节级不变；查询层拿到 probe', () => {
  const model = {uid, name: 'cover', thumbnail: '/api/image?url=x'};
  const plain = deriveAssetRows({models: [model]})[0].payload;
  assert.equal(plain, JSON.stringify(model));
  const probe = {v: 1, hex: '#3B82F6', h: 217, s: 0.83, l: 0.6, width: 1000, height: 2000, at: 1};
  const injected = JSON.parse(deriveAssetRows({models: [model], assetProbe: {[uid]: probe}})[0].payload);
  assert.deepEqual(injected.probe, probe);
  const rows = rowsFromState({[MAIN_STATE_KEY]: JSON.stringify({version: 2, models: [model], assetProbe: {[uid]: probe}})});
  assert.equal(rows[0].probe.width, 1000);
  assert.equal(rows[0].probe.h, 217);
  assert.equal(queryAssets({rows, filters: {colors: ['blue'], colorSimilarity: 70}}).uids[0], uid);
  assert.equal(queryAssets({rows, filters: {colors: ['red'], colorSimilarity: 70}}).uids.length, 0);
});

test('主状态读写：saveLibrary 保留 assetProbe，loadLibrary 恢复并丢掉坏记录', () => {
  const map = new Map();
  const storage = {getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value))};
  const good = {v: 1, hex: '#22C55E', h: 142, s: 0.7, l: 0.45, width: 800, height: 600, at: 1};
  saveLibrary(storage, {models: [{uid}], favorites: new Set(), history: [], tasks: [],
    assetProbe: {[uid]: good, bad: {hex: 'nope'}}});
  const restored = loadLibrary(storage);
  assert.deepEqual(restored.assetProbe[uid], good);
  assert.equal(restored.assetProbe.bad, undefined);
});

test('调度器：缺项统计、可见卡片用已加载 img、全库扫描停止后不再继续', async () => {
  const state = {models: [{uid, thumbnail: 'x.jpg'}, {uid: 'b'.repeat(32), thumbnail: 'y.jpg'}], assetProbe: {}};
  const doc = {
    createElement: () => ({width: 0, height: 0, getContext: () => ({
      drawImage() {}, getImageData: () => ({data: pixels([220, 30, 60]), width: 64, height: 64}),
    })}),
    querySelector: () => null,
  };
  const makeImage = () => {
    const img = {naturalWidth: 1920, naturalHeight: 1080, complete: true, onload: null, onerror: null};
    Object.defineProperty(img, 'src', {set() { queueMicrotask(() => img.onload?.()); }});
    return img;
  };
  const fakeImage = makeImage();
  const probe = createAssetProbe({state, save: () => {}, doc, ImageCtor: function () { return makeImage(); }});
  assert.equal(probe.total(), 2);
  assert.equal(probe.missing(), 2);
  assert.equal(await probe.probeOne(state.models[0], fakeImage), true);
  assert.equal(probe.missing(), 1);
  assert.equal(await probe.probeOne(state.models[0], fakeImage), false, '已采过的跳过');
  assert.equal(isValidProbe(state.assetProbe[uid]), true);
  await probe.scanAll({limit: 1});
  assert.equal(probe.missing(), 0);
});
