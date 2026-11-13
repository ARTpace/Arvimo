import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { Readable } from 'node:stream';
import { artstationFetch, curlImpersonateAvailable, curlImpersonateFetch, looksLikeChallenge } from './curl-impersonate.mjs';
import { cookieHeaderFor } from './cookie-jar.mjs';

export const isSketchfabHost = host => /^(?:[a-z0-9-]+\.)*sketchfab\.com$/i.test(host);
export const isArtstationHost = host => /^(?:[a-z0-9-]+\.)*artstation\.com$/i.test(host);
export function isPublicIP(ip) {
  if (net.isIP(ip) === 4) {
    const [a,b,c] = ip.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31)
      || (a===192&&b===168) || (a===100&&b>=64&&b<=127) || (a===192&&b===0)
      || (a===198&&(b===18||b===19)) || (a===198&&b===51&&c===100) || (a===203&&b===0&&c===113));
  }
  if (net.isIP(ip) === 6) {
    const first=parseInt(ip.split(':')[0],16);
    return first>=0x2000 && first<=0x3fff && !/^2001:(?:db8|0):/i.test(ip) && !/^2002:/i.test(ip);
  }
  return false;
}
export function validateUrl(value, { sketchfabOnly=false, artstation=false }={}) {
  let u;try { u=new URL(String(value)); } catch { throw new Error('请输入完整的 http:// 或 https:// 网页地址'); }
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.href.length>8192) throw new Error('不支持这个网址格式');
  if (u.port && !['80','443'].includes(u.port)) throw new Error('仅支持标准 HTTP/HTTPS 端口');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  if (!host || /(^|\.)(localhost|local|internal)$/i.test(host) || (net.isIP(host)&&!isPublicIP(host))) throw new Error('不允许访问本机、内网或保留地址');
  if (sketchfabOnly && (!isSketchfabHost(host)||u.protocol!=='https:')) throw new Error('模型引擎只允许访问 Sketchfab HTTPS 域名');
  if (artstation && (!isArtstationHost(host)||u.protocol!=='https:')) throw new Error('ArtStation 流程只允许访问 artstation.com HTTPS 域名');
  // WHATWG URL leaves ^ literal, but ambientCG's file storage rejects it even in redirect paths.
  u.pathname=u.pathname.replace(/\^/g,'%5E');
  u.hash='';return u;
}

/** Resolve once, validate ALL addresses and pin the connection to prevent DNS rebinding. */
// A local hosts file may hijack a domain to a private address (ad-block lists, fake-ip leftovers).
// In that case, ask the DNS server directly for the real public record (the hosts file is ignored)
// and require the public-IP check on that answer too, then pin the connection to it.
//
// 解析结果按 host 缓存 60 秒：批量抓上千张图时，每张都重新 lookup 是纯浪费（实测单次 2~16ms，
// 上千张就是 10~30 秒），而且 CDN 地址在一分钟内不会变。**缓存里只放「已通过公网校验的地址」**，
// 所以缓存不会成为绕过校验的通道；连接失败时由调用方 `forgetHostAddress` 作废，下一次重新解析。
const DNS_TTL_MS = 60_000;
const DNS_CACHE = new Map();

async function resolvePublicAddress(host) {
  const cached = DNS_CACHE.get(host);
  if (cached && Date.now() - cached.at < DNS_TTL_MS) return cached.addresses;
  const direct = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  const ok = (list) => list.length && list.every(a => isPublicIP(a.address));
  if (ok(direct)) { DNS_CACHE.set(host, { addresses: direct, at: Date.now() }); return direct; }
  if (!net.isIP(host)) {
    try {
      const [a, v6] = await Promise.all([dns.resolve4(host).catch(() => []), dns.resolve6(host).catch(() => [])]);
      const pure = [...a.map(x => ({ address: x, family: 4 })), ...v6.map(x => ({ address: x, family: 6 }))];
      if (ok(pure)) { DNS_CACHE.set(host, { addresses: pure, at: Date.now() }); return pure; }
    } catch { /* fall through to the guard below */ }
  }
  if (!direct.length || direct.some(a => !isPublicIP(a.address))) throw new Error('目标域名解析到非公网地址，已阻止。如使用 Fake-IP 代理，请为此域名配置真实 DNS');
  return direct;
}

