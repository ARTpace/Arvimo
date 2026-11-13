// 采集结果的「待合并队列」。
//
// 为什么不直接写主状态：`models` 只能整块 POST，而前端手里握着全量 models、每 200ms 就可能
// 整块覆盖一次。服务端偷偷往 blob 里追加资产，下一次前端保存就会把它抹掉 —— 这是典型的一致性坑。
// 所以采集器只把结果放进这个队列，前端拉取 → 合并 → 自己走既有整块保存 → 回执删除。
// 收益：零新增写库通道、零迁移、失败可重放；代价：资产要等前端合并一次才出现在卡片里。
import fs from 'node:fs/promises';
import path from 'node:path';

export const PENDING_LIMIT = 2000;
export const PENDING_MODEL_BYTES = 16 * 1024;

const UID = /^[a-f0-9]{32}$/i;
const text = value => typeof value === 'string' ? value : '';

function cleanModel(input) {
  if (!input || typeof input !== 'object' || !UID.test(text(input.uid))) return null;
  let raw = '';
  try { raw = JSON.stringify(input); } catch { return null; }
  if (raw.length > PENDING_MODEL_BYTES) return null;
  return {...input, uid: input.uid.toLowerCase()};
}

export function createCollectPending({file, io = fs, now = Date.now, limit = PENDING_LIMIT} = {}) {
  if (!file) throw Error('缺少待合并队列文件路径');
  let cache = null;
  let queue = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      const data = JSON.parse(await io.readFile(file, 'utf8'));
      cache = {version: 1, models: (Array.isArray(data.models) ? data.models : []).map(cleanModel).filter(Boolean).slice(0, limit), updatedAt: Number(data.updatedAt) || 0};
    } catch {
      cache = {version: 1, models: [], updatedAt: 0};
    }
    return cache;
  }

  function commit(mutator) {
    const write = queue.then(async () => {
      const current = await load();
      const next = mutator(current);
      if (!next) return current;
      next.updatedAt = now();
      await io.mkdir(path.dirname(file), {recursive: true});
      await io.writeFile(`${file}.tmp`, JSON.stringify(next));
      await io.rename(`${file}.tmp`, file);
      cache = next;
      return next;
    });
    queue = write.catch(() => {});
    return write;
  }

  return {
    file,
    async list() {
      const data = await load();
      return data.models.map(model => ({...model}));
    },
    async add(models) {
      const rows = (Array.isArray(models) ? models : []).map(cleanModel).filter(Boolean);
      if (!rows.length) return {added: 0, count: (await load()).models.length};
      let added = 0;
      const next = await commit(current => {
        const seen = new Set(current.models.map(model => model.uid));
        const merged = [...current.models];
        for (const model of rows) {
          if (seen.has(model.uid)) continue;
          seen.add(model.uid);
          merged.push(model);
          added += 1;
        }
        // 超出上限时丢最旧的：新采集的优先留下，旧条目等前端下次上线再合并意义更小。
        return {...current, models: merged.slice(-limit)};
      });
      return {added, count: next.models.length};
    },
    async ack(uids) {
      const drop = new Set((Array.isArray(uids) ? uids : []).map(uid => text(uid).toLowerCase()).filter(uid => UID.test(uid)));
      if (!drop.size) return {removed: 0, count: (await load()).models.length};
      let removed = 0;
      const next = await commit(current => {
        const kept = current.models.filter(model => !drop.has(model.uid));
        removed = current.models.length - kept.length;
        return removed ? {...current, models: kept} : null;
      });
      return {removed, count: next.models.length};
    },
    /** 只读摘要：面板轮询用，不搬全量模型。 */
    async status() {
      const data = await load();
      return {count: data.models.length, updatedAt: data.updatedAt};
    },
  };
}
