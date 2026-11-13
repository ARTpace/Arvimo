// 「这次失败值不值得再试一次」的唯一判定。
//
// 下载链路上有两个地方要回答同一个问题：单张图片要不要原地重试（image-store.mjs），
// 整个任务要不要排进自动重试（downloads.mjs）。两边各写一份正则，迟早会出现
// 「图片层认为该跳过、任务层认为该判死」这种自相矛盾的结论，所以判定只住在这里。
//
// 实测真实踩到的：花瓣 CDN 在抓得急时会直接掐连接，Node 抛的是 `socket hang up`
// （错误码 ECONNRESET），消息里既没有 "timeout" 也没有 "ECONN"，所以早先的
// /ECONN|timeout/ 正则完全没认出它，一个 294 张的画板就这么在第 7 张被判死了。

/** 连接级错误码：请求还没走完，重连一次通常就好了。 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',        // 对端直接掐断（socket hang up 就是它）
  'ECONNABORTED',
  'ECONNREFUSED',      // 对端瞬时不可用（CDN 节点在切）
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',         // DNS 临时失败
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',         // 域名解析抖动；重试次数有限，猜错也不贵
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** 没有错误码、只有一句话的情况（Node 的 "socket hang up" 是典型）。 */
const TRANSIENT_TEXT = /socket hang up|premature close|other side closed|aborted the request|ECONNRESET|EPIPE|连接代理超时|远程站点响应超时|网络连接|连接被重置|响应超时/i;

/** 值得重试的 HTTP 状态：限流与网关侧的临时故障。4xx 的 403/404 是「这个地址就是没有」，重试无意义。 */
export function isTransientStatus(status) {
  const code = Number(status);
  return code === 408 || code === 425 || code === 429 || (code >= 500 && code !== 501 && code !== 505);
}

/**
 * 这个错误是不是「换个时机 / 换条连接就能好」。
 * 只看一次的错误对象，不猜意图：有 code 看 code，没 code 看消息；HTTP 错误看 status。
 */
export function isTransientNetworkError(error, status) {
  if (!error) return false;
  const code = String(error.code || '');
  if (TRANSIENT_CODES.has(code)) return true;
  if (isTransientStatus(status ?? error.status)) return true;
  return TRANSIENT_TEXT.test(String(error.message || error));
}
