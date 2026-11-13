// 「只入库」：把一块画板 / 一个作品页记进资产库，图片一张都不下。
//
// 为什么这样就能出正式卡：资产库扫描只看 info.json（local-assets.mjs），而卡片封面在
// info.json.thumbnail 是 http(s) 地址时会交给 /api/image 代理出图（绕开各站防盗链）。
// 也就是说「元数据 + 远程封面」已经够一张卡了，下载几百 MB 原图不是出卡的前提。
//
// 必须守住的一条：**不写 images 数组**。清单一旦声明了图片，校验器就要求磁盘上真有那些文件，
// 画廊也会去打开不存在的路径。图片数量走 imageCount，与清单分开记。
//
// 目录名与下载器共用 folder-name.mjs 的规则：之后点「下载原图」，队列能原地接管这张卡的目录，
// 而不是在旁边再长一个「(1)」。
import fsp from 'node:fs/promises';
import path from 'node:path';
import {cleanStem} from './folder-name.mjs';
import {writeImageManifest} from './image-bundle.mjs';

/** 清单里的状态标记。卡片据此显示「远程收藏」，下载队列据此认出「这个目录可以原地接管」。 */
export const REMOTE_STATUS = 'remote';

const UID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_IMAGE_COUNT = 1_000_000;
export const isBoardUid = value => UID_PATTERN.test(String(value || ''));

async function readInfo(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, 'info.json'), 'utf8')); }
  catch { return null; }
}

/**
 * 目录里已有的同一个 uid。远程卡第二次点「只入库」不该长出第二张卡 ——
 * 用户重复点保存是很常见的，去重不能靠目录名（标题可能被改过）。
 */
export async function findBoardDir(folder, uid) {
  if (!folder || !uid) return null;
  let entries;
  try { entries = await fsp.readdir(folder, { withFileTypes: true }); }
  catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const info = await readInfo(path.join(folder, entry.name));
    if (info?.uid === uid) return path.join(folder, entry.name);
  }
  return null;
}

/** 补齐下载用：只认「远程收藏」的目录。已经下完 / 正在下的包不该被当成接管目标。 */
export async function findRemoteBoardDir(folder, uid) {
  const dir = await findBoardDir(folder, uid);
  if (!dir) return null;
  const info = await readInfo(dir);
  return info?.status === REMOTE_STATUS ? dir : null;
}

/**
 * 写一张远程收藏卡。返回 `{dir, title, imageCount, skipped}`：
 * `skipped:true` 表示这个 uid 已经有真正的图片包了，什么都没有覆盖。
 */
export async function writePictureBoardCard({
  folder, category = '图片', uid, platform = '', url = '',
  title = '', author = '', cover = null, imageCount = 0, tags = [],
} = {}) {
  if (!isBoardUid(uid)) throw Error('资产标识无效（需要 32 位十六进制）');
  if (!folder) throw Error('没有可写入的资产库目录');
  const parent = path.join(folder, category);
  await fsp.mkdir(parent, {recursive: true});
  // 已有同 uid 的目录就复用（哪怕标题变了）：一张资产一张卡。
  const dir = (await findBoardDir(parent, uid)) || path.join(parent, cleanStem(title || platform || '图片包', uid));
  await fsp.mkdir(dir, {recursive: true});
  const previous = await readInfo(dir);
  const count = Math.min(MAX_IMAGE_COUNT, Math.max(0, Math.floor(Number(imageCount) || 0)));
  // 真包优先：一个已经下过图的目录，绝不能用「远程卡」盖掉它的清单。
  if (previous && previous.status !== REMOTE_STATUS
    && ((Array.isArray(previous.images) && previous.images.length) || (Array.isArray(previous.files) && previous.files.length))) {
    return { dir, title: String(previous.title || title || path.basename(dir)), imageCount: Number(previous.imageCount) || 0, skipped: true };
  }
  const merged = [...new Set([...(Array.isArray(previous?.tags) ? previous.tags : []), ...(Array.isArray(tags) ? tags : [])].filter(Boolean))];
  const manifest = {
    uid,
    kind: 'images',
    platform: String(platform || ''),
    title: String(title || path.basename(dir)),
    author: String(author || ''),
    // 出处与来源页：`url` 是队列判重与「下载原图」回填的唯一凭据。
    url: String(url || ''),
    source_url: String(url || ''),
    source: String(url || ''),
    // 远程封面：前端走 /api/image 代理出图，所以这里不下载、不缓存。
    thumbnail: cover || null,
    imageCount: count,
    status: REMOTE_STATUS,
    remote: true,
    ...(merged.length ? { tags: merged } : {}),
    note: '远程收藏：只记录了平台页面信息（标题 / 作者 / 封面 / 张数），图片还没有下载到本机。',
    exportedAt: new Date().toISOString(),
    tool: 'AssetVault / picture board',
  };
  await writeImageManifest(dir, manifest);
  return { dir, title: manifest.title, imageCount: count, skipped: false };
}
