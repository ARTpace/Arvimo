// 有界并发 map：worker 数取 min(limit, items.length)，结果按输入下标写回，顺序不变。
// fn 抛错时整体 reject（由调用方 catch），不静默吞掉。
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
