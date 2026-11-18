// LAN 的展示名与共享口令都不证明成员身份。只有主机批准的当前会话绑定
// lanMemberId 可以授予成员角色；每次解析重新检查成员是否存在、启用。
// 旧成员表保留，旧客户端默认只读；主机需通过 /api/lan/sessions 重新批准。
// x-sfx-member 仅供主机本地切换/收窄身份，不参与 LAN 提权。
import {randomBytes} from 'node:crypto';

/** 三种角色。顺序即权限从高到低。 */
export const ROLES = Object.freeze(['owner', 'editor', 'viewer']);

/** 权限矩阵：read 读资产、write 改资产与合集、manage 管成员。 */
export const PERMISSIONS = Object.freeze({
  owner: Object.freeze({read: true, write: true, manage: true}),
  editor: Object.freeze({read: true, write: true, manage: false}),
  viewer: Object.freeze({read: true, write: false, manage: false}),
});

/** 权限判定。未知角色一律按最低权限处理。 */
export function can(role, action) {
  return PERMISSIONS[role]?.[action] === true;
}

/** 请求本身该被拒绝（400 / 403），与服务器故障（500）区分开。 */
export class MemberRejected extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'MemberRejected'; this.detail = detail; }
}

/** 成员名与局域网登录页同一套白名单：名字会回显到表单属性，必须是安全的。 */
const NAME_RE = /^[\p{L}\p{N}_.\- ]{1,24}$/u;
const MEMBER_ID_RE = /^m-[a-f0-9]{8}$/;

const newMemberId = () => `m-${randomBytes(4).toString('hex')}`;

/** 校验并规范化成员输入。抛 MemberRejected 即 400。 */
export function normalizeMember(input = {}) {
  const name = String(input.name ?? '').trim();
  if (!NAME_RE.test(name)) {
    throw new MemberRejected('成员名字须为 1–24 个字符，可用中英文、数字、空格、下划线、点或连字符');
  }
  const role = String(input.role ?? 'viewer');
  if (!ROLES.includes(role)) throw new MemberRejected('角色无效');
  const memberId = String(input.member_id ?? '').trim() || newMemberId();
  if (!MEMBER_ID_RE.test(memberId)) throw new MemberRejected('成员编号无效');
  const disabled = input.disabled === true || input.disabled === 1 || input.disabled === '1';
  return {member_id: memberId, name, role, disabled: disabled ? 1 : 0};
}

/** 成员列表：按角色从高到低、同角色按名字排，方便面板直接显示。 */
export function listMembers(conn) {
  return conn.all(`SELECT member_id, name, role, disabled, created_at, last_seen_at FROM members
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, name`);
}

const ownerCount = conn => Number(
  conn.all("SELECT count(*) AS n FROM members WHERE role = 'owner' AND disabled = 0")[0]?.n ?? 0) || 0;

/**
 * 新增或更新成员。
 * 约束：不能把最后一名启用中的 owner 降级或停用 —— 否则就没人能再管成员了。
 */
export function saveMember(conn, input, {now = Date.now} = {}) {
  const member = normalizeMember(input);
  const existing = conn.all('SELECT member_id, role, disabled FROM members WHERE member_id = ?', [member.member_id])[0];
  if (existing && existing.role === 'owner' && (member.role !== 'owner' || member.disabled) && ownerCount(conn) <= 1) {
    throw new MemberRejected('至少要保留一名启用状态的主管');
  }
  conn.run(`INSERT INTO members (member_id, name, role, disabled, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(member_id) DO UPDATE SET name = excluded.name, role = excluded.role, disabled = excluded.disabled`,
    [member.member_id, member.name, member.role, member.disabled, now()]);
  return member;
}

/** 删除成员。同样不能删掉最后一名 owner。 */
export function removeMember(conn, memberId) {
  const id = String(memberId ?? '').trim();
  if (!MEMBER_ID_RE.test(id)) throw new MemberRejected('成员编号无效');
  const row = conn.all('SELECT role FROM members WHERE member_id = ?', [id])[0];
  if (!row) return false;
  if (row.role === 'owner' && ownerCount(conn) <= 1) throw new MemberRejected('至少要保留一名主管');
  conn.run('DELETE FROM members WHERE member_id = ?', [id]);
  return true;
}

