// AssetVault 反馈收集 Worker（Cloudflare Workers + D1）
//
// 路由：
//   POST /v1/feedback          提交反馈（前端直接调用）
//   GET  /admin?token=xxx      简易后台（用 wrangler secret 配 ADMIN_TOKEN）
//
// 设计取舍：
//   · 不做图形验证码 —— 桌面端弹验证码的流失比垃圾反馈更伤；改用蜜罐 + 双维度限流 + 长度上限。
//   · 不存原始 IP，只存加盐哈希（限流用），避免把用户网络信息落库。
//   · context 只收白名单字段，服务端再过滤一遍，客户端被改也灌不进多余内容。

const TYPES = new Set(['bug', 'feature', 'other']);
const MAX = { title: 120, body: 5000, contact: 120, logs: 20000 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 白名单化诊断摘要：只留这几个键，数组截到 20 条，每条再砍到三个字段。 */
function cleanContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const take = (v, n) => String(v ?? '').slice(0, n);
  const recent = Array.isArray(raw.recent)
    ? raw.recent.slice(-20).map((r) => ({
        status: Number(r?.status) || 0,
        host: take(r?.host, 120),
        path: take(r?.path, 300),
      }))
    : [];
  return {
    appVersion: take(raw.appVersion, 40),
    engine: take(raw.engine, 40),
    os: take(raw.os, 60),
    webview: take(raw.webview, 60),
    platform: take(raw.platform, 40),
    page: take(raw.page, 40),
    lastError: take(raw.lastError, 500),
    recent,
  };
}

async function handleFeedback(req, env) {
  let data;
  try {
    data = await req.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }
  if (!data || typeof data !== 'object') return json({ error: '请求体为空' }, 400);

  // 蜜罐：真实表单里这个字段被 CSS 藏起来，人不会看见也不会填。填了就当机器人，回 200 让它别再试。
  if (String(data.honeypot || '').trim()) return json({ id: 'ok', createdAt: new Date().toISOString() }, 201);

  const type = TYPES.has(data.type) ? data.type : '';
  const title = String(data.title || '').trim();
  const body = String(data.body || '').trim();
  if (!type) return json({ error: '反馈类型不合法' }, 400);
  if (!title) return json({ error: '标题不能为空' }, 400);
  if (!body) return json({ error: '详细描述不能为空' }, 400);
  if (title.length > MAX.title || body.length > MAX.body) return json({ error: '内容超出长度上限' }, 400);

  const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0';
  const ipHash = await sha256(ip + (env.SALT || 'assetvault'));
  const installId = String(data.installId || '').slice(0, 40);

  // 限流一：同一 IP 10 分钟最多 3 条。
  const ipCount = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM feedback WHERE ip_hash = ? AND created_at > datetime('now', '-10 minutes')`,
  ).bind(ipHash).first();
  if ((ipCount?.c || 0) >= 3) return json({ error: '提交太频繁了，请 10 分钟后再试', retryAfter: 600 }, 429);

  // 限流二：同一个安装实例一天最多 20 条（共用出口 IP 的办公网不会被一个人连累）。
  if (installId) {
    const installCount = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM feedback WHERE install_id = ? AND created_at > datetime('now', '-1 day')`,
    ).bind(installId).first();
    if ((installCount?.c || 0) >= 20) return json({ error: '今天的反馈条数已达上限', retryAfter: 3600 }, 429);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const context = cleanContext(data.context);

  await env.DB.prepare(
    `INSERT INTO feedback (id, created_at, type, title, body, contact, install_id, app_version, context_json, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, createdAt, type, title.slice(0, MAX.title), body.slice(0, MAX.body),
    String(data.contact || '').slice(0, MAX.contact),
    installId, String(context?.appVersion || '').slice(0, 40),
    context ? JSON.stringify(context) : '', ipHash,
  ).run();

  // 有配企微/飞书机器人就顺手推一条，失败不影响提交结果。
  if (env.WEBHOOK_URL) {
    const label = { bug: '问题反馈', feature: '功能建议', other: '其他' }[type];
    const text = `【AssetVault · ${label}】${title}\n${body.slice(0, 300)}\n\n版本 ${context?.appVersion || '?'} · ${context?.os || '?'} · ${context?.platform || '—'}`;
    fetch(env.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    }).catch(() => {});
  }

  return json({ id, createdAt }, 201);
}

async function handleAdmin(url, env) {
  const token = url.searchParams.get('token') || '';
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return new Response('forbidden', { status: 403 });
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, type, title, body, contact, app_version, context_json, status
     FROM feedback ORDER BY created_at DESC LIMIT ?`,
  ).bind(limit).all();
  const rows = (results || []).map((r) => {
    let ctx = {};
    try { ctx = JSON.parse(r.context_json || '{}'); } catch {}
    return { ...r, context_json: undefined, context: ctx };
  });
  return new Response(JSON.stringify({ count: rows.length, items: rows }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method === 'POST' && url.pathname === '/v1/feedback') return handleFeedback(req, env);
    if (req.method === 'GET' && url.pathname === '/admin') return handleAdmin(url, env);
    if (req.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'assetvault-feedback' });
    return json({ error: 'not found' }, 404);
  },
};
