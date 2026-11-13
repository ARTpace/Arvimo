/**
 * 协作设置的数据契约层：角色映射、行模型、请求缝。
 *
 * 这里没有一行 DOM 代码 —— 界面层（team-settings.js）只消费这些纯函数，
 * 所以权限门控、脏数据降级、请求体构造都能脱离浏览器单测。
 */

export const ROLES = Object.freeze(['owner', 'editor', 'viewer']);
export const ROLE_LABELS = Object.freeze({owner: '主管', editor: '编辑', viewer: '访客'});
export const roleLabel = role => ROLE_LABELS[role] || '访客';

const pad = value => String(value).padStart(2, '0');

/** 备份时间是毫秒时间戳；老备份没有 meta 时给个可读的兜底。 */
export function formatStamp(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '时间未知';
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 一行备份的可读摘要：时间 + 资产数 + 是否含可用索引。 */
export function backupCaption(item = {}) {
  // 老备份的 meta 里没有 assets：Number(null) 会变成 0，不能把它显示成「0 条资产」。
  const raw = item.assets;
  const count = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  const assets = Number.isFinite(count) ? `${count.toLocaleString('zh-CN')} 条资产` : '资产数未知';
  return `${formatStamp(item.at)} · ${assets} · ${item.hasDatabase ? '含索引' : '仅状态快照'}`;
}

/**
 * 前端只做展示门控：真正的鉴权在服务端，这里的开关只是别让只读用户点了白撞 403。
 * 权限由 GET /members 直接给出，不从角色字符串反推 —— 以后加角色只改服务端一处。
 */
export function permissionsOf(data = {}) {
  const manage = data.canManage === true;
  const write = data.canWrite === true;
  const me = data.me || {};
  return {
    manage,
    write,
    restore: manage,
    identity: `${String(me.name || '本机').trim()} · ${roleLabel(me.role)}`,
  };
}

/** 表单 → 请求体。编辑时带 member_id，新增时省略（服务端会生成）。 */
export function memberDraftToPayload(draft = {}) {
  const payload = {
    name: String(draft.name ?? '').trim(),
    role: ROLES.includes(draft.role) ? draft.role : 'viewer',
    disabled: draft.disabled === true || draft.disabled === 1,
  };
  // 行模型用 member_id，但也兼容传进来的 .id —— 少了这个兜底，编辑成员会被服务端当成新增。
  const id = String(draft.member_id ?? draft.id ?? '').trim();
  if (id) payload.member_id = id;
  return payload;
}

/** 成员列表 → 行模型。脏数据统一降级成 viewer，不信任服务端之外的任何输入。 */
export function memberRows(data = {}) {
  const meId = String(data.me?.member_id ?? '');
  return (Array.isArray(data.members) ? data.members : []).map(row => ({
    // 与服务端契约同名：saveMember 直接 {...row} 提交，不需要再翻译一次字段名。
    member_id: String(row.member_id ?? ''),
    name: String(row.name ?? ''),
    role: ROLES.includes(row.role) ? row.role : 'viewer',
    disabled: row.disabled === true || Number(row.disabled) === 1,
    isMe: String(row.member_id ?? '') === meId,
  }));
}

/** 备份列表 → 行模型。编号必须是时间戳格式，恢复接口按同样规则校验。 */
export const BACKUP_NAME = /^\d{8}-\d{6}(?:-\d{3})?$/;
export function backupRows(data = {}) {
  return (Array.isArray(data.backups) ? data.backups : [])
    .filter(item => item && BACKUP_NAME.test(String(item.name ?? '')))
    .map(item => ({name: String(item.name), caption: backupCaption(item)}));
}

/** 审批 ID 只用于主机选中会话，不是登录凭据，也不按展示名推断身份。 */
export function sessionRows(data = {}, now = Date.now()) {
  return (Array.isArray(data.sessions) ? data.sessions : [])
    .filter(row => row && /^[a-f0-9]{32}$/.test(String(row.id || '')) && Number(row.expires) > now)
    .map(row => ({id: String(row.id), username: String(row.username || '未命名访客'),
      member_id: String(row.member_id || ''), expires: Number(row.expires)}));
}

const LOCAL = {'X-SFX-Local': '1'};

/** 统一的请求缝：错误统一从 {error} 取，测试可直接注入 fetchFn。 */
export async function teamRequest(url, {method = 'GET', body, search = '', fetchFn} = {}) {
  const doFetch = fetchFn || globalThis.fetch;
  const response = await doFetch(url + search, {
    method, cache: 'no-store',
    headers: {...LOCAL, ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = Error(data.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}
