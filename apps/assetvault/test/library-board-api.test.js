// 画板 HTTP 面：路由、请求头、错误归一化与参数拼装。全部注入假 fetch，不打网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoardApi, COLLECT_ROUTES} from '../src/library/board-api.js';

const fixture = (responses = {}) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({url, options});
    const found = Object.entries(responses).find(([key]) => url.startsWith(key));
    const payload = found?.[1] ?? {ok: true};
    return {
      ok: payload.status ? payload.status < 400 : true,
      status: payload.status || 200,
      json: async () => payload.body ?? {ok: true},
    };
  };
  return {api: createBoardApi({fetchImpl}), calls};
};

test('所有采集路由都在契约清单里，且带本地请求标识', async () => {
  const {api, calls} = fixture();
  await api.collectStatus();
  await api.rules('r-1');
  await api.saveRule({name: 'x'});
  await api.deleteRule('r-1');
  await api.runRule('r-1', true);
  await api.runs('r-1');
  await api.pending();
  await api.ack(['a']);
  for (const call of calls) {
    assert.equal(call.options.headers['X-SFX-Local'], '1');
    assert.equal(call.options.cache, 'no-store');
    if (call.url.startsWith('/api/collect/')) assert.ok(COLLECT_ROUTES.some(route => call.url.startsWith(route)));
  }
});

test('规则列表与立即采集的查询参数正确', async () => {
  const {api, calls} = fixture();
  await api.rules('r-9');
  assert.match(calls[0].url, /ruleId=r-9/);
  await api.runRule('r-9', true);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), {id: 'r-9', dryRun: true});
});

test('画板接口走 /api/library 且 action 可替换', async () => {
  const {api, calls} = fixture({'': {body: {collections: []}}});
  await api.listBoards();
  await api.saveBoard({name: '石板'});
  await api.deleteBoard('c-1');
  await api.boardItems('c-1', ['a'], 'remove');
  assert.deepEqual(calls.map(call => call.options.method || 'GET'), ['GET', 'POST', 'DELETE', 'POST']);
  assert.equal(calls[2].url, '/api/library/collections?id=c-1');
  assert.deepEqual(JSON.parse(calls[3].options.body), {id: 'c-1', uids: ['a'], action: 'remove'});
});

test('ack 只回传 uid 列表，pending 用 GET', async () => {
  const {api, calls} = fixture();
  await api.pending();
  await api.ack(['a', 'b']);
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(JSON.parse(calls[1].options.body), {uids: ['a', 'b']});
});

test('非 2xx 归一化成带 status 的 Error，消息取服务端 error', async () => {
  const {api} = fixture({'/api/collect/run': {status: 409, body: {error: '这条规则正在采集'}}});
  await assert.rejects(() => api.runRule('r-1'), error => error.status === 409 && /正在采集/.test(error.message));
});

test('404 是旧进程的信号，status 必须保留给面板识别', async () => {
  const {api} = fixture({'/api/collect/rules': {status: 404, body: {error: 'Not Found'}}});
  await assert.rejects(() => api.rules(), error => error.status === 404);
});

test('能力位走 /api/downloads/capabilities，与采集路由不同源', async () => {
  const {api, calls} = fixture({'/api/downloads/capabilities': {body: {version: '3.15.0', collectRules: true}}});
  const cap = await api.capabilities();
  assert.equal(cap.collectRules, true);
  assert.equal(calls[0].url, '/api/downloads/capabilities');
});

test('缺 fetch 实现时明确报错，不在运行时才炸', () => {
  assert.throws(() => createBoardApi({fetchImpl: null}), /fetch/);
});
