// 平台官方封面缓存：把平台那张渲染图（材质球 / 模型场景图）落到包内 preview.*。
//
// 为什么需要它（2026-11-16）：入库时曾经用 pickPreview 从包里挑「基础色贴图」当封面，
// 于是材质变成一块平铺花纹、模型变成一张 mat0_c.jpg，跟平台搜索结果完全是两个东西。
// 卡片封面真正想要的顺序是：
//   包内 preview.*（离线可看，平台同一张图）> 平台外链 > 包内其它图
// 这个顺序写在 server/library-db.mjs 的 upsert 里；这里负责让「包内 preview.*」真的存在。
//
// 失败一律静默返回 null：封面是锦上添花，不能因为它拖垮下载保存。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const PREVIEW_RE = /^preview\.(png|jpe?g|webp|gif|avif)$/i;
/** 平台图通常就是 jpeg/png；webp 也照存，前端 <img> 与缩略图服务（sharp）都认。 */
const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
};
const MIN_BYTES = 2048;
const MAX_BYTES = 12 * 1024 * 1024;

/** 本地平台封面看 rel 对应的文件名，不能把参数顺序或版本号当成文件名的一部分。 */
export function localPlatformCover(url) {
  const value=String(url||'');
  if(!/^\/api\/local\/(thumb|file)\?/.test(value))return '';
  const rel=new URL(value,'http://local').searchParams.get('rel')||'';
  return /(?:^|[\\/])preview\.(png|jpe?g|webp|gif|avif)$/i.test(rel)?value:'';
}

/**
 * 把 `url` 这张平台官方图缓存成 `dir/preview.<ext>`。
 * @param {string} dir 资产包目录（不是下载根目录）
 * @param {string} url 平台官方缩略图（必须是 https）
 * @returns {Promise<string|null>} 写好的文件路径，跳过或失败时为 null
 */
export async function cachePlatformCover(dir, url, {timeout = 6000} = {}) {
  try {
    const target = String(dir || '');
    const source = String(url || '');
    if (!target || !/^https:\/\//i.test(source)) return null;
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return null;
    // 包里已经有 preview.* 就别覆盖：可能是用户自己挑的图，或上次缓存的同一张。
    if (fs.readdirSync(target).some(name => PREVIEW_RE.test(name))) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    let res;
    try {
      res = await fetch(source, {signal: ac.signal, headers: {'User-Agent': 'Mozilla/5.0'}});
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MIN_BYTES || buf.length > MAX_BYTES) return null;
    const file = path.join(target, `preview${EXT_BY_TYPE[type] || '.jpg'}`);
    await fsp.writeFile(file, buf);
    return file;
  } catch {
    return null;
  }
}
