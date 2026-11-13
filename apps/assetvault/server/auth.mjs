/* 本机账号：进工作台之前先过一道自己的登录页。
 *
 * 设计取向：
 *   - 只服务「这台机器的主人」：账号文件落在应用数据目录的 accounts/ 下（auth-users.json），
 *     不联网、不同步；它**不在**任何资源库目录里 —— 多个库共用同一套账号（ADR-13），
 *     所以切库之后人和会话都还在；
 *   - 密码只约束长度（6–64 位），不限字符种类：大小写字母、数字、符号都可以，也区分大小写；
 *   - 口令不落明文：scrypt + 每账号独立 salt；会话是 HMAC 签过名的无状态 cookie，
 *     重启服务不会失效（密钥随账号文件持久化）；
 *   - 局域网访客走 lan-sharing.mjs 自己那套共享口令，不在这里二次拦截（req.lanVisitor）。
 *
 * 注意：这里没有「找回密码」。本机应用没有可验证的身份通道，忘了密码只能删掉账号文件重建，
 * 所以登录页把「仅保存在本机」写在明面上。
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHmac, randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';

const COOKIE = 'av_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,20}$/;
// 只卡长度：不再限定 8 位数字，也不做大小写/符号的组成限制。
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;
const MAX_USERS = 20;
const FAIL_MAX = 6;
const FAIL_LOCK_MS = 60 * 1000;
/** 未登录也允许拿到的静态文件：登录页自己 + 图标 + 启动画面（启动画面只加载，不拿数据）。 */
const PUBLIC_FILES = new Set(['/login.html', '/login.css', '/login.js', '/account-chip.js', '/favicon.svg', '/splash.html', '/splash.js', '/mascot.png']);

const b64url = value => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unb64url = value => Buffer.from(String(value).replaceAll('-', '+').replaceAll('_', '/'), 'base64');

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function reply(res, status, data, headers = {}) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers});
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 4096) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > limit) throw fail('请求内容过大');
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw fail('请求内容不是有效的 JSON');
  }
}

const publicUser = user => ({name: user.name, createdAt: user.createdAt || 0, lastLoginAt: user.lastLoginAt || 0});

