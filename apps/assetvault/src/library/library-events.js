// 资产库变更广播的前端客户端（S3-c）。
//
// 用途：局域网多人协作时，别人改了标签 / 评分 / 收藏，我这边的卡片要跟着变。
// 50 万资产下整体刷新是不可接受的 —— 服务端只广播「哪些 uid 变了」，
// 客户端据此失效对应卡片即可。
//
// 为什么用 SSE 不用 WebSocket：只是单向通知，SSE 走普通 HTTP、浏览器原生支持，
// 断线自动重连（还会自动带上 Last-Event-ID，服务端能把空档补齐）。
//
// 降级：EventSource 不可用或连不上时退到轮询 —— 广播是加速器，不是必需品，
// 断线期间顶多晚一点看到别人的改动，不该让整个面板瘫掉。

/** 事件合并窗口（毫秒）：几十条变更攒成一次重绘，别一张卡重绘一次。 */
export const FLUSH_DELAY_MS = 120;
/** 连续失败多少次后放弃重连（转降级）。 */
export const MAX_RETRIES = 5;

/**
 * 变更事件 → 需要刷新的 uid 集合。
 * 纯函数，单独可测：这是「服务端广播」与「前端重绘」之间唯一的契约。
 */
export function collectChange(payload, pending = {uids: new Set(), all: false, local: false}) {
  if (!payload || typeof payload !== 'object') return pending;
  // kind:'assets' = 粗粒度广播（整块写入、恢复备份）：全量失效。
  if (payload.kind === 'assets') pending.all = true;
  // kind:'local' = 磁盘上的资产目录变了（实时监控）。不碰卡片索引，只让本地文件列表重扫。
  if (payload.kind === 'local') pending.local = true;
  if (typeof payload.uid === 'string' && payload.uid) pending.uids.add(payload.uid);
  return pending;
}

/** 把待处理集合整理成回调参数。 */
export function flushChange(pending) {
  const result = {uids: [...pending.uids], all: pending.all, local: !!pending.local};
  pending.uids.clear();
  pending.all = false;
  pending.local = false;
  return result;
}

/**
 * 建立一条变更订阅。
 *
 * @param {object} options
 * @param {(change:{uids:string[],all:boolean}) => void} options.onChange 有变更时回调
 * @param {(status:string) => void} [options.onStatus] 连接状态：connecting / live / retrying / offline
 * @param {(url:string) => object} [options.createSource] 建连接的工厂（默认 new EventSource）
 * @param {number} [options.flushDelayMs] 合并窗口
 */
export function createLibraryEvents({
  url = '/api/library/events',
  onChange = () => {},
  onStatus = () => {},
  createSource = null,
  flushDelayMs = FLUSH_DELAY_MS,
  maxRetries = MAX_RETRIES,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const pending = {uids: new Set(), all: false, local: false};
  let source = null;
  let flushTimer = null;
  let retryTimer = null;
  let retries = 0;
  let stopped = false;
  let status = '';

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus(next);
  }

  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimer(() => {
      flushTimer = null;
      if (!pending.uids.size && !pending.all && !pending.local) return;
      onChange(flushChange(pending));
    }, flushDelayMs);
  }

  function open() {
    if (stopped) return;
    setStatus(retries ? 'retrying' : 'connecting');
    const factory = createSource || (target => new EventSource(target));
    try { source = factory(url); }
    catch (error) { setStatus('offline'); onStatus(String(error?.message || error)); return; }
    source.onopen = () => { retries = 0; setStatus('live'); };
    source.onmessage = event => {
      let payload = null;
      try { payload = JSON.parse(event.data); } catch { return; } // 坏帧直接丢，不影响后续
      collectChange(payload, pending);
      schedule();
    };
    source.onerror = () => {
      // EventSource 自己会重连；只有「彻底关闭」才需要我们自己接上。
      if (!source || source.readyState === 2 /* CLOSED */) {
        source = null;
        retries += 1;
        if (retries > maxRetries) { setStatus('offline'); return; }
        setStatus('retrying');
        retryTimer = setTimer(() => { retryTimer = null; open(); }, Math.min(30000, 1000 * retries));
      }
    };
  }

  return {
    start() { if (stopped) return; stopped = false; open(); },
    stop() {
      stopped = true;
      if (flushTimer) { clearTimer(flushTimer); flushTimer = null; }
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
      try { source?.close(); } catch { /* 关不掉就算了，服务端会自己断开 */ }
      source = null;
    },
    get status() { return status; },
    /** 待处理变更数：给「有 N 处更新」的提示用。 */
    get pending() { return pending.uids.size + (pending.all ? 1 : 0); },
  };
}