/** 地址缓存作废：连接级失败（换 IP、旧 IP 挂了）后让下一次重新解析，而不是死磕一个地址。 */
export function forgetHostAddress(host) {
  if (host) DNS_CACHE.delete(String(host).toLowerCase());
}

/** 连接复用（keep-alive）。图床上每张图重新握手是纯浪费：实测同一主机第二张起
 *  `tcp=0 tls=0`、首字节从 150~240ms 掉到 25~35ms，单张省 200ms 上下。
 *
 *  **复用不改变安全边界**：socket 仍是按 `lookup` 钉住的、已通过公网校验的地址建立的；
 *  池的 key 是 `protocol//host`，跨站点不会共用连接（不会把 A 站的 cookie 带到 B 站）。
 *  只复用「已经过校验的通道」，不复用校验过程本身。 */
const KEEPALIVE_AGENTS = new Map();
function agentFor(u) {
  const key = `${u.protocol}//${u.host}`;
  let agent = KEEPALIVE_AGENTS.get(key);
  if (!agent) {
    const Ctor = u.protocol === 'https:' ? https : http;
    agent = new Ctor.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 8, maxFreeSockets: 4 });
    KEEPALIVE_AGENTS.set(key, agent);
  }
  return agent;
}

/** 哪些站点「直连比走代理快」。这是**性能偏好，不是安全判定** —— 直连照样过完整的
 *  URL 校验、公网 IP 校验与 DNS pinning，只是不再绕一层 CONNECT 隧道。
 *
 *  实测（2026-11-08，花瓣 5 张原图）：走代理 489ms/张、8.7MB/s；直连 224ms/张、19.1MB/s。
 *  差在代理模式下每张都要新建隧道 + TLS，而且节点带宽有限 —— 上千张的板子差出十几分钟。
 *
 *  覆盖方式：`SFX_PROXY_BYPASS=foo.com,bar.cn` 追加域名；`SFX_PROXY_BYPASS=all` 全部直连；
 *  `SFX_PROXY_BYPASS=none` 关掉这张表（恢复「一律走代理」）。 */
const PROXY_DIRECT_HOSTS=Object.freeze([
  /(?:^|\.)huaban\.com$/i,      // 花瓣：站内 API 与图床（gd-hbimg / gd-hbimg-edge）都在国内
  /(?:^|\.)zcool\.com\.cn$/i,   // 站酷：同上
  /(?:^|\.)poco\.cn$/i,         // POCO：同上
]);

/** 这次该不该绕过代理。默认规则表 + 环境变量追加，认不出就老实走代理。 */
export function shouldBypassProxy(host, env=process.env){
  const extra=String(env.SFX_PROXY_BYPASS??'').trim();
  if(/^(?:none|off)$/i.test(extra))return false;
  if(/^(?:all|direct)$/i.test(extra))return true;
  const name=String(host||'').toLowerCase();
  if(!name)return false;
  if(PROXY_DIRECT_HOSTS.some(rule=>rule.test(name)))return true;
  return extra.split(',').map(item=>item.trim().toLowerCase()).filter(Boolean)
    .some(suffix=>name===suffix||name.endsWith('.'+suffix));
}

/** 连接级错误：说明这条通道（或它钉住的 IP）坏了，扔掉地址缓存与空闲 socket，让下一次重新建。 */
const STALE_CONNECTION = /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i;

