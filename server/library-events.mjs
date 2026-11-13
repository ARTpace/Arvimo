// S3-c：变更广播（SSE）。
//
// 为什么用 SSE 而不是 WebSocket：单向通知（服务端 → 客户端）用 SSE 就够，
// 它走普通 HTTP，浏览器原生支持，断线自动重连，不需要额外依赖与握手协议。
// 客户端只失效受影响的卡片，不做全量刷新 —— 50 万资产下全量刷新是不可接受的。
//
// 四个设计点：
//   1. **每个连接一个队列 + 上限**：慢客户端不能拖垮服务端。队列满了就断开它
//      （浏览器会自动重连并重新拉数据），而不是无限堆积内存。
//   2. **心跳**：注释帧（`: ping`）让中间设备不掐连接，也让我们能发现死连接。
//   3. **断线续传**：每条事件带自增 seq，事件流保留最近若干条；重连时带上
//      Last-Event-ID 就能补齐空档，不必为了一次瞬断就重拉整页。
//   4. **降级路径**：EventSource 不可用时前端仍可轮询 —— 广播是加速器，不是必需品。
const MAX_QUEUE = 256;
/** 心跳间隔（毫秒）。比常见的 60s 短，便于测试与快速发现断线。 */
export const HEARTBEAT_MS = 30000;
/**
 * 断线补发窗口：保留最近 N 条事件。
 * 一次批量打标会广播几十条，512 条足够覆盖绝大多数瞬断；
 * 超出窗口的客户端只能整体重拉（seq 对不上时前端会走全量刷新）。
 */
export const MAX_HISTORY = 512;

/**
 * 变更总线。同进程内的多个 HTTP 连接共享一个实例。
 */
export function createEventBus({onWarn = () => {}} = {}) {
  const clients = new Set();
  /** 最近事件：{seq, frame}。frame 是可直接写出的完整 SSE 帧。 */
  const history = [];
  let seq = 0;

  /**
   * 广播一次变更。payload 形如 {kind:'tags', uid:'...', rev:12}。
   * 没有连接时也要记 seq —— 否则客户端重连带 Last-Event-ID 时会算错位置。
   */
  function emit(payload) {
    if (!payload) return 0;
    seq += 1;
    const frame = `id: ${seq}\ndata: ${JSON.stringify({...payload, seq})}\n\n`;
    history.push({seq, frame});
    if (history.length > MAX_HISTORY) history.shift();
    if (!clients.size) return 0;
    let sent = 0;
    for (const client of [...clients]) {
      if (client.queue.length >= MAX_QUEUE) {
        // 慢客户端：直接断开。浏览器会自动重连并重新拉数据，
        // 这比让它继续堆积内存、导致服务端内存被拖垮要好。
        onWarn(`资产库事件订阅者积压过多，已断开（uid=${client.uid}）`);
        drop(client);
        continue;
      }
      client.queue.push(frame);
      client.flush();
      sent++;
    }
    return sent;
  }

  function drop(client) {
    if (!clients.has(client)) return;
    clients.delete(client);
    try { client.res.end(); } catch { /* 连接可能已经断了 */ }
  }

  /**
   * 注册一个连接。返回退订函数。
   * lastEventId：客户端上次收到的 seq（浏览器重连时通过 Last-Event-ID 头带回）。
   */
  function subscribe(req, res, {uid = '', lastEventId = null} = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉 nginx 的缓冲，否则事件会被攒着一起发。
      'X-Accel-Buffering': 'no',
    });
    // 立刻发一条注释帧：让客户端知道连上了（EventSource 的 onopen 也依赖这个）。
    res.write(': connected\n\n');

    const client = {res, queue: [], uid, flush: null};
    client.flush = () => {
      if (!client.queue.length) return;
      const chunk = client.queue.join('');
      client.queue.length = 0;
      try { res.write(chunk); } catch { drop(client); }
    };
    clients.add(client);

    // 断线补发：只补 seq 大于客户端已收到的部分。
    const from = Number(lastEventId);
    if (Number.isFinite(from) && from >= 0 && from < seq) {
      const missed = history.filter(item => item.seq > from);
      if (missed.length) {
        client.queue.push(missed.map(item => item.frame).join(''));
        client.flush();
      }
    }

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { drop(client); }
    }, HEARTBEAT_MS);
    // 心跳不该拖住进程退出。
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const cleanup = () => { clearInterval(heartbeat); drop(client); };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
    return cleanup;
  }

  return {
    emit,
    subscribe,
    /** 当前事件序号：客户端拿它当「我看到的最新位置」。 */
    get seq() { return seq; },
    /** 补发窗口里的事件（轮询降级路径用）。 */
    since(from = 0) {
      const start = Number(from);
      if (!Number.isFinite(start)) return [];
      return history.filter(item => item.seq > start).map(item => item.frame);
    },
    get size() { return clients.size; },
    close() { for (const client of [...clients]) drop(client); },
  };
}
