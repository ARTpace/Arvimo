// 服务端 3D 封面编排：先捡便宜的，再动贵的。
//
//   .blend  → 内嵌 TEST 预览（毫秒、零依赖）→ 没有才交给 Blender
//   .usd*   → 直接 Blender（USD 文件里没有内嵌预览）
//
// 两者产物都写进同一份缩略图缓存，所以卡片、大图预览、画板都只是普通 <img>。
import { readBlendPreview, isBlendName } from './blend-preview.mjs';
import { renderBlenderCover, BLENDER_COVER_EXT } from './blender-thumb.mjs';
import { saveModelThumb } from './thumb-cache.mjs';

/** 这些格式浏览器侧渲染不了，只能服务端出封面。 */
export const SERVER_COVER_EXT = BLENDER_COVER_EXT;
export const isServerCoverName = name => SERVER_COVER_EXT.test(String(name || ''));

/**
 * 生成并缓存封面。
 * @returns {Promise<{source: 'blend-preview'|'blender', width: number, height: number, blender?: string}>}
 */
export async function ensureServerCover(file, { width = 512, format = 'png' } = {}) {
  if (isBlendName(file)) {
    const embedded = await readBlendPreview(file);
    if (embedded) {
      await saveModelThumb(file, embedded.png, { width, format });
      return { source: 'blend-preview', width: embedded.width, height: embedded.height };
    }
  }
  const rendered = await renderBlenderCover(file, { width });
  await saveModelThumb(file, rendered.png, { width, format });
  return { source: 'blender', width: rendered.width, height: rendered.height, blender: rendered.blender };
}

export { blenderStatus } from './blender-thumb.mjs';