const PROXY_ENV_KEYS=['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy'];
function parseProxy(raw){
  if(!raw)return null;
  const v=String(raw).trim();
  if(!v||/^(?:none|direct|off)$/i.test(v))return null;
  try{const p=new URL(v);return(p.protocol==='http:'||p.protocol==='https:')?p:null;}catch{return null;}
}
// Windows 上再兜底读系统代理（Edge/Chrome 走的就是它）。reg 不可用时静默跳过。
function systemProxyWindows(env){
  if(process.platform!=='win32'||env.SFX_NO_SYSTEM_PROXY==='1')return null;
  try{
    const out=execFileSync('reg',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],{encoding:'utf8',windowsHide:true,timeout:4000});
    if(!/ProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(out))return null;
    const server=(out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)||[])[1];
    if(!server)return null;
    const first=String(server).split(';')[0].trim();
    const cleaned=first.includes('=')?first.split('=').pop():first;
    return parseProxy(/^[a-z]+:\/\//i.test(cleaned)?cleaned:'http://'+cleaned);
  }catch{return null;}
}
/** HTTP(S) 出站代理：SFX_PROXY 优先且是显式开关 —— 写 none/direct/off 即强制直连，
 *  不再回落到 HTTPS_PROXY 或系统代理；否则读 HTTPS_PROXY/HTTP_PROXY 等环境变量，Windows 再兜底系统代理。 */
export function resolveProxy(env=process.env){
  const explicit=String(env.SFX_PROXY??'').trim();
  if(explicit){
    if(/^(?:none|direct|off)$/i.test(explicit))return null;
    const p=parseProxy(explicit);if(p)return p;
  }
  for(const key of PROXY_ENV_KEYS){const p=parseProxy(env[key]);if(p)return p;}
  return systemProxyWindows(env);
}
function proxyAuthHeader(proxy){
  if(!proxy||!proxy.username)return{};
  const raw=`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password||'')}`;
  return{'Proxy-Authorization':'Basic '+Buffer.from(raw).toString('base64')};
}
function proxyTunnel(proxy,hostname,port,signal){
  return new Promise((resolve,reject)=>{
    const req=(proxy.protocol==='https:'?https:http).request({host:proxy.hostname,port:Number(proxy.port||(proxy.protocol==='https:'?443:80)),method:'CONNECT',path:`${hostname}:${port}`,headers:proxyAuthHeader(proxy),...(proxy.protocol==='https:'?{rejectUnauthorized:true,ca:proxyCa()}: {})});
    const timer=setTimeout(()=>req.destroy(new Error('连接代理超时')),15000);
    const abort=()=>req.destroy(new Error('任务已取消'));
    signal?.addEventListener('abort',abort,{once:true});
    const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    req.on('connect',(res,socket)=>{done();if(res.statusCode!==200){socket.destroy();reject(new Error('代理 CONNECT 失败：HTTP '+res.statusCode));return;}resolve(socket);});
    req.on('error',(e)=>{done();reject(e);});
    req.end();
  });
}
function proxyTls(socket,hostname,ca){
  return new Promise((resolve,reject)=>{
    const s=tls.connect({socket,servername:hostname,rejectUnauthorized:true,...(ca?{ca}: {})});
    s.once('secureConnect',()=>resolve(s));
    s.once('error',error=>{s.destroy();reject(error);});
  });
}
// Optional explicit enterprise trust bundle. Never turn off certificate validation.
function proxyCa(){
  const file=process.env.SFX_PROXY_CA_FILE;
  if(!file)return undefined;
  try{return readFileSync(file);}catch{throw new Error('无法读取代理可信 CA 文件（SFX_PROXY_CA_FILE）');}
}

/** 代理隧道复用：key = `代理地址|目标站点`，每个 key 一个专属 keep-alive agent。
 *
 *  为什么需要：原来每张图都要走一遍 `CONNECT → 等 200 → TLS 握手`。实测代理模式 489ms/张、
 *  8.7MB/s，同一批图直连 224ms/张、19.1MB/s —— 差的主要就是这段握手被重复上千次。
 *
 *  **为什么是 agent，而不是自己维护一张 free 列表**：实测「`createConnection` 直接返回已有
 *  socket、不显式传 agent」时，Node 把每个请求都当一次性的 —— 请求头 `Connection: close`，
 *  每次新建连接（4 次请求 4 个不同的本地端口）。交给专属 agent 之后，同样 4 次请求只建
 *  1 条连接；keep-alive、并发上限、对端关闭后的清理都由 Node 负责，也就不会出现
 *  「两个响应抢同一条 socket」这种比慢严重得多的问题。
 *
 *  安全边界不变：隧道连到哪个主机、证书怎么校验，仍由 `proxyTunnel`/`proxyTls` 决定；
 *  复用只省掉重复握手；证书验证失败必须关闭连接，绝不降级。 */
