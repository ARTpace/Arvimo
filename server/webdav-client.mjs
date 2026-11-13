// 极简 WebDAV 客户端（零依赖，基于内置 fetch）。
//
// 只实现同步真正需要的六件事：探测、建目录、列目录、上传、下载、取元信息。
// 不引入 webdav 包的理由和 MCP server 一样：这个仓库运行时依赖为零，多一个包就多一处
// 安装失败点；而 WebDAV 的这六个动作就是六个 HTTP 方法，自己写反而更容易控制错误文案。
//
// 认证只做 Basic：WebDAV 的 Digest 需要在 Node 里重放 nonce，而主流服务（坚果云、Nextcloud、
// Synology、Alist）都支持 Basic。用户填的应用密码本身就是给这种用途准备的。
const DEFAULT_TIMEOUT = 20000;

/** 路径逐段编码：目录名里的空格 / 中文 / # 不编码会被服务器当成截断或锚点。 */
function encodePath(value) {
  return String(value || '')
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

/** 从 PROPFIND 的多状态响应里取 href / 修改时间 / ETag。前缀可能是 d: / D: / 无。 */
function parseMultistatus(xml) {
  const entries = [];
  const blocks = String(xml).match(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi) || [];
  for (const block of blocks) {
    const pick = pattern => {
      const match = block.match(pattern);
      return match ? match[1].trim() : '';
    };
    const href = pick(/<(?:[\w-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i);
    if (!href) continue;
    const rawEtag = pick(/<(?:[\w-]+:)?getetag[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?getetag>/i)
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') || null;
    entries.push({
      rawEtag,
      href: decodeURIComponent(href),
      lastModified: pick(/<(?:[\w-]+:)?getlastmodified[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?getlastmodified>/i) || null,
      etag: (pick(/<(?:[\w-]+:)?getetag[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?getetag>/i) || '').replace(/^W\//, '').replace(/"/g, '') || null,
      isDir: /<(?:[\w-]+:)?collection\b/i.test(block),
    });
  }
  return entries;
}

export function createWebdav({ url, username = '', password = '', timeoutMs = DEFAULT_TIMEOUT, fetchImpl = fetch } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw Error('WebDAV 地址必须以 http:// 或 https:// 开头');
  const authorization = username
    ? `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
    : '';

  function failure(message, code, status = 0) {
    return Object.assign(new Error(message), {code, status});
  }

  // Deadline 覆盖 headers 与 body；reader.cancel 也能终止不响应 signal 的 fake Response。
  async function request(method, relative, { body = null, headers = {}, timeout = timeoutMs, consume = null, maxBytes = null } = {}) {
    const controller = new AbortController();
    let response, reader;
    let expired = false;
    let timer;
    const deadline = new Promise((_, reject) => {
      const abort = () => {
        expired = true;
        controller.abort();
        reader?.cancel().catch(() => {});
        reject(failure(`连接 WebDAV 超时（${Math.round(timeout / 1000)} 秒），检查地址与网络`, 'WEBDAV_TIMEOUT', response?.status || 0));
      };
      timer = setTimeout(abort, timeout);
    });
    const target = `${base}/${encodePath(relative)}`.replace(/\/$/, '') || base;
    const operation = async () => {
      response = await fetchImpl(target, {
        method, body,
        headers: { ...(authorization ? { Authorization: authorization } : {}), ...headers },
        signal: controller.signal,
        redirect: 'error',
      });
      if (expired) { response.body?.cancel().catch(() => {}); return; }
      // 兼容 fake fetch：即使忽略 redirect 选项，也不能将重定向当成功或触发 HEAD fallback。
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw failure('WebDAV 不允许重定向，请填写最终地址', 'WEBDAV_REDIRECT', response.status);
      }
      let data;
      if (consume && response.status >= 200 && response.status < 300) {
        if (response.body?.getReader) {
          reader = response.body.getReader();
          const chunks = [];
          let bytes = 0;
          while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (maxBytes !== null && bytes > maxBytes) {
              controller.abort();
              reader.cancel().catch(() => {});
              throw failure('WebDAV 元数据超过读取字节上限', 'WEBDAV_TOO_LARGE', response.status);
            }
            chunks.push(Buffer.from(value));
          }
          const buffer = Buffer.concat(chunks);
          data = consume === 'text' ? buffer.toString('utf8') : buffer;
        } else if (maxBytes !== null && response.body === null) {
          // 标准 Response 的 null body 是已知空流，无需不受控的全量读取。
          data = Buffer.alloc(0);
        } else {
          if (maxBytes !== null) {
            controller.abort();
            throw failure('WebDAV 响应不支持有界流式读取', 'WEBDAV_UNBOUNDED_BODY', response.status);
          }
          data = consume === 'text' ? await response.text() : Buffer.from(await response.arrayBuffer());
        }
      }
      return {status: response.status, headers: response.headers, data};
    };
    try {
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      if (error?.code?.startsWith('WEBDAV_')) throw error;
      throw failure(`连不上 WebDAV：${error?.message || error}`, 'WEBDAV_NETWORK', response?.status || 0);
    } finally {
      clearTimeout(timer);
      if (reader) {
        reader.cancel().catch(() => {});
        reader.releaseLock();
      } else if (response?.body) response.body.cancel().catch(() => {});
    }
  }

  function explain(status) {
    if (status === 401 || status === 403) return 'WebDAV 账号或密码不对（也可能是应用密码未开启）';
    if (status === 404) return 'WebDAV 路径不存在，检查地址里的目录是否已创建';
    if (status === 507) return 'WebDAV 空间不足，服务器拒绝写入';
    if (status === 423) return 'WebDAV 文件被锁定，稍后重试';
    return `WebDAV 返回 HTTP ${status}`;
  }

  /** 探测：能列根目录就算通。返回服务器声明的 DAV 能力（有的服务会拒绝 PROPFIND）。 */
  async function test() {
    const response = await request('PROPFIND', '', { headers: { Depth: '0', 'Content-Type': 'application/xml' } });
    if (response.status === 207 || response.status === 200) return { ok: true };
    if (response.status === 405) return { ok: true, limited: true }; // 少数网盘不支持 PROPFIND 但支持 PUT/GET
    throw failure(explain(response.status), 'WEBDAV_HTTP', response.status);
  }

  /** 逐级 MKCOL：405 表示已存在；重定向由 request 拒绝。 */
  async function ensureDir(relative) {
    const segments = String(relative || '').split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      const response = await request('MKCOL', segments.slice(0, index).join('/'));
      if (![200, 201, 204, 301, 405].includes(response.status)) throw failure(explain(response.status), 'WEBDAV_HTTP', response.status);
    }
  }

  /** 列目录：返回 name（相对于该目录的末段）→ 元信息。 */
  async function list(relative) {
    const response = await request('PROPFIND', relative, { headers: { Depth: '1', 'Content-Type': 'application/xml' }, consume: 'text' });
    if (response.status === 404) return [];
    if (response.status === 405) return []; // 不支持列目录的服务器：当作空，靠 PUT 覆盖
    if (response.status !== 207 && response.status !== 200) throw failure(explain(response.status), 'WEBDAV_HTTP', response.status);
    const text = response.data;
    const prefix = `/${encodePath(relative)}`;
    const result = new Map();
    for (const entry of parseMultistatus(text)) {
      const normalized = entry.href.replace(/\/+$/, '');
      // 目录自身（href 恰为请求路径）跳过，否则会被当成一个要同步的文件。
      if (!normalized || normalized === prefix) continue;
      const name = normalized.split('/').pop();
      if (!name) continue;
      result.set(name, {
        lastModified: entry.lastModified ? Date.parse(entry.lastModified) || null : null,
        etag: entry.etag,
        rawEtag: entry.rawEtag,
        isDir: entry.isDir,
      });
    }
    return [...result.entries()].map(([name, meta]) => ({ name, ...meta }));
  }

  async function get(relative) {
    const response = await request('GET', relative, {consume: 'buffer'});
    if (response.status === 404) return null;
    if (response.status !== 200) throw failure(explain(response.status), 'WEBDAV_HTTP', response.status);
    return response.data;
  }

  /** v2 读取原语：内容与令牌绑定同一个 GET 响应，不用 HEAD 拼接版本。 */
  async function getWithMetadata(relative, {maxBytes = 8 * 1024 * 1024} = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 8 * 1024 * 1024) {
      throw failure('元数据字节上限必须是 1 至 8 MiB 的安全整数', 'WEBDAV_INVALID_LIMIT');
    }
    const response = await request('GET', relative, {consume: 'buffer', maxBytes});
    if (response.status === 404) return null;
    if (response.status !== 200) throw failure(explain(response.status), 'WEBDAV_HTTP', response.status);
    return {buffer: response.data, rawEtag: response.headers.get('etag') || null};
  }

  async function put(relative, buffer) {
    const response = await request('PUT', relative, {
      body: buffer,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.length) },
      timeout: Math.max(timeoutMs, 120000), // 大目录域可能几百 MB，给足上传时间
    });
    if (![200, 201, 204].includes(response.status)) throw failure(explain(response.status), 'WEBDAV_HTTP', response.status);
    return { etag: (response.headers.get('etag') || '').replace(/"/g, '') || null, rawEtag: response.headers.get('etag') || null };
  }

  /** v2 原语：只接受原样强 ETag 或 create-only；不探测、不重试、不降级无条件 PUT。 */
  async function putConditional(relative, buffer, {ifMatch, ifNoneMatch} = {}) {
    if ((ifMatch !== undefined) === (ifNoneMatch !== undefined) ||
        (ifNoneMatch !== undefined && ifNoneMatch !== '*') ||
        (ifMatch !== undefined && (typeof ifMatch !== 'string' || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(ifMatch)))) {
      throw failure('条件写必须指定一个原始强 ETag 或 If-None-Match:*', 'WEBDAV_INVALID_CONDITION');
    }
    const response = await request('PUT', relative, {
      body: buffer,
      headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.length),
        ...(ifMatch !== undefined ? {'If-Match': ifMatch} : {'If-None-Match': '*'})},
    });
    if (response.status === 412) throw failure('WebDAV 条件写冲突，必须重读基线', 'WEBDAV_CONFLICT', 412);
    if (![200, 201, 204].includes(response.status)) throw failure(explain(response.status), 'WEBDAV_HTTP', response.status);
    const rawEtag = response.headers.get('etag') || null;
    return {etag: rawEtag?.replace(/"/g, '') || null, rawEtag};
  }

  async function stat(relative) {
    const response = await request('HEAD', relative);
    if (response.status === 404) return null;
    if (response.status !== 200) {
      // HEAD 被拒绝（部分服务）时退回 PROPFIND 深度 0。
      const probe = await request('PROPFIND', relative, { headers: { Depth: '0' }, consume: 'text' });
      if (probe.status === 404) return null;
      if (probe.status !== 207) throw failure(explain(probe.status), 'WEBDAV_HTTP', probe.status);
      const [entry] = parseMultistatus(probe.data);
      return entry ? { etag: entry.etag, rawEtag: entry.rawEtag, lastModified: entry.lastModified ? Date.parse(entry.lastModified) || null : null } : null;
    }
    const lastModified = Date.parse(response.headers.get('last-modified') || '');
    return {
      etag: (response.headers.get('etag') || '').replace(/"/g, '') || null,
      rawEtag: response.headers.get('etag') || null,
      lastModified: Number.isFinite(lastModified) ? lastModified : null,
    };
  }

  return { test, ensureDir, list, get, getWithMetadata, put, putConditional, stat, base };
}
