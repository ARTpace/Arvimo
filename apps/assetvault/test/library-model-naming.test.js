import test from 'node:test';
import assert from 'node:assert/strict';
import { assetStem, cleanFolderName, cleanFilename } from '../server/folder-name.mjs';

const UID = '2311f122d8cf6c8f46a11bb55f600aed';

test('3D 模型交付名 = 标题 - 作者，去掉 uid 尾巴', () => {
  const cases = [
    ['Kermit knight', 'jose_lh_3dart', 'Kermit knight - jose_lh_3dart'],
    ['Sci-Fi Helmet', 'Some Seller', 'Sci-Fi Helmet - Some Seller'],
    ['Low poly tree', 'artist42', 'Low poly tree - artist42'],
    // 作者是平台名也照带，跟 ArtStation 规则一致
    ['chair_02', 'Poly Haven', 'chair_02 - Poly Haven'],
    ['Wood Floor 045', 'ambientCG', 'Wood Floor 045 - ambientCG'],
    ['pole_01', 'NVIDIA', 'pole_01 - NVIDIA'],
  ];
  for (const [name, author, expect] of cases) {
    assert.equal(assetStem(name, author), expect);
    assert.equal(cleanFolderName(assetStem(name, author), UID, false), expect);
    assert.equal(cleanFilename(assetStem(name, author), UID, false), expect + '.zip');
  }
});

test('标题已含作者时不重复拼接', () => {
  assert.equal(assetStem('Chair - Poly Haven', 'Poly Haven'), 'Chair - Poly Haven');
  assert.equal(assetStem('Kermit Knight', 'kermit'), 'Kermit Knight'); // 大小写不敏感的子串判定
});

test('非法字符与多余空白被清洗', () => {
  assert.equal(assetStem('A/B:C*? "X"  ', 'Some|Author'), 'A_B_C__ _X_ - Some_Author');
  assert.equal(assetStem('   ', ''), '模型'); // 空标题有兜底
});

test('图片/材质/HDRI 仍走 keepUid=true（uid 尾巴保留，防重名）', () => {
  // 这些平台 runner 的 zipName 带 -material/-hdri/-pack 语义，且下载器给它们 keepUid=true。
  assert.equal(cleanFolderName('Wood_Floor-material', UID), `Wood_Floor-material-${UID.slice(0, 8)}`);
  assert.equal(cleanFolderName('studio_hdri-hdri', UID), `studio_hdri-hdri-${UID.slice(0, 8)}`);
});