export function createAuth({file, sessionMs = SESSION_MS} = {}) {
  if (!file) throw Error('createAuth 需要账号文件路径');
  const state = load();
  const tokenFile = path.join(path.dirname(file), 'auth-token');
  // 机器令牌：给 CLI / MCP / 本机脚本留一条不用人类登录的路。它是 32 字节随机串，
  // 跟账号文件同目录（库外共享），同一台机器上的进程才读得到，不进 cookie、不进页面。
  try {
    fs.mkdirSync(path.dirname(tokenFile), {recursive: true});
    fs.writeFileSync(tokenFile, state.token, {mode: 0o600});
  } catch {/* 写不进去最多是 CLI 要走登录，不能因为它挡住服务启动 */}
  /** key = 账号名|IP，避免同一台机器上反复试同一个名字。 */
  const failures = new Map();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const users = (Array.isArray(raw.users) ? raw.users : [])
        .filter(user => user && typeof user.name === 'string' && user.salt && user.hash)
        .map(user => ({id: String(user.id || randomBytes(8).toString('hex')), name: user.name, salt: user.salt, hash: user.hash, createdAt: Number(user.createdAt) || 0, lastLoginAt: Number(user.lastLoginAt) || 0}));
      const secret = typeof raw.secret === 'string' && raw.secret.length >= 32 ? raw.secret : randomBytes(32).toString('hex');
      const token = typeof raw.token === 'string' && raw.token.length >= 32 ? raw.token : randomBytes(32).toString('hex');
      return {version: 1, secret, token, users};
    } catch {
      return {version: 1, secret: randomBytes(32).toString('hex'), token: randomBytes(32).toString('hex'), users: []};
    }
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), {mode: 0o600});
    fs.renameSync(temp, file);
  }

  const digest = (password, salt) => scryptSync(password, salt, 32);
  const sign = payload => {
    const body = b64url(JSON.stringify(payload));
    const mac = b64url(createHmac('sha256', state.secret).update(body).digest());
    return `${body}.${mac}`;
  };

  function verify(token) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', state.secret).update(body).digest();
    const given = unb64url(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let payload = null;
    try {
      payload = JSON.parse(unb64url(body).toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || typeof payload.u !== 'string' || Number(payload.exp) <= Date.now()) return null;
    return state.users.find(user => user.id === payload.u) || null;
  }

  /** 当前登录用户的原记录（要改字段时用这个；给出去用 publicUser 剥一层）。 */
  function currentRecord(req) {
    return verify(readCookie(req, COOKIE));
  }

  function currentUser(req) {
    const user = currentRecord(req);
    return user ? publicUser(user) : null;
  }

  const cookie = (token, maxAge = Math.round(sessionMs / 1000)) => `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

  function issue(user, res) {
    const token = sign({u: user.id, exp: Date.now() + sessionMs});
    res.setHeader('Set-Cookie', cookie(token));
    return token;
  }

  function register({name, password}) {
    name = String(name || '').trim();
    password = String(password || '');
    if (!NAME_RE.test(name)) throw fail('账号名要 2–20 个字，只能用中文、字母、数字、下划线或短横线');
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) throw fail(`密码要 ${PASSWORD_MIN}–${PASSWORD_MAX} 位，字母、数字、符号都可以`);
    if (state.users.some(user => user.name.toLowerCase() === name.toLowerCase())) throw fail('这个账号名已经被占用了', 409);
    if (state.users.length >= MAX_USERS) throw fail('账号数量已达上限，请先删除不用的账号', 429);
    const salt = randomBytes(16).toString('hex');
    const user = {id: randomBytes(8).toString('hex'), name, salt, hash: digest(password, salt).toString('hex'), createdAt: Date.now(), lastLoginAt: Date.now()};
    state.users.push(user);
    persist();
    return user;
  }

  function attemptKey(name, req) {
    return `${name.toLowerCase()}|${req.socket?.remoteAddress || ''}`;
  }

  function throttle(key, now) {
    const record = failures.get(key);
    if (!record) return;
    if (record.until > now) throw fail(`尝试次数太多了，请 ${Math.ceil((record.until - now) / 1000)} 秒后再试`, 429);
    if (record.until && record.until <= now) failures.delete(key);
  }

  function penalize(key, now) {
    const record = failures.get(key) || {count: 0, until: 0};
    record.count += 1;
    if (record.count >= FAIL_MAX) {
      record.count = 0;
      record.until = now + FAIL_LOCK_MS;
    }
    failures.set(key, record);
  }

  function login({name, password}, req) {
    name = String(name || '').trim();
    password = String(password || '');
    if (!name || !password) throw fail('请输入账号名和密码');
    const now = Date.now();
    const key = attemptKey(name, req);
    throttle(key, now);
    const user = state.users.find(item => item.name.toLowerCase() === name.toLowerCase());
    const ok = user ? timingSafeEqual(digest(password, user.salt), Buffer.from(user.hash, 'hex')) : false;
    if (!ok) {
      penalize(key, now);
      throw fail('账号名或密码不对', 401);
    }
    failures.delete(key);
    user.lastLoginAt = now;
    try {
      persist();
    } catch {/* 登录时间只是记录，写不进去不能挡住登录 */}
    return user;
  }

  /**
   * 改密码：必须先验旧密码（同样是失败就计入限流，防止拿登录态暴力试旧密码）。
   * 改完重新签发一次 cookie，当前这台设备不用重新登录。
   */
  function changePassword({current, next}, req, user) {
    current = String(current || '');
    next = String(next || '');
    const now = Date.now();
    const key = attemptKey(user.name, req);
    throttle(key, now);
    if (!timingSafeEqual(digest(current, user.salt), Buffer.from(user.hash, 'hex'))) {
      penalize(key, now);
      throw fail('当前密码不对', 401);
    }
    if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) throw fail(`新密码要 ${PASSWORD_MIN}–${PASSWORD_MAX} 位，字母、数字、符号都可以`);
    if (next === current) throw fail('新密码和当前密码一样，换一个吧');
    user.salt = randomBytes(16).toString('hex');
    user.hash = digest(next, user.salt).toString('hex');
    persist();
    failures.delete(key);
    return user;
  }

  /** /api/auth/* 自己认路；返回 true 表示这条请求已经处理完。 */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/auth/')) return false;
    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      reply(res, 200, {user: currentUser(req), hasUsers: state.users.length > 0, accounts: state.users.length});
      return true;
    }
    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      const input = await readJson(req);
      const user = register(input);
      issue(user, res);
      reply(res, 201, {user: publicUser(user)});
      return true;
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const input = await readJson(req);
      const user = login(input, req);
      issue(user, res);
      reply(res, 200, {user: publicUser(user)});
      return true;
    }
    if (url.pathname === '/api/auth/password' && req.method === 'POST') {
      const user = currentRecord(req);
      if (!user) { reply(res, 401, {error: '请先登录'}); return true; }
      const input = await readJson(req);
      changePassword(input, req, user);
      issue(user, res);
      reply(res, 200, {user: publicUser(user)});
      return true;
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', cookie('', 0));
      reply(res, 200, {ok: true});
      return true;
    }
    reply(res, 405, {error: '不支持的请求方式'});
    return true;
  }

  /**
   * 闸门：没登录就别想看工作台。返回 true 表示已经拦下并回过响应。
   * 局域网访客（req.lanVisitor）已经过共享口令，不在这里重复要账号。
   */
  function machineRequest(req) {
    const given = String(req.headers['x-av-token'] || '').trim() || (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '').trim();
    if (!given) return false;
    const expected = Buffer.from(state.token);
    const actual = Buffer.from(given);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  function gate(req, res, url) {
    if (url.pathname === '/api/health') return false;
    if (PUBLIC_FILES.has(url.pathname)) return false;
    if (req.lanVisitor) return false;
    if (currentUser(req)) return false;
    // 本机工具（CLI / MCP）带机器令牌直连接口；页面脚本不会拿到这个令牌。
    if (machineRequest(req)) return false;
    if (url.pathname.startsWith('/api/')) {
      reply(res, 401, {error: '请先登录'});
      return true;
    }
    const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname)}`;
    res.writeHead(302, {Location: `/login.html${next}`, 'Cache-Control': 'no-store'});
    res.end();
    return true;
  }

  return {handle, gate, currentUser, status: () => ({hasUsers: state.users.length > 0, accounts: state.users.length})};
}
