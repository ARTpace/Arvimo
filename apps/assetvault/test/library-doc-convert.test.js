// LibreOffice 转 PDF 的纯逻辑：探测、参数、缓存键、输出校验。
// 本机没装 LibreOffice 也能全跑 —— 所有外部进程 / 文件操作都走注入，不依赖真实 soffice。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DOC_PDF_EXTS, canConvertDoc, sofficeCandidates, createSofficeProbe, docStatus,
  sofficeArgs, expectedPdfPath, cacheKeyFor, convertToPdf,
} from '../server/doc-convert.mjs';

test('sofficeCandidates：环境变量优先，按平台给常见路径，PATH 兜底', () => {
  const win = sofficeCandidates('win32', {SFX_SOFFICE: 'D:\\tools\\soffice.exe'});
  assert.equal(win[0], 'D:\\tools\\soffice.exe');
  assert.ok(win.includes('C:\\Program Files\\LibreOffice\\program\\soffice.exe'));
  assert.equal(win.at(-1), 'soffice.exe');
  assert.ok(sofficeCandidates('darwin', {}).includes('/Applications/LibreOffice.app/Contents/MacOS/soffice'));
  assert.ok(sofficeCandidates('linux', {}).includes('/usr/bin/soffice'));
  assert.equal(sofficeCandidates('linux', {}).at(-1), 'soffice');
  assert.ok(!sofficeCandidates('linux', {}).includes(undefined));
});

test('createSofficeProbe：验证 --version 成功才认，结果缓存只探测一次', () => {
  let calls = 0;
  const probe = createSofficeProbe({
    candidates: ['/fake/a', '/fake/b'],
    exists: p => true,
    run: () => { calls++; return {status: calls === 1 ? 1 : 0}; },
  });
  assert.equal(probe(), '/fake/b');
  assert.equal(calls, 2);
  assert.equal(probe(), '/fake/b');
  assert.equal(calls, 2, '第二次不该再 spawn');
});

test('createSofficeProbe：绝对路径不存在直接跳过，spawn 抛错不算崩', () => {
  const runs = [];
  const probe = createSofficeProbe({
    candidates: ['/missing/soffice', 'soffice'],
    exists: p => p === 'soffice',
    run: (bin) => { runs.push(bin); if (bin === 'soffice') throw Error('ENOENT'); return {status: 0}; },
  });
  assert.equal(probe(), null);
  assert.deepEqual(runs, ['soffice']);
  assert.equal(probe(), null);
  assert.equal(runs.length, 1, '失败结果也缓存，避免每次预览都探测一遍');
});

test('docStatus：available / path / exts 三项齐全', () => {
  assert.deepEqual(docStatus(() => null), {available: false, path: null, exts: DOC_PDF_EXTS});
  assert.deepEqual(docStatus(() => '/usr/bin/soffice'),
    {available: true, path: '/usr/bin/soffice', exts: DOC_PDF_EXTS});
});

