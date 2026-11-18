// 资产库的「自带说明书」：把元数据写在资产旁边，而不是只存在库外的 library.db。
//
// 为什么要有 sidecar（借鉴灵感库 / Eagle 的做法）：
//   · library.db 在库数据目录，资产根是另一个目录。拷走资产根 / 换机器 / DB 损坏时，
//     标签、来源页、备注、AI 提示词全丢，只剩一堆按分类摆好的文件。
//   · 写一份 __info.json 在文件旁边，资产库就自解释：别的工具（Eagle、DCC、脚本）能读，
//     我们也能在 DB 丢时反推重建。
//
// 三条硬约定：
//   1. 只写「离开数据库仍然有意义」的字段 —— 不写绝对路径（filePath/localRoot 跟着文件走没意义，
//      还会把用户目录结构泄漏给拿到这个库的人）。
//   2. 原子写（tmp + rename），内容没变就不碰文件 —— 避免触发微力同步反复上传。
//   3. 尽力而为：写失败只记日志，绝不阻断导入 / 下载 / 改标签。
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

export const SIDECAR_FILE = '__info.json';
export const LIBRARY_DIR = '.assetvault';
export const LIBRARY_MARKER = 'library.json';
export const DESKTOP_INI = 'desktop.ini';
const SCHEMA = 1;

const text = value => String(value ?? '').trim();
const num = value => (Number.isFinite(Number(value)) && value !== '' && value !== null ? Number(value) : undefined);
const drop = obj => Object.fromEntries(Object.entries(obj).filter(([, value]) => {
  if (value === undefined || value === null || value === '') return false;
  return !(Array.isArray(value) && !value.length);
}));

const tagNames = value => (Array.isArray(value) ? value
  .map(item => (typeof item === 'string' ? item : item?.name || item?.label || ''))
  .map(text).filter(Boolean) : undefined);

/** 资产 → sidecar 内容。字段顺序稳定，方便人眼 diff。 */
export function sidecarPayload(model = {}, {now = Date.now(), kind = ''} = {}) {
  const ai = model.aiMeta;
  const source = text(model.source);
  // 扩展名以文件本身的为准：AI 生成器的文件名常带提示词，DB 里的 ext 会被截成
  // 「3),wrench_elven_arch,outdoors」这种垃圾值，写进 sidecar 只会误导别的工具。
  const fromPath = text(path.extname(text(model.filePath || model.localRel)).slice(1)).toLowerCase();
  const ext = fromPath && fromPath.length <= 5 && /^[a-z0-9]+$/.test(fromPath) ? fromPath : text(model.ext).toLowerCase();
  return drop({
    schema: SCHEMA,
    uid: text(model.uid),
    name: text(model.name || model.title),
    ext,
    assetType: text(model.assetType),
    kind: text(kind || model.kind),
    bytes: num(model.bytes),
    // 只认 DB 里显式的宽高；probe 记的是探测用缩略图的尺寸，会写出 192×384 这种错值。
    width: num(model.width),
    height: num(model.height),
    sha256: text(model.sha256),
    addedAt: num(model.addedAt),
    updatedAt: now,
    platform: text(model.platform),
    source,
    // 平台资产标识：材质 3D 预览（ambientCG viewer / PolyHaven CDN / Sketchfab embed）全靠它。
    // 它和 uid 是两回事 —— uid 是本地主键（标签、收藏都按它关联），平台 ID 只用来取平台数据。
    assetId: text(model.assetId),
    // 平台官方缩略图：只存 http(s) 外链，不存 /api/local/thumb 那种宿主路径（换机即失效）。
    // 扫描器读到它就用它当卡片封面，材质才不会显示成一块平铺贴图。
    thumbnail: /^https?:\/\//i.test(text(model.platformThumbnail || model.thumbnail)) ? text(model.platformThumbnail || model.thumbnail) : undefined,
    // 平台来源页：能点回去找到原模型的那条链接，比 platform 字段值钱得多。
    originUrl: text(/^https?:/i.test(source) ? source : model.originUrl || model.sourceUrl || model.pageUrl),
    tags: tagNames(model.tags),
    favorite: model.favorite === true ? true : undefined,
    note: text(model.note),
    aiMeta: ai && (ai.prompt || ai.tool)
      ? drop({tool: text(ai.tool), prompt: text(ai.prompt)})
      : undefined,
  });
}

/** Windows 上把文件设成隐藏（失败不影响写入结果）。 */
function hideOnWindows(target) {
  if (process.platform !== 'win32') return;
  try { execFileSync('attrib.exe', ['+h', target], {stdio: 'ignore', windowsHide: true}); } catch {}
}

/**
 * 写 JSON，内容相同就不动文件。
 * 微力同步 / OneDrive 会盯着 mtime，写一次就传一次 1 GB 之外的垃圾流量，
 * 所以「内容没变」必须真的不落盘，而不是写完发现一样。
 */
function writeJsonIfChanged(target, payload, {binary = null, hide = false} = {}) {
  const body = binary ?? Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  let existed = false;
  try {
    const old = fs.readFileSync(target);
    existed = true;
    if (old.equals(body)) return false;
  } catch {}
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
  if (hide && !existed) hideOnWindows(target);
  return true;
}

/**
 * sidecar 的名字分两种，判据是「这个资产是一个文件，还是一个文件夹」：
 *
 *   · 平铺单文件（一张图、一个 glb）：`<文件名>.info.json` 放在旁边。
 *     分类目录里平铺着几百个资产，统一起名 `__info.json` 会被后写的覆盖 ——
 *     实测 732 个资产只剩 7 份，所以这里必须带文件名。
 *   · 一个资产一个文件夹（下载来的模型包 / 材质包）：`<包目录>/__info.json` 放进包里。
 *     包里天然只有一个资产，不存在覆盖；放包里才能「整个文件夹拷走，说明书跟着走」。
 *     早先是放在包外面（`包名.info.json` 与目录同级），单独拷走包时说明就落下了。
 */
