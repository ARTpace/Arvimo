// 资产库「文件格式」单一事实源：分组清单、类型、MIME、预览策略都只在这里定义一次。
//
// 清单分组与交互语义借鉴 Serpent src/shared/media-formats.ts / audio-media.ts /
// text-media.ts / format-filter-presets.ts（MIT，见 docs/THIRD_PARTY.md）。原版是若干
// 并列数组 + 六个 MIME 函数，移植时合并成「一张表 + 派生索引」，避免 UI / Worker 各留一份。
//
// 三个坐标别混：
//   - group   = 用户看到的筛选分组（图像 / 视频 / …，对齐 Serpent 面板）；
//   - kind    = AssetVault 本地文件的渲染大类（model/env/image/font/audio/video/document/other），
//               由 server/local-browse.mjs 的 fileKind() 沿用，不能随便改；
//   - preview = 前端 openFile() 的分派策略（native/decode/thumb/…），见 local-files.js。
//
// 这是纯数据 + 纯函数：无 DOM、无 node 内置依赖，服务端与浏览器 bundle 共用同一份。
// 扩展格式不要改调用点 —— 用 createFormatRegistry({extraFormats, extraGroups, overrides})。

/** 与 Serpent 面板一致的 7 个语义分组。本库自有格式按语义并进这些组，不另起「本库扩展」。 */
export const GROUP_META = Object.freeze([
  {id: 'image', label: '图像'},
  {id: 'video', label: '视频'},
  {id: 'audio', label: '音频'},
  {id: 'model', label: '3D 模型'},
  {id: 'document', label: '文档'},
  {id: 'font', label: '字体'},
  {id: 'misc', label: '杂项'},
]);

/** UI 分组顺序 = 参考面板顺序；text 只以 token 形式出现在杂项，不单独成组。 */
export const STANDARD_UI_GROUP_IDS = Object.freeze(GROUP_META.map(group => group.id));

export const FORMAT_TEXT_TOKEN = 'text';
export const FORMAT_UNKNOWN_TOKEN = 'unknown';
/** 本库自有、参考清单里没有的格式。归位后靠 `origin:'local'` 追溯，不再单列一组。 */
export const LOCAL_FORMAT_EXTS = Object.freeze([
  'usd', 'usda', 'usdc', 'usdz', 'hdr', 'ply', '3mf', 'ogv', 'mtl',
  'blend', 'sbsar', 'zip', 'heic', 'heif', 'dds',
  // 文档渲染扩展：浏览器内渲染（docx / epub）与 LibreOffice 转 PDF（doc-pdf）两类。
  'docx', 'doc', 'epub', 'pptx', 'ppt', 'xlsx', 'xls', 'rtf',
  'odt', 'odp', 'ods',
]);
const LOCAL_FORMAT_SET = new Set(LOCAL_FORMAT_EXTS);

/** 文本 token 展开清单（Serpent text-media.ts，MIT）。UI 只显示一个「文本」chip。 */
export const TEXT_EXTS = Object.freeze([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'css', 'js',
  'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'sh', 'bat', 'ps1',
  'sql', 'rst', 'tex', 'vue', 'svelte', 'kt', 'swift', 'rb',
  'php', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'lua', 'r', 'plist',
]);