const TUNNEL_AGENTS=new Map();
const TUNNEL_IDLE_MS=15_000;      // TCP keepalive 探测间隔
const TUNNEL_MAX_SOCKETS=6;       // 与图片下载的并发度对齐，避免池比任务还宽

const tunnelKey=(proxy,hostname,port,isHttps,ca)=>`${proxy.protocol}//${proxy.hostname}:${Number(proxy.port||80)}|${hostname}:${port}|${isHttps?'https':'http'}|${createHash('sha256').update(`${proxy.username||''}:${proxy.password||''}`).update(ca||'').digest('hex')}`;
/** 逃生开关：个别代理在复用的隧道上表现异常时，`SFX_NO_TUNNEL_POOL=1` 回到「每个请求新建」。 */
const TUNNEL_POOL_OFF=/^(?:1|true|yes|on)$/i.test(String(process.env.SFX_NO_TUNNEL_POOL||''));

/** 为「一个代理 + 一个目标站点」造专属 agent。`dial` 可注入，测试里用它接到本地 socket。 */
export function createTunnelAgent({proxy,hostname,port,isHttps=true,keepAlive=true,idleMs=TUNNEL_IDLE_MS,maxSockets=TUNNEL_MAX_SOCKETS,dial=null,ca=proxyCa()}={}){
  const Ctor=isHttps?https.Agent:http.Agent;
  const agent=new Ctor({keepAlive,keepAliveMsecs:idleMs,maxSockets,maxFreeSockets:Math.min(maxSockets,4)});
  let created=0;
  const openTunnel=dial||(async()=>{
    let socket=await proxyTunnel(proxy,hostname,Number(port));
    if(isHttps){
      try{socket=await proxyTls(socket,hostname,ca);}
      catch(error){socket.destroy();throw error;}
    }
    return socket;
  });
  // 只在 agent 认为需要新连接时才会被调用 —— 所以 `created` 就是「真实建了几条隧道」。
  agent.createConnection=(_options,callback)=>{
    created++;
    openTunnel().then(socket=>callback(null,socket),error=>callback(error));
    return undefined;
  };
  const stats=()=>({created,idle:Object.values(agent.freeSockets||{}).reduce((n,list)=>n+list.length,0)});
  return {agent,stats};
}

function tunnelAgentFor({proxy,hostname,port,isHttps}){
  const ca=proxyCa();
  const key=tunnelKey(proxy,hostname,port,isHttps,ca);
  let entry=TUNNEL_AGENTS.get(key);
  if(!entry){
    entry=createTunnelAgent({proxy,hostname,port,isHttps,ca,keepAlive:!TUNNEL_POOL_OFF});
    TUNNEL_AGENTS.set(key,entry);
  }
  return entry;
}

/** 诊断：每个「代理+站点」实际新建了几条隧道、当前空闲几条。`created` 远小于请求数就说明复用在生效。 */
export const tunnelPoolStats=()=>[...TUNNEL_AGENTS.entries()].map(([key,entry])=>({key,...entry.stats()}));

