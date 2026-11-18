// 锁定「归属锚点」规则：这套判据一旦漂了，同一资产又会出两张卡
// （一张平台缩略图、一张「N 张」图集）。测试很便宜，复发很贵。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {anchorPackage, packageDirOf, claimIndex, isClaimed, isPendingClaim, dirKey} from '../server/asset-claim.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
  const pkg = path.join(root, '材质', 'Fabric 085');
  fs.mkdirSync(path.join(pkg, 'textures'), { recursive: true });
  fs.writeFileSync(path.join(pkg, '__info.json'), '{"uid":"abc"}');
  fs.writeFileSync(path.join(pkg, 'textures', 'Color.jpg'), 'x');
  fs.mkdirSync(path.join(root, '图片', '其他图片'), { recursive: true });
  fs.writeFileSync(path.join(root, '图片', '其他图片', 'shot.png'), 'x');
  return { root, pkg };
}

test('记录里的 packageDir 是事实，优先直接用', () => {
  const { root, pkg } = fixture();
  assert.equal(packageDirOf({ packageDir: pkg, filePath: path.join(pkg, 'textures', 'Color.jpg') }), pkg);
  fs.rmSync(root, { recursive: true, force: true });
});

test('主文件在包内时，包目录 = 有 sidecar 的父目录', () => {
  const { root, pkg } = fixture();
  assert.equal(packageDirOf({ filePath: path.join(pkg, 'textures', 'Color.jpg') }), pkg);
  fs.rmSync(root, { recursive: true, force: true });
});

test('包外散图的父目录是分类目录，不该被当成包', () => {
  const { root } = fixture();
  assert.equal(packageDirOf({ filePath: path.join(root, '图片', '其他图片', 'shot.png') }), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('anchorPackage 只补不覆盖，已在就不动', () => {
  const { root, pkg } = fixture();
  const model = { filePath: path.join(pkg, 'textures', 'Color.jpg') };
  assert.equal(anchorPackage(model), true);
  assert.equal(model.packageDir, pkg);
  assert.equal(anchorPackage(model), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('认领判据：packageDir 精确 / sidecar uid / 主文件前缀，任一命中即不出包卡', () => {
  const { root, pkg } = fixture();
  const rel = '材质/Fabric 085';
  const index = claimIndex([{ uid: 'abc', payload: JSON.stringify({ packageDir: pkg }) }]);

  assert.equal(isClaimed({ root, rel }, index), true, 'packageDir 精确命中');
  assert.equal(isClaimed({ root, rel: '材质/另一个', uid: 'abc' }, index), true, 'uid 命中');

  const byFile = claimIndex([{ uid: 'def', payload: JSON.stringify({ filePath: path.join(pkg, 'textures', 'Color.jpg') }) }]);
  assert.equal(isClaimed({ root, rel }, byFile), true, '主文件在包内');

  // 没登记的普通素材包要留着 —— 那是它存在的意义。
  assert.equal(isClaimed({ root, rel: '材质/未登记', uid: 'zzz' }, claimIndex([])), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('未登记 = 有包内身份却没记录', () => {
  assert.equal(isPendingClaim({ uid: 'abc' }), true);
  assert.equal(isPendingClaim({ hasMeta: true }), true);
  assert.equal(isPendingClaim({ uid: '', hasMeta: false }), false);
});

test('dirKey 抹平 Windows 大小写差异', () => {
  assert.equal(dirKey('C:\\Assets\\Pak'), dirKey('c:\\assets\\pak'));
});

test('图集使用自身清单身份，不要求普通资产记录认领',()=>{assert.equal(isPendingClaim({category:'images',uid:'album',hasMeta:true}),false);});
