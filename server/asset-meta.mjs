// 资产元信息（info.json · schema v1）：一个资产包只放一个 info.json。
//
// 事实字段（uid / title / kind / package 统计）在「登记」时写一次；AI 派生字段挂在
// `ai` 子对象里，只 patch 不重建。这样一个文件装下全部信息，又不会出现「补标签把事实
// 字段冲掉」的情况。
//
// 写盘三条铁律（缺一条就会出事故）：
//   1. 只补不改：目录里已有能解析的 info.json 就整份拒绝改写 —— 事实以磁盘为准；
//   2. 原子替换：写 .tmp → 重新 parse 校验 → rename，半截内容永远上不了盘；
//   3. 只写包根：调用方必须先确认这是扫描判定出来的包根目录。写到父目录会让
//      扫描器（local-assets.mjs 的 walk）把那棵子树整块吞成一个包。
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {formatOf} from '../src/library/format-registry.js';

export const META_SCHEMA = 1;
export const META_FILE = 'info.json';
/** 只读主文件头 1MB：整份 hash 一个大 fbx 要几百毫秒，扫描感知得到。 */
const HEAD_BYTES = 1024 * 1024;
/** 与平台 uid（32 位 hex）区分开：资产库按 uid 去重，撞号会把本地包当成下载任务卡藏起来。 */
const UID_PREFIX = 'local-';
/** 包内图片数量按注册表算：图像组 + 环境贴图（EXR/HDR）。RAW 与 ICO 现在也算图片。 */
const isImageEntry = name => {
  const entry = formatOf(name);
  return !!entry && (entry.group === 'image' || entry.kind === 'env');
};

/** 读目录里的 info.json。没有、读不动、JSON 坏了都返回 null（调用方按「没登记」处理）。 */
export async function readMeta(dir) {
  try {
    const text = await fsp.readFile(path.join(dir, META_FILE), 'utf8');
    const meta = JSON.parse(text);
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

/** 首次登记的稳定身份：主文件（模型 → 封面 → 清单第一个）的相对路径 + 大小 + 前 1MB 内容。
 *  一旦写进 info.json 就固定，之后改名、加贴图、移动目录都不换身份。
 *  `pack` 是 local-assets 的 describe() 输出，entry / cover 都是相对包目录的路径。 */
export async function deriveUid(dir, pack = {}) {
  const rel = pack.entry || pack.cover || (pack.entries || [])[0]?.rel || '';
  const hash = createHash('sha1').update(`v1\n${pack.fileCount || 0}\n${pack.bytes || 0}\n`);
  if (rel) {
    const abs = path.join(dir, ...String(rel).split('/'));
    try {
      const handle = await fsp.open(abs, 'r');
      try {
        const {size} = await handle.stat();
        const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
        if (head.length) await handle.read(head, 0, head.length, 0);
        hash.update(`${rel}\n${size}\n`).update(head);
      } finally {
        await handle.close();
      }
    } catch {
      // 主文件读不动（权限/被占用）就只靠清单指纹，宁可少一个信号也别让登记失败。
    }
  } else {
    // 空包/只有空目录：没有文件可指纹，退回目录名，至少同一次登记内稳定。
    hash.update(`dir\n${path.basename(dir)}`);
  }
  return `${UID_PREFIX}${hash.digest('hex').slice(0, 32)}`;
}

function imageCount(pack) {
  return (pack.entries || []).filter(item => isImageEntry(item.name || '')).length;
}

/** 组装 schema v1。字段名对齐 local-assets 的 describe() 读法：title / kind / resolution / format。 */
export function buildMeta(pack, uid) {
  const now = new Date().toISOString();
  return {
    schemaVersion: META_SCHEMA,
    generatedBy: 'assetvault',
    uid,
    title: String(pack.title || ''),
    author: String(pack.author || ''),
    license: String(pack.license || ''),
    // 平台包（sketchfab / artstation / ambientcg）由各自的写入器负责；这里是本地导入。
    source: String(pack.platform || 'local-import'),
    kind: String(pack.category || 'model'),
    resolution: String(pack.resolution || ''),
    format: String(pack.format || ''),
    importedAt: now,
    updatedAt: now,
    // 统计写进文件，扫描就不必为了「多少文件、多大、封面是哪张」再走一遍整棵树。
    package: {
      type: pack.type || 'folder',
      entry: pack.entry || null,
      cover: pack.cover || null,
      fileCount: pack.fileCount || 0,
      bytes: pack.bytes || 0,
      images: imageCount(pack),
    },
    movedFrom: [],
  };
}

/** 原子写：tmp → 校验 → rename。中途失败只会留下 .tmp，原文件一个字节都不动。 */
export async function writeMeta(dir, meta) {
  const file = path.join(dir, META_FILE);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  try {
    JSON.parse(await fsp.readFile(tmp, 'utf8'));
  } catch (error) {
    await fsp.rm(tmp, {force: true}).catch(() => {});
    throw Error(`info.json 校验失败，未写入：${error.message}`);
  }
  await fsp.rename(tmp, file);
  return meta;
}

/** 登记一个还没 info.json 的包。已有能解析的 info.json 就原样返回，不改写。 */
export async function registerPackage(dir, pack = {}) {
  const existing = await readMeta(dir);
  if (existing) return {skipped: true, uid: typeof existing.uid === 'string' ? existing.uid : '', meta: existing};
  const uid = typeof pack.uid === 'string' && pack.uid ? pack.uid : await deriveUid(dir, pack);
  const meta = await writeMeta(dir, buildMeta(pack, uid));
  return {skipped: false, uid, meta};
}

/** AI 只走这条路：补/换 `ai` 段，其余字段从磁盘原样带过去。 */
export async function patchAi(dir, ai) {
  const meta = await readMeta(dir);
  if (!meta) throw Error('这个资产还没有登记（缺 info.json），先登记再写标签');
  meta.ai = {...(meta.ai && typeof meta.ai === 'object' ? meta.ai : {}), ...ai};
  meta.updatedAt = new Date().toISOString();
  return writeMeta(dir, meta);
}
const clampRating = value => {const n = Math.round(Number(value));return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;};
/** 用户段（评分/备注）与 AI 段一样只 patch 不重建：`user` 子对象整段替换，事实字段不动。
 *  包不存在或没登记时返回 null，由调用方决定报 409 还是静默跳过。 */
export async function patchPackageMeta(dir, {ai = null, user = null} = {}) {
  const meta = await readMeta(dir);
  if (!meta) return null;
  if (ai && typeof ai === 'object' && !Array.isArray(ai)) meta.ai = {...(meta.ai && typeof meta.ai === 'object' ? meta.ai : {}), ...ai};
  if (user && typeof user === 'object' && !Array.isArray(user)) meta.user = {rating: clampRating(user.rating), note: typeof user.note === 'string' ? user.note.slice(0, 2000) : ''};
  meta.updatedAt = new Date().toISOString();
  return writeMeta(dir, meta);
}
