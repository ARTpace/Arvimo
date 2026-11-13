// 本地库体检的纯函数：包名归一化 + 报告聚合。没有 DOM，跑得动就说明逻辑对。
import test from 'node:test';
import assert from 'node:assert/strict';
import {healthReport, normalizeAssetName} from '../src/library/local-health.js';

test('包名归一化：剥掉下载器追加的 hash 段、副本后缀和扩展名', () => {
  assert.equal(normalizeAssetName('Old Market-547f8d6146e2-803d778f'), 'old market');
  assert.equal(normalizeAssetName('让时间停留。-b3579877'), '让时间停留。');
  assert.equal(normalizeAssetName('Lion Sword (1)'), 'lion sword');
  assert.equal(normalizeAssetName('Lion Sword copy'), 'lion sword');
  assert.equal(normalizeAssetName('模型/材质/Rock_01.zip'), 'rock 01');
  assert.equal(normalizeAssetName(''), '');
});

test('体检报告：体积合计、最大排行、同名同大小的重复组', () => {
  const packages = [
    {rel: '模型/Lion Sword-aaa111', title: 'Lion Sword', bytes: 900, fileCount: 12, category: 'models'},
    {rel: '模型/Lion Sword (1)', title: 'Lion Sword', bytes: 900, fileCount: 12, category: 'models'},
    {rel: '图片/Old Market', title: 'Old Market', bytes: 300, fileCount: 4, category: 'images'},
    {rel: '图片/Empty', title: 'Empty', bytes: 0, fileCount: 0, category: 'images'},
  ];
  const report = healthReport(packages);
  assert.equal(report.count, 4);
  assert.equal(report.totalBytes, 2100);
  assert.equal(report.totalFiles, 28);
  assert.equal(report.biggest[0].title, 'Lion Sword');
  assert.equal(report.duplicates.length, 1, '只有同名同大小的一组算重复');
  assert.equal(report.duplicates[0].length, 2);
  assert.equal(report.wastedBytes, 900, '重复组里除第一份外的都算浪费');
  assert.equal(report.empty.length, 1);
});

test('体检报告：同名不同大小不算重复（避免误删不同版本）', () => {
  const report = healthReport([
    {rel: 'a/Rock', title: 'Rock', bytes: 100, fileCount: 1},
    {rel: 'b/Rock', title: 'Rock', bytes: 200, fileCount: 2},
  ]);
  assert.equal(report.duplicates.length, 0);
  assert.equal(report.wastedBytes, 0);
});

test('体检报告：空列表不炸', () => {
  const report = healthReport([]);
  assert.deepEqual(
    {count: report.count, totalBytes: report.totalBytes, dupes: report.duplicates.length},
    {count: 0, totalBytes: 0, dupes: 0},
  );
});
