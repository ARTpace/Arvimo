import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizePolyforkParams,polyforkVariantUrl,patchGeneratorSource} from '../server/polyfork.mjs';

const ROOT = new URL('..', import.meta.url);
const read = file => readFileSync(new URL(`src/library/${file}`, ROOT), 'utf8');
const server = readFileSync(new URL('server/polyfork.mjs', ROOT), 'utf8');

// 真实风车资产（windmill-3aad49）的旋钮骨架，字段照抄官方 -params.json。
// 这家的核心区别是：color 改的是顶点色（浏览器就地改），range/choice 改的是几何（必须回服务端重建）。
const WINDMILL = {
  params: {
    colorway: {type: 'choice', default: 'cream-stone', label: 'Colorway', options: ['cream-stone', 'red-cap']},
    stone: {type: 'color', default: '#e8dcc0', label: 'Stone'},
    moss: {type: 'color', default: '#7d8a5a', label: 'Moss'},
    tallness: {type: 'range', default: 1, label: 'Tallness', affects: 'geometry', min: 0.75, max: 1.18},
    sails: {type: 'choice', default: '4', label: 'Sail count', options: ['4', '5']},
  },
  presets: {
    'cream-stone': {stone: '#e8dcc0', moss: '#7d8a5a'},
    'red-cap': {stone: '#e8dcc0', moss: '#4a6a4f'},
  },
};

test('成套配色认成 preset，不认成几何 —— 分错的代价是拖一下滑杆就烧一次烘焙额度', () => {
  const {params} = normalizePolyforkParams(WINDMILL);
  const colorway = params.find(p => p.key === 'colorway');
  assert.equal(colorway.kind, 'preset');
  // 反证：presets 的键是预设名（cream-stone），不是参数名（colorway）。
  // 拿参数名去查 presets 会查空，于是被误判成 geometry，每次换配色都要重建整个模型。
  assert.equal('colorway' in WINDMILL.presets, false);
});

test('color 旋钮就地改顶点色，range 与几何 choice 才回服务端重建', () => {
  const {params} = normalizePolyforkParams(WINDMILL);
  const kind = Object.fromEntries(params.map(p => [p.key, p.kind]));
  assert.equal(kind.stone, 'color');
  assert.equal(kind.moss, 'color');
  assert.equal(kind.tallness, 'geometry');
  assert.equal(kind.sails, 'geometry');
  // 风帆数 4/5 改的是网格，不是配色。
  assert.equal(params.find(p => p.key === 'sails').options.length, 2);
});

test('没有 presets 的资产（如 earthworm）不受影响，颜色旋钮照样认得出来', () => {
  const raw = {params: {
    skin: {type: 'color', default: '#b5847f'},
    rings: {type: 'range', default: 1, affects: 'geometry', min: 0, max: 1.5, step: 0.01},
  }};
  const {params,presets,remixable} = normalizePolyforkParams(raw);
  assert.equal(remixable, true);
  assert.deepEqual(presets, {});
  assert.deepEqual(params.map(p => p.kind), ['color', 'geometry']);
  assert.equal(params[1].step, 0.01);
});

test('选项本身就是色值的 choice 归类成颜色，不会被送去烘焙', () => {
  const raw = {params: {tint: {type: 'choice', default: '#ff0000', options: ['#ff0000', '#00ff00']}}};
  assert.equal(normalizePolyforkParams(raw).params[0].kind, 'color');
});

test('range 缺 min/max/step 时给出可用区间，面板不会渲染出 NaN 滑杆', () => {
  const raw = {params: {odd: {type: 'range', default: 0.5}}};
  const [row] = normalizePolyforkParams(raw).params;
  assert.equal(row.min, 0);
  assert.equal(row.max, 1);
  assert.ok(row.step > 0 && Number.isFinite(row.step));
});

test('空清单（资产没有开放旋钮）不报错，只标 remixable=false', () => {
  const empty = normalizePolyforkParams({});
  assert.equal(empty.remixable, false);
  assert.deepEqual(empty.params, []);
});

test('变体 URL 只在真有非默认参数时才带 p，避免无谓的烘焙请求', () => {
  assert.equal(polyforkVariantUrl('windmill-3aad49', {}), 'https://polyfork.dev/cdn/windmill-3aad49-remix.glb');
  assert.equal(polyforkVariantUrl('windmill-3aad49', {tallness: undefined}), 'https://polyfork.dev/cdn/windmill-3aad49-remix.glb');
  const url = polyforkVariantUrl('windmill-3aad49', {tallness: 1.5});
  assert.match(url, /-remix\.glb\?p=/);
  assert.equal(decodeURIComponent(url.split('?p=')[1]), '{"tallness":1.5}');
});

test('预览层与面板的接线保持完整', () => {
  const preview = read('gltf-preview.js');
  for (const name of ['loadPolyfork', 'setPolyforkColors', 'bakePolyfork']) {
    assert.ok(preview.includes(`${name},`), `gltf-preview.js 没有导出 ${name}`);
  }
  // 颜色改动必须走顶点色就地写入；如果哪天改成「也去请求服务端」，这里会先炸。
  assert.ok(preview.includes('function pfPaint'), '顶点色写入函数不见了');
  assert.ok(preview.includes('COLOR_0') || preview.includes('attributes?.color'), '顶点色归类不见了');

  const view = read('library-view.js');
  assert.match(view, /m\.platform==='polyfork'/, '预览入口没有 Polyfork 分支');
  assert.match(view, /openPolyforkPreview/, '预览入口没有调参数面板');

  const app = read('app.js');
  assert.match(app, /resetPolyforkDetails\(\)/, '关闭预览时没有重置参数面板状态');

  // 能力位：老进程没有 /api/polyfork/params，不加这一位前端会一直显示「读取失败」。
  const caps = readFileSync(new URL('server/capabilities.mjs', ROOT), 'utf8');
  assert.match(caps, /polyforkParams:\s*true/);
  assert.match(server, /normalizePolyforkParams/);
});

test('生成器源码改写：裸导入换成注入，仍有别的依赖就放弃', () => {
  // 官方文档的写法就是 `import { createAsset } from './xxx.mjs'` 然后塞进自己的 three 场景。
  // 浏览器里跑它有两个前提：bare specifier 得有人解析、CSP 得放行 —— 所以这里把它改写成
  // 「three / mergeGeometries 由页面 globalThis 注入」，再由同源 URL 发回去 import。
  const sample = [
    "import * as THREE from 'three';",
    "import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';",
    'export function createAsset(){ return new THREE.Group(); }',
  ].join('\n');
  const out = patchGeneratorSource(sample);
  assert.ok(out.includes('const THREE = globalThis.__PF_THREE__;'), 'THREE 必须改成从 globalThis 取');
  assert.ok(out.includes('const { mergeGeometries } = globalThis.__PF_BGU__;'), 'mergeGeometries 同样要注入');
  assert.ok(!/from\s+['"]three/.test(out), '改写后不该再剩裸导入');
  assert.ok(out.includes('export function createAsset'), '导出语句要原样保留，前端靠它拿 createAsset');

  // 反证：还有第三条裸依赖时不能硬塞 —— 返回 null，调用方退回服务端烘焙。
  const extra = "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';\n" + sample;
  assert.equal(patchGeneratorSource(extra), null);
});
