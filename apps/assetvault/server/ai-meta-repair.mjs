/**
 * 给已入库的本地 PNG 资产回填 AI 生成元数据（提示词 / 生成工具）。
 *
 * 与 asset-type-repair.mjs 同一套路：启动时跑一次，按文件路径读 PNG 文本块，
 * 命中的用 asset:patch 写回 payload.aiMeta，前端归类/筛选据此把图判到「AI生成」。
 * 幂等：已有 aiMeta 的记录直接跳过；文件离线、非 PNG、读失败都静默跳过。
 */
import {readAiImageMeta} from './ai-image-meta.mjs';
import {mapLimit} from './bounded-map.mjs';

const CONCURRENCY = 8;

export async function repairAiMeta({storage, limit = 20000} = {}) {
  if (!storage) return {repaired: 0, scanned: 0};
  let rows;
  try { rows = await storage.withDb(conn => conn.all("SELECT uid, payload FROM assets WHERE state = 'active'")); }
  catch { return {repaired: 0, scanned: 0}; }
  if (!rows) return {repaired: 0, scanned: 0};

  // 只看本地 PNG 资产：平台下载图不会有 SD/ComfyUI 提示词，不必读。
  const candidates = [];
  for (const row of rows) {
    if (candidates.length >= limit) break;
    let model;
    try { model = JSON.parse(row.payload); } catch { continue; }
    if (!model || model.platform !== 'local' || model.aiMeta) continue;
    const ext = String(model.ext || '').toLowerCase();
    if (ext !== 'png') continue;
    const file = model.filePath || '';
    if (!file) continue;
    candidates.push({uid: row.uid, file});
  }
  if (!candidates.length) return {repaired: 0, scanned: 0};

  const results = await mapLimit(candidates, CONCURRENCY, async ({uid, file}) => {
    try {
      const meta = await readAiImageMeta(file);
      return meta ? {op: 'asset:patch', uid, patch: {aiMeta: meta}} : null;
    } catch { return null; }
  });
  const ops = results.filter(Boolean);
  if (!ops.length) return {repaired: 0, scanned: candidates.length};

  try {
    const report = await storage.withDbWrite(conn => conn.applyAssetOps(ops, {actor: 'ai-meta-repair'}));
    return {repaired: Number(report?.applied) || ops.length, scanned: candidates.length};
  } catch {
    return {repaired: 0, scanned: candidates.length};
  }
}
