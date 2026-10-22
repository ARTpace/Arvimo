import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { Readable } from 'node:stream';
import { artstationFetch, curlImpersonateAvailable } from './curl-impersonate.mjs';

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
async function resolvePublicAddress(host) {
  const direct = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (direct.length && direct.every(a => isPublicIP(a.address))) return direct;
  if (!net.isIP(host)) {
    try {
      const [a, v6] = await Promise.all([dns.resolve4(host).catch(() => []), dns.resolve6(host).catch(() => [])]);
      const pure = [...a.map(x => ({ address: x, family: 4 })), ...v6.map(x => ({ address: x, family: 6 }))];
      if (pure.length && pure.every(x => isPublicIP(x.address))) return pure;
    } catch { /* fall through to the guard below */ }
  }
  if (!direct.length || direct.some(a => !isPublicIP(a.address))) throw new Error('目标域名解析到非公网地址，已阻止。如使用 Fake-IP 代理，请为此域名配置真实 DNS');
  return direct;
}

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
    const req=http.request({host:proxy.hostname,port:Number(proxy.port||80),method:'CONNECT',path:`${hostname}:${port}`,headers:proxyAuthHeader(proxy)});
    const timer=setTimeout(()=>req.destroy(new Error('连接代理超时')),15000);
    const abort=()=>req.destroy(new Error('任务已取消'));
    signal?.addEventListener('abort',abort,{once:true});
    const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    req.on('connect',(res,socket)=>{done();if(res.statusCode!==200){socket.destroy();reject(new Error('代理 CONNECT 失败：HTTP '+res.statusCode));return;}resolve(socket);});
    req.on('error',(e)=>{done();reject(e);});
    req.end();
  });
}
function proxyTls(socket,hostname,verify){
  return new Promise((resolve,reject)=>{
    const s=tls.connect({socket,servername:hostname,rejectUnauthorized:verify});
    s.once('secureConnect',()=>resolve(s));
    s.once('error',reject);
  });
}
const TLS_CERT_ERR=/CERT|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO|certificate/i;
// 经代理出站：CONNECT 隧道 + TLS。默认校验证书，遇到 MITM 代理的证书错误再降级重连一次。
async function openViaProxy(u,{proxy,signal,timeout,redirects,headers}){
  const isHttps=u.protocol==='https:';
  const port=Number(u.port||(isHttps?443:80));
  let socket=await proxyTunnel(proxy,u.hostname,port,signal);
  if(isHttps){
    try{socket=await proxyTls(socket,u.hostname,process.env.SFX_PROXY_VERIFY==='1');}
    catch(e){
      if(!TLS_CERT_ERR.test(String(e.code||e.message)))throw e;
      try{socket.destroy();}catch{}
      socket=await proxyTls(await proxyTunnel(proxy,u.hostname,port,signal),u.hostname,false);
    }
  }
  const res=await new Promise((resolve,reject)=>{
    const req=http.request({createConnection:()=>socket,host:u.hostname,port,path:u.pathname+u.search,method:'GET',headers:{Host:u.hostname,...headers}});
    req.setTimeout(timeout,()=>req.destroy(new Error('远程站点响应超时')));
    req.on('response',resolve);req.on('error',reject);req.end();
  });
  if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){
    res.resume();if(redirects<=0)throw new Error('网页重定向过多');
    const next=validateUrl(new URL(res.headers.location,u).href,{});
    try{socket.destroy();}catch{}
    return openViaProxy(next,{proxy,signal,timeout,redirects:redirects-1,headers});
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
function shouldImpersonate(status,{artstation,impersonate,method}){
  return status===403&&artstation&&impersonate!==false&&method==='GET'&&curlImpersonateAvailable();
}
async function openViaImpersonate(u,{signal,timeout,proxy}){
  const r=await artstationFetch(u.href,{signal,timeout,proxy});
  return {stream:Readable.from([r.body]),status:r.status,headers:r.headers,url:u.href};
}

/** GET by default; pass `method:'POST'` plus a serialised `body` for JSON APIs (ArtStation search). */
export async function openPublic(value, { sketchfabOnly=false, artstation=false, signal, timeout=25000, redirects=5, method='GET', body=null, headers:extraHeaders=null, impersonate=true }={}) {
  const u=validateUrl(value,{sketchfabOnly,artstation});signal?.throwIfAborted();
  const host=u.hostname.replace(/^\[|\]$/g,'');
  const payload=body==null?null:Buffer.from(body);
  const headers={'User-Agent':'SketchfabLocalLibrary/1.0 (authorized personal model library)','Accept':'*/*','Accept-Encoding':'identity',...(isSketchfabHost(host)?{Referer:'https://sketchfab.com/'}:isArtstationHost(host)?{Referer:'https://www.artstation.com/'}:{}),...(payload?{'Content-Length':String(payload.length)}:{}),...(extraHeaders||{})};
  const proxy=resolveProxy();
  if(proxy){
    const viaProxy=await openViaProxy(u,{proxy,signal,timeout,redirects,headers,method,body:payload});
    if(shouldImpersonate(viaProxy.status,{artstation,impersonate,method}))return openViaImpersonate(u,{signal,timeout,proxy});
    return viaProxy;
  }
  const addresses=await resolvePublicAddress(host);
  if (!addresses.length || addresses.some(a=>!isPublicIP(a.address))) throw new Error('目标域名解析到非公网地址，已阻止。如使用 Fake-IP 代理，请为此域名配置真实 DNS');
  const address=addresses.find(a=>a.family===4)||addresses[0];
  const result=await new Promise((resolve,reject)=>{
    const req=(u.protocol==='https:'?https:http).request(u,{
      agent:false,signal,method,
      lookup:(_h,opts,cb)=>opts?.all?cb(null,[address]):cb(null,address.address,address.family),
      headers,
    },response=>resolve(response));
    req.setTimeout(timeout,()=>req.destroy(new Error('远程站点响应超时')));req.on('error',reject);req.end(payload||undefined);
  });
  if ([301,302,303,307,308].includes(result.statusCode) && result.headers.location) {
    result.resume();if (redirects<=0) throw new Error('网页重定向过多');
    const keepBody=[307,308].includes(result.statusCode);
    return openPublic(new URL(result.headers.location,u).href,{sketchfabOnly,artstation,signal,timeout,redirects:redirects-1,method:keepBody?method:'GET',body:keepBody?body:null,headers:keepBody?extraHeaders:null,impersonate});
  }
  if (shouldImpersonate(result.statusCode,{artstation,impersonate,method})) {
    result.resume();                                    // 挑战页要读完再丢，否则 socket 会一直挂着
    return openViaImpersonate(u,{signal,timeout,proxy:null});
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