export function sidecarName(filePath) {
  const base = path.basename(String(filePath || ''));
  if (base.length <= 120) return `${base}.info.json`;
  // 超长名（AI 提示词当文件名）截断 + 短 hash 保唯一，避免踩 260 字符路径上限。
  const hash = createHash('md5').update(base).digest('hex').slice(0, 8);
  const ext = path.extname(base);
  return `${base.slice(0, 100)}~${hash}${ext}.info.json`;
}

/** 判断是不是目录资产。路径不存在（文件已被移走）时按单文件处理，保持旧行为。 */
function isDirectoryTarget(filePath) {
  try { return fs.statSync(String(filePath || '')).isDirectory(); } catch { return false; }
}

/** 资产旁的 sidecar 路径：目录资产放包里，单文件资产放旁边。 */
export function sidecarPathFor(filePath) {
  const target = String(filePath || '');
  if (target && isDirectoryTarget(target)) return path.join(target, SIDECAR_FILE);
  return path.join(path.dirname(target), sidecarName(target));
}

/** 目录资产改成「包内 __info.json」之前，旧版本写在包外面的那份，写新的时顺手清掉。 */
function legacySiblingSidecar(filePath) {
  return path.join(path.dirname(String(filePath)), `${path.basename(String(filePath))}.info.json`);
}

/** 写某个资产的 sidecar。返回是否真的写了（内容没变 → false）。 */
export function writeSidecar(filePath, model, options = {}) {
  if (!filePath) return false;
  const payload = sidecarPayload(model, options);
  if (!payload.uid) return false;
  try {
    const written = writeJsonIfChanged(sidecarPathFor(filePath), payload, {hide: true});
    if (isDirectoryTarget(filePath)) {
      try { fs.rmSync(legacySiblingSidecar(filePath), {force: true}); } catch {}
    }
    return written;
  } catch {
    return false;
  }
}

/** 读回 sidecar（DB 丢失后重建索引 / 排查用）。 */
export function readSidecar(filePath) {
  try { return JSON.parse(fs.readFileSync(sidecarPathFor(filePath), 'utf8')); } catch { return null; }
}

export const libraryMarkerPath = archiveRoot => path.join(String(archiveRoot), LIBRARY_DIR, LIBRARY_MARKER);

/**
 * 资产根的身份文件：换机器 / 换工具时靠它认出「这是 AssetVault 的哪个库」。
 * guid 首次生成后不再变 —— 改库名只改 name，不换身份。
 */
export function ensureLibraryMarker(archiveRoot, {name = '', storeId = '', dataDir = '', importType = 'copy', now = Date.now()} = {}) {
  if (!archiveRoot) return null;
  // 统一走 path.resolve：调用方可能传 J:\\\\资产、J:/资产/ 这类写法，写进库标识就没法用了。
  const root = path.resolve(String(archiveRoot));
  const dir = path.join(root, LIBRARY_DIR);
  const file = path.join(dir, LIBRARY_MARKER);
  let old = null;
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const label = text(name) || text(old?.name) || path.basename(root);
  const data = text(dataDir) || text(old?.dataDir);
  const payload = {
    schema: SCHEMA,
    app: 'AssetVault',
    guid: text(old?.guid) || randomUUID(),
    name: label,
    storeId: text(storeId) || text(old?.storeId),
    archiveRoot: root,
    dataDir: data,
    importType: text(importType) || 'copy',
    createdAt: num(old?.createdAt) || now,
    updatedAt: num(old?.updatedAt) || now,
  };
  const changed = !old || old.name !== payload.name || old.dataDir !== payload.dataDir
    || old.storeId !== payload.storeId || old.archiveRoot !== payload.archiveRoot;
  if (changed) payload.updatedAt = now;
  try {
    fs.mkdirSync(dir, {recursive: true});
    writeJsonIfChanged(file, payload);
    hideOnWindows(dir);
  } catch {}
  return payload;
}

/**
 * 让资源管理器里这个文件夹显示库名 + 自定义图标。
 * 内容必须是 UTF-16LE + BOM，否则中文 InfoTip 会乱码（Windows 的 ini 解析不吃 UTF-8）。
 */
export function ensureDesktopIni(archiveRoot, {name = '', iconPath = ''} = {}) {
  if (!archiveRoot) return false;
  const root = path.resolve(String(archiveRoot));
  const file = path.join(root, DESKTOP_INI);
  const icon = text(iconPath) || path.join(APP_ROOT, 'assets', 'assetvault.ico');
  const lines = [
    '[.ShellClassInfo]',
    'ConfirmFileOp=0',
    'NoSharing=1',
    ...(fs.existsSync(icon) ? [`IconResource=${icon},0`] : []),
    `InfoTip=AssetVault 资产库${name ? `：${name}` : ''}`,
  ];
  const body = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf16le')]);
  try {
    writeJsonIfChanged(file, null, {binary: body, hide: true});
    // 文件夹带 +s（系统）属性，desktop.ini 才会被资源管理器采纳。
    if (process.platform === 'win32') {
      try { execFileSync('attrib.exe', ['+s', root], {stdio: 'ignore', windowsHide: true}); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

/** 库根的两件套一次配齐（启动时调用，幂等）。 */
export function ensureLibraryIdentity(archiveRoot, options = {}) {
  const marker = ensureLibraryMarker(archiveRoot, options);
  ensureDesktopIni(archiveRoot, {name: options.name || marker?.name || ''});
  return marker;
}