test('sofficeArgs：独立 UserInstallation profile + headless + 只在指定目录出 PDF', () => {
  const args = sofficeArgs({file: '/docs/报告.pptx', outdir: '/tmp/out', profileDir: '/tmp/profile'});
  assert.match(args[0], /^-env:UserInstallation=file:\/\/\//, 'profile 必须是 file:// URL，防与前台实例抢锁');
  assert.ok(args.includes('--headless'));
  assert.ok(args.includes('--convert-to'));
  assert.equal(args[args.indexOf('--convert-to') + 1], 'pdf');
  assert.equal(args[args.indexOf('--outdir') + 1], '/tmp/out');
  assert.equal(args.at(-1), '/docs/报告.pptx');
  assert.notDeepEqual(
    sofficeArgs({file: 'a.pptx', outdir: '/o', profileDir: '/p1'}),
    sofficeArgs({file: 'a.pptx', outdir: '/o', profileDir: '/p2'}),
    '不同 profile 必须产出不同参数',
  );
});

test('expectedPdfPath：soffice 用源文件名换后缀，同名异格式会撞车', () => {
  assert.equal(expectedPdfPath('/docs/报告.pptx', '/tmp/out'), path.join('/tmp/out', '报告.pdf'));
  assert.equal(expectedPdfPath('slides.PPTX', '/tmp/out'), path.join('/tmp/out', 'slides.pdf'));
});

test('cacheKeyFor：路径 / 大小 / mtime 任一变化就换键，且可复现', () => {
  const stat = {size: 100, mtimeMs: 1000};
  const a = cacheKeyFor('/docs/a.pptx', stat);
  assert.match(a, /^[a-f0-9]{40}$/);
  assert.equal(a, cacheKeyFor('/docs/a.pptx', stat));
  assert.notEqual(a, cacheKeyFor('/docs/b.pptx', stat));
  assert.notEqual(a, cacheKeyFor('/docs/a.pptx', {...stat, size: 101}));
  assert.notEqual(a, cacheKeyFor('/docs/a.pptx', {...stat, mtimeMs: 1001}));
});

test('canConvertDoc：只放行注册表里 preview:doc-pdf 的后缀', () => {
  for (const ext of DOC_PDF_EXTS) assert.ok(canConvertDoc(`file.${ext}`), ext);
  for (const ext of ['docx', 'epub', 'md', 'pdf', 'exe', 'bin', '']) {
    assert.ok(!canConvertDoc(`file.${ext}`), `${ext} 不该喂给外部进程`);
  }
});

test('convertToPdf：格式不在白名单直接拒绝，不会启动外部进程', async () => {
  let spawned = false;
  await assert.rejects(
    convertToPdf('a.docx', {probe: () => '/bin/soffice', run: () => { spawned = true; return {status: 0}; }}),
    /不支持转换这个格式/,
  );
  assert.equal(spawned, false);
});

test('convertToPdf：没装 LibreOffice 时给可安装的明确错误，不 spawn', async () => {
  let spawned = false;
  await assert.rejects(
    convertToPdf('a.pptx', {probe: () => null, run: () => { spawned = true; return {status: 0}; }}),
    /没找到 LibreOffice/,
  );
  assert.equal(spawned, false);
});

test('convertToPdf：退出码为 0 但没产物也算失败（soffice 退出码不可信）', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'assetvault-doctest-'));
  t.after(() => fs.promises.rm(dir, {recursive: true, force: true}));
  const source = path.join(dir, 'deck.pptx');
  await fs.promises.writeFile(source, 'fake');
  let called = 0;
  await assert.rejects(
    convertToPdf(source, {
      probe: () => '/bin/soffice',
      cacheDir: path.join(dir, 'cache'),
      run: () => { called++; return {status: 0}; }, // 故意不写 PDF
    }),
    /没能生成 PDF/,
  );
  assert.equal(called, 1);
});

test('convertToPdf：成功时落缓存，第二次命中缓存不再 spawn，临时目录已清理', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'assetvault-doctest-'));
  t.after(() => fs.promises.rm(dir, {recursive: true, force: true}));
  const source = path.join(dir, 'deck.pptx');
  await fs.promises.writeFile(source, 'fake');
  const cacheDir = path.join(dir, 'cache');
  const works = [];
  let calls = 0;

  const options = {
    probe: () => '/bin/soffice',
    cacheDir,
    // 假装 soffice：从 --outdir 参数推出输出位置，写一份最小 PDF。
    run: (bin, args) => {
      calls++;
      const outdir = args[args.indexOf('--outdir') + 1];
      works.push(path.dirname(outdir));
      fs.writeFileSync(expectedPdfPath(source, outdir), '%PDF-1.4 fake');
      return {status: 0};
    },
  };
  const first = await convertToPdf(source, options);
  assert.equal(first.cached, false);
  assert.equal(first.buffer.toString(), '%PDF-1.4 fake');
  assert.equal(calls, 1);
  const second = await convertToPdf(source, options);
  assert.equal(second.cached, true, '第二次必须命中磁盘缓存');
  assert.equal(calls, 1, '命中缓存不该再启动 soffice');
  for (const work of works) assert.ok(!fs.existsSync(work), '转换临时目录要清掉');
});

test('convertToPdf：源文件改了就重新转换（缓存键含 mtime/size）', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'assetvault-doctest-'));
  t.after(() => fs.promises.rm(dir, {recursive: true, force: true}));
  const source = path.join(dir, 'deck.pptx');
  await fs.promises.writeFile(source, 'fake');
  let calls = 0;
  const options = {
    probe: () => '/bin/soffice',
    cacheDir: path.join(dir, 'cache'),
    run: (bin, args) => {
      calls++;
      const outdir = args[args.indexOf('--outdir') + 1];
      fs.writeFileSync(expectedPdfPath(source, outdir), `pdf-${calls}`);
      return {status: 0};
    },
  };
  assert.equal((await convertToPdf(source, options)).buffer.toString(), 'pdf-1');
  await fs.promises.writeFile(source, 'changed content');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await convertToPdf(source, options)).buffer.toString(), 'pdf-2');
  assert.equal(calls, 2);
});
