// 安装 curl-impersonate：一个把 ClientHello 伪装成真实浏览器（Chrome/Safari/Firefox）的 curl 构建。
//
// 为什么需要它：artstation.com 挂在 Cloudflare Bot Management（企业档）后面，靠 JA3/JA4 指纹
// 判定客户端。Node 的 https、系统 curl 都只能拿到一部分端点的 200，`/projects/<hash>.json`、
// `/users/<u>.json`、`/users/<u>/likes.json` 一律 403 挑战页（实测 2026-09）。
// curl-impersonate 用浏览器自己的 TLS 栈，这几个端点直接 200。
//
// 只装可执行文件与许可证；`.bat` 包装脚本不需要——调用方直接传 `--impersonate <target>`。
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {createWriteStream} from 'node:fs';
import {fileURLToPath} from 'node:url';

/** 解 gzip + tar，返回 Map<路径, Buffer>。
 *
 *  不调系统 tar：在 Git Bash 里 spawn('tar') 拿到的是 GNU tar，它把 `H:/…` 的盘符
 *  当成远程主机（`host:path`），直接报 "Cannot connect to H:"；而 Windows 自带的
 *  bsdtar 又认不得 GNU 那套选项。自己解只依赖 node:zlib，任何 shell 下结果一致。 */
function extractTarGz(buf){
  const tar=zlib.gunzipSync(buf);
  const str=(b,start,len)=>Buffer.from(b.subarray(start,start+len)).toString('utf8').replace(/\0[\s\S]*$/,'');
  const out=new Map();
  let off=0,pendingName=null;
  while(off+512<=tar.length){
    const header=tar.subarray(off,off+512);
    if(header.every(b=>b===0))break;                       // 结束块
    const name=str(header,0,100);
    const size=parseInt(str(header,124,12).trim(),8)||0;
    const type=String.fromCharCode(header[156]||0x30);
    const prefix=str(header,345,155);
    const full=pendingName||(prefix?`${prefix}/${name}`:name);
    const body=off+512;
    const bytes=Math.ceil(size/512)*512;
    if(type==='L')pendingName=str(tar,body,size);          // GNU long name 覆盖下一条
    else if(type==='x'||type==='g'){/* PAX 扩展头：本身不是文件，跳过 */}
    else if(type==='0'||type==='\u0000'||type===''){out.set(full,Buffer.from(tar.subarray(body,body+size)));pendingName=null;}
    else pendingName=null;
    off=body+bytes;
  }
  return out;
}

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const VERSION=process.env.CURL_IMPERSONATE_VERSION||'2.2.3';
const REPO='lexiforest/curl-impersonate';

const isWin=process.platform==='win32';
const arch=process.arch==='arm64'?'arm64':'x86_64';
const platform=process.platform==='win32'?'win32'
  :process.platform==='darwin'?'macos'
  :process.platform==='linux'?'linux-gnu'
  :null;
if(!platform)throw Error('仅支持 Windows / Linux / macOS');
const asset=`curl-impersonate-v${VERSION}.${arch}-${platform}.tar.gz`;
const url=`https://github.com/${REPO}/releases/download/v${VERSION}/${asset}`;

const dir=path.join(root,'vendor','curl-impersonate');
const exeName=isWin?'curl-impersonate.exe':'curl-impersonate';
const target=path.join(dir,exeName);
if(fs.existsSync(target)){console.log(`已存在：${target}\n如需更新请先删除该文件，或设置 CURL_IMPERSONATE_VERSION 指定其他版本。`);process.exit(0);}

console.log(`下载 curl-impersonate v${VERSION}（${arch}-${platform}）…`);
console.log(url);
const res=await fetch(url,{redirect:'follow'});
if(!res.ok)throw Error(`下载失败：HTTP ${res.status}（若为 404，请确认该版本是否有 ${arch}-${platform} 构建）`);
await fsp.mkdir(dir,{recursive:true});

const tmp=path.join(dir,`.dl-${process.pid}-${Date.now()}.tar.gz`);
const ws=createWriteStream(tmp);
try{
  for await(const chunk of res.body)ws.write(chunk);
  await new Promise((r,j)=>{ws.end();ws.on('finish',r);ws.on('error',j);});
}catch(e){await fsp.unlink(tmp).catch(()=>{});throw Error(`下载中断：${e.message}`);}

// .tar.gz 自己解（见 extractTarGz）：Windows 的 bsdtar / Git Bash 的 GNU tar 各有各的坑，
// 而这里只需要取出一两个文件，不值得为解压引入系统工具依赖。
let entries;
try{
  entries=extractTarGz(await fsp.readFile(tmp));
}catch(e){
  await fsp.unlink(tmp).catch(()=>{});
  throw Error(`解压失败：${e.message}`);
}

try{
  const byName=[...entries].map(([name,data])=>({name,base:path.posix.basename(name),data}));
  const exe=byName.find(f=>f.base===exeName);
  if(!exe)throw Error(`压缩包中未找到 ${exeName}`);

  await fsp.writeFile(target,exe.data);
  if(!isWin)await fsp.chmod(target,0o755);
  // 许可证随二进制一起留下：vendored 二进制必须能就地看到它的出处与条款。
  const licenses=byName.filter(f=>/^LICENSE/i.test(f.base));
  for(const lic of licenses)await fsp.writeFile(path.join(dir,lic.base),lic.data);
  await fsp.writeFile(path.join(dir,'SOURCE.txt'),
    `curl-impersonate v${VERSION}（${arch}-${platform}）\n来源：https://github.com/${REPO}/releases/tag/v${VERSION}\n资产：${asset}\n\n用途：为 ArtStation 出站请求提供浏览器 TLS 指纹，绕过该站点的 Cloudflare 指纹拦截。\n许可证见同目录 LICENSE*（curl 为 MIT-like；BoringSSL/nghttp2/ngtcp2 等组件各有其许可证）。\n`,'utf8');

  console.log(`完成：${target}（含 ${licenses.length} 个许可证文件）`);
}catch(e){
  throw Error(`安装失败：${e.message}`);
}finally{
  await fsp.unlink(tmp).catch(()=>{});
}