// 经代理出站：同一个「代理+站点」复用已建立的 CONNECT 隧道。
// 每一跳统一回到 openPublic，重新校验目标、凭据与路由。
async function openViaProxy(u,{proxy,signal,timeout,redirects,headers,method='GET',body=null,requestOptions}){
  const isHttps=u.protocol==='https:';
  const port=Number(u.port||(isHttps?443:80));
  const {agent}=tunnelAgentFor({proxy,hostname:u.hostname,port,isHttps});

  const send=()=>new Promise((resolve,reject)=>{
    const req=(isHttps?https:http).request({agent,host:u.hostname,port,path:u.pathname+u.search,method,signal,headers},resolve);
    req.setTimeout(timeout,()=>req.destroy(new Error('远程站点响应超时')));
    req.on('error',reject);
    req.end(body||undefined);
  });

  let res;
  try{
    res=await send();
  }catch(e){
    // 复用的空闲连接可能已经被对端关掉（代理换节点 / CDN 回收）：agent 会把它从池里摘掉，
    // 再发一次就会新建。只对连接级错误重试一次 —— 其他错误重试也没用。
    if(!STALE_CONNECTION.test(String(e.code||e.message)))throw e;
    res=await send();
  }
  if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){
    res.resume();if(redirects<=0)throw new Error('网页重定向过多');
    return followRedirect(u,res,requestOptions);
  }
  return {stream:res,status:res.statusCode,headers:res.headers,url:u.href};
}
/**
 * ArtStation 的 Cloudflare Bot Management 按 TLS 指纹拦人：Node 原生 https（以及系统 curl、
 * 手改 cipherSuites/sigalgs 的 Node TLS）都拿不到 `/projects/<hash>.json`、`/users/<u>.json`、
 * `/users/<u>/likes.json` —— 一律 403 挑战页。换 curl-impersonate 的浏览器指纹就能 200，
 * 所以这里在 403 时用同一份安全校验过的 URL 重试一次。
 *
 * 只有 GET、只有 ArtStation 域名、只有装了二进制时才降级；其余情况如实把响应交回调用方。
 */
function shouldImpersonate(status,{artstation,browserPrint,impersonate,method}){
  return status===403&&(artstation||browserPrint)&&impersonate!==false&&method==='GET'&&curlImpersonateAvailable();
}
/** Uiverse 这类「一口咬定 403」的站点：系统 curl 能 200、Node 原生 TLS 一律被拦，
 *  是 Cloudflare 按指纹挑人，不是 UA 或频率问题。这里换浏览器指纹再试一次，
 *  取第一个不是挑战页的响应。 */
const BROWSER_PRINT_FINGERPRINTS=Object.freeze(['chrome136','safari184']);
/** 「Node 原生 TLS 必定 403」的站点：先在 Node 上打一次只会白白多花一次往返
 *  （实测 uiverse.io 固定 403、耗时 ~200ms，之后仍要换指纹重打）。这些 host 在
 *  `browserPrint` 模式下直接走指纹通道，把每次请求的 1/3 时间省掉。 */
const PRINT_ONLY_HOSTS=Object.freeze([/(?:^|\.)uiverse\.io$/i]);
function mustBrowserPrint(host,{browserPrint,impersonate,method}){
  return browserPrint&&impersonate!==false&&method==='GET'&&curlImpersonateAvailable()
    &&PRINT_ONLY_HOSTS.some(rule=>rule.test(String(host||'')));
}
async function browserPrintFetch(url,{signal,timeout,proxy}){
  let last=null;
  for(const fingerprint of BROWSER_PRINT_FINGERPRINTS){
    signal?.throwIfAborted();
    const r=await curlImpersonateFetch(url,{fingerprint,signal,timeout,proxy});
    if(!(typeof looksLikeChallenge==='function'&&looksLikeChallenge(r.status,r.body)))return r;
    last=r;
  }
  return last;
}
async function openViaImpersonate(u,{signal,timeout,proxy,browserPrint}){
  const r=browserPrint?await browserPrintFetch(u.href,{signal,timeout,proxy}):await artstationFetch(u.href,{signal,timeout,proxy});
  return {stream:Readable.from([r.body]),status:r.status,headers:r.headers,url:u.href};
}

