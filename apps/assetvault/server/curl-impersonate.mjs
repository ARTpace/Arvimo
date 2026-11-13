// curl-impersonate 出站层。
//
// ArtStation 挂在 Cloudflare Bot Management（企业档）后面，按 JA3/JA4 指纹判定客户端。
// Node 的 https 只能拿到一部分端点的 200；`/projects/<hash>.json`、`/users/<u>.json`、
// `/users/<u>/likes.json` 一律 403 挑战页。连系统 curl 和裸 Node TLS 冒充 Chrome
// （自定义 cipherSuites/sigalgs/ecdhCurve）也过不去 —— 实测都是 403。
//
// 只有整套浏览器 TLS 栈可行。这里调 vendor 里的 curl-impersonate（lexiforest 构建），
// 用 `--impersonate <target>` 指定指纹。
//
// 指纹不是随便挑的（实测 2026-09-21，同一 IP、同一分钟内）：
//   safari184   → 详情 200 / 用户 200 / 点赞 200
//   firefox147  → 详情 200 / 用户 200 / 点赞 200
//   safari260   → 200
//   chrome136   → 详情 403 / 点赞 403      ← 新版 Chrome 指纹反而被拦
//   chrome142   → 详情 403 / 点赞 403
// 所以默认列表把 Safari/Firefox 排在前面，Chrome 只作为最后的兜底。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export const CURL_IMPERSONATE_VERSION='2.2.3';

/** 浏览器指纹尝试顺序。顺序本身是实测结论，不是偏好——见文件头。 */
export const ARTSTATION_FINGERPRINTS=Object.freeze(['safari184','firefox147','safari260','firefox144','chrome136','chrome142']);

export const DEFAULT_MAX_BYTES=32*1024*1024;

/** `SFX_CURL_IMPERSONATE`（显式路径）→ `vendor/curl-impersonate/` → PATH 上的同名程序；找不到返回 null。 */
export function curlImpersonateBinary(){
  const fromEnv=process.env.SFX_CURL_IMPERSONATE;
  if(fromEnv&&fs.existsSync(fromEnv))return fromEnv;
  const name=process.platform==='win32'?'curl-impersonate.exe':'curl-impersonate';
  const local=path.join(root,'vendor','curl-impersonate',name);
  if(fs.existsSync(local))return local;
  return null;
}

export function curlImpersonateAvailable(){return curlImpersonateBinary()!==null;}

export function curlImpersonateInfo(){
  const bin=curlImpersonateBinary();
  return {available:bin!==null,bin,version:CURL_IMPERSONATE_VERSION,fingerprints:[...ARTSTATION_FINGERPRINTS]};
}

/** Cloudflare 的挑战/拦截页：状态码可能是 403/503，但正文是 HTML 而不是我们要的 JSON。
 *
 *  注意 CF 有两套页面，文案完全不同：JS 挑战页有 `challenge-platform` / "Just a moment"，
 *  而直接拦下的 block 页只有 `cf_challenge_text_small` 这类 class —— 只匹配前者会漏判
 *  （实测 chrome136 被拦时正则是 false）。所以这里把两类特征都收进来。 */
export function looksLikeChallenge(status,body){
  if(status!==403&&status!==503)return false;
  const head=Buffer.isBuffer(body)?body.subarray(0,8192).toString('utf8'):String(body||'').slice(0,8192);
  return /challenge-platform|cf_chl|cf-chl|cf_challenge|cf-please-wait|Just a moment|Attention Required|Enable JavaScript and cookies/i.test(head);
}

function decodeBody(body,encoding){
  const e=String(encoding||'').toLowerCase();
  try{
    if(e.includes('gzip'))return zlib.gunzipSync(body);
    if(e.includes('deflate'))return zlib.inflateSync(body);
    if(e.includes('br'))return zlib.brotliDecompressSync(body);
    if(e.includes('zstd')&&typeof zlib.zstdDecompressSync==='function')return zlib.zstdDecompressSync(body);
  }catch{/* 解压失败就原样返回，让调用方按 JSON 解析失败去报错 */ }
  return body;
}

