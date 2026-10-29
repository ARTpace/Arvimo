import {platformModules,PICTURE_SITE_GROUPS,PLATFORM_TAG,PLATFORM_HOME,PLATFORM_IMAGE_CAPS,pictureSiteLoginable} from './platforms.js';
import {esc} from './html-esc.js';
/** 徽标：优先用注册表里给的单字，否则取标签里每个词的首字母（Sketchfab→S、Poly Haven→PH）。 */
const markOf=(label,mark)=>mark||label.split(' ').map(word=>word[0]).join('').toUpperCase();
/** 图站的「官网」直接从示例链接推 origin，避免再维护一份容易过期的主页清单。 */
const homeOf=site=>{
 try{return new URL(site.example||`https://${(site.hosts||[])[0]||''}/`).origin;}
 catch{return `https://${(site.hosts||[])[0]||''}/`;}
};

/** 说明文字一律收进「i」图标，悬停/聚焦才展开——设置页只留平台名，不用读一屏小字。 */
const tipIcon=(text,label='说明')=>text?`<span class="tip" role="img" tabindex="0" aria-label="${esc(label)}" data-tip="${esc(text)}"></span>`:'';
/** 登录按钮的归属域名：卡片主页压成主机名，用来和 cookie 仓库里的域名对账。 */
const hostOf=value=>{try{return new URL(value).hostname;}catch{return '';}};
const bareHost=value=>String(value||'').replace(/^\./,'').toLowerCase().replace(/^www\./,'');
/** `zcool.com.cn` 与 `www.zcool.com.cn` 算同一家，cookie 域比卡片主机名短一级是常态。 */
const sameSite=(cookieHost,cardHost)=>{
 const a=bareHost(cookieHost),b=bareHost(cardHost);
 if(!a||!b)return false;
 return a===b||a.endsWith(`.${b}`)||b.endsWith(`.${a}`);
};
export function createPlatformSettingsCard({settings,toast}){
 const modules=platformModules();
 const groups=PICTURE_SITE_GROUPS||[];
 const siteCount=groups.reduce((sum,group)=>sum+group.sites.length,0);
 // 3D 平台与图站共用同一套卡片结构（徽标 / 名称 / 开关 + 短标签 / 示例 / 官网 / 登录 / 测试），
 // 也共用同一份开关存储 —— 关掉后对应的检索、解析与下载都会被服务端拒绝。
 // 「登录」只出现在需要登录态才放行的站（名单与服务端 PICTURE_LOGIN_URLS 同源）：点开一个可见浏览器窗口，
 // 用户自己登录 / 过验证，cookie 由服务端每 2.5 秒同步进仓库，之后解析走纯 HTTP。
 const moduleCard=({id,name,mark,tag,home,example,checked,attr,tip,login})=>{
  const loginHost=login?hostOf(home||example):'';
  const loginBtn=loginHost?`<button type="button" class="module-link module-login" data-login="${esc(id)}" data-login-host="${esc(loginHost)}" data-label="${esc(name)}" title="打开浏览器窗口登录 ${esc(name)}（或过一下人机验证），关掉窗口 cookie 自动保存">登录</button>`:'';
  // 「复制」和「登录」成对出现：把该站 cookie 头原样拷出去，方便贴到别的工具里复现同样的登录态。
  const copyBtn=loginHost?`<button type="button" class="module-link module-copy" data-copy="${esc(id)}" data-copy-host="${esc(loginHost)}" data-label="${esc(name)}" disabled title="还没有 cookie，先登录一次">复制</button>`:'';
  return `<label class="platform-module-card"${tip?` title="${esc(tip)}"`:''}><input type="checkbox" role="switch" aria-label="启用 ${esc(name)}" data-${attr}="${esc(id)}" ${checked?'checked':''}><span class="module-row"><span class="module-mark" aria-hidden="true">${esc(mark)}</span><span class="module-name">${esc(name)}</span><span class="platform-module-switch" aria-hidden="true"></span></span><span class="module-row module-foot"><span class="module-tag">${esc(tag)}</span><span class="module-actions">${example?`<button type="button" class="module-link" data-example="${esc(example)}" data-label="${esc(name)}">示例</button>`:''}${home?`<a class="module-link" href="${esc(home)}" target="_blank" rel="noreferrer noopener">官网</a>`:''}${loginBtn}${copyBtn}<button type="button" class="module-link module-test" data-test="${esc(id)}" data-test-url="${esc(example||'')}" data-label="${esc(name)}" aria-label="测试 ${esc(name)} 是否可用">测试</button></span></span></label>`;
 };
 const platformCards=modules.map(p=>moduleCard({
  id:p.id,name:p.label,mark:markOf(p.label),tag:PLATFORM_TAG[p.id]||p.hint||'3D 资产',
  home:PLATFORM_HOME[p.id],checked:settings[p.id]!==false,attr:'platform',tip:p.description||p.hint,
  login:pictureSiteLoginable(p.id),
 })).join('');
 const pictureCard=site=>moduleCard({
  id:site.id,name:site.label,mark:site.label[0],tag:site.tag||'图片站',
  home:homeOf(site),example:site.example,checked:settings[site.id]!==false,attr:'picture-platform',tip:site.hint,
  login:pictureSiteLoginable(site.id),
 });
 const pictureBlock=!groups.length?'':'<div class="picture-site-settings"><h4 class="platform-group-title picture-site-title"><span class="platform-group-dot" aria-hidden="true"></span>图站（直链解析）<span class="platform-group-count">'+siteCount+' 个</span>'+tipIcon('粘作品页或标签页链接即可整站解析入库；关掉即禁止解析与下载','图站模块说明')+'</h4>'+groups.map(group=>`<section class="picture-site-group"><h5 class="platform-group-title"><span class="platform-group-dot" aria-hidden="true"></span>${esc(group.name)}<span class="platform-group-count">${group.sites.length} 个</span>${tipIcon(group.note,`${group.name} 说明`)}</h5><div class="platform-module-grid">${group.sites.map(pictureCard).join('')}</div></section>`).join('')+'</div>';
 // 双能力平台的镜像卡：同一个 platform id（不是 picture-platform），所以保存时写的是同一个开关，
 // 切换任意一处都会立刻同步另一处 —— 用户不用去猜「这个平台该在哪边关」。
 const imageCaps=PLATFORM_IMAGE_CAPS.map(cap=>{
  const platform=modules.find(item=>item.id===cap.id);
  return platform?moduleCard({
   id:cap.id,name:platform.label,mark:markOf(platform.label),tag:cap.tag,
   home:PLATFORM_HOME[cap.id],checked:settings[cap.id]!==false,attr:'platform',tip:platform.description||platform.hint,
   login:pictureSiteLoginable(cap.id),
  }):'';
 }).join('');
 const imageBlock=imageCaps?'<div class="picture-site-settings image-cap-settings"><h4 class="platform-group-title picture-site-title"><span class="platform-group-dot" aria-hidden="true"></span>模型平台的配图<span class="platform-group-count">'+PLATFORM_IMAGE_CAPS.length+' 个</span>'+tipIcon('这些平台主营 3D / 材质，同时能直接拿图做参考。开关与上方 3D 分组共用，任一处关闭两边都关','模型平台的配图说明')+'</h4><div class="platform-module-grid">'+imageCaps+'</div></div>':'';
 const card=document.createElement('div');card.className='settings-card platform-settings';
 card.innerHTML='<h3 class="settings-section-title">3D 模型平台</h3><div class="platform-modules-intro"><span data-module-count aria-live="polite"></span>'+tipIcon('开启后参与在线搜索；关闭只影响检索，不影响本地资产和已有任务','平台开关说明')+'</div><div class="platform-module-grid" data-module-grid>'+platformCards+'</div>'+pictureBlock+imageBlock+'<div class="platform-modules-actions"><p>保存后自动刷新生效<br><span>局域网访客刷新后同步</span></p><button type="button" class="primary">保存并应用</button></div>';
 // 计数只统计 3D 分组（镜像卡是同一批开关的副本，混进来会让分母翻倍）。
 const updateCount=()=>{card.querySelector('[data-module-count]').textContent=`已开启 ${card.querySelectorAll('[data-module-grid] [data-platform]:checked').length} / ${modules.length}`;};
 card.addEventListener('change',updateCount);
 // 镜像卡开关联动：同一个 platform id 的所有可见开关保持同一状态。
 card.addEventListener('change',event=>{
  const input=event.target.closest('input[data-platform]');
  if(!input)return;
  for(const other of card.querySelectorAll(`input[data-platform="${input.dataset.platform}"]`))if(other!==input)other.checked=input.checked;
 });
 updateCount();
 // ---- 卡片上的「登录」：拿 cookie 的唯一入口 ----
 // 需要登录态 / 人机验证的站（站酷、500px、Pinterest…）在卡片上给一个登录按钮：
 // 点一下弹一个可见浏览器窗口，用户自己登录，服务端每 2.5 秒把该站 cookie 同步进仓库。
 // 之后解析走纯 HTTP，不再每次开浏览器。按钮文字直接反映状态（登录 / 登录中… / 已登录）。
 async function readCookieHosts(){
  try{
   const response=await fetch('/api/browser/cookies',{headers:{'X-SFX-Local':'1'}});
   if(!response.ok)return null;
   const data=await response.json();
   return Array.isArray(data.hosts)?data.hosts:null;
  }catch{return null;}
 }
// 只染色，不发请求：真实 cookie 归属按注册域比对（cookie 存 zcool.com.cn，卡片主页是 www.zcool.com.cn）。
// 三态而不是两态 —— 有 cookie ≠ 登录了：跑过一次 WAF 挑战、被统计脚本种几条偏好，都会留下 cookie。
// 服务端能给判据的站（站酷解 session、500px 解 JWT）返回 login:true/false，判不了的返回 null，
// 这时只说「已存 cookie」，绝不冒充「已登录」（站酷匿名访客也有 session，就是这么误报的）。
const paintLogin=(button,hosts)=>{
 const host=button.dataset.loginHost||'',name=button.dataset.label||'该站';
 const rows=(hosts||[]).filter(row=>sameSite(row.domain,host));
 const count=rows.reduce((sum,row)=>sum+Number(row.count||0),0);
 const known=rows.some(row=>row.login===true)?true:(rows.some(row=>row.login===false)?false:null);
 const copy=button.parentElement?button.parentElement.querySelector('[data-copy]'):null;
 if(copy){
  copy.disabled=count===0;
  copy.title=count===0?`还没有 ${name} 的 cookie，先点「登录」`:`复制 ${name} 的 ${count} 条 cookie（name=value; … 可直接贴到别的工具）`;
 }
 if(count===0){
  button.removeAttribute('data-state');button.textContent='登录';
  button.title=`打开浏览器窗口登录 ${name}（或过一下人机验证），关掉窗口 cookie 自动保存`;
  return;
 }
 const at=Math.max(...rows.map(row=>Number(row.updatedAt)||0));
 const stamp=at?` · ${new Date(at).toLocaleString()}`:'';
 if(known===false){
  // 站方自己说「没登录」（比如站酷 session 里 currentUser 是 null）—— 只存了验证/统计 cookie。
  button.dataset.state='warn';button.textContent='未登录';
  button.title=`${name}：本地有 ${count} 条 cookie${stamp}，但${name}返回的是未登录状态（多半只是过验证 / 统计 cookie）。点一下真正登录`;
 }else if(known===true){
  button.dataset.state='ok';button.textContent='已登录';
  button.title=`${name}：已登录，本地存了 ${count} 条 cookie${stamp}。点一下重新登录 / 换账号`;
 }else{
  // 没有判据的站：只陈述事实，不替它下结论。
  button.dataset.state='have';button.textContent='已存 cookie';
  button.title=`${name}：本地存了 ${count} 条 cookie${stamp}，但这个站没有登录态判据，无法确认是否真登录。点一下重新登录`;
 }
};
 const watchers=new Map();
 // 登录窗口可能开很久，轮询到「窗口关了」为止再落一次状态，中间每次拿到新 cookie 也立刻回写。
 function watchLogin(button){
  const id=button.dataset.login;
  if(watchers.has(id))return;
  const started=Date.now();
  const timer=setInterval(async()=>{
   const hosts=await readCookieHosts();
   if(hosts)paintLogin(button,hosts);
   let open=false;
   try{
    const response=await fetch('/api/browser/login',{headers:{'X-SFX-Local':'1'}});
    open=Boolean((await response.json())?.open);
   }catch{open=false;}
   if(open&&Date.now()-started<15*60*1000)return;
   clearInterval(timer);watchers.delete(id);button.dataset.busy='0';
   const finalHosts=await readCookieHosts();
   if(finalHosts)paintLogin(button,finalHosts);
   if(!['ok','have','warn'].includes(button.dataset.state||''))toast(`${button.dataset.label||''} 还没拿到 cookie，可以再点一次登录`);
  },3000);
  watchers.set(id,timer);
 }
 async function openLogin(button){
  if(button.dataset.busy==='1')return;
  const id=button.dataset.login,name=button.dataset.label||id;
  button.dataset.busy='1';button.dataset.state='busy';button.textContent='打开中…';
  try{
   const response=await fetch('/api/browser/login',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({platform:id})});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||'打不开登录窗口');
   button.textContent='登录中…';
   toast(`已打开 ${name} 登录窗口：登录（或完成验证）后直接关掉窗口，cookie 会自动保存`);
   watchLogin(button);
  }catch(error){
   const message=String(error?.message||'打不开登录窗口');
   button.dataset.busy='0';button.dataset.state='fail';button.textContent='登录失败';
   button.title=`${name} 登录窗口打不开：${message}`;
   toast(`${name} 登录窗口打不开：${message}`);
   setTimeout(async()=>paintLogin(button,await readCookieHosts()||[]),4000);
  }
 }
 // 卡片渲染完先对一次账，把已有 cookie 的站直接标成「已登录」（不点也不影响解析）。
 readCookieHosts().then(hosts=>{if(hosts)card.querySelectorAll('[data-login]').forEach(button=>paintLogin(button,hosts));});
 // 卡片内的「示例 / 官网」是交互元素，点它们不能顺带拨动外面的开关。
 // 自检：点「测试」时让服务端用该平台真实的搜索/解析入口跑一次，结果直接回写在按钮上。
 // 只读一次请求，不写缓存、不入队，也不会因为平台被关掉就拒绝测试（关掉也要能自证好坏）。
 async function runTest(button){
  if(button.dataset.busy==='1')return;
  const id=button.dataset.test,name=button.dataset.label||id;
  button.dataset.busy='1';button.dataset.state='busy';button.textContent='…';button.title=`正在测试 ${name}，请稍候`;
  try{
   const response=await fetch('/api/platforms/test',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({id,url:button.dataset.testUrl||''})});
   const data=await response.json();
   if(!response.ok)throw Error(data.error||'测试请求失败');
   if(!data.ok)throw Error(data.error||'平台无响应');
   const seconds=(Number(data.ms||0)/1000).toFixed(1);
   button.dataset.state='ok';button.textContent='正常';
   button.title=`${name} 可用 · 耗时 ${seconds}s · ${data.count>0?`取到 ${data.count} 条`:'连接正常但没取到条目'}${data.sample?`\n示例：${data.sample}`:''}`;
   toast(`${name} 可用 · ${seconds}s`);
  }catch(error){
   const message=String(error?.message||'连接失败');
   button.dataset.state='fail';button.textContent='不可用';
   button.title=`${name} 测试失败：${message}`;
   toast(`${name} 测试失败：${message}`);
  }finally{button.dataset.busy='0';}
 }