// Only transport-independent public headers may cross an origin boundary. Unknown
// caller headers may contain API keys, so do not try to enumerate every secret name.
const CROSS_ORIGIN_HEADERS=new Set(['accept','accept-language','accept-encoding','user-agent','content-type']);
function followRedirect(u,response,options){
  const next=validateUrl(new URL(response.headers.location,u).href,options);
  if(u.protocol==='https:'&&next.protocol==='http:')throw new Error('已阻止 HTTPS 降级重定向到 HTTP');
  const keepBody=[307,308].includes(response.statusCode);
  const headers=Object.fromEntries(Object.entries(options.headers||{}).filter(([name])=>{
    const key=name.toLowerCase();
    if(key==='host'||key==='proxy-authorization'||key==='proxy-authenticate')return false;
    if(!keepBody&&['content-length','content-type','transfer-encoding'].includes(key))return false;
    return next.origin===u.origin||CROSS_ORIGIN_HEADERS.has(key);
  }));
  return openPublic(next.href,{...options,redirects:options.redirects-1,headers,method:keepBody?options.method:'GET',body:keepBody?options.body:null});
}

/** GET by default; pass `method:'POST'` plus a serialised `body` for JSON APIs (ArtStation search).
 *  `useProxy:false` 强制直连：个别站点（如 500px 的 GraphQL）经本机系统代理会连不通或被判 403，
 *  调用方明确知道目标是固定可信域名时才会这么用。 */
export async function openPublic(value, { sketchfabOnly=false, artstation=false, browserPrint=false, signal, timeout=25000, redirects=5, method='GET', body=null, headers:extraHeaders=null, impersonate=true, useProxy=true, useCookies=true }={}) {
  const u=validateUrl(value,{sketchfabOnly,artstation});signal?.throwIfAborted();
  const host=u.hostname.replace(/^\[|\]$/g,'');
  const payload=body==null?null:Buffer.from(body);
  // Host is derived from the validated URL; proxy credentials belong only on CONNECT.
  extraHeaders=Object.fromEntries(Object.entries(extraHeaders||{}).map(([key,value])=>[key.toLowerCase(),value])
    .filter(([key])=>!['host','proxy-authorization','proxy-authenticate'].includes(key)));
  const requestOptions={sketchfabOnly,artstation,browserPrint,signal,timeout,redirects,method,body,headers:extraHeaders,impersonate,useProxy,useCookies};
  // 登录态 cookie：用户在这个站点登录过（或被浏览器跑过 WAF 挑战），就把域名匹配的 cookie 一起带上。
  // 只按域名匹配，所以不会误发给第三方 CDN；调用方显式给了 Cookie 时以调用方为准。
  const jarCookie=(!useCookies||Object.hasOwn(extraHeaders,'cookie'))?'':cookieHeaderFor(u.href);
  const headers={'User-Agent':'SketchfabLocalLibrary/1.0 (authorized personal model library)','Accept':'*/*','Accept-Encoding':'identity',...(isSketchfabHost(host)?{Referer:'https://sketchfab.com/'}:isArtstationHost(host)?{Referer:'https://www.artstation.com/'}:{}),...(payload?{'Content-Length':String(payload.length)}:{}),...(jarCookie?{Cookie:jarCookie}:{}),...(extraHeaders||{})};
  const proxy=useProxy?resolveProxy():null;
  const bypass=Boolean(proxy&&shouldBypassProxy(host));
  // 「必 403」的站点：跳过注定失败的 Node 请求，直接指纹通道（省一次约 200ms 的往返）。
  if(mustBrowserPrint(host,{browserPrint,impersonate,method})){
    const direct=await openViaImpersonate(u,{signal,timeout,proxy:bypass?null:proxy,browserPrint:true});
    if([301,302,303,307,308].includes(direct.status)&&direct.headers?.location){
      direct.stream.destroy();
      if(redirects<=0)throw new Error('网页重定向过多');
      return openPublic(new URL(direct.headers.location,u).href,{...requestOptions,redirects:redirects-1,method:'GET',body:null});
    }
    return direct;
  }
  if(proxy&&!bypass){
    const viaProxy=await openViaProxy(u,{proxy,signal,timeout,redirects,headers,method,body:payload,requestOptions});
    if(shouldImpersonate(viaProxy.status,{artstation,browserPrint,impersonate,method}))return openViaImpersonate(u,{signal,timeout,proxy,browserPrint});
    return viaProxy;
  }
  try{
    return await openDirect(u,{host,address:await resolvePublicAddress(host),payload,headers,signal,timeout,method,redirects,artstation,impersonate,requestOptions});
  }catch(e){
    // 规则表说「这个站点直连更快」，但这次真的连不上（换了网络 / 只有代理能出去）：
    // 退回代理再试一次。性能偏好永远不该变成「网站打不开」。
    if(!bypass||!STALE_CONNECTION.test(String(e.code||e.message)))throw e;
    const viaProxy=await openViaProxy(u,{proxy,signal,timeout,redirects,headers,method,body:payload,requestOptions});
    if(shouldImpersonate(viaProxy.status,{artstation,browserPrint,impersonate,method}))return openViaImpersonate(u,{signal,timeout,proxy,browserPrint});
    return viaProxy;
  }
}

