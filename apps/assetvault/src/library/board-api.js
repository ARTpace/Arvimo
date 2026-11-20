// 画板与智能收集的统一 HTTP 面：两套 base（/api/library 画板、/api/collect 采集）收在一处。
// 只做参数拼装与错误归一化，不碰 DOM 与 state，便于单测注入假 fetch。
const LIBRARY = '/api/library';
const COLLECT = '/api/collect';
const HEADERS = {'X-SFX-Local': '1', 'Content-Type': 'application/json'};

export const COLLECT_ROUTES = Object.freeze([
  '/api/collect/status', '/api/collect/rules', '/api/collect/run',
  '/api/collect/runs', '/api/collect/pending', '/api/collect/pending/ack',
]);

async function call(fetchImpl, url, {method = 'GET', body} = {}) {
  const response = await fetchImpl(url, {
    method, headers: HEADERS, cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = Error(data.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const query = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};

export function createBoardApi({fetchImpl = globalThis.fetch} = {}) {
  if (typeof fetchImpl !== 'function') throw Error('缺少 fetch 实现');
  const lib = (path, options) => call(fetchImpl, `${LIBRARY}${path}`, options);
  const col = (path, options) => call(fetchImpl, `${COLLECT}${path}`, options);

  return {
    // 能力位：老进程没有 /api/collect/*，面板必须显式提示重启而不是静默 404。
    capabilities: () => call(fetchImpl, '/api/downloads/capabilities'),

    listBoards: () => lib('/collections'),
    saveBoard: board => lib('/collections', {method: 'POST', body: board}),
    deleteBoard: id => lib(`/collections${query({id})}`, {method: 'DELETE'}),
    boardItems: (id, uids, action = 'add') => lib('/collections/items', {method: 'POST', body: {id, uids, action}}),
    // 画板卡片的「封面 + 小图条」：一次批量请求多块画板的缩略图，避免每卡一个 XHR。
    boardPreviews: (ids, limit = 6) => lib('/collections/previews', {method: 'POST', body: {ids, limit}}),

    // 智能画板：不落结果快照，只把「q + filters + sort」这条规则存进 smart_collections。
    // 带 id 就是更新规则（服务端 upsert），不带 id 就是新建；规则本身由调用方给，
    // 这里不猜任何筛选语义，避免前端出现第二份筛选白名单。
    saveSmartBoard: rule => lib('/smart-collections', {method: 'POST', body: rule}),
    resolveSmartBoard: (id, options = {}) => lib('/smart-collections/resolve', {method: 'POST', body: {id, ...options}}),

    collectStatus: () => col('/status'),
    rules: (ruleId = '') => col(`/rules${query({ruleId, limit: 50})}`),
    saveRule: rule => col('/rules', {method: 'POST', body: rule}),
    deleteRule: id => col(`/rules${query({id})}`, {method: 'DELETE'}),
    runRule: (id, dryRun = false, requestId = '') => col('/run', {method: 'POST', body: {id, dryRun,...(requestId?{requestId}:{})}}),
    runs: (ruleId,requestId='') => col(`/runs${query({ruleId,requestId, limit: 20})}`),
    pending: () => col('/pending'),
    ack: uids => col('/pending/ack', {method: 'POST', body: {uids}}),
  };
}