/**
 * 成员目录：带短 TTL 的内存缓存。
 *
 * 为什么不每次都查库：身份解析在写路径上每次请求都要做一次，
 * 而成员只有十几行 —— 缓存命中时是纯内存操作。
 * 普通列表缓存 2 秒；授权解析强制 fresh，角色与禁用变化下一请求立即生效。
 */
export function createMemberDirectory({storage, onWarn = () => {}} = {}) {
  let cache = null;
  const TTL_MS = 2000;

  async function list({fresh = false} = {}) {
    if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.map;
    let rows = null;
    try { rows = await storage.withDb(conn => listMembers(conn)); }
    catch (error) { onWarn(`成员列表读取失败：${error.message}`); }
    const map = new Map((rows || []).map(row => [row.member_id, {...row, disabled: Number(row.disabled) === 1}]));
    cache = {at: Date.now(), map};
    return map;
  }

  /** 写操作后立刻失效：本机不该等 TTL。 */
  function invalidate() { cache = null; }

  /**
   * 解析请求身份 → {member_id, name, role, source, unknown}。
   * role 一定是 ROLES 里的一个值，调用方直接拿它判权限即可。
   */
  async function resolve(req) {
    const members = await list({fresh: true});
    const header = String(req?.headers?.['x-sfx-member'] ?? '').trim();
    if (req?.lanVisitor) {
      const name = String(req.lanUser ?? '').trim();
      const member = members.get(String(req.lanMemberId ?? ''));
      if (member && !member.disabled) return {...member, source: 'lan'};
      return {member_id: '', name, role: 'viewer', disabled: 0, source: 'lan', unknown: true};
    }
    if (header) {
      const member = members.get(header);
      if (member && !member.disabled) return {...member, source: 'header'};
      return {member_id: header, name: '', role: 'viewer', disabled: 0, source: 'header', unknown: true};
    }
    // 主机本地：默认就是主人。要以别的成员身份操作，显式带上成员号即可。
    return {member_id: 'local', name: '主机', role: 'owner', disabled: 0, source: 'local'};
  }

  return {list, resolve, invalidate};
}

// 默认关闭新写入口：只有明确的 POST 查询例外可以只读访问。
const READ_POST_ROUTES = new Set([
  '/api/library/query', '/api/library/assets', '/api/library/assets/detail',
  '/api/library/collections/previews', '/api/library/smart-collections/resolve',
  '/api/scan', '/api/search', '/api/artstation/search', '/api/artstation/resolve',
  '/api/polyhaven/search', '/api/simready/search', '/api/polypizza/search',
  '/api/kenney/search', '/api/freestylized/search', '/api/polyfork/search',
  '/api/ambientcg/search', '/api/uiverse/search', '/api/pinterest/related',
]);
const HOST_ROUTES = new Set([
  '/api/platforms', '/api/platforms/test', '/api/library/delete',
  '/api/library/import-roots', '/api/library/import-preflight', '/api/library/import-file', '/api/library/drop-import', '/api/library/drop-import/flush', '/api/library/relink-file', '/api/library/pick-folder', '/api/library/browse-folder',
  '/api/library/sync', '/api/library/backups/restore', '/api/library/import/eagle',
  '/api/library/import/eagle/probe', '/api/ai/key', '/api/ai/settings', '/api/ai/test', '/api/ai/models', '/api/ai/probe', '/api/ai/probe-models',
  '/api/downloads/settings', '/api/downloads/pick-folder', '/api/downloads/browse-folders',
  '/api/downloads/reveal',
]);
export function requestPermission(method, pathname) {
  const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  // 平台列表本身是公开的；设置与宿主能力即便是 GET 也不属于 LAN 成员。
  const host = (HOST_ROUTES.has(pathname) && !(pathname === '/api/platforms' && safe))
    || /^\/api\/(auth|lan|setup|browser|exports|substance|drag)(\/|$)/.test(pathname)
    || /^\/api\/library\/stores(\/|$)/.test(pathname)
    || /^\/api\/downloads\/blender-bridge(\/|$)/.test(pathname)
    || /^\/api\/downloads\/tasks\/[^/]+\/(reveal|send-blender)$/.test(pathname);
  if (host) return 'host';
  if (!pathname.startsWith('/api/') || safe) return 'read';
  if (method === 'POST' && READ_POST_ROUTES.has(pathname)) return 'read';
  if (pathname === '/api/library/members') return 'manage';
  return 'write';
}
