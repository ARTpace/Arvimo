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
  const session = options.fabSession || { accessToken: options.accessToken, accountId: options.accountId };
  if (!session.accessToken || !session.accountId) throw Error('Fab 需要先登录 Epic 账号');
  const id = String(assetId || '').trim();
  if (!id) throw Error('Fab 资产 ID 缺失');
  const open = options.open || openPublic;

  progress({ stage: 'starting', message: '正在读取 Fab 版本库…' });
  const items = await fabLibrary(session, { open, signal });
  const item = items.find(i => i.assetId === id);
  if (!item) throw Error(`你的 Fab 库里没有资产 ${id}（只能下载已拥有的资产）`);
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

  const chunkDir = await fs.mkdtemp(path.join(workRoot || path.dirname(output), `fab-chunks-${String(uid).slice(0, 8)}-`));
  try {
    await downloadChunks(manifest, baseUrls, chunkDir, { open, signal, progress });
    await fs.mkdir(output, { recursive: true });
    await assembleFiles(manifest, chunkDir, output, { signal, progress });
    const meta = {
      uid, kind: 'fab', platform: 'fab', assetId: id,
      url: `https://www.fab.com/listings/${id}`,
      engineVersions: version.engineVersions,
      license: '见 Fab 资产页',
      note: 'Fab 引擎资产（已拥有）。下载走 Epic Launcher 私有端点，请遵守 Epic 条款与资产许可。',
      exportedAt: new Date().toISOString(), tool: 'AssetVault · Fab',
    };
    await fs.writeFile(path.join(output, 'info.json'), JSON.stringify(meta, null, 2), 'utf8');
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

/** 把搜索行归一化成统一卡片形状（与 ambientCG / Kenney 的卡片一致）。 */
export function normalizeFabAsset(row) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.uid || row.id || '').trim();
  if (!id) return null;
  return {
    uid: fabUid(id),
    platform: 'fab',
    assetId: id,
    sourceType: 'model',
    assetType: 'models',
    name: String(row.title || id).trim().slice(0, 240) || `Fab ${id}`,
    author: String(row.seller?.name || row.sellerName || 'Fab').slice(0, 120),
    thumbnail: '',
    url: `https://www.fab.com/listings/${id}`,
    license: '见 Fab 资产页',
    downloadable: true,
    categories: [],
    tags: [],
    faces: null, vertices: null, likes: 0, views: 0, animations: 0,
  };
}

/** 关键词搜索 Fab 资产（走网页端 GET 接口，自动带 fab.com 域的登录 cookie）。 */
export async function fabSearch(input = {}, { signal, open = openPublic } = {}) {
  signal?.throwIfAborted();
  const cursor = input.cursor ? (typeof input.cursor === 'string' ? JSON.parse(input.cursor) : input.cursor) : {};
  const q = String(cursor.q ?? input.q ?? '').trim();
  const page = Math.max(1, Number(cursor.page ?? input.page) || 1);
  const query = new URLSearchParams({ count: '24' });
  if (q) query.set('q', q);
  if (cursor.next) query.set('cursor', cursor.next);
  const r = await open(`${FAB_HOST}/i/listings/search?${query}`, { signal, timeout: 45000 });
  if (r.status < 200 || r.status >= 300) { try { r.stream.destroy(); } catch {} throw Error(`Fab 搜索返回 HTTP ${r.status}`); }
  const payload = JSON.parse((await readAll(r)).toString('utf8'));
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const models = rows.map(normalizeFabAsset).filter(Boolean);
  const next = (payload?.cursors || {}).next;
  return {
    models, received: models.length, total: models.length, page,
    next: next ? JSON.stringify({ q, next, page: page + 1 }) : null,
    pending: [],
    source: 'Fab · 3D 资产商城',
    warnings: models.length ? [] : [`Fab 上没有匹配 “${q}” 的资产`],
    query: q,
  };
}
