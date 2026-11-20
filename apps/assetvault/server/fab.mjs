// Fab integration — Epic 旗下 3D 资产商城（www.fab.com）。
//
// Fab 没有公开 API。这里的两条链路都是社区工具逆向出来的、Epic 官方客户端自己在用的私有端点：
//   • 下载已拥有资产：走 Epic Games Launcher 的端点，OAuth Bearer 认证（移植自 Fobal/fab-downloader，GPL-3.0）
//       OAuth:  POST {OAUTH_HOST}/account/api/oauth/token        (authorization_code / refresh_token)
//       库:     GET  {FAB_HOST}/e/accounts/{accountId}/ue/library (Bearer)
//       构建:   POST {FAB_HOST}/e/artifacts/{artifactId}/manifest (Bearer, JSON)
//       下载:   manifest → chunk（Epic CDN）→ 拼装 → SHA-1 校验
//   • 搜索：走网页端 GET {FAB_HOST}/i/listings/search（cookie 认证），出自 FAB-Free-Asset-Getter 的接口注释
//
// 这套端点 Epic 随时可能改，且不官方支持。runner 的契约与 runAmbientcgJob / runKenneyJob 一致：
// 把散文件写进 output、写 info.json，返回值 { zipName, title, author, thumbnail }，后续交给
// DownloadManager 打包 / 校验 / 提交，下载 UI 与队列完全复用。
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openPublic } from './public-http.mjs';
import { resolveDataDir } from './data-dir.mjs';
import { cookieHeaderFor } from './cookie-jar.mjs';
import { packFolder } from './folder-archive.mjs';
import { listArchiveEntries, extractArchiveEntry } from './archive.mjs';

const FAB_HOST = 'https://www.fab.com';
const OAUTH_HOST = 'https://account-public-service-prod03.ol.epicgames.com';
// Epic Games Launcher 的公开 OAuth 客户端——标识的是「启动器」，不是某个账号（fab-downloader 同源）。
const CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';
const LAUNCHER_UA = 'UELauncher/17.0.1-37584233+++Portal+Release-Live Windows/10.0.19043.1.0.64bit';

const MANIFEST_MAGIC = 0x44bec00c;
const CHUNK_MAGIC = 0xb1fe3aa2;

const SERVER_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(SERVER_DIR, '..');

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** library uid 固定 32 位十六进制（沿用 Sketchfab / ambientCG 约定），对 assetId 取 md5。 */
export function fabUid(id) {
  return createHash('md5').update(`fab:${String(id || '')}`).digest('hex');
}

/** 32 位十六进制 uid 的字符串键（Map / 分片缓存文件名都用它）。 */
function guidHex(guid) {
  return guid.map(part => (part >>> 0).toString(16).toUpperCase().padStart(8, '0')).join('');
}
function guidKey(guid) {
  return guid.map(part => part >>> 0).join(':');
}
function guidBytes(guid) {
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) buf.writeUInt32LE(guid[i] >>> 0, i * 4);
  return buf;
}
function u64Bytes(hash) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(hash));
  return buf;
}
const b64url = buf => buf.toString('base64url'); // 无 padding，等价 Python urlsafe_b64encode().rstrip('=')

/** 从 openPublic 的响应流里读满一个 Buffer（带硬上限，防止异常超大响应）。 */
async function readAll(r, limit = 256 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of r.stream) {
      bytes += chunk.length;
      if (bytes > limit) throw Error('响应体过大，已停止读取');
      chunks.push(chunk);
    }
  } catch (e) {
    try { r.stream.destroy(); } catch {}
    throw e;
  }
  return Buffer.concat(chunks);
}

/** 固定并发度地跑一张异步任务表，保持原顺序。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── 认证（OAuth，Epic Launcher 客户端）─────────────────────────────────────────

/** 用浏览器登录页拿到的 authorizationCode 换成会话。 */
export async function fabExchangeCode(code, { open = openPublic } = {}) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(code).trim(), token_type: 'eg1' });
  return tokenRequest(form, { open });
}
/** 用 refresh_token 续期。 */
export async function fabRefresh(refreshToken, { open = openPublic } = {}) {
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(refreshToken).trim(), token_type: 'eg1' });
  return tokenRequest(form, { open });
}

/**
 * 接受 Epic Games Launcher 的终端用户许可协议（OAuth 的 corrective action）。
 *
 * 只有「用户在本机界面上明确点了同意」才能调用这里 —— 这是代用户提交一份法律协议。
 * 拿到 204 就说明账号已接受，重放授权地址即可拿到授权码。continuation 有有效期，
 * 过期会报错，重开一次登录窗口就能拿到新的。
 */
