// 格式注册表：清单完整性、分类/MIME/预览策略、单一事实源与扩展缝。
// 清单来自 Serpent 的格式筛选面板（MIT）；本库自有格式按语义并入标准组，靠 origin 追溯。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FORMATS, FORMAT_GROUPS, KNOWN_EXTS, TEXT_EXTS, LOCAL_FORMAT_EXTS,
  GROUP_META, STANDARD_UI_GROUP_IDS, formatFilterGroups, formatOf, formatKind, formatMime, formatGroup,
  extensionOf, formatsOfModel, createFormatRegistry, hasUnknownFormat,
} from '../src/library/format-registry.js';
import {fileKind, localMime, listLocalFolder} from '../server/local-browse.mjs';
import {canThumb} from '../server/thumb-cache.mjs';
import {BROWSER_VIDEO_EXT} from '../server/video-transcode.mjs';

// 参考面板的 7 个组 + 本库格式按语义归位后的完整 chip 清单。
const UI_GROUPS = [
  ['image', '图像', 'png jpg jpeg jfif gif tif tiff webp avif svg bmp ico psd exr tga raw dng cr2 cr3 nef arw raf orf rw2 hdr heic heif dds'],
  ['video', '视频', 'mp4 mov avi wmv webm mkv m4v flv ogv'],
  ['audio', '音频', 'wav mp3 ogg oga m4a aac flac opus aif aiff ac3'],
  ['model', '3D 模型', 'fbx obj gltf glb stl usd usda usdc usdz ply 3mf mtl blend sbsar'],
  // 文档渲染扩展：docx / epub 浏览器内渲染，doc-pdf 组走 LibreOffice 转 PDF。
  ['document', '文档', 'pdf ai docx epub doc pptx ppt xlsx xls rtf odt odp ods'],
  ['font', '字体', 'ttf otf woff woff2 ttc'],
  ['misc', '杂项', 'html hdf htm zip text'],
];

test('UI 分组：参考面板清单 + 本库格式按语义归位（不再单列「本库扩展」）', () => {
  const ui = formatFilterGroups();
  for (const [id, label, exts] of UI_GROUPS) {
    const group = ui.find(item => item.id === id);
    assert.ok(group, `缺分组 ${id}`);
    assert.equal(group.label, label);
    assert.deepEqual([...group.exts], exts.split(' '), `${id} 的 chip 清单不一致`);
  }
  assert.equal(GROUP_META.length, 7);
  assert.deepEqual([...STANDARD_UI_GROUP_IDS], UI_GROUPS.map(group => group[0]));
  assert.equal(ui.length, 7, '本库扩展不再单独成组');
  assert.ok(!ui.some(group => group.id === 'extra'));
  for (const ext of LOCAL_FORMAT_EXTS) {
    assert.ok(ui.some(group => group.exts.includes(ext)), `${ext} 归位后没进任何 UI 分组`);
    assert.equal(formatOf(ext)?.origin, 'local', `${ext} 丢失本库来源标记`);
  }
  assert.equal(formatOf('a.png')?.origin, 'ref', '参考清单格式不能误标本库扩展');
  assert.equal(formatOf('a.md')?.origin, 'ref');
  for (const [ext, group] of [['usdz', 'model'], ['blend', 'model'], ['sbsar', 'model'],
    ['hdr', 'image'], ['dds', 'image'], ['ogv', 'video'], ['zip', 'misc']]) {
    assert.equal(formatGroup(`a.${ext}`), group, `.${ext} 应归 ${group}`);
  }
});

test('注册表每项都有完整元数据，扩展名不重复且合法', () => {
  const keys = Object.keys(FORMATS);
  assert.equal(keys.length, new Set(keys).size);
  assert.equal(keys.length, KNOWN_EXTS.length);
  for (const [ext, item] of Object.entries(FORMATS)) {
    assert.match(ext, /^[a-z0-9]{1,8}$/, `非法扩展名 ${ext}`);
    assert.equal(item.ext, ext);
    assert.ok(item.group && item.kind && item.mime && item.preview, `${ext} 元数据不全`);
    assert.ok(['ref', 'local'].includes(item.origin), `${ext} 缺来源标记`);
    assert.ok(formatOf(`x.${ext}`) === item, `${ext} 查表不一致`);
  }
  assert.equal(TEXT_EXTS.length, 43, '文本 token 展开清单与 Serpent text-media.ts 对齐');
  assert.equal(LOCAL_FORMAT_EXTS.length, 26, '15 个原有 + 11 个文档渲染扩展，新增文档格式记得同步这里');
  assert.ok(FORMAT_GROUPS.find(group => group.id === 'text').exts.length === 43);
  assert.deepEqual([...formatFilterGroups().find(group => group.id === 'misc').exts],
    ['html', 'hdf', 'htm', 'zip', 'text'], '杂项 chip 从注册表派生，含本库 zip 与文本 token');
});

