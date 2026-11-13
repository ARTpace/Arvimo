import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createAuth} from '../server/auth.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-auth-'));
const file = path.join(dir, 'auth-users.json');
const auth = createAuth({file});

/** 只挂 auth 的最小宿主：闸门 + 一条假数据接口，用来验证「没登录进不去」。 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (await auth.handle(req, res, url)) return;
    if (auth.gate(req, res, url)) return;
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('workbench');
  } catch (error) {
    res.writeHead(error.status || 400, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: error.message}));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const post = (route, payload, cookie = '') => fetch(`${base}${route}`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json', ...(cookie ? {cookie} : {})},
  body: JSON.stringify(payload)
});

test('未登录：数据接口 401，页面 302 到登录页，登录页本身放行', async () => {
  const api = await fetch(`${base}/api/library-state`);
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error, '请先登录');

  const page = await fetch(`${base}/`, {redirect: 'manual'});
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');

  const login = await fetch(`${base}/login.html`, {redirect: 'manual'});
  assert.equal(login.status, 200);
});

test('本机工具带机器令牌可以直连接口（CLI / MCP 不被迫走登录）', async () => {
  const token = fs.readFileSync(path.join(dir, 'auth-token'), 'utf8').trim();
  assert.ok(token.length >= 32, '机器令牌应该落在数据目录里');
  const ok = await fetch(`${base}/api/library-state`, {headers: {'x-av-token': token}});
  assert.equal(ok.status, 200);
  const bad = await fetch(`${base}/api/library-state`, {headers: {'x-av-token': 'nope'}});
  assert.equal(bad.status, 401);
});

test('密码只约束长度：6–64 位，字符种类与大小写都不限', async () => {
  for (const password of ['12345', 'x'.repeat(65), '']) {
    const response = await post('/api/auth/register', {name: '短密码', password});
    assert.equal(response.status, 400, `密码 ${JSON.stringify(password)} 不该通过`);
    assert.match((await response.json()).error, /6–64 位/);
  }
  // 大小写混排 + 符号也能建号
  const mixed = await post('/api/auth/register', {name: 'Mixed', password: 'Abc!234'});
  assert.equal(mixed.status, 201);
  // 区分大小写：只改大小写登不上，原样才能进
  assert.equal((await post('/api/auth/login', {name: 'Mixed', password: 'abc!234'})).status, 401);
  assert.equal((await post('/api/auth/login', {name: 'Mixed', password: 'Abc!234'})).status, 200);
});

test('账号名规则：太短、带空格都不行', async () => {
  for (const name of ['a', '有 空格', 'x'.repeat(21), '']) {
    const response = await post('/api/auth/register', {name, password: '12345678'});
    assert.equal(response.status, 400);
  }
});

test('注册即登录：拿到的 cookie 能进工作台', async () => {
  const response = await post('/api/auth/register', {name: '阿凉', password: '12345678'});
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await response.json()).user.name, '阿凉');

  const page = await fetch(`${base}/`, {headers: {cookie}, redirect: 'manual'});
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'workbench');

  const me = await fetch(`${base}/api/auth/me`, {headers: {cookie}});
  assert.equal((await me.json()).user.name, '阿凉');
});

test('重名注册被挡下；密码不对 401；密码对了能登录', async () => {
  assert.equal((await post('/api/auth/register', {name: '阿凉', password: '87654321'})).status, 409);

  const wrong = await post('/api/auth/login', {name: '阿凉', password: '00000000'});
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, '账号名或密码不对');

  const ok = await post('/api/auth/login', {name: '阿凉', password: '12345678'});
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get('set-cookie'));
});

test('改密码：验旧密码、长度校验、改完旧密码失效', async () => {
  const login = await post('/api/auth/login', {name: '阿凉', password: '12345678'});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const change = (payload, jar = cookie) => post('/api/auth/password', payload, jar);

  assert.equal((await change({current: 'wrong-one', next: 'NextPw123'})).status, 401);
  assert.equal((await change({current: '12345678', next: '12345'})).status, 400);
  assert.equal((await change({current: '12345678', next: '12345678'})).status, 400);

  const ok = await change({current: '12345678', next: 'NextPw123'});
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get('set-cookie'), '改完应重新签发 cookie，当前设备不掉线');

  assert.equal((await post('/api/auth/login', {name: '阿凉', password: '12345678'})).status, 401);
  assert.equal((await post('/api/auth/login', {name: '阿凉', password: 'NextPw123'})).status, 200);
  // 换回原密码，后面的用例还要用
  assert.equal((await change({current: 'NextPw123', next: '12345678'})).status, 200);
});

test('账号文件里没有明文口令', async () => {
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('12345678'), '口令不该以明文落盘');
  const saved = JSON.parse(raw);
  assert.ok(saved.users.length >= 1);
  assert.ok(saved.users[0].salt && saved.users[0].hash);
});

test('退出登录：cookie 失效，再访问又被拦下', async () => {
  const login = await post('/api/auth/login', {name: '阿凉', password: '12345678'});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const out = await post('/api/auth/logout', {}, cookie);
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('伪造 / 过期的会话不认', async () => {
  const fake = await fetch(`${base}/`, {headers: {cookie: 'av_session=abc.def'}, redirect: 'manual'});
  assert.equal(fake.status, 302);
  assert.equal(auth.currentUser({headers: {}}), null);
});

test('连续输错会触发限流', async () => {
  let status = 0;
  for (let index = 0; index < 8; index += 1) {
    status = (await post('/api/auth/login', {name: '阿凉', password: '11111111'})).status;
  }
  assert.equal(status, 429);
});