/** 直连：DNS pinning + keep-alive，不走代理。 */
async function openDirect(u,{host,address:addresses,payload,headers,signal,timeout,method,redirects,artstation,impersonate,requestOptions}){
  if (!addresses.length || addresses.some(a=>!isPublicIP(a.address))) throw new Error('目标域名解析到非公网地址，已阻止。如使用 Fake-IP 代理，请为此域名配置真实 DNS');
  const address=addresses.find(a=>a.family===4)||addresses[0];
  const result=await new Promise((resolve,reject)=>{
    const req=(u.protocol==='https:'?https:http).request(u,{
      agent:agentFor(u),signal,method,rejectUnauthorized:true,
      lookup:(_h,opts,cb)=>opts?.all?cb(null,[address]):cb(null,address.address,address.family),
      headers,
    },response=>resolve(response));
    req.setTimeout(timeout,()=>req.destroy(new Error('远程站点响应超时')));
    // 通道坏了（旧 socket / 钉住的 IP 失联）：作废地址缓存，下一次重新解析并新建连接。
    req.on('error',e=>{if(STALE_CONNECTION.test(String(e.code||e.message)))forgetHostAddress(host);reject(e);});
    req.end(payload||undefined);
  });
  if ([301,302,303,307,308].includes(result.statusCode) && result.headers.location) {
    result.resume();if (redirects<=0) throw new Error('网页重定向过多');
    return followRedirect(u,result,requestOptions);
  }
  if (shouldImpersonate(result.statusCode,{artstation,browserPrint:requestOptions.browserPrint,impersonate,method})) {
    result.resume();                                    // 挑战页要读完再丢，否则 socket 会一直挂着
    return openViaImpersonate(u,{signal,timeout,proxy:null,browserPrint:requestOptions.browserPrint});
  }
  let stream=result;
  const encoding=String(result.headers['content-encoding']||'').toLowerCase();
  const decoder=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null;
  if(decoder){result.on('error',e=>decoder.destroy(e));stream=result.pipe(decoder);}
  stream.once('close',()=>{if(!result.complete)result.destroy();});
  return {stream,status:result.statusCode,headers:result.headers,url:u.href};
}
export async function readPublic(value, options={}) {
  const r=await openPublic(value,options);const chunks=[];let bytes=0;
  try {for await(const chunk of r.stream){bytes+=chunk.length;if(bytes>(options.maxBytes||8*1024*1024))throw new Error('网页或元数据过大，已停止读取');chunks.push(chunk);}}
  catch(e){r.stream.destroy();throw e;}
  const body=Buffer.concat(chunks);
  if(r.status<200||r.status>=300){const e=new Error(`远程站点返回 HTTP ${r.status}${[401,403].includes(r.status)?'：需要权限或站点拒绝访问，未尝试绕过':''}`);e.status=r.status;throw e;}
  return {...r,body};
}
export async function publicJson(url,options={}) {
  const r=await readPublic(url,{...options,sketchfabOnly:true});
  try{return JSON.parse(r.body.toString('utf8'));}catch{throw new Error('站点返回的不是有效模型数据');}
}
