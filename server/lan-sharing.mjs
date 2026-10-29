import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';

const SESSION_MS=12*60*60*1000;
const MAX_NAMES=6;   // one device IP can be shared by a few people; keep the most recent names
const validPort=port=>Number.isInteger(port)&&port>0&&port<=65535;
const privateIP=ip=>/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip);
const normalizeIP=ip=>String(ip||'').replace(/^::ffff:/,'');
const loopback=ip=>ip==='127.0.0.1'||ip==='::1';
const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));return true;};
async function readBody(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>8192)throw Error('请求过大');}return text;}
// The name is only a label the host sees in its device list, so it is restricted to a
// whitespace-free-ish whitelist: that also makes echoing it back into the form attribute safe.
const NAME_RE=/^[\p{L}\p{N}_.\- ]{1,24}$/u;
const NAME_ERROR='请填写你的名字：1–24 个字符，可用中英文、数字、空格、下划线、点或连字符。';
const attr=value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const loginPage=(error='',username='')=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AssetVault · 局域网访问</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101820;color:#dce5ee;font:15px system-ui}main{width:min(340px,80vw);padding:32px;border:1px solid #30414f;border-radius:18px;background:#17222c}h1{font-size:25px;margin:0 0 8px}p{color:#9badbc;line-height:1.7}input,button{box-sizing:border-box;width:100%;padding:13px;border-radius:9px;border:1px solid #394e5f;font:inherit}input{background:#101820;color:#eee;margin:8px 0 14px}button{background:#c9f581;color:#192613;cursor:pointer}.error{color:#edaa89}</style><main><h1>AssetVault</h1><p>填写你的名字和主机设置的共享密码，访问同一资产库。</p>${error?`<p class="error">${error}</p>`:''}<form method="post" action="/api/lan/login"><label for="username">你的名字</label><input id="username" name="username" type="text" autocomplete="nickname" required autofocus maxlength="24" value="${attr(username)}"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128"><button type="submit">进入资产库</button></form></main></html>`;

