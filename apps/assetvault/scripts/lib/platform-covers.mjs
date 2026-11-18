// 平台官方封面取图：按平台 + assetId 拿到那张「平台搜索里看到的图」。
//
// 这张图是资产的身份证据之外的另一半：assetId 决定点开能不能 3D 预览，
// 封面图决定卡片像不像平台看到的那个东西。两者一旦被本地素材顶掉，
// 库里的资产就退化成「一堆贴图」。维护脚本与 relink 工具共用这份规则。
//
// 每个取图函数都只依赖平台的公开接口（不需要登录），失败返回 null，由调用方决定退路。
const UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'};

async function getBuffer(url) {
  const res = await fetch(url, {headers: UA, redirect: 'follow'});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getJson(url) {
  return JSON.parse((await getBuffer(url)).toString('utf8'));
}

/** Sketchfab：搜索/详情接口都匿名可读，取最大那张（通常 1920 宽）。 */
export async function sketchfabCover(assetId) {
  if (!/^[0-9a-f]{32}$/i.test(assetId)) return null;
  const data = await getJson(`https://api.sketchfab.com/v3/models/${assetId}`);
  return pickSketchfabImage(data);
}

function pickSketchfabImage(data) {
  const images = (data?.thumbnails?.images || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  if (!images.length) return null;
  return {url: images[0].url};
}

/** Sketchfab 搜索结果里直接带缩略图，省一次详情请求。 */
export function sketchfabSearchCover(result) {
  return pickSketchfabImage(result);
}

/** PolyHaven：CDN 契约 URL，slug 就是 assetId。 */
export function polyhavenCoverUrl(assetId) {
  return `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(assetId)}.png?width=1024&height=1024`;
}

/** ambientCG：材质/模型共用同一套缩略图 CDN。 */
export function ambientcgCoverUrl(assetId) {
  return `https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/1024-JPG-242424/${encodeURIComponent(assetId)}.jpg`;
}

/** FreeStylized：WP REST 的 featured media；分类按资产类型挑。 */
export async function freestylizedCoverUrl(assetId, {taxonomy = '3d_models'} = {}) {
  const api = `https://freestylized.com/wp-json/wp/v2/${taxonomy}?slug=${encodeURIComponent(assetId)}&_embed=1`;
  const rows = await getJson(api);
  const media = Array.isArray(rows) ? rows[0]?._embedded?.['wp:featuredmedia']?.[0] : null;
  const sizes = media?.media_details?.sizes || {};
  return (sizes.large || sizes.medium_large || sizes.full || sizes.medium || {}).source_url || null;
}

/**
 * 统一入口：拿平台官方封面的图源地址（不下载）。
 * @returns {Promise<string|null>}
 */
export async function platformCoverUrl(platform, assetId, hints = {}) {
  const id = String(assetId || '').trim();
  if (!id) return null;
  switch (String(platform || '').toLowerCase()) {
    case 'sketchfab': return (await sketchfabCover(id))?.url || null;
    case 'polyhaven': return polyhavenCoverUrl(id);
    case 'ambientcg': return ambientcgCoverUrl(id);
    case 'freestylized': return freestylizedCoverUrl(id, hints).catch(() => null);
    default: return null;
  }
}

/** 下载封面字节；webp/avif 交给 sharp 转 jpg 的地方由调用方处理。 */
export async function downloadCover(url) {
  if (!url || !/^https:\/\//i.test(url)) return null;
  const res = await fetch(url, {headers: UA, redirect: 'follow'});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2048 || buf.length > 12 * 1024 * 1024) return null;
  const ext = {'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif', 'image/gif': '.gif'}[type] || '.jpg';
  return {buf, ext, type};
}
