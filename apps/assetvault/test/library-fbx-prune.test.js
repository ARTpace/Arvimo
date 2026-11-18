import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pruneUnreferencedTextures} from '../server/fbx.mjs';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'sfx-prune-'));

test('只删 FBX 未引用的散落贴图，保留被引用的与非贴图文件', async () => {
  const d = await temp();
  const files = {
    'mat0_BaseColor.png': 'base',
    'mat0_Normal.jpg': 'normal',
    'mat0_MetallicRoughness.png': 'metal',
    'mat2_MetallicRoughness.png': 'metal2',
    'scene.glb': 'glb',
    'info.json': '{}',
  };
  for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(d, name), data);
  // FBX 里只明文出现 BaseColor 与 Normal 的文件名
  const fbx = path.join(d, 'model.fbx');
  await fs.writeFile(fbx, 'RelativeFilename mat0_BaseColor.png ... RelativeFilename mat0_Normal.jpg ...');

  const removed = await pruneUnreferencedTextures(d, fbx);

  assert.deepEqual(removed.sort(), ['mat0_MetallicRoughness.png', 'mat2_MetallicRoughness.png']);
  const left = await fs.readdir(d);
  assert.ok(left.includes('mat0_BaseColor.png'));
  assert.ok(left.includes('mat0_Normal.jpg'));
  assert.ok(left.includes('scene.glb'));
  assert.ok(left.includes('info.json'));
  assert.ok(!left.includes('mat0_MetallicRoughness.png'));
});

test('FBX 一张贴图都没引用时不动任何文件（导出异常保护）', async () => {
  const d = await temp();
  await fs.writeFile(path.join(d, 'mat0_BaseColor.png'), 'base');
  await fs.writeFile(path.join(d, 'mat0_MetallicRoughness.png'), 'metal');
  const fbx = path.join(d, 'model.fbx');
  await fs.writeFile(fbx, 'no texture references here');

  const removed = await pruneUnreferencedTextures(d, fbx);

  assert.deepEqual(removed, []);
  assert.deepEqual((await fs.readdir(d)).sort(), ['mat0_BaseColor.png', 'mat0_MetallicRoughness.png', 'model.fbx']);
});