// ---- 卡片上的「复制」：把该站 cookie 头拷到剪贴板 ----
// 场景：cookie 已经收进仓库，但用户想拿去别的工具（curl / 爬虫 / 另一台机器）复现同样的登录态。
// 走服务端 `/api/browser/cookies?domain=` 取拼好的 `name=value; …`，只在本机可用。
async function writeClipboard(text){
 try{await navigator.clipboard.writeText(text);return;}
 catch{/* 非 https / 无权限时退回 execCommand */}
 const area=document.createElement('textarea');
 area.value=text;area.style.position='fixed';area.style.top='-1000px';area.style.opacity='0';
 document.body.appendChild(area);area.select();
 let ok=false;
 try{ok=document.execCommand('copy');}catch{ok=false;}
 area.remove();
 if(!ok)throw Error('浏览器不允许写剪贴板');
}
async function copySiteCookie(button){
 if(button.dataset.busy==='1')return;
 const host=button.dataset.copyHost||'',name=button.dataset.label||'该站';
 button.dataset.busy='1';
 try{
  const response=await fetch(`/api/browser/cookies?domain=${encodeURIComponent(host)}`,{headers:{'X-SFX-Local':'1'}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'取 cookie 失败');
  if(!data.header)throw Error('这个站还没有 cookie，先登录一次');
  await writeClipboard(data.header);
  button.dataset.state='ok';button.textContent='已复制';
  button.title=`已复制 ${data.cookies} 条 cookie · ${new Date().toLocaleTimeString()}\n${data.header.slice(0,180)}${data.header.length>180?'…':''}`;
  toast(`已复制 ${name} 的 ${data.cookies} 条 cookie（${data.header.length} 字符）`);
  setTimeout(()=>{button.textContent='复制';button.removeAttribute('data-state');},2000);
 }catch(error){
  button.dataset.state='fail';button.textContent='复制失败';
  button.title=`复制 ${name} cookie 失败：${error.message}`;
  toast(`复制 ${name} cookie 失败：${error.message}`);
  setTimeout(()=>{button.textContent='复制';button.removeAttribute('data-state');},2500);
 }finally{button.dataset.busy='0';}
}
card.addEventListener('click',async event=>{
 const login=event.target.closest('[data-login]');
 if(login){event.preventDefault();event.stopPropagation();openLogin(login);return;}
 const copyCookie=event.target.closest('[data-copy]');
 if(copyCookie){event.preventDefault();event.stopPropagation();if(!copyCookie.disabled)copySiteCookie(copyCookie);return;}
  const test=event.target.closest('[data-test]');
  if(test){event.preventDefault();event.stopPropagation();runTest(test);return;}
  const copy=event.target.closest('[data-example]');
  if(copy){
   event.preventDefault();event.stopPropagation();
   const url=copy.dataset.example;if(!url)return;
   try{await navigator.clipboard.writeText(url);toast(`已复制 ${copy.dataset.label} 示例链接，去「发现」页搜索框粘贴即可`);}
   catch{toast(`示例链接：${url}`);}
   return;
  }
  if(event.target.closest('a.module-link'))event.stopPropagation();
 });
 card.querySelector('button.primary').onclick=async event=>{
  const button=event.currentTarget;button.disabled=true;
  try{
   const input={};
   for(const node of card.querySelectorAll('[data-platform],[data-picture-platform]')){
    const id=node.dataset.platform||node.dataset.picturePlatform;
    if(id)input[id]=node.checked;
   }
   const response=await fetch('/api/platforms',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify(input)});
   const data=await response.json();if(!response.ok)throw Error(data.error||'平台配置保存失败');
   location.reload();
  }catch(error){toast(error.message);button.disabled=false;}
 };
 return card;
}