export function createLanSharing({file,interfaces=()=>os.networkInterfaces(),now=Date.now}){ let config={enabled:false,salt:'',hash:''},configError='';
 let listener=null;
 try{
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  if(typeof saved.enabled!=='boolean'||!/^([a-f0-9]{32}|)$/.test(saved.salt)||!/^([a-f0-9]{64}|)$/.test(saved.hash)||saved.enabled&&(!saved.hash||!saved.salt))throw Error('配置无效');
  if(saved.port!==undefined&&!validPort(saved.port))throw Error('共享端口无效');
  config={enabled:saved.enabled,salt:saved.salt,hash:saved.hash,port:saved.port,previousPort:validPort(saved.previousPort)?saved.previousPort:undefined,portReview:saved.portReview===true};
 }catch(e){if(e.code!=='ENOENT')configError='共享配置读取失败，已关闭共享。请重新保存设置。';}
 const sessions=new Map(),attempts=new Map();
 const clientsFile=file+'.clients.json';
 const clients=new Map();
 try{
  for(const item of JSON.parse(fs.readFileSync(clientsFile,'utf8'))){
   if(privateIP(item.ip)&&Number.isFinite(item.firstSeen)&&Number.isFinite(item.lastSeen))clients.set(item.ip,{ip:item.ip,firstSeen:item.firstSeen,lastSeen:item.lastSeen,blocked:item.blocked===true,usernames:Array.isArray(item.usernames)?item.usernames.filter(name=>typeof name==='string'&&NAME_RE.test(name)).slice(-MAX_NAMES):[]});
  }
 }catch(e){if(e.code!=='ENOENT')throw Error('局域网设备记录读取失败，请检查 '+clientsFile);}
 function saveClients(){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(clientsFile+'.tmp',JSON.stringify([...clients.values()]),{mode:0o600});fs.renameSync(clientsFile+'.tmp',clientsFile);
 }
 // ponytail: identify devices by socket IP; DHCP changes require blocking the new IP again.
 function clientStatus(){
  const list=[...clients.values()].map(item=>{
   const active=[...sessions.values()].filter(session=>session.ip===item.ip&&session.expires>now());
   return {...item,usernames:[...(item.usernames||[])],onlineUsers:[...new Set(active.map(session=>session.username).filter(Boolean))],online:!item.blocked&&active.length>0&&now()-item.lastSeen<5*60*1000};
  });
  return {total:list.length,online:list.filter(item=>item.online).length,clients:list.sort((a,b)=>b.lastSeen-a.lastSeen)};
 }
 const addresses=()=>[...new Set(Object.values(interfaces()).flat().filter(item=>item.family==='IPv4'&&!item.internal&&privateIP(item.address)).map(item=>item.address))];
 function saveConfig(next){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(next),{mode:0o600});fs.renameSync(temp,file);
  config=next;configError='';
 }
 const status=port=>{
  const sharingPort=config.port||4178,state=listener?.state();
  const available=config.enabled&&(state?state.activePort===sharingPort:!config.port||port===sharingPort);
  const portConflict=config.enabled&&!!state&&['EADDRINUSE','EACCES'].includes(state.errorCode);
  return {enabled:config.enabled,available,hasPassword:!!config.hash,port,sharingPort,portConflict,
   portChanged:config.enabled&&(config.portReview===true||!!config.previousPort&&config.previousPort!==sharingPort),previousPort:config.previousPort,
   addresses:available?(state?.hosts||addresses()).map(ip=>`http://${ip}:${sharingPort}/`):[],error:configError||state?.error||''};
 };
 function startupPort(preferred){
  if(!config.enabled)return preferred;
  // 旧配置首次升级时沿用上次运行端口，此后分享端口不随本机回退而改变。
  if(!config.port)saveConfig({...config,port:preferred,portReview:true});
  // portReview/previousPort 只是「那一次迁移」的待确认提示，落盘后必须在下次启动前清掉，
  // 否则 status() 永远报 portChanged，前端每次启动都会把设置页掀开。
  // 用户主动改端口时的提示由那次 POST 的响应负责，不依赖这两个字段的持久化。
  else if(config.portReview===true||config.previousPort!==undefined)saveConfig({...config,portReview:false,previousPort:undefined});
  return config.port;
 }
 async function configure(input,port){
  if(typeof input.enabled!=='boolean')throw Error('共享开关格式无效');
  const next={...config,enabled:input.enabled};
  if(input.password!==undefined&&input.password!==''){
   if(typeof input.password!=='string'||input.password.length<8||input.password.length>128)throw Error('访问密码须为 8–128 个字符');
   next.salt=randomBytes(16).toString('hex');next.hash=scryptSync(input.password,next.salt,32).toString('hex');
  }
  if(next.enabled&&!next.hash)throw Error('首次启用共享请设置访问密码');
  if(input.useCurrentPort===true)throw Error('分享端口已独立，请填写新的局域网分享端口');
  if(input.sharingPort!==undefined&&!validPort(input.sharingPort))throw Error('分享端口须为 1–65535 的整数');
  const requested=input.sharingPort??next.port??4178;
  if(input.sharingPort!==undefined&&listener&&requested===listener.state().localPort)throw Error('分享端口不能与本机入口端口相同，请选择其他端口');
  if(next.port&&requested!==next.port)next.previousPort=next.port;
  next.port=requested;
  if(input.acknowledgePortChange===true){delete next.previousPort;delete next.portReview;}
  const revoke=next.enabled!==config.enabled||next.hash!==config.hash||next.port!==config.port;
  saveConfig(next);if(revoke){sessions.clear();attempts.clear();}
  await listener?.sync();return status(port);
 }
 // no-referrer turns an HTTP form POST's Origin into null; keep it only within this origin.
 function html(res,error='',statusCode=200,username=''){res.writeHead(statusCode,{'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(loginPage(error,username));return true;}
 async function handle(req,res){
  const port=req.socket.localPort,ip=normalizeIP(req.socket.remoteAddress),host=req.headers.host;
  const localHosts=[`127.0.0.1:${port}`,`localhost:${port}`];
  const local=loopback(ip)&&localHosts.includes(host);
  if(!local&&config.enabled&&config.port&&config.port!==port)return reply(res,403,{error:'共享端口被占用，局域网共享已暂停，请联系主机确认新链接'});
  const allowedHosts=[...localHosts,...(config.enabled?addresses().map(address=>`${address}:${port}`):[])];
  if(!allowedHosts.includes(host)||!local&&!privateIP(ip))return reply(res,403,{error:'局域网共享未开启或访问地址不受支持'});
  const origin=req.headers.origin;
  const pathname=new URL(req.url,`http://${host}`).pathname;
  // Opening a LAN link from localhost is a cross-site navigation, not an API request.
  const entryNavigation=req.method==='GET'&&['/','/splash.html'].includes(pathname)&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
  if(origin&&origin!==`http://${host}`||req.headers['sec-fetch-site']==='cross-site'&&!entryNavigation)return reply(res,403,{error:'禁止跨站请求'});
  if(pathname==='/api/lan/settings'||pathname==='/api/lan/clients'){
   if(!local)return reply(res,403,{error:'共享设置只能在主机本地修改'});
   if(req.headers['x-sfx-local']!=='1')return reply(res,403,{error:'缺少本地请求标识'});
   if(pathname==='/api/lan/clients'){
    if(req.method==='GET')return reply(res,200,clientStatus());
    if(req.method!=='POST')return reply(res,405,{error:'请求方法不支持'});
    const input=JSON.parse(await readBody(req)),client=clients.get(input.ip);
    if(!client||typeof input.blocked!=='boolean')return reply(res,400,{error:'设备或禁用状态无效'});
    const previous=client.blocked;client.blocked=input.blocked;
    try{saveClients();}catch(e){client.blocked=previous;throw e;}
    if(client.blocked)for(const [key,session] of sessions)if(session.ip===client.ip)sessions.delete(key);
    return reply(res,200,clientStatus());
   }
   if(req.method==='GET')return reply(res,200,status(port));
   if(req.method==='POST')return reply(res,200,await configure(JSON.parse(await readBody(req)),port));
   return reply(res,405,{error:'请求方法不支持'});
  }
  if(local)return false;
  if(!config.enabled)return reply(res,403,{error:'局域网共享已关闭'});
  let client=clients.get(ip);
  if(!client){client={ip,firstSeen:now(),lastSeen:now(),blocked:false,usernames:[]};clients.set(ip,client);saveClients();}
  if(client.blocked)return reply(res,403,{error:'此设备已被主机禁用，请联系管理员'});
  client.lastSeen=now();
  if(pathname==='/api/lan/login'&&req.method==='POST'){
   const params=new URLSearchParams(await readBody(req));
   const username=String(params.get('username')||'').trim();
   if(!NAME_RE.test(username))return html(res,NAME_ERROR,401);
   const time=now();for(const [key,value] of attempts)if(value.until<=time)attempts.delete(key);
   const attempt=attempts.get(ip)||{count:0,until:time+15*60*1000};
   if(attempt.count>=5||attempts.size>=256&&!attempts.has(ip))return reply(res,429,{error:'尝试次数过多，请 15 分钟后重试'});
   attempt.count++;attempts.set(ip,attempt);
   const password=params.get('password')||'';
   if(password.length>128||!timingSafeEqual(scryptSync(password,config.salt,32),Buffer.from(config.hash,'hex')))return html(res,'密码不正确，请重试。',401,username);
   attempts.delete(ip);
   if(!client.usernames.includes(username)){
    client.usernames=[...client.usernames,username].slice(-MAX_NAMES);
    try{saveClients();}catch{/* the name is only a label; a failed write must not block login */}
   }
   for(const [key,value] of sessions)if(value.expires<=time)sessions.delete(key);
   if(sessions.size>=256)sessions.delete(sessions.keys().next().value);
   const token=randomBytes(32).toString('hex');sessions.set(token,{expires:time+SESSION_MS,ip,username});
   res.writeHead(303,{'Location':'/','Set-Cookie':`assetvault_lan=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS/1000}`});res.end();return true;
  }
  const token=(req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith('assetvault_lan='))?.slice(15);
  const session=sessions.get(token);
  if(!session||session.ip!==ip||session.expires<=now()){
   sessions.delete(token);
   return req.method==='GET'&&(pathname==='/'||pathname==='/splash.html')?html(res):reply(res,401,{error:'请刷新页面并输入共享密码'});
  }
  req.lanVisitor=true;
  // A shared session can use AI without reading the host's saved API secret.
  if(pathname==='/api/ai/key')return reply(res,403,{error:'仅主机本地可以查看 API 密钥'});
  const hostSettings=['/api/ai/settings','/api/ai/test','/api/downloads/settings','/api/downloads/pick-folder','/api/downloads/browse-folders','/api/downloads/reveal'];
  if(hostSettings.includes(pathname)||/^\/api\/(setup|browser)(\/|$)/.test(pathname)||/^\/api\/downloads\/blender-bridge(\/|$)/.test(pathname)||/^\/api\/downloads\/tasks\/[^/]+\/reveal$/.test(pathname))return reply(res,403,{error:'局域网访客不能访问或修改主机设置'});
  if(pathname==='/api/lan/logout'&&req.method==='POST'){
   sessions.delete(token);res.writeHead(303,{'Location':'/','Set-Cookie':'assetvault_lan=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});res.end();return true;
  }
  return false;
 }
 return {handle,status,startupPort,networkAddresses:addresses,attachListener(value){listener=value;}};
}
