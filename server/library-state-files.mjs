/**
 * 状态文件层的纯函数：体积上限、域文件路径、入参校验、封面恢复、目录合并。
 *
 * 从 library-storage.mjs 拆出，保持「接入层只管编排、纯逻辑可独立单测」。
 * library-storage.mjs 会 re-export 这里的公开符号，所以外部 import 路径不变。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {MAIN_STATE_KEY, STATE_KEYS} from './library-schema.mjs';

/** 服务端认可的状态 key。白名单之外的键一律拒收（防止把任意数据塞进状态目录）。 */
const allowed = new Set(STATE_KEYS);

/**
 * 单个状态 key 的体积上限。目录域在 50 万资产时实测 209MB —— 这个上限管的是
 * 「会话域 / 用户域 / 探测域」这类小对象，目录域有独立的宽松上限（见 MAX_CATALOG_BYTES）。
 * 原来 16MB 是给整个 blob 定的，现在按域分开：目录域本来就大，其余三域必须小。
 */
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
/** 目录域的体积上限：50 万资产实测 209MB，留出余量给继续增长的库。 */
export const MAX_CATALOG_BYTES = 1024 * 1024 * 1024;

/**
 * 域文件路径：服务端与测试共用同一份布局定义，避免把 `state/<key>.json` 写死在两处。
 * 一个域一个文件，写一个域只重写那个域 —— 这是 ADR-02 写入代价与库大小解耦的关键。
 */
export const stateFileFor = (dataDir, key) => path.join(dataDir, 'state', `${key}.json`);

/** save() 与 mutate() 共用的入参校验：白名单 key、字符串、单键体积。 */
export function validateValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error('资产库状态格式无效');
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key) || typeof value !== 'string') throw Error('资产库状态格式无效');
    const limit = key === MAIN_STATE_KEY ? MAX_CATALOG_BYTES : MAX_STATE_BYTES;
    if (value.length > limit) throw Error('资产库状态格式无效');
  }
  return values;
}

// Export manifests identify the asset but older ones omit its platform cover.
// Reuse saved catalog metadata without network requests or importing unrelated assets.
export async function restoreLibraryCovers(values, recovered = [], cacheDir) {
  const result = {...values}; let state;
  try { state = JSON.parse(result['sfx-library-v2'] || '{}'); } catch { return {values: result, recovered}; }
  const models = Array.isArray(state.models) ? state.models : [];
  const missing = new Set([...models, ...recovered].filter(m => m?.uid && !m.thumbnail).map(m => m.uid));
  if (!missing.size) return {values: result, recovered};
  const source = model => String(model?.url || model?.artworkUrl || '').replace(/\/$/, '');
  const wantedSources = new Set([...models, ...recovered].filter(m => missing.has(m.uid)).map(source).filter(Boolean));
  const covers = new Map(), sourceCovers = new Map();
  // sourceCovers 的 key 是 URL 不是 uid —— 同名资产换过平台链接时靠它兜底，别写成 uid。
  const remember = model => {
    if (typeof model?.thumbnail === 'string' && model.thumbnail.startsWith('https://')) {
      covers.set(model.uid, model.thumbnail);
      if (source(model)) sourceCovers.set(source(model), model.thumbnail);
    }
  };
  for (const model of [...models, ...recovered]) remember(model);
  let files = []; try { files = await fs.readdir(cacheDir); } catch {}
  for (const name of files) {
    if ([...models, ...recovered].filter(m => missing.has(m.uid))
      .every(m => covers.has(m.uid) || sourceCovers.has(source(m)))) break;
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    try {
      const file = path.join(cacheDir, name);
      if ((await fs.stat(file)).size > 12 * 1024 * 1024) continue;
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const model of data.models || []) {
        if (missing.has(model.uid) || wantedSources.has(source(model))) remember(model);
      }
    } catch {/* A damaged cache entry must not prevent opening the library. */}
  }
  const fill = model => !model?.thumbnail && (covers.has(model.uid) || sourceCovers.has(source(model)))
    ? {...model, thumbnail: covers.get(model.uid) || sourceCovers.get(source(model))} : model;
  if (models.some(m => fill(m) !== m)) result['sfx-library-v2'] = JSON.stringify({...state, models: models.map(fill)});
  return {values: result, recovered: recovered.map(fill)};
}

/**
 * 目录域合并。
 *
 * 前端只持有它看到的那部分目录（内存上限 + 分页），如果直接替换，服务端的目录会被缩小 ——
 * 50 万的库被一次普通保存打成 2 万条，而且不可逆。
 * 合并语义：同名以新为准，其余原样留下。删除走 asset.remove 通道定点删。
 */
export function mergeCatalog(currentRaw, incomingRaw, dropped = new Set()) {
  let current = {};
  let incoming = null;
  try { current = JSON.parse(typeof currentRaw === 'string' ? currentRaw : '{}') || {}; } catch { current = {}; }
  try { incoming = JSON.parse(typeof incomingRaw === 'string' ? incomingRaw : '{}') || {}; } catch { return incomingRaw; }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incomingRaw;
  const mergeList = (first = [], second = []) => {
    const map = new Map();
    for (const item of [...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])]) {
      if (item && typeof item === 'object' && item.uid) map.set(item.uid, item);
    }
    return [...map.values()];
  };
  const merged = {...current, ...incoming};
  // 只在字段真的存在时才写回：无中生有的 `trashed: []` 会改变 blob 的字节，
  // 让「只改备注」的保存看起来像改过目录，也会让导出快照多出幽灵字段。
  if (Array.isArray(current.models) || Array.isArray(incoming.models)) {
    // 前端把资产移进回收站后 models 里就没有它了；合并语义若把它从 current 补回来，
    // 同一 uid 会同时躺在 models 与 trashed 里，目录越来越脏。显式剔除才是「移走」。
    const trashedUids = new Set((Array.isArray(incoming.trashed) ? incoming.trashed : [])
      .map(item => item?.uid).filter(Boolean));
    const currentModels = (Array.isArray(current.models) ? current.models : [])
      .filter(item => !trashedUids.has(item?.uid));
    merged.models = mergeList(currentModels, incoming.models).filter(item => !dropped.has(item?.uid));
  }
  if (Array.isArray(current.trashed) || Array.isArray(incoming.trashed)) {
    merged.trashed = mergeList(current.trashed, incoming.trashed).filter(item => !dropped.has(item?.uid));
  }
  if (Array.isArray(merged.favorites)) merged.favorites = merged.favorites.filter(uid => !dropped.has(uid));
  return JSON.stringify(merged);
}