/** `-D` 记录的是每个跳转的响应头，取最后一段（真正的那次响应）。 */
function parseHeaderFile(text){
  const blocks=String(text||'').split(/\r?\n\r?\n/).filter(b=>/^HTTP\//i.test(b.trim()));
  const last=blocks[blocks.length-1];
  if(!last)return {status:0,headers:{}};
  const lines=last.split(/\r?\n/);
  const status=Number((lines[0].match(/^HTTP\/[\d.]+\s+(\d{3})/)||[])[1])||0;
  const headers={};
  for(const line of lines.slice(1)){
    const i=line.indexOf(':');
    if(i<=0)continue;
    const key=line.slice(0,i).trim().toLowerCase();
    const value=line.slice(i+1).trim();
    headers[key]=headers[key]?`${headers[key]}, ${value}`:value;
  }
  return {status,headers};
}

let headerSeq=0;

/**
 * 用指定指纹取一个 URL。整体缓冲后返回（ArtStation 的 JSON 接口最大也就几百 KB）。
 * 返回 `{status,headers,body,url,fingerprint}`；`body` 已按 content-encoding 解压。
 */
export function curlImpersonateFetch(url,{fingerprint='safari184',timeout=30000,headers=null,maxBytes=DEFAULT_MAX_BYTES,signal,proxy=null,caFile=process.env.SFX_PROXY_CA_FILE}={}){
  return new Promise((resolve,reject)=>{
    const bin=curlImpersonateBinary();
    if(!bin)return reject(Error('未找到 curl-impersonate。请先运行 npm run fetch:curl-impersonate（或设置 SFX_CURL_IMPERSONATE 指向可执行文件）。'));
    const hdrFile=path.join(os.tmpdir(),`sfx-ci-${process.pid}-${headerSeq++}-${Date.now()}.hdr`);
    const args=[
      '-q', // Must be first: do not inherit curlrc (including insecure/proxy/header options).
      '--impersonate',fingerprint,
      '-sS','--proto','=http,https', // Single hop only; caller validates every redirect.
      '--max-time',String(Math.max(1,Math.ceil(timeout/1000))),
      '-D',hdrFile,'-o','-',            // 头写临时文件，正文走 stdout
      '--proxy',proxy?`${proxy.protocol}//${proxy.host}`:'', // Ignore ambient proxy variables when explicitly direct.
      ...(caFile?['--cacert',caFile,...(proxy?.protocol==='https:'?['--proxy-cacert',caFile]:[])]:[]),
      ...(headers?Object.entries(headers).flatMap(([k,v])=>['-H',`${k}: ${v}`]):[]),
      url,
    ];
    const child=spawn(bin,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const chunks=[];const errChunks=[];
    let bytes=0,killed=false,failure=null,timer;
    const finish=err=>{
      if(killed)return;
      killed=true;
      clearTimeout(timer);
      signal?.removeEventListener('abort',onAbort);
      let headerText='';
      if(!err)try{headerText=fs.readFileSync(hdrFile,'utf8');}catch{/* 进程没来得及写：按无头处理 */}
      fsp.unlink(hdrFile).catch(()=>{});
      if(err)return reject(err);
      const {status,headers:parsedHeaders}=parseHeaderFile(headerText);
      if(!status){
        return reject(Error('curl-impersonate 未返回有效响应'));
      }
      const body=decodeBody(Buffer.concat(chunks),parsedHeaders['content-encoding']);
      if(parsedHeaders['content-encoding'])delete parsedHeaders['content-encoding'];
      if(parsedHeaders['content-length'])parsedHeaders['content-length']=String(body.length);
      resolve({status,headers:parsedHeaders,body,url,fingerprint});
    };
    const onAbort=()=>{try{child.kill('SIGKILL');}catch{}finish(Error('任务已取消'));};
    if(signal?.aborted)return onAbort();
    signal?.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}finish(Error('远程站点响应超时'));},timeout+5000);
    child.stdout.on('data',c=>{
      bytes+=c.length;
      if(bytes>maxBytes){failure=Error('响应体过大，已停止读取');try{child.kill('SIGKILL');}catch{}return;}
      chunks.push(c);
    });
    child.stderr.on('data',c=>{if(errChunks.length<16)errChunks.push(c);});
    child.on('error',e=>finish(e.code==='ENOENT'?Error('curl-impersonate 无法执行：请重新运行 npm run fetch:curl-impersonate'):e));
    child.on('close',(code,signal)=>finish(failure||(code===0?null:Error(`curl-impersonate 请求失败（${code===null?'进程中断':'退出码 '+code}）`))));
  });
}

/** 这一层只用来打 JSON 接口，所以"该给 JSON 却给了 HTML"本身就是被拦的铁证——
 *  比匹配 CF 的任意一种文案更可靠（拦截页的措辞他们随时会换）。 */
function rejectedJson(r){
  if(looksLikeChallenge(r.status,r.body))return true;
  const ct=String(r.headers['content-type']||'').toLowerCase();
  return r.status>=400&&ct.includes('text/html');
}

/**
 * 依次尝试指纹直到拿到非挑战响应。命中并返回那一次的结果。
 * 全部被拦时抛出错误，并带上每个指纹的状态，方便判断是限流还是真被墙。
 */
export async function artstationFetch(url,{fingerprints=ARTSTATION_FINGERPRINTS,signal,timeout=30000,headers,maxBytes,proxy}={}){
  const tried=[];
  for(const fingerprint of fingerprints){
    signal?.throwIfAborted();
    const r=await curlImpersonateFetch(url,{fingerprint,signal,timeout,headers,maxBytes,proxy});
    if(!rejectedJson(r))return r;
    tried.push(`${fingerprint}=${r.status}`);
  }
  throw Error(`ArtStation 拒绝了全部 ${fingerprints.length} 个浏览器指纹（${tried.join(', ')}）。通常是短时间内请求过多触发了限流，稍后再试。`);
}
