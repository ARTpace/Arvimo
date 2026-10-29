// 扫描结果缓存：同一组根目录的重复扫描直接读缓存，不再每请求全量重建目录树。
//
// 失效策略（三层，均可通过环境变量调整或关闭）：
//   1. 签名探针：根目录自身的 mtimeMs+size + 顶层条目名清单。顶层增删/改名资产立即失效，
//      成本只有每根一次 stat + 一次 readdir（NTFS 上目录 mtime 只随直接子项增删变化）；
//   2. TTL 兜底：嵌套变化（往既有包里加文件）签名探不到，在 TTL 内可能短暂陈旧，
//      默认 15s，SFX_SCAN_CACHE_TTL_MS 可调，设 0 等价关闭缓存；
//   3. 显式失效：登记/元信息补写等会改包内容的写操作完成后调用 invalidateScanCache()。
import fsp from 'node:fs/promises';

const TTL_MS = Math.max(0, Number(process.env.SFX_SCAN_CACHE_TTL_MS) || 15000);
const MAX_ENTRIES = 4; // 只留最近几组根目录的缓存，避免超大资产库把内存吃爆。

const cache = new Map(); // key -> { signature, value, at }

/** 根目录签名：每根一次 stat + 一次 readdir（只取名字，不 stat 子项）。探不到的变化交给 TTL。 */
async function rootsSignature(roots) {
  const parts = [];
  for (const root of roots) {
    try {
      const stat = await fsp.stat(root);
      let names = '';
      try { names = (await fsp.readdir(root)).sort().join('|'); } catch { /* 根还在但读不动，签名只留 stat */ }
      parts.push(`${stat.mtimeMs}:${stat.size}:${names}`);
    } catch {
      parts.push('missing');
    }
  }
  return parts.join('#');
}

/** 写操作（登记 / 补写元信息 / 删除资产）之后调用：清空全部扫描缓存。 */
export function invalidateScanCache() {
  cache.clear();
}

/**
 * 带失效的缓存读取。key 需已含 roots 的完整区分度（调用方用 JSON 串）；
 * 命中且 TTL 内 → 复核签名，一致才返回缓存；否则 compute() 重算并回填（回填签名取扫描后的，
 * 覆盖扫描期间发生的顶层变化）。
 */
export async function cachedScan(key, { roots, compute }) {
  if (!TTL_MS) return compute();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    const signature = await rootsSignature(roots);
    if (signature === hit.signature) return hit.value;
  }
  const value = await compute();
  if (cache.size >= MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { signature: await rootsSignature(roots), value, at: Date.now() });
  return value;
}