export async function fabAcceptEula(continuation, { open = openPublic } = {}) {
  const token = String(continuation || '').trim();
  if (!token) throw Error('缺少 Epic 的 continuation');
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const tokenRes = await open(`${OAUTH_HOST}/account/api/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    timeout: 30000,
    useCookies: false,
  });
  const tokenText = (await readAll(tokenRes)).toString('utf8');
  let client = null;
  try { client = JSON.parse(tokenText); } catch { /* 下面统一报错 */ }
  if (!client?.access_token) throw Error(`Epic 客户端凭据无效（HTTP ${tokenRes.status}）：${tokenText.slice(0, 120)}`);
  const res = await open(`${OAUTH_HOST}/account/api/public/corrections/acceptEula`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${client.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ continuation: token }),
    timeout: 30000,
    useCookies: false,
  });
  if (res.status < 200 || res.status >= 300) {
    const detail = (await readAll(res)).toString('utf8');
    throw Error(`Epic 拒绝接受协议（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 140) : ''}`);
  }
  return true;
}
async function tokenRequest(form, { open }) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await open(`${OAUTH_HOST}/account/api/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': LAUNCHER_UA,
      Accept: 'application/json',
    },
    body: form.toString(),
    timeout: 45000,
    useCookies: false,
  });
  const text = (await readAll(r)).toString('utf8');
  if (r.status < 200 || r.status >= 300) throw Error(`Epic 登录失败 HTTP ${r.status}：${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw Error('Epic 返回的不是有效 JSON'); }
  if (data?.errorCode) throw Error(`Epic 拒绝登录：${data.errorMessage || data.errorCode}`);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accountId: data.account_id,
    displayName: data.display_name || '',
    expiresAt: data.expires_at,
  };
}

function sessionFile(root) {
  return path.join(resolveDataDir(root).dir, 'fab', 'session.json');
}
export async function fabSaveSession(root, session) {
  const file = sessionFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  return session;
}
export async function fabLoadSession(root) {
  try { return JSON.parse(await fs.readFile(sessionFile(root), 'utf8')); } catch { return null; }
}

// ── 库列表 & 构建请求 ────────────────────────────────────────────────────────

function parseLibraryItem(raw) {
  const versions = (raw?.projectVersions || []).map(p => ({
    artifactId: p.artifactId,
    engineVersions: Array.isArray(p.engineVersions) ? p.engineVersions : [],
  }));
  return {
    assetId: raw.assetId,
    namespace: raw.assetNamespace,
    title: raw.title || raw.assetId,
    distributionMethod: raw.distributionMethod || '',
    projectVersions: versions,
  };
}

/** 列出账号已拥有的全部 Fab 资产（分页拉全）。 */
export async function fabLibrary(session, { open = openPublic, signal } = {}) {
  const items = [];
  let cursor = null;
  while (true) {
    signal?.throwIfAborted();
    const query = new URLSearchParams({ count: '100' });
    if (cursor) query.set('cursor', cursor);
    const r = await open(`${FAB_HOST}/e/accounts/${encodeURIComponent(session.accountId)}/ue/library?${query}`, {
      signal, timeout: 60000,
      headers: { Authorization: `Bearer ${session.accessToken}`, 'User-Agent': LAUNCHER_UA, Accept: 'application/json' },
      useCookies: false,
    });
    if (r.status === 401) { try { r.stream.destroy(); } catch {} throw Error('Epic 登录已过期：在平台设置里点 Fab 的登录图标重新登录一次'); }
    if (r.status < 200 || r.status >= 300) { try { r.stream.destroy(); } catch {} throw Error(`Fab 库列表返回 HTTP ${r.status}`); }
    const page = JSON.parse((await readAll(r)).toString('utf8'));
    for (const raw of page?.results || []) items.push(parseLibraryItem(raw));
    cursor = (page?.cursors || {}).next;
    if (!cursor) break;
  }
  return items;
}

/** 向 Fab 请求某个 artifact 的当前构建，返回 manifest 地址与各 CDN base url。 */
export async function fabRequestBuild(session, { artifactId, itemId, namespace, platform = 'Windows' }, { open = openPublic, signal } = {}) {
  const body = JSON.stringify({ item_id: itemId, namespace, platform });
  const r = await open(`${FAB_HOST}/e/artifacts/${encodeURIComponent(artifactId)}/manifest`, {
    method: 'POST', signal, timeout: 60000,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': LAUNCHER_UA,
      Accept: 'application/json',
    },
    body,
    useCookies: false,
  });
  const text = (await readAll(r)).toString('utf8');
  if (r.status === 403) throw Error('Fab 暂时限流（HTTP 403），请等一分钟再试');
  if (r.status < 200 || r.status >= 300) throw Error(`Fab 构建请求返回 HTTP ${r.status}：${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  const infos = Array.isArray(data?.downloadInfo) ? data.downloadInfo : [];
  const info = infos.find(i => i.artifactId === artifactId) || infos[0];
  if (!info) throw Error('Fab 没有返回构建下载信息');
  return { buildVersion: info.buildVersion || '', sources: pairSources(info) };
}
function pairSources(info) {
  const manifestUrls = (info.distributionPoints || []).map(p => p.manifestUrl || '');
  const sources = [];
  for (const base of info.distributionPointBaseUrls || []) {
    const manifestUrl = manifestUrls.find(url => url.startsWith(base));
    if (manifestUrl) sources.push({ manifestUrl, baseUrl: base.replace(/\/+$/, '') });
  }
  if (!sources.length) throw Error('Fab 没有返回可用的下载地址');
  return sources;
}

// ── Manifest 解析（二进制 + JSON，Epic UGC 格式）────────────────────────────────

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  read(n) {
    if (n < 0 || this.pos + n > this.buf.length) throw Error('manifest 数据意外结束');
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }
  u8() { const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
  i32() { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  u64() { const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  guid() { return [this.u32(), this.u32(), this.u32(), this.u32()]; }
  fstring() {
    // 正长度=ASCII（含终止符），负长度=UTF-16 字符数（含终止符），0=空串。
    const length = this.i32();
    if (length > 0) return this.read(length).subarray(0, length - 1).toString('ascii');
    if (length < 0) { const n = -length; return this.read(n * 2).subarray(0, n * 2 - 2).toString('utf16le'); }
    return '';
  }
  endSection(start, size) {
    if (this.pos > start + size) throw Error('manifest 段长度越界');
    this.pos = start + size;
  }
}

/** 解析 Epic 构建清单：magic 命中走二进制，否则按 JSON（较老格式）解析。 */
export function parseManifest(data) {
  if (data.length >= 4 && data.readUInt32LE(0) === MANIFEST_MAGIC) return parseBinaryManifest(data);
  return parseJsonManifest(data);
}
function parseBinaryManifest(data) {
  const header = new Reader(data);
  header.u32();                    // magic
  const headerSize = header.u32();
  header.u32();                    // uncompressed size
  header.u32();                    // compressed size
  const sha1 = header.read(20);
  const storedAs = header.u8();
  if (storedAs & 2) throw Error('不支持加密的 manifest');
  if (headerSize > data.length) throw Error('manifest 头比文件还大');
  let body = data.subarray(headerSize);
  if (storedAs & 1) {
    body = zlib.inflateSync(body);
    if (!createHash('sha1').update(body).digest().equals(sha1)) throw Error('manifest SHA-1 校验失败');
  }
  const reader = new Reader(body);
  const { featureLevel, buildVersion } = readMeta(reader);
  const chunks = readChunks(reader, featureLevel);
  const files = readFiles(reader);
  return { featureLevel, buildVersion, chunks, files };
}
function readMeta(reader) {
  const start = reader.pos;
  const size = reader.u32();
  const dataVersion = reader.u8();
  const featureLevel = reader.u32();
  reader.u8();                     // is_file_data
  reader.u32();                    // app_id
  reader.fstring();                // app_name
  const buildVersion = reader.fstring();
  reader.fstring();                // launch_exe
  reader.fstring();                // launch_command
  for (let i = 0, n = reader.u32(); i < n; i++) reader.fstring(); // prerequisite ids
  reader.fstring();                // prereq_name
  reader.fstring();                // prereq_path
  reader.fstring();                // prereq_args
  if (dataVersion >= 1) reader.fstring();                 // build_id
  if (dataVersion >= 2) { reader.fstring(); reader.fstring(); } // uninstall action
  reader.endSection(start, size);
  return { featureLevel, buildVersion };
}
function readChunks(reader, featureLevel) {
  const start = reader.pos;
  const size = reader.u32();
  reader.u8();                     // version
  const count = reader.u32();
  const guids = Array.from({ length: count }, () => reader.guid());
  const hashes = Array.from({ length: count }, () => reader.u64());
  reader.read(20 * count);         // SHA-1 of each chunk
  const groups = Array.from({ length: count }, () => reader.u8());
  reader.read(4 * count);          // window sizes
  reader.read(8 * count);          // compressed file sizes
  let secrets = new Array(count).fill(null);
  if (featureLevel >= 22) {
    secrets = Array.from({ length: count }, () => reader.guid());
    reader.read(4 * count);        // compressed window sizes
    reader.read(16 * count);       // encryption tags
  }
  reader.endSection(start, size);
  const chunks = new Map();
  for (let i = 0; i < count; i++) {
    chunks.set(guidKey(guids[i]), { guid: guids[i], hash: hashes[i], group: groups[i], secret: secrets[i] });
  }
  return chunks;
}
function readFiles(reader) {
  const start = reader.pos;
  const size = reader.u32();
  reader.u8();                     // version
  const count = reader.u32();
  const names = Array.from({ length: count }, () => reader.fstring());
  for (let i = 0; i < count; i++) reader.fstring(); // symlink target
  const hashes = Array.from({ length: count }, () => Buffer.from(reader.read(20)));
  reader.read(count);              // flags
  for (let i = 0; i < count; i++) { for (let k = 0, n = reader.u32(); k < n; k++) reader.fstring(); } // install tags
  const parts = Array.from({ length: count }, () => readFileParts(reader));
  reader.endSection(start, size);
  return names.map((filename, i) => ({ filename, sha1: hashes[i], parts: parts[i] }));
}
function readFileParts(reader) {
  const count = reader.u32();
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = reader.pos;
    const size = reader.u32();
    const guid = reader.guid();
    const offset = reader.u32();
    const length = reader.u32();
    reader.endSection(start, size);
    out.push({ guid, offset, size: length });
  }
  return out;
}
function parseJsonManifest(data) {
  const doc = JSON.parse(data.toString('utf8').replace(/^\uFEFF/, ''));
  const featureLevel = blobToInt(doc.ManifestFileVersion || '013000000000');
  const hashList = doc.ChunkHashList || {};
  const groupList = doc.DataGroupList || {};
  const chunks = new Map();
  for (const key of Object.keys(doc.ChunkFilesizeList || {})) {
    const guid = guidFromJson(key);
    chunks.set(guidKey(guid), { guid, hash: BigInt(blobToInt(hashList[key] || '0')), group: blobToInt(groupList[key] || '0'), secret: null });
  }
  const files = (doc.FileManifestList || []).map(entry => ({
    filename: entry.Filename || '',
    sha1: Buffer.from(blobToInt(entry.FileHash).toString(16).padStart(40, '0'), 'hex'),
    parts: (entry.FileChunkParts || []).map(part => ({
      guid: guidFromJson(part.Guid),
      offset: blobToInt(part.Offset),
      size: blobToInt(part.Size),
    })),
  }));
  return { featureLevel, buildVersion: doc.BuildVersionString || '', chunks, files };
}
function blobToInt(blob) {
  let value = 0;
  for (let shift = 0, i = 0; i < blob.length; i += 3, shift++) value += Number(blob.slice(i, i + 3)) * 2 ** (8 * shift);
  return value;
}
function guidFromJson(text) {
  const buf = Buffer.from(text, 'hex');
  return [buf.readUInt32BE(0), buf.readUInt32BE(4), buf.readUInt32BE(8), buf.readUInt32BE(12)];
}

// ── Chunk 解析 & 路径 ────────────────────────────────────────────────────────

/** 解码一个 chunk 文件，返回 { guid, payload }（payload 已解压）。 */
export function decodeChunk(data) {
  const reader = new Reader(data);
  if (reader.u32() !== CHUNK_MAGIC) throw Error('chunk magic 错误');
  reader.u32();                    // header version
  const headerSize = reader.u32();
  reader.u32();                    // compressed size
  const guid = reader.guid();
  reader.read(8);                  // rolling hash
  const storedAs = reader.u8();
  if (storedAs & 2) throw Error('不支持加密的 chunk');
  if (headerSize > data.length) throw Error('chunk 头比文件还大');
  let payload = data.subarray(headerSize);
  if (storedAs & 1) payload = zlib.inflateSync(payload);
  return { guid, payload };
}

/** chunk 相对 CDN base url 的路径（feature_level 决定目录与命名）。 */
export function chunkPath(chunk, featureLevel) {
  const folder = featureLevel >= 22 ? 'ChunksV5' : featureLevel >= 15 ? 'ChunksV4' : featureLevel >= 6 ? 'ChunksV3' : featureLevel >= 3 ? 'ChunksV2' : 'Chunks';
  const group = String(chunk.group).padStart(2, '0');
  if (featureLevel >= 22) {
    const secret = !chunk.secret || chunk.secret.every(x => x === 0) ? 'plain' : b64url(guidBytes(chunk.secret));
    const hashPart = b64url(u64Bytes(chunk.hash));
    const guidPart = b64url(guidBytes(chunk.guid));
    return `${folder}/${secret}/${group}/${hashPart}_${guidPart}.chunk`;
  }
  const hashHex = BigInt(chunk.hash).toString(16).toUpperCase().padStart(16, '0');
  return `${folder}/${group}/${hashHex}_${guidHex(chunk.guid)}.chunk`;
}

// ── 下载 runner（对齐 runAmbientcgJob / runKenneyJob 契约）─────────────────────

function safeRelPath(filename) {
  const parts = String(filename).replace(/\\/g, '/').split('/');
  if (!filename || filename.includes(':') || filename.startsWith('/') || parts.some(x => x === '' || x === '..')) {
    throw Error(`manifest 里的文件路径不安全：${filename}`);
  }
  return parts;
}
function engineSort(pv) {
  const m = String(pv.engineVersions[0] || '').match(/(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 1000 + Number(m[2]) : 0;
}
function pickVersion(item, want) {
  const normalize = v => { const m = String(v || '').match(/(\d+)\.(\d+)/); return m ? `UE_${Number(m[1])}.${Number(m[2])}` : null; };
  if (want) {
    const w = normalize(want);
    const hit = item.projectVersions.find(p => p.engineVersions.includes(w));
    if (hit) return hit;
  }
  return item.projectVersions.slice().sort((a, b) => engineSort(b) - engineSort(a))[0] || null;
}

/**
 * 把一份已拥有的 Fab 资产下载并拼装进 `output`：
 * 请求构建 → 下载 manifest → 下 chunk → 按目录拼文件 → SHA-1 校验 → 写 info.json。
 * `options` 需带 fabSession（{accessToken, accountId}），或带 accessToken / accountId。
 */
export async function runFabJob({ uid, options = {}, output, deliver, workRoot, assetId }, { signal, progress = () => {} } = {}) {
  signal?.throwIfAborted();
  let session = options.fabSession || (await fabLoadSession(ROOT)) || { accessToken: options.accessToken, accountId: options.accountId };
  if (!session.accessToken || !session.accountId) {
    throw Error('Fab 还没登录 Epic：在「平台设置 → Fab」点登录图标，弹出窗口里登进 Epic 账号（窗口自动关掉才算成功），回来再点下载');
  }
  // Epic 的 access_token 只活两小时，放着不动就会在下载时报 401；到期前先用 refresh_token 续一次，
  // 免得好好的登录态被当成「没登录」。
  const expiresAt = new Date(session.expiresAt || 0).getTime();
  if (session.refreshToken && Number.isFinite(expiresAt) && expiresAt - Date.now() < 5 * 60 * 1000) {
    try {
      session = await fabSaveSession(ROOT, await fabRefresh(session.refreshToken, { open: options.open || openPublic }));
    } catch { /* 续不上就按原 token 试，真过期了下面会报 401 */ }
  }
  const id = String(assetId || '').trim();
  if (!id) throw Error('Fab 资产 ID 缺失');
  const open = options.open || openPublic;

  progress({ stage: 'starting', message: '正在读取 Fab 版本库…' });
  const items = await fabLibrary(session, { open, signal });
  const item = items.find(i => i.assetId === id);
  // ue/library 只列「带引擎构建」的资产；贴图集 / glTF / 附加文件这类只存在于网页库。
  // 引擎库里查不到不等于没拥有 —— 换网页库那条路继续下（同一份所有权，另一个端点）。
  if (!item) return runFabWebJob({ uid, id, session, options, output, deliver, workRoot, open, signal, progress });
  const version = pickVersion(item, options.engineVersion);
  if (!version) throw Error('这个资产没有可用的引擎版本');

  progress({ stage: 'starting', message: `正在请求构建信息（${version.engineVersions.join(' / ') || version.artifactId}）…` });
  const build = await fabRequestBuild(session, {
    artifactId: version.artifactId, itemId: item.assetId, namespace: item.namespace, platform: options.platform || 'Windows',
  }, { open, signal });

  progress({ stage: 'starting', message: '正在下载构建清单…' });
  let manifest = null;
  let baseUrls = [];
  for (const source of build.sources) {
    try {
      const r = await open(source.manifestUrl, { signal, timeout: 120000, headers: { 'User-Agent': LAUNCHER_UA }, useCookies: false });
      if (r.status < 200 || r.status >= 300) { try { r.stream.destroy(); } catch {} continue; }
      manifest = parseManifest(await readAll(r));
      baseUrls = build.sources.map(s => s.baseUrl);
      break;
    } catch { /* 换下一个 CDN */ }
  }
  if (!manifest) throw Error('无法下载或解析构建清单');

  // workRoot 是 DownloadManager 给的后台工作目录（data/workers/<job>-<attempt>），
  // 它本身不保证已存在；mkdtemp 不会自己建父目录，缺了会直接 ENOENT。
  const workParent = workRoot || path.dirname(output);
  await fs.mkdir(workParent, { recursive: true });
  const chunkDir = await fs.mkdtemp(path.join(workParent, `fab-chunks-${String(uid).slice(0, 8)}-`));
  // 契约是「runner 把散文件写进 output 目录」；output 只在 folder 模式才是目录，
  // zip 模式下它是个 .zip.part 文件，所以先摊到临时目录最后再打包。
  const outDir = deliver === 'zip' ? path.join(chunkDir, 'out') : output;
  try {
    await downloadChunks(manifest, baseUrls, chunkDir, { open, signal, progress });
    await fs.mkdir(outDir, { recursive: true });
    await assembleFiles(manifest, chunkDir, outDir, { signal, progress });
    const meta = {
      uid, kind: 'fab', platform: 'fab', assetId: id,
      url: `https://www.fab.com/listings/${id}`,
      engineVersions: version.engineVersions,
      license: '见 Fab 资产页',
      note: 'Fab 引擎资产（已拥有）。下载走 Epic Launcher 私有端点，请遵守 Epic 条款与资产许可。',
      exportedAt: new Date().toISOString(), tool: 'Arvimo · Fab',
    };
    await fs.writeFile(path.join(outDir, 'info.json'), JSON.stringify(meta, null, 2), 'utf8');
    if (deliver === 'zip') {
      await fs.mkdir(path.dirname(output), { recursive: true });
      await packFolder(outDir, output, { signal });
    }
  } finally {
    await fs.rm(chunkDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
  return { zipName: `${id}-fab`, title: item.title, author: 'Fab', thumbnail: null };
}

async function downloadChunks(manifest, baseUrls, chunkDir, { open, signal, progress }) {
  const chunks = [...manifest.chunks.values()];
  const total = chunks.length;
  const chunkFile = chunk => path.join(chunkDir, `${guidHex(chunk.guid)}.bin`);
  const todo = [];
  let done = 0;
  for (const chunk of chunks) {
    try { await fs.access(chunkFile(chunk)); done++; } catch { todo.push(chunk); }
  }
  if (done) progress({ stage: 'transferring', message: `复用已下载分片 ${done}/${total}`, bytesWritten: done, totalBytes: total });
  let lastReport = 0;
  await mapLimit(todo, 6, async chunk => {
    signal?.throwIfAborted();
    const rel = chunkPath(chunk, manifest.featureLevel);
    let payload = null;
    for (const base of baseUrls) {
      try {
        const r = await open(`${base}/${rel}`, { signal, timeout: 120000, headers: { 'User-Agent': LAUNCHER_UA }, useCookies: false });
        if (r.status < 200 || r.status >= 300) { try { r.stream.destroy(); } catch {} continue; }
        const decoded = decodeChunk(await readAll(r));
        if (guidKey(decoded.guid) !== guidKey(chunk.guid)) continue;
        payload = decoded.payload;
        break;
      } catch { /* 换下一个 CDN */ }
    }
    if (!payload) throw Error(`分片下载失败：${rel}`);
    const file = chunkFile(chunk);
    await fs.writeFile(`${file}.tmp`, payload);
    await fs.rename(`${file}.tmp`, file);
    done++;
    const now = Date.now();
    if (now - lastReport > 300 || done === total) {
      lastReport = now;
      progress({ stage: 'transferring', message: `下载构建分片 ${done}/${total}`, bytesWritten: done, totalBytes: total });
    }
  });
}

async function assembleFiles(manifest, chunkDir, output, { signal, progress }) {
  const files = manifest.files;
  for (let done = 0; done < files.length; done++) {
    signal?.throwIfAborted();
    const file = files[done];
    const rel = safeRelPath(file.filename);
    const target = path.join(output, ...rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const hash = createHash('sha1');
    const handle = await fs.open(target, 'w');
    try {
      for (const part of file.parts) {
        const chunk = await fs.readFile(path.join(chunkDir, `${guidHex(part.guid)}.bin`));
        const piece = chunk.subarray(part.offset, part.offset + part.size);
        if (piece.length !== part.size) throw Error(`${file.filename} 的分片引用越界`);
        await handle.write(piece);
        hash.update(piece);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!hash.digest().equals(file.sha1)) throw Error(`${file.filename} SHA-1 校验失败`);
    progress({ stage: 'converting', message: `拼装文件 ${done + 1}/${files.length}`, bytesWritten: done + 1, totalBytes: files.length });
  }
}

// ── 搜索（网页端 /i/ 接口，cookie 认证）─────────────────────────────────────────

// ── 搜索 + 详情（网页端 /i/ 接口，cookie 认证）─────────────────────────────────

/** 从 thumbnails[].images[] 里挑分辨率最大的一张（Fab 封面在 media.fab.com，多尺寸）。 */
function pickFabThumbnail(row) {
  let best = '';
  let bestWidth = -1;
  for (const group of (Array.isArray(row?.thumbnails) ? row.thumbnails : [])) {
    for (const img of (group?.images || [])) {
      const url = String(img?.url || '');
      if (!/^https:\/\//.test(url)) continue;
      const width = Number(img.width) || 0;
      if (width >= bestWidth) { best = url; bestWidth = width; }
    }
  }
  return best;
}
function pickFabLicense(row) {
  const list = Array.isArray(row?.licenses) ? row.licenses : [];
  const names = list.map(item => item?.name).filter(Boolean);
  if (names.length) return names.join(' / ');
  return row?.isFree === true ? '免费' : '见 Fab 资产页';
}
/** Fab 的 14 种产品类型（页面「产品类型」面板同款）。tutorial 的 slug 暂未探明，先不列。
 *  统一 assetType 只做粗归类，Fab 自己的类型名另存 fabType，卡片与筛选都按它显示。 */
export const FAB_LISTING_TYPES = Object.freeze([
  { value: '3d-model', label: '3D 模型', type: 'models' },
  { value: 'material', label: '材质与纹理', type: 'textures' },
  { value: 'sprites-and-flipbooks', label: 'Sprite 与图像序列', type: 'images' },
  { value: 'decal', label: '贴花', type: 'images' },
  { value: 'brush', label: '笔刷', type: 'images' },
  { value: 'hdri', label: 'HDRI', type: 'hdris' },
  { value: 'animation', label: '动画', type: 'models' },
  { value: 'audio', label: '音频', type: 'audio' },
  { value: 'vfx', label: '视觉效果', type: 'packs' },
  { value: 'ui', label: '用户界面', type: 'uielement' },
  { value: 'game-system', label: '游戏系统', type: 'packs' },
  { value: 'game-template', label: '游戏模板', type: 'packs' },
  { value: 'tool-and-plugin', label: '工具与插件', type: 'packs' },
]);
const FAB_TYPE_BY_SLUG = new Map(FAB_LISTING_TYPES.map(item => [item.value, item]));

function fabAssetType(listingType) {
  const slug = String(listingType || '').trim().toLowerCase();
  const known = FAB_TYPE_BY_SLUG.get(slug);
  if (known) return known.type;
  // 兼容早期取值与未登记的新类型：只按关键字兜底，不认识的一律当模型。
  if (slug.includes('material') || slug.includes('texture')) return 'textures';
  if (slug.includes('hdri')) return 'hdris';
  if (slug === 'bundle') return 'packs';
  return 'models';
}
function fabRating(row) {
  const value = Number(row?.ratings?.averageRating ?? row?.averageRating);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : null;
}

/** 把搜索行归一化成统一卡片形状（与 ambientCG / Kenney 的卡片一致）。 */
export function normalizeFabAsset(row) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.uid || row.id || '').trim();
  if (!id) return null;
  const price = Number.isFinite(row.startingPrice?.price) ? row.startingPrice.price : null;
  return {
    uid: fabUid(id),
    platform: 'fab',
    assetId: id,
    sourceType: 'model',
    assetType: fabAssetType(row.listingType),
    fabType: FAB_TYPE_BY_SLUG.get(String(row.listingType || '').toLowerCase())?.label || '',
    name: String(row.title || id).trim().slice(0, 240) || `Fab ${id}`,
    author: String(row.user?.sellerName || row.seller?.name || 'Fab').slice(0, 120),
    thumbnail: pickFabThumbnail(row),
    url: `https://www.fab.com/listings/${id}`,
    license: pickFabLicense(row),
    downloadable: row.isFree === true || price === 0,
    categories: row.category?.name ? [String(row.category.name)] : [],
    tags: (Array.isArray(row.tags) ? row.tags : []).map(tag => tag?.name).filter(Boolean).slice(0, 8),
    isFree: row.isFree === true || price === 0,
    price,
    rating: fabRating(row),
    faces: null, vertices: null, likes: 0, views: 0, animations: 0,
  };
}

/** 关键词 / 免费搜索 Fab 资产（网页端 GET 接口，自动带 fab.com 域的登录 cookie）。
 *  注意：Fab 的「免费」筛选 is_free=1 只有在带 sort_by 时才生效 —— 实测无 sort_by 时会被忽略。
 *  listing_types 也只在单值时生效（多值只认最后一个），所以前端用单选下拉传一个 slug。 */
export async function fabSearch(input = {}, { signal, open = openPublic } = {}) {
  signal?.throwIfAborted();
  const cursor = input.cursor ? (typeof input.cursor === 'string' ? JSON.parse(input.cursor) : input.cursor) : {};
  const q = String(cursor.q ?? input.q ?? '').trim();
  const page = Math.max(1, Number(cursor.page ?? input.page) || 1);
  const free = input.free === true || input.isFree === true || cursor.free === true;
  const sortBy = String(input.sortBy || cursor.sortBy || '-createdAt');
  const listingType = String(input.listingType || cursor.listingType || '').trim().toLowerCase();
  // 分类用 Fab 自己的 slug：path 的 "/" 换成 "--"（nature-terrain、nature-terrain--rock、
  // buildings-architecture--components--balconies 三种层级实测都有效）。
  const category = String(input.category || cursor.category || '').trim();
  // 卖家页 https://www.fab.com/sellers/Quixel%20Megascans 走的是同一个搜索接口的 seller 参数，
  // 值是解码后的卖家名（不是 slug），实测能精确命中。
  const seller = String(input.seller || cursor.seller || '').trim();
  const query = new URLSearchParams({ count: '24', sort_by: sortBy });
  if (q) query.set('q', q);
  if (free) query.set('is_free', '1');
  if (listingType) query.set('listing_types', listingType);
  if (category) query.set('categories', category);
  if (seller) query.set('seller', seller);
  if (cursor.next) query.set('cursor', cursor.next);
  const r = await open(`${FAB_HOST}/i/listings/search?${query}`, { signal, timeout: 45000, headers: { Accept: 'application/json' } });
  if (r.status < 200 || r.status >= 300) { try { r.stream.destroy(); } catch {} throw Error(`Fab 搜索返回 HTTP ${r.status}`); }
  const payload = JSON.parse((await readAll(r)).toString('utf8'));
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const models = rows.map(normalizeFabAsset).filter(Boolean);
  const next = (payload?.cursors || {}).next;
  const typeLabel = FAB_TYPE_BY_SLUG.get(listingType)?.label || '';
  const scope = [typeLabel, q || '免费资产'].filter(Boolean).join(' · ');
  return {
    models, received: models.length, total: models.length, page,
    next: next ? JSON.stringify({ q, free, sortBy, listingType, category, seller, next, page: page + 1 }) : null,
    pending: [],
    source: 'Fab · 3D 资产商城',
    warnings: models.length ? [] : [`Fab 上没有匹配 “${[seller && `卖家 ${seller}`, scope].filter(Boolean).join(' · ')}” 的资产`],
    query: q,
  };
}

function stripFabHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 归一化资产详情（描述、媒体图、许可、评分）。 */
export function normalizeFabDetail(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.uid || '').trim();
  if (!id) return null;
  const images = [];
  for (const media of (Array.isArray(raw.medias) ? raw.medias : [])) {
    const url = media?.thumbnailUrl || media?.url || media?.source;
    if (/^https:\/\//.test(String(url || ''))) images.push(String(url));
  }
  if (!images.length) { const cover = pickFabThumbnail(raw); if (cover) images.push(cover); }
  const price = Number.isFinite(raw.startingPrice?.price) ? raw.startingPrice.price : null;
  return {
    uid: fabUid(id), platform: 'fab', assetId: id,
    name: String(raw.title || id),
    author: String(raw.user?.sellerName || 'Fab'),
    url: `https://www.fab.com/listings/${id}`,
    description: stripFabHtml(raw.description || '').slice(0, 4000),
    descriptionHtml: String(raw.description || ''),
    images: [...new Set(images)].slice(0, 24),
    category: raw.category?.name || '',
    tags: (Array.isArray(raw.tags) ? raw.tags : []).map(tag => tag?.name).filter(Boolean),
    licenses: (Array.isArray(raw.licenses) ? raw.licenses : []).map(item => item?.name).filter(Boolean),
    rating: fabRating(raw),
    reviewCount: Number(raw.reviewCount) || 0,
    isFree: price === 0,
    price,
    externalUrl: String(raw.externalUrl || ''),
  };
}

/** 取单个 Fab 资产的详情（GET /i/listings/<uid>）。assetId 是真实 listing uuid。 */
export async function fabDetail(input = {}, { signal, open = openPublic } = {}) {
  signal?.throwIfAborted();
  const id = String(input.assetId || input.id || '').trim();
  if (!id) throw Error('Fab 资产 ID 缺失');
  const r = await open(`${FAB_HOST}/i/listings/${encodeURIComponent(id)}`, { signal, timeout: 45000, headers: { Accept: 'application/json' } });
  if (r.status < 200 || r.status >= 300) { try { r.stream.destroy(); } catch {} throw Error(`Fab 详情返回 HTTP ${r.status}`); }
  const raw = JSON.parse((await readAll(r)).toString('utf8'));
  return normalizeFabDetail(raw);
}

// ── 网页库（/i/ 接口）：一键入库 & 非引擎资产下载 ─────────────────────────────
//
// /i/ 走的是 fab.com 网页自己的会话（cookie `fab_sessionid` + CSRF `fab_csrftoken`），
// Epic 的 Bearer 在这条链路上不认（实测 401 Authentication credentials were not provided）。
// 页面上「Add to library」就是 POST /i/listings/<uid>/add-to-library {offer_id}。

const FAB_WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fabWebAuth() {
  const cookie = cookieHeaderFor(`${FAB_HOST}/`);
  const csrf = (cookie.match(/(?:^|;\s*)fab_csrftoken=([^;]+)/) || [])[1] || '';
  return { cookie, csrf, signedIn: /(?:^|;\s*)fab_sessionid=/.test(cookie) };
}

let fabWarmAt = 0;

/** cookie 里没有 fab.com 会话时，借一次浏览器把首页跑一遍：Epic SSO 还在，页面自己会种上 fab_sessionid。 */
async function ensureFabWebAuth() {
  const now = fabWebAuth();
  if (now.signedIn) return now;
  if (Date.now() - fabWarmAt < 60_000) return now;
  fabWarmAt = Date.now();
  try {
    const { warmCookies } = await import('./browser-session.mjs');
    await warmCookies(`${FAB_HOST}/`, 'fab.com');
  } catch { /* 浏览器起不来就按未登录处理，下面给可读提示 */ }
  return fabWebAuth();
}

async function fabWebJson(url, { method = 'GET', body, signal, open = openPublic, retry = true } = {}) {
  const auth = await ensureFabWebAuth();
  if (!auth.signedIn) throw Error('Fab 网页还没登录：在「设置 → 平台 → Fab」点登录图标登一次，之后入库/下载都复用这份会话');
  const r = await open(url, {
    method, signal, timeout: 45000,
    headers: {
      Accept: 'application/json',
      'User-Agent': FAB_WEB_UA,
      Cookie: auth.cookie,
      Referer: `${FAB_HOST}/`,
      Origin: FAB_HOST,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method === 'GET' ? {} : { 'X-CSRFToken': auth.csrf }),
    },
    body: body ? JSON.stringify(body) : undefined,
    useCookies: false,
  });
  if (r.status === 403 && retry) {
    // CSRF 被轮换过（登录窗口又同步了一轮）→ 重读 cookie 再试一次。
    try { r.stream.destroy(); } catch {}
    fabWarmAt = 0;
    return fabWebJson(url, { method, body, signal, open, retry: false });
  }
  const text = (await readAll(r)).toString('utf8');
  if (r.status === 401) throw Error('Fab 网页登录已失效：重新登录一次 Fab 就能继续');
  if (r.status < 200 || r.status >= 300) throw Error(`Fab 返回 HTTP ${r.status}：${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}

/** 免费资产一键入库（等同于资产页上的「Add to library」）。非免费会直接抛错，不会扣款。 */
export async function fabClaim(listingId, { open = openPublic, signal } = {}) {
  const id = String(listingId || '').trim();
  if (!id) throw Error('Fab 资产 ID 缺失');
  const raw = await fabWebJson(`${FAB_HOST}/i/listings/${encodeURIComponent(id)}`, { open, signal });
  const free = (Array.isArray(raw?.licenses) ? raw.licenses : []).filter(x => Number(x?.priceTier?.price) === 0);
  const offer = free.find(x => x.slug === 'personal') || free[0];
  if (!offer?.offerId) {
    const price = Number(raw?.startingPrice?.price);
    throw Error(Number.isFinite(price) && price > 0 ? '这个资产是收费的，一键入库只处理免费资产' : '这个资产没有可入库的免费许可');
  }
  await fabWebJson(`${FAB_HOST}/i/listings/${encodeURIComponent(id)}/add-to-library`, {
    method: 'POST', body: { offer_id: offer.offerId }, open, signal,
  });
  return { id, title: String(raw?.title || id), license: String(offer.name || offer.slug || '') };
}

/** 批量入库：先跳过已在库的，再 5 条并发逐条记账（一条失败不中断整批）。 */
export async function fabClaimMany(ids, { open = openPublic, signal, progress = () => {} } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(x => String(x || '').trim()).filter(Boolean))];
  // 已经在库里的不必再打一次接口：整页重试、或同一页点两次的情况很常见。
  let have = new Set();
  try { have = new Set((await fabWebLibrary({ open, signal })).map(row => row.listingId)); } catch { /* 读不到库就按全部待入库处理 */ }
  const todo = list.filter(id => !have.has(id));
  const skipped = list.length - todo.length;
  const results = [];
  let index = 0;
  const worker = async () => {
    while (index < todo.length) {
      const id = todo[index++];
      if (signal?.aborted) throw Object.assign(Error('已取消'), { name: 'AbortError' });
      try {
        const hit = await fabClaim(id, { open, signal });
        results.push({ id, ok: true, ...hit });
        progress({ message: `已入库 ${hit.title || id}`, done: skipped + results.length, total: list.length });
      } catch (e) {
        results.push({ id, ok: false, title: '', message: String(e?.message || e) });
        progress({ message: `入库失败 ${id}`, done: skipped + results.length, total: list.length });
      }
    }
  };
  // 入库是「读一次详情 + 一次 POST」的轻请求，5 并发足够快又不容易撞限流。
  await Promise.all(Array.from({ length: Math.min(5, todo.length || 1) }, () => worker()));
  const added = results.filter(r => r.ok).length;
  return { total: list.length, added, skipped, failed: results.length - added, results };
}

/** 网页端「我的库」：比 ue/library 全，含贴图集 / glTF / 附加文件这些非引擎格式。 */
export async function fabWebLibrary({ open = openPublic, signal, maxPages = 20 } = {}) {
  const items = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted();
    const query = new URLSearchParams({ count: '100', sort_by: '-createdAt' });
    if (cursor) query.set('cursor', cursor);
    const data = await fabWebJson(`${FAB_HOST}/i/library/search?${query}`, { open, signal });
    const before = items.length;
    for (const rec of (data?.results || [])) {
      const listing = rec?.listing || {};
      const listingId = String(listing.uid || '');
      if (!listingId || seen.has(listingId)) continue;
      seen.add(listingId);
      items.push({
        listingId,
        libraryId: String(rec.uid || ''),
        title: String(listing.title || listingId),
        formats: (Array.isArray(listing.assetFormats) ? listing.assetFormats : [])
          .map(f => String(f?.assetFormatType?.code || '')).filter(Boolean),
        createdAt: String(rec.createdAt || ''),
      });
    }
    cursor = data?.cursors?.next || '';
    if (!cursor || items.length === before) break;   // 游标不生效时别把同一页拉 20 遍
  }
  return items;
}

// 网页库的格式选择按「这个资产的类型」分派，而不是一条固定优先级：
//
// 早先 texture-set 排在 gltf/fbx 之前，碰到「模型 + 贴图集」的混合包会只下到贴图集，
// 模型一个文件都没有 —— 拖进 Blender 自然是空的。格式清单本身就是最可靠的类型信号：
// 只要它提供了 gltf/fbx/obj/usd/blend，就说明这是个模型包，哪怕同时挂着贴图集也该先取模型。
/** 模型格式（判定「模型包」用，顺序即首选次序）。 */
const WEB_MODEL_ORDER = ['gltf', 'fbx', 'obj', 'usd', 'blend'];
/** 纯材质 / 贴图类资产：贴图集优先，其次 image（常规 PNG 包），最后才是附加文件。 */
// 'image' 放在 'additional-files' 之前：贴图/笔刷类资产的 image 是常规 PNG 包，
// additional-files 往往是 8K EXR 这种又大又不通用的附加包（实测同一资产 21MB vs 100MB）。
const WEB_MATERIAL_ORDER = ['texture-set', 'image', 'additional-files'];
/** 贴图集常按精度分包；默认取 2k（体积与质量都合适），可用 options.fabFile 指定文件名覆盖。 */
const WEB_RES_ORDER = ['2k', '4k', '1k', '8k'];

/**
 * 按资产类型挑格式：给了模型格式就是模型包 → 取模型；否则按材质资产取贴图集。
 * 两条都不命中（例如只有 additional-files 或某种新格式）时退回清单第一个，保证还能下。
 */
function pickWebFormat(formats) {
  const list = Array.isArray(formats) ? formats : [];
  for (const code of WEB_MODEL_ORDER) if (list.includes(code)) return code;
  for (const code of WEB_MATERIAL_ORDER) if (list.includes(code)) return code;
  return list[0] || '';
}

function pickWebFile(files, want) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return null;
  if (want) {
    const hit = list.find(f => f.name === want || f.uid === want);
    if (hit) return hit;
  }
  for (const res of WEB_RES_ORDER) {
    const hit = list.find(f => new RegExp(`[_.\\- ]${res}(?:[_.\\-]|\\.zip$)`, 'i').test(String(f.name || '')));
    if (hit) return hit;
  }
  return list.slice().sort((a, b) => (a.size || 0) - (b.size || 0))[0];
}

/** 把响应体直接写盘（大包走流，不整块进内存）。 */
async function saveStream(r, file, { signal, progress, totalBytes = 0 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const fh = await fs.open(`${file}.tmp`, 'w');
  let bytes = 0;
  try {
    for await (const chunk of r.stream) {
      signal?.throwIfAborted();
      await fh.write(chunk);
      bytes += chunk.length;
      progress?.({ bytesWritten: bytes, totalBytes });
    }
  } finally { await fh.close(); }
  await fs.rename(`${file}.tmp`, file);
  return bytes;
}

async function extractZipInto(file, output, { signal, progress } = {}) {
  const { entries, truncated } = await listArchiveEntries(file, { limit: 2000 });
  await fs.mkdir(output, { recursive: true });
  let done = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const rel = safeRelPath(entry.name);
    const target = path.join(output, ...rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const blob = await extractArchiveEntry(file, entry.name, { maxBytes: 512 * 1024 * 1024 });
    await fs.writeFile(target, blob.bytes);
    done++;
    if (done % 10 === 0 || done === entries.length) {
      progress({ stage: 'converting', message: `解包 ${done}/${entries.length}`, bytesWritten: done, totalBytes: entries.length });
    }
  }
  return { files: done, truncated };
}

/** 网页库资产的下载：定位库记录 → 选格式与分包 → download-info 拿签名地址 → 落盘 → 解包。 */
async function runFabWebJob({ uid, id, options = {}, output, deliver = 'folder', workRoot, open, signal, progress }) {
  progress({ stage: 'starting', message: '正在读取 Fab 网页库…' });
  let items = await fabWebLibrary({ open, signal });
  let hit = items.find(row => row.listingId === id);
  let claimError = '';
  if (!hit) {
    // 免费资产直接当「获取并下载」：Fab 网页上的下载按钮本身也是先 Add to library 再下，
    // 所以这里补一次入库再重读库；收费资产 fabClaim 会抛错，不会产生订单。
    try { await fabClaim(id, { open, signal }); } catch (e) { claimError = String(e?.message || e); }
    if (!claimError) {
      // Fab 的库搜索是索引：实测入库后要 8～11 秒才查得到，所以这里轮询而不是等一次。
      for (let attempt = 1; attempt <= 8 && !hit; attempt++) {
        progress({ stage: 'starting', message: `已加入 Fab 库，正在等索引同步…（${attempt * 2.5 | 0} 秒）` });
        await new Promise(resolve => setTimeout(resolve, 2500));
        signal?.throwIfAborted();
        items = await fabWebLibrary({ open, signal });
        hit = items.find(row => row.listingId === id);
      }
    }
  }
  if (!hit) {
    throw Error(claimError
      ? `这个资产没能加入 Fab 库：${claimError}`
      : `已加入 Fab 库但库里还查不到（${id}）：稍等几秒再点一次下载`);
  }
  // 刚入库的记录里 libraryId 也有索引延迟：直接拿它查 asset-formats 会 404
  // （No LibraryAsset matches the given query）。所以这里连格式列表一起重试，
  // 每轮重新读一次库拿最新的 libraryId。
  let detail = null;
  let file = null;
  let pickedFormat = '';
  let remote = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    pickedFormat = pickWebFormat(hit.formats);
    if (!pickedFormat) throw Error('这个资产没有可下载的文件格式');
    progress({ stage: 'starting', message: `正在获取文件列表（${pickedFormat}）…` });
    try {
      detail = await fabWebJson(`${FAB_HOST}/i/library/assets/${encodeURIComponent(hit.libraryId)}/asset-formats/${encodeURIComponent(pickedFormat)}`, { open, signal });
      file = pickWebFile(detail?.files, options.fabFile);
      if (!file?.uid) throw Object.assign(Error('这个格式下没有可下载的文件'), { fatal: true });
      // 下载地址这一步同样会撞上索引延迟（libraryId 已出现、文件记录还没跟上），放在同一个重试里。
      const info = await fabWebJson(`${FAB_HOST}/i/library/assets/${encodeURIComponent(hit.libraryId)}/asset-formats/${encodeURIComponent(pickedFormat)}/files/${encodeURIComponent(file.uid)}/download-info?platform=Windows`, { open, signal });
      remote = String(info?.downloadInfo?.[0]?.downloadUrl || '');
      if (!/^https:\/\//.test(remote)) throw Object.assign(Error('Fab 没有返回下载地址'), { fatal: true });
      break;
    } catch (e) {
      if (e.fatal || attempt === 5 || !/HTTP 404/.test(String(e.message))) throw e;
      progress({ stage: 'starting', message: '库记录还在同步，稍等重试…' });
      await new Promise(resolve => setTimeout(resolve, 3000));
      signal?.throwIfAborted();
      const again = await fabWebLibrary({ open, signal });
      hit = again.find(row => row.listingId === id) || hit;
    }
  }
  if (!file?.uid) throw Error('这个格式下没有可下载的文件');
  if (!remote) throw Error('Fab 没有返回下载地址');

  // workRoot 可能还不存在（DownloadManager 只把路径算出来，不会预先建目录）→ 先建父目录再 mkdtemp。
  const workParent = workRoot || path.dirname(output);
  await fs.mkdir(workParent, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(workParent, `fab-web-${String(uid).slice(0, 8)}-`));
  const local = path.join(workDir, String(file.name || `${id}.zip`).replace(/[\\/]/g, '_'));
  // deliver='zip' 时 output 是一个 .zip 文件路径，先在临时目录摊开再打包；folder 就直接摊进 output。
  const unpackDir = deliver === 'zip' ? path.join(workDir, 'out') : output;
  try {
    const received = await saveStream(await open(remote, { signal, timeout: 300000, headers: { 'User-Agent': FAB_WEB_UA }, useCookies: false }), local, {
      signal, totalBytes: Number(file.size) || 0,
      progress: p => progress({ stage: 'transferring', message: `下载 ${file.name || '文件'}`, ...p }),
    });
    if (Number(file.size) > 0 && received !== Number(file.size)) throw Error(`下载不完整（${received}/${file.size} 字节）`);
    if (/\.zip$/i.test(local)) {
      progress({ stage: 'converting', message: '正在解包…' });
      await extractZipInto(local, unpackDir, { signal, progress });
    } else {
      await fs.mkdir(unpackDir, { recursive: true });
      await fs.copyFile(local, path.join(unpackDir, path.basename(local)));
    }
    const meta = {
      uid, kind: 'fab', platform: 'fab', assetId: id,
      url: `https://www.fab.com/listings/${id}`,
      file: String(file.name || ''), format: pickedFormat,
      license: '见 Fab 资产页',
      note: 'Fab 网页库资产（已拥有）。下载走 fab.com 网页接口，请遵守 Fab 条款与资产许可。',
      exportedAt: new Date().toISOString(), tool: 'Arvimo · Fab',
    };
    await fs.writeFile(path.join(unpackDir, 'info.json'), JSON.stringify(meta, null, 2), 'utf8');
    if (deliver === 'zip') {
      progress({ stage: 'converting', message: '正在打包…' });
      await fs.mkdir(path.dirname(output), { recursive: true });
      await packFolder(unpackDir, output, { signal });
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
  return { zipName: `${id}-fab`, title: hit.title, author: 'Fab', thumbnail: null };
}
