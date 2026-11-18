// 类型启发式：扩展名判不出、又没采到 assetType 的三类资产（材质 / 资源包 / UI）。
// 铁律：只加不覆盖、宁可漏判不可误判、规则数据驱动可扩展。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_KIND_RULES, createKindHeuristics, kindHeuristics, inferKindHints,
} from '../src/library/asset-kind-heuristics.js';
import {formatRegistry} from '../src/library/format-registry.js';

const kindOf = name => formatRegistry.kindOf(name);
const hints = (names, owner = '') => inferKindHints(names, owner, kindOf);

test('规则表是数据：三类各一条、id 唯一、可冻结', () => {
  assert.deepEqual(DEFAULT_KIND_RULES.map(r => r.id), ['textures', 'packs', 'uielement']);
  assert.equal(new Set(DEFAULT_KIND_RULES.map(r => r.id)).size, DEFAULT_KIND_RULES.length);
  assert.equal(Object.isFrozen(DEFAULT_KIND_RULES), true);
  for (const rule of DEFAULT_KIND_RULES) {
    assert.ok(rule.kinds.length && rule.whenOwner.length, `${rule.id} 要限定 kind 与 owner`);
  }
});

test('材质：同名多通道才命中，单图及材质目录不够', () => {
  assert.deepEqual(hints(['wood_basecolor.png','wood_normal.png'], 'images'), ['textures']);
  assert.deepEqual(hints(['wood_mask.png'], 'images'), []);
  assert.deepEqual(hints(['textures/photo.png'], 'images'), []);
  assert.deepEqual(hints(['wood_basecolor.png','rock_normal.png'], 'images'), []);
});

test('材质：普通图库照片绝不误判（含 images 目录、连号命名、中文题材）', () => {
  assert.deepEqual(hints(['images/01-Civitai.jpg'], 'images'), []);
  assert.deepEqual(hints(['images/123.png'], 'images'), []);
  assert.deepEqual(hints(['插画/美宣 插画-81e3d996.png'], 'images'), []);
  assert.deepEqual(hints(['真人脸部参考/a3b5a406.jpg'], 'images'), []);
  // 模型的附属贴图不把模型拖进材质
  assert.deepEqual(hints(['chair/textures/color.jpg'], 'models'), []);
  assert.deepEqual(hints(['chair/normal.png'], 'models'), []);
});

test('资源包：zip 归档与 pack/资源包 命名命中；图片模型带 pack 字不误判', () => {
  assert.deepEqual(hints(['Kenney_Kit.zip'], 'other'), ['packs']);
  assert.deepEqual(hints(['资源包/UI-Pack.zip'], 'other'), ['packs']);
  assert.deepEqual(hints(['Megapack.zip'], 'other'), ['packs']);
  // kind 必须是 other（zip）；普通图片 / 模型不算资源包
  assert.deepEqual(hints(['fantasy-pack.png'], 'images'), []);
  assert.deepEqual(hints(['backpack.glb'], 'models'), []);
});

test('UI 元素：同批 html + css 组合才命中，单个文档不算', () => {
  assert.deepEqual(hints(['index.html', 'style.css'], 'documents'), ['uielement']);
  assert.deepEqual(hints(['index.html', 'main.css'], ''), ['uielement']);
  // 只有 html 或只有 css → 不算，避免把普通文档全拖进 UI
  assert.deepEqual(hints(['index.html'], 'documents'), []);
  assert.deepEqual(hints(['readme.css'], 'documents'), []);
  // 图片批次里混进 html/css 也不算（kind 过滤）
  assert.deepEqual(hints(['a.png', 'b.css'], 'images'), []);
});

test('owner 白名单：被执行阶段明确判定的主类型不重复补类', () => {
  assert.deepEqual(hints(['x_basecolor.png'], 'models'), []);
  assert.deepEqual(hints(['x.zip'], 'images'), []);
  assert.deepEqual(hints(['index.html', 'style.css'], 'models'), []);
});

test('扩展缝：extraRules / overrides 无需改调用点即可加规则、改条件', () => {
  const custom = createKindHeuristics({
    extraRules: [{
      id: 'videos', kinds: ['image'], whenOwner: ['', 'images'],
      any: [/\.seq$/i],
    }],
    overrides: {
      textures: {any: [/\.tex$/i]},
    },
  });
  assert.deepEqual(custom.hintsFor({files: [{name: 'a.seq', kind: 'image'}], owner: 'images'}), ['videos']);
  assert.deepEqual(custom.hintsFor({files: [{name: 'a_tex.png', kind: 'image'}], owner: 'images'}), []);
  assert.deepEqual(custom.hintsFor({files: [{name: 'a.tex', kind: 'image'}], owner: 'images'}), ['textures']);
  // 默认实例不受影响（无全局污染）
  assert.deepEqual(kindHeuristics.hintsFor({files: [{name: 'a.tex', kind: 'image'}]}), []);
});