test('kind / MIME / 分组的关键映射保持既有语义', () => {
  for (const [name, kind] of [['a.glb', 'model'], ['a.obj', 'model'], ['a.exr', 'env'], ['a.hdr', 'env'],
    ['a.png', 'image'], ['a.cr3', 'image'], ['a.mp3', 'audio'], ['a.ac3', 'audio'],
    ['a.mkv', 'video'], ['a.flv', 'video'], ['a.pdf', 'document'], ['a.woff2', 'font'],
    ['a.usdz', 'model'], ['a.bin', 'other']]) {
    assert.equal(formatKind(name), kind, `${name} 的 kind`);
    assert.equal(fileKind(name), kind, `${name} 必须走注册表（server/local-browse）`);
  }
  assert.equal(localMime('a.glb'), 'model/gltf-binary');
  assert.equal(localMime('a.ac3'), 'audio/ac3');
  assert.equal(localMime('a.nef'), 'image/x-nikon-nef');
  assert.equal(localMime('a.bin'), 'application/octet-stream');
  assert.equal(formatGroup('a.exr'), 'image', 'EXR 在 UI 归图像组、渲染归 env');
  assert.equal(formatGroup('a.html'), 'misc');
  assert.equal(formatOf('a.AI')?.preview, 'thumb');
});

test('extensionOf 兼容文件名 / 裸后缀 / 带 query 的 URL', () => {
  assert.equal(extensionOf('C:\\资产\\图.CR2'), 'cr2');
  assert.equal(extensionOf('model.glb?x=1#y'), 'glb');
  assert.equal(extensionOf('.PNG'), 'png');
  assert.equal(extensionOf('FBX'), 'fbx');
  assert.equal(extensionOf('no-ext'), '');
  assert.equal(extensionOf(''), '');
});

test('扫描结果带 format / group，服务端不再自备第二份扩展名表', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-formats-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  for (const name of ['a.png', 'b.CR3', 'c.flv', 'd.ai', 'e.bin', 'f.usdz']) await fs.writeFile(path.join(dir, name), 'x');
  const result = await listLocalFolder({folder: dir});
  assert.equal(result.files.length, 6);
  const byName = Object.fromEntries(result.files.map(file => [file.name, file]));
  assert.equal(byName['a.png'].format, 'png');
  assert.equal(byName['a.png'].group, 'image');
  assert.equal(byName['b.CR3'].group, 'image');
  assert.equal(byName['c.flv'].kind, 'video');
  assert.equal(byName['d.ai'].group, 'document');
  assert.equal(byName['e.bin'].kind, 'other');
  assert.equal(byName['e.bin'].group, '');
  assert.equal(byName['f.usdz'].group, 'model', '本库格式扫描结果也归到语义组');
});

test('formatsOfModel 从路径、format 字段、包内条目派生后缀', () => {
  assert.deepEqual(formatsOfModel({format: 'FBX', entries: [{rel: 'a.glb'}, 'b.exr'], filePath: 'C:/x/c.psd'}),
    ['psd', 'fbx', 'glb', 'exr']);
  assert.deepEqual(formatsOfModel({name: '没有路径', url: 'https://example.com/models/x'}), []);
  assert.deepEqual(formatsOfModel(null), []);
  assert.ok(formatsOfModel({filePath: 'x.bin'}).includes('bin'), '未知后缀也要保留，供「其他」与自定义格式命中');
});

test('扩展缝：extraFormats / extraGroups / overrides 造出独立注册表', () => {
  const custom = createFormatRegistry({
    extraFormats: [['xyz', 'custom', 'image', 'image/x-xyz', 'thumb']],
    extraGroups: [{id: 'custom', label: '自定义'}],
    overrides: {png: {preview: 'thumb'}},
  });
  assert.equal(custom.get('a.XYZ')?.mime, 'image/x-xyz');
  assert.equal(custom.get('a.png')?.preview, 'thumb');
  assert.ok(custom.groups.some(group => group.id === 'custom' && group.exts.includes('xyz')));
  assert.equal(formatFilterGroups(custom).at(-1).id, 'custom', '自定义组仍排在标准组之后');
  assert.equal(formatFilterGroups(custom).length, 8);
  assert.equal(formatOf('a.png').preview, 'native', '默认注册表不能被定制实例污染');
});

test('hasUnknownFormat 与派生子集：缩略图 / 原生视频不再手写清单', () => {
  assert.equal(hasUnknownFormat(['bin']), true);
  assert.equal(hasUnknownFormat(['png', 'bin']), false);
  assert.equal(hasUnknownFormat([]), true);
  assert.equal(hasUnknownFormat(['hdf']), false, 'hdf 是已知格式，不该被「其他」误命中');
  assert.equal(canThumb('a.png'), true);
  assert.equal(canThumb('a.psd'), true);
  assert.equal(canThumb('a.nef'), true, '相机 RAW 应可尝试后端转 PNG');
  assert.equal(canThumb('a.svg'), false, 'SVG 保持既有行为：不生成缩略图');
  assert.equal(BROWSER_VIDEO_EXT.test('a.ogv'), true);
  assert.equal(BROWSER_VIDEO_EXT.test('a.mkv'), false);
  assert.equal(BROWSER_VIDEO_EXT.test('a.flv'), false);
});