/** [ext, group, kind, mime, preview] —— 加一种格式只加一行。 */
const ROWS = [
  // 图像（24）：包含相机 RAW，浏览器解不了但后端可经 ffmpeg 转出缩略图。
  ['png', 'image', 'image', 'image/png', 'native'],
  ['jpg', 'image', 'image', 'image/jpeg', 'native'],
  ['jpeg', 'image', 'image', 'image/jpeg', 'native'],
  ['jfif', 'image', 'image', 'image/jpeg', 'native'],
  ['gif', 'image', 'image', 'image/gif', 'native'],
  ['tif', 'image', 'image', 'image/tiff', 'decode-tiff'],
  ['tiff', 'image', 'image', 'image/tiff', 'decode-tiff'],
  ['webp', 'image', 'image', 'image/webp', 'native'],
  ['avif', 'image', 'image', 'image/avif', 'native'],
  ['svg', 'image', 'image', 'image/svg+xml', 'native'],
  ['bmp', 'image', 'image', 'image/bmp', 'native'],
  ['ico', 'image', 'image', 'image/x-icon', 'native'],
  ['psd', 'image', 'image', 'image/vnd.adobe.photoshop', 'decode-psd'],
  ['exr', 'image', 'env', 'image/x-exr', 'env'],
  ['tga', 'image', 'image', 'image/x-tga', 'decode-tga'],
  ['raw', 'image', 'image', 'image/x-raw', 'thumb'],
  ['dng', 'image', 'image', 'image/x-adobe-dng', 'thumb'],
  ['cr2', 'image', 'image', 'image/x-canon-cr2', 'thumb'],
  ['cr3', 'image', 'image', 'image/x-canon-cr3', 'thumb'],
  ['nef', 'image', 'image', 'image/x-nikon-nef', 'thumb'],
  ['arw', 'image', 'image', 'image/x-sony-arw', 'thumb'],
  ['raf', 'image', 'image', 'image/x-fuji-raf', 'thumb'],
  ['orf', 'image', 'image', 'image/x-olympus-orf', 'thumb'],
  ['rw2', 'image', 'image', 'image/x-panasonic-rw2', 'thumb'],
  // 视频（8）：只有 4 个容器浏览器原生可播，其余走 ffmpeg 实时转封装。
  ['mp4', 'video', 'video', 'video/mp4', 'video-native'],
  ['mov', 'video', 'video', 'video/quicktime', 'video-transcode'],
  ['avi', 'video', 'video', 'video/x-msvideo', 'video-transcode'],
  ['wmv', 'video', 'video', 'video/x-ms-wmv', 'video-transcode'],
  ['webm', 'video', 'video', 'video/webm', 'video-native'],
  ['mkv', 'video', 'video', 'video/x-matroska', 'video-transcode'],
  ['m4v', 'video', 'video', 'video/x-m4v', 'video-native'],
  ['flv', 'video', 'video', 'video/x-flv', 'video-transcode'],
  // 音频（11）：aif/aiff/ac3 浏览器多半不认，用同一个转码通道出 MP4 音轨。
  ['wav', 'audio', 'audio', 'audio/wav', 'audio'],
  ['mp3', 'audio', 'audio', 'audio/mpeg', 'audio'],
  ['ogg', 'audio', 'audio', 'audio/ogg', 'audio'],
  ['oga', 'audio', 'audio', 'audio/ogg', 'audio'],
  ['m4a', 'audio', 'audio', 'audio/mp4', 'audio'],
  ['aac', 'audio', 'audio', 'audio/aac', 'audio'],
  ['flac', 'audio', 'audio', 'audio/flac', 'audio'],
  ['opus', 'audio', 'audio', 'audio/ogg', 'audio'],
  ['aif', 'audio', 'audio', 'audio/aiff', 'audio-transcode'],
  ['aiff', 'audio', 'audio', 'audio/aiff', 'audio-transcode'],
  ['ac3', 'audio', 'audio', 'audio/ac3', 'audio-transcode'],
  // 3D 模型（5）+ 文档（2）+ 字体（5）：截图面板原样。
  ['fbx', 'model', 'model', 'model/fbx', 'model'],
  ['obj', 'model', 'model', 'model/obj', 'model'],
  ['gltf', 'model', 'model', 'model/gltf+json', 'model'],
  ['glb', 'model', 'model', 'model/gltf-binary', 'model'],
  ['stl', 'model', 'model', 'model/stl', 'model'],
  ['pdf', 'document', 'document', 'application/pdf', 'pdf'],
  ['ai', 'document', 'document', 'application/illustrator', 'thumb'],
  // 文档渲染扩展分两轨（见 docs/CODEMAP.md「文档渲染」）：
  //   docx / epub = 浏览器内纯 JS 渲染；md/markdown 见 TEXT_PREVIEW_OVERRIDES。
  //   doc / pptx / ppt / xlsx / xls / rtf / odt / odp / ods = LibreOffice 转 PDF 后复用 pdf iframe。
  ['docx', 'document', 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['epub', 'document', 'document', 'application/epub+zip', 'epub'],
  ['doc', 'document', 'document', 'application/msword', 'doc-pdf'],
  ['pptx', 'document', 'document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'doc-pdf'],
  ['ppt', 'document', 'document', 'application/vnd.ms-powerpoint', 'doc-pdf'],
  ['xlsx', 'document', 'document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'doc-pdf'],
  ['xls', 'document', 'document', 'application/vnd.ms-excel', 'doc-pdf'],
  ['rtf', 'document', 'document', 'application/rtf', 'doc-pdf'],
  ['odt', 'document', 'document', 'application/vnd.oasis.opendocument.text', 'doc-pdf'],
  ['odp', 'document', 'document', 'application/vnd.oasis.opendocument.presentation', 'doc-pdf'],
  ['ods', 'document', 'document', 'application/vnd.oasis.opendocument.spreadsheet', 'doc-pdf'],
  ['ttf', 'font', 'font', 'font/ttf', 'font'],
  ['otf', 'font', 'font', 'font/otf', 'font'],
  ['woff', 'font', 'font', 'font/woff', 'font'],
  ['woff2', 'font', 'font', 'font/woff2', 'font'],
  ['ttc', 'font', 'font', 'font/collection', 'font'],
  // 杂项：hdf 只用于筛选（没有内建预览）；html/htm 静态 iframe。
  ['html', 'misc', 'document', 'text/html; charset=utf-8', 'html'],
  ['hdf', 'misc', 'other', 'application/x-hdf', 'none'],
  ['htm', 'misc', 'document', 'text/html; charset=utf-8', 'html'],
  // 本库自有格式（origin:'local'）：按语义并入上面的标准组，不另起「本库扩展」。
  // 3D 模型：USD 家族 / 更多网格 / Blender 工程 / 材质与材质库。
  ['usd', 'model', 'model', 'model/usd', 'usd'],
  ['usda', 'model', 'model', 'model/usd', 'usd'],
  ['usdc', 'model', 'model', 'model/usd', 'usd'],
  ['usdz', 'model', 'model', 'model/usdz', 'model'],
  ['ply', 'model', 'model', 'model/ply', 'model'],
  ['3mf', 'model', 'model', 'model/3mf', 'model'],
  ['mtl', 'model', 'other', 'text/plain; charset=utf-8', 'text'],
  ['blend', 'model', 'other', 'application/x-blender', 'none'],
  ['sbsar', 'model', 'other', 'application/x-sbsar', 'none'],
  // 图像：全景环境图与浏览器解不了但可转 PNG 的容器；视频：Ogg 容器；杂项：压缩包。
  ['hdr', 'image', 'env', 'image/vnd.radiance', 'env'],
  ['heic', 'image', 'image', 'image/heic', 'thumb'],
  ['heif', 'image', 'image', 'image/heif', 'thumb'],
  ['dds', 'image', 'image', 'image/vnd-ms.dds', 'thumb'],
  ['ogv', 'video', 'video', 'video/ogg', 'video-native'],
  ['zip', 'misc', 'other', 'application/zip', 'none'],
];

/**
 * 文本后缀里需要「排版渲染」而非纯文本查看的例外：值就是 preview 策略。
 * 加一种文本类渲染器只在这里加一行，TEXT_EXTS 清单、分组与所有调用点都不用动。
 * md / markdown 由 marked + DOMPurify 渲染成 HTML，其余文本仍是纯文本查看器。
 */
export const TEXT_PREVIEW_OVERRIDES = Object.freeze({md: 'markdown', markdown: 'markdown'});

const TEXT_ROWS = TEXT_EXTS.map(ext => [ext, 'text', 'document',
  ext === 'json' ? 'application/json' : (ext === 'xml' ? 'application/xml' : 'text/plain; charset=utf-8'),
  TEXT_PREVIEW_OVERRIDES[ext] || 'text']);

const freeze = value => Object.freeze(value);

/** 造一份注册表。extraFormats 用与 ROWS 同形的行；overrides 可改已有项的任意字段。 */
export function createFormatRegistry({extraFormats = [], extraGroups = [], overrides = {}} = {}) {
  const entries = {};
  for (const [ext, group, kind, mime, preview] of [...ROWS, ...TEXT_ROWS, ...extraFormats]) {
    const key = ext.toLowerCase();
    // origin 只作追溯标记：ref = 参考清单，local = 本库自有；overrides 可改，便于将来做徽标 / 分组策略。
    const origin = LOCAL_FORMAT_SET.has(key) ? 'local' : 'ref';
    entries[key] = freeze({ext: key, group, kind, mime, preview, origin, ...(overrides[key] || overrides[ext] || {})});
  }
  const formats = freeze(entries);
  const groups = freeze([...GROUP_META, {id: 'text', label: '文本'}, ...extraGroups].map(group => freeze({
    ...group,
    // 文本组只在 token 层面存在：UI 用一个「文本」chip 代替 45 个扩展名。
    exts: freeze(Object.values(formats).filter(item => item.group === group.id).map(item => item.ext)),
  })));
  const knownExts = freeze([...new Set([...Object.keys(formats)])]);
  const known = new Set(knownExts);
  return freeze({
    formats, groups, knownExts, textExts: TEXT_EXTS,
    has: ext => known.has(String(ext || '').toLowerCase()),
    get: name => formats[extensionOf(name)] || null,
    groupOf: name => formats[extensionOf(name)]?.group || '',
    kindOf: name => formats[extensionOf(name)]?.kind || 'other',
    mimeOf: name => formats[extensionOf(name)]?.mime || 'application/octet-stream',
    previewOf: name => formats[extensionOf(name)]?.preview || 'none',
  });
}

/** 文件名 / '.ext' / 'ext' / 带 query 的 URL → 小写无点扩展名；没有就返回空串。 */
export function extensionOf(name) {
  const raw = String(name ?? '').trim().toLowerCase().split(/[?#]/)[0];
  const base = raw.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return /^[a-z0-9]{1,8}$/.test(base) ? base : '';
  const ext = base.slice(dot + 1);
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export const formatRegistry = createFormatRegistry();
export const FORMATS = formatRegistry.formats;
export const FORMAT_GROUPS = formatRegistry.groups;
export const KNOWN_EXTS = formatRegistry.knownExts;
export const formatOf = name => formatRegistry.get(name);
export const formatKind = name => formatRegistry.kindOf(name);
export const formatMime = name => formatRegistry.mimeOf(name);
export const formatGroup = name => formatRegistry.groupOf(name);

/**
 * UI 面板的分组投影：标准组按参考面板顺序输出，本库格式已在各自组内；
 * 杂项额外挂一个「文本」token（代替 43 个后缀），「其他」是面板里独立复选框。
 * extraGroups 扩展缝注册的自定义组排到最后；空组不渲染，避免只剩一个标题。
 */
export function formatFilterGroups(registry = formatRegistry) {
  const byId = new Map(registry.groups.map(group => [group.id, group]));
  const standard = STANDARD_UI_GROUP_IDS.map(id => {
    const group = byId.get(id);
    const exts = [...(group?.exts || [])];
    if (id === 'misc') exts.push(FORMAT_TEXT_TOKEN);
    return freeze({id, label: group?.label || id, exts: freeze(exts)});
  });
  const custom = registry.groups
    .filter(group => !STANDARD_UI_GROUP_IDS.includes(group.id) && group.id !== 'text' && group.exts.length)
    .map(group => freeze({id: group.id, label: group.label, exts: group.exts}));
  return freeze([...standard, ...custom]);
}

/** 只有这些字段允许「没有点的纯 token」当格式（info.json 里的 format:'FBX'）。 */
const BARE_FORMAT_KEYS = new Set(['ext', 'extension', 'format', 'assetFormat', 'fileFormat']);

/** 从一个资产 model 里抽出所有后缀：路径字段 + 显式 format 字段 + 包内条目清单。
 *  不过滤已知集合 —— 自定义格式与「其他」判定都要靠这些原始后缀。 */
export function formatsOfModel(model) {
  if (!model || typeof model !== 'object') return [];
  const found = new Set();
  const add = (value, bare = false) => {
    if (typeof value === 'string' || typeof value === 'number') {
      const raw = String(value).trim().toLowerCase().split(/[?#]/)[0];
      if (!bare && !raw.includes('.')) return;
      const ext = extensionOf(raw);
      if (ext) found.add(ext);
    } else if (value && typeof value === 'object') {
      for (const key of ['rel', 'name', 'path', 'file', 'filePath']) add(value[key]);
      for (const key of ['ext', 'format']) add(value[key], true);
    }
  };
  for (const key of ['filePath', 'root', 'rel', 'folder', 'name', 'filename', 'format',
    'assetFormat', 'fileFormat', 'entry', 'cover', 'ext', 'extension']) add(model[key], BARE_FORMAT_KEYS.has(key));
  for (const key of ['entries', 'files', 'downloads', 'assets']) {
    if (Array.isArray(model[key])) for (const item of model[key].slice(0, 200)) add(item);
  }
  return [...found];
}

/** 一组扩展名里是否完全没有「已知格式」——「其他 / unknown」的判定。 */
export function hasUnknownFormat(exts, registry = formatRegistry) {
  const list = Array.isArray(exts) ? exts : [];
  return !list.some(ext => registry.has(ext));
}
