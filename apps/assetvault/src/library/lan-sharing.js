import {icon} from './icon-set.js';

const pad=value=>String(value).padStart(2,'0');
const stamp=ms=>{const d=new Date(ms);return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;};
// 说明文字全部收进 ? 按钮的悬浮提示里，面板只留控件本身。
const HINTS={
 access:'其他用户共享这台电脑的资产库、下载目录与 Blender。仅在可信局域网开启；访问走 HTTP，不要填其他账号的密码。连不上时请在 Windows 防火墙中允许 Arvimo · 艺团 / Node.js 使用专用网络。',
 password:'至少 8 个字符。首次开启必须设置；留空表示保留原密码。修改密码或关闭共享会让其他设备重新登录。',
 devices:'按 IP 统计访问过的设备（含未登录）。圆点亮起＝已登录且近 5 分钟有请求；悬停名字看全部用过的人，悬停时间看首次访问。禁用立即拦截后续请求，已开始的任务不会取消；解除禁用后需重新登录。IP 变化视为新设备。'
};

// ? 按钮的说明气泡挂在 body 上（position:fixed）。以前画在卡片内部，被设置面板的滚动容器
// 从中间裁断——「至少 8 个字符…」那句只显出半行。fixed + 视口内夹取位置，任何容器都裁不到。
let tip=null,tipBound=false;
// 设置面板是 showModal() 的 dialog，处在浏览器 top layer：气泡挂在 body 上会被整个对话框盖住，
// 所以宿主优先取最近的 dialog 元素，只有脱离对话框时才退回 body。
const tipHost=element=>element.closest?.('dialog')||document.body;
function tipElement(host){
 if(!tip){tip=document.createElement('div');tip.className='lan-tip';}
 if(tip.parentElement!==host)host.append(tip);
 if(!tipBound){
  tipBound=true;
  const close=()=>{if(tip.dataset.open==='true')tip.dataset.open='false';};
  window.addEventListener('scroll',close,{passive:true,capture:true});
  window.addEventListener('resize',close,{passive:true});
 }
 return tip;
}
function showTip(button){
 const bubble=tipElement(tipHost(button)),gap=8;
 bubble.textContent=button.dataset.tip||'';
 bubble.style.left='0px';bubble.style.top='0px';
 const rect=button.getBoundingClientRect(),box=bubble.getBoundingClientRect();
 const left=Math.max(gap,Math.min(rect.left+rect.width/2-box.width/2,window.innerWidth-box.width-gap));
 const below=rect.bottom+gap,above=rect.top-box.height-gap;
 bubble.style.left=`${Math.round(left)}px`;
 bubble.style.top=`${Math.round(below+box.height>window.innerHeight-gap?Math.max(gap,above):below)}px`;
 bubble.dataset.open='true';
}
function bindTips(card){
 const hintOf=event=>event.target.closest?.('.lan-hint');
 const hide=hint=>tipElement(tipHost(hint||card)).dataset.open='false';
 card.addEventListener('pointerover',event=>{const hint=hintOf(event);if(hint)showTip(hint);});
 card.addEventListener('pointerout',event=>{const hint=hintOf(event);if(hint&&!hint.contains(event.relatedTarget))hide(hint);});
 card.addEventListener('focusin',event=>{const hint=hintOf(event);if(hint)showTip(hint);});
 card.addEventListener('focusout',()=>hide());
}

export function createLanSharingSettings({toast}){
 const card=document.createElement('section');card.className='settings-card';
 card.innerHTML=`<div class="lan-row">
   <label class="lan-sharing-toggle"><input type="checkbox" data-lan-enabled>允许局域网访问</label>
   <button type="button" class="lan-hint" data-tip="${HINTS.access}" aria-label="局域网共享说明">?</button>
   <span class="lan-status" role="status" data-lan-status>正在读取共享状态…</span>
  </div>
  <form class="lan-form" data-lan-form>
   <label>分享端口 <input type="number" data-lan-port min="1" max="65535" step="1" required aria-label="局域网分享固定端口" style="width:100px"></label>
   <input type="password" data-lan-password autocomplete="new-password" minlength="8" maxlength="128" aria-label="访问密码" placeholder="访问密码">
   <button type="button" class="lan-hint" data-tip="${HINTS.password}" aria-label="密码规则说明">?</button>
  </form>
  <div class="lan-sharing-addresses" data-lan-addresses></div>
  <p class="lan-status" role="alert" data-lan-port-notice hidden></p>
  <button type="button" class="secondary" data-lan-change-port hidden>重试固定分享端口</button>
  <button type="button" class="secondary" data-lan-ack-port hidden>已重新分享新链接</button>
  <div class="lan-row lan-devices">
   <span class="lan-section">访问设备</span>
   <button type="button" class="lan-hint" data-tip="${HINTS.devices}" aria-label="访问设备说明">?</button>
   <span class="lan-summary" role="status" data-lan-summary></span>
   <button type="button" class="lan-icon" data-lan-refresh title="刷新设备" aria-label="刷新设备">${icon('rotate')}</button>
  </div>
  <div data-lan-clients></div>`;
 bindTips(card);
 const enabled=card.querySelector('[data-lan-enabled]'),password=card.querySelector('[data-lan-password]'),status=card.querySelector('[data-lan-status]'),addresses=card.querySelector('[data-lan-addresses]');
 const portNotice=card.querySelector('[data-lan-port-notice]'),changePort=card.querySelector('[data-lan-change-port]'),ackPort=card.querySelector('[data-lan-ack-port]');
 const sharePort=card.querySelector('[data-lan-port]');
 async function api(input,url='/api/lan/settings'){
  const response=await fetch(url,{method:input?'POST':'GET',cache:'no-store',headers:{'X-SFX-Local':'1',...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});
  const result=await response.json();if(!response.ok)throw Error(result.error||'共享设置请求失败');return result;
 }
 const summary=card.querySelector('[data-lan-summary]'),clientList=card.querySelector('[data-lan-clients]'),refresh=card.querySelector('[data-lan-refresh]');
 function renderClients(data){
  summary.textContent=`${data.total} 台 · 活跃 ${data.online} · 已禁用 ${data.clients.filter(item=>item.blocked).length}`;
  clientList.replaceChildren();
  if(!data.clients.length){clientList.textContent='暂无局域网设备访问记录';return;}
  for(const client of data.clients){
   // 名字是访客登录时自己填的标签：同一 IP 可能被几个人用过，主名优先取当前在线的那个，
   // 其余折成 +N，完整名单放 title 里，行内只留一件事可读。
   const names=client.usernames||[],online=client.onlineUsers||[];
   const shown=online[0]||names[names.length-1]||'';
   const others=names.filter(name=>name!==shown).length;

   const row=document.createElement('div');
   row.className='lan-client';row.dataset.state=client.blocked?'blocked':client.online?'online':'idle';

   const dot=document.createElement('span');dot.className='lan-client-dot';
   dot.title=client.blocked?'已被禁用':client.online?'在线':'未活跃';

   const ip=document.createElement('span');ip.className='lan-client-ip';ip.textContent=client.ip;

   const name=document.createElement('span');name.className='lan-client-name';
   name.textContent=shown?`${shown}${others?` +${others}`:''}`:'未登录';
   name.dataset.empty=String(!shown);
   name.title=names.length?`登录过：${names.join('、')}${online.length?`\n当前在线：${online.join('、')}`:''}`:'这台设备还没登录过';

   const time=document.createElement('span');time.className='lan-client-time';
   time.textContent=stamp(client.lastSeen);
   time.title=`最近访问 ${new Date(client.lastSeen).toLocaleString()} · 首次访问 ${new Date(client.firstSeen).toLocaleString()}`;

   const button=document.createElement('button'),label=client.blocked?'解除禁用':'禁用设备';
   button.type='button';button.className='lan-client-block';button.dataset.unblock=String(client.blocked);
   button.title=label;button.setAttribute('aria-label',label);button.innerHTML=icon(client.blocked?'rotate':'ban');
   button.onclick=async()=>{
    button.disabled=true;
    try{renderClients(await api({ip:client.ip,blocked:!client.blocked},'/api/lan/clients'));toast(client.blocked?'已解除禁用':'已禁用该设备');}
    catch(e){toast(e.message);button.disabled=false;}
   };
   row.append(dot,ip,name,time,button);clientList.append(row);
  }
 }
 async function loadClients(){
  refresh.disabled=true;
  try{renderClients(await api(undefined,'/api/lan/clients'));}
  catch(e){summary.textContent=e.message;}
  finally{refresh.disabled=false;}
 }
 refresh.onclick=loadClients;
 function render(data){
  enabled.checked=data.enabled;password.value='';
  sharePort.value=String(data.sharingPort);
  password.placeholder=data.hasPassword?'访问密码（留空保留）':'访问密码（至少 8 位）';
  status.textContent=data.error||(data.enabled?'共享已开启':'共享已关闭，仅主机可访问');
  changePort.hidden=!data.portConflict;
  ackPort.hidden=!data.portChanged||data.portConflict;
  portNotice.hidden=!data.error&&!data.portConflict&&!data.portChanged;
  portNotice.textContent=data.portConflict
   ?`分享端口 ${data.sharingPort} 被占用或不可用，局域网分享已暂停，本机入口不受影响。释放端口后点击“重试固定分享端口”，或修改上方分享端口并保存；改端口后须重新分享链接。`
   :data.portChanged?(data.previousPort
    ?`分享端口已从 ${data.previousPort} 改为 ${data.sharingPort}，旧链接已失效，请将下方新链接重新分享给其他人。`
    :`分享端口已固定为 ${data.sharingPort}。旧版未记录固定分享端口，请核对下方链接，并重新分享给其他人。`):(data.error||'');
  if(data.portConflict)status.textContent='共享已暂停：分享端口冲突';
  addresses.replaceChildren();
  if(data.enabled&&data.available!==false){
   if(!data.addresses.length)status.textContent='共享已开启，未检测到局域网地址';
   for(const url of data.addresses){
    const row=document.createElement('div'),link=document.createElement('a'),copy=document.createElement('button');
    link.textContent=url;link.href=url;link.target='_blank';link.rel='noopener noreferrer';
    copy.type='button';copy.className='text-button';copy.textContent='复制';
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(url);toast('共享地址已复制');}catch{toast('复制失败，请手动复制地址');}};
    row.append(link,copy);addresses.append(row);
   }
  }
 }
 async function updatePort(input){
  changePort.disabled=ackPort.disabled=enabled.disabled=password.disabled=sharePort.disabled=true;
  try{const data=await api({enabled:true,...input});render(data);toast(data.portConflict||data.error||data.available===false?'分享尚未恢复，请检查端口提示':data.portChanged?'分享链接已更新，请重新分享给其他人':'分享设置已更新');}
  catch(e){status.textContent=e.message;}
  finally{changePort.disabled=ackPort.disabled=enabled.disabled=password.disabled=sharePort.disabled=false;}
 }
 changePort.onclick=()=>updatePort({});
 ackPort.onclick=()=>updatePort({acknowledgePortChange:true});
 async function load(){
  try{render(await api());enabled.disabled=password.disabled=false;await loadClients();}
  catch(e){status.textContent=e.message;enabled.disabled=password.disabled=true;}
 }
 /* 自动保存：共享页也撤掉保存键，勾开关、改密码、改端口都会直接写盘。
    密码不足 8 位或端口越界时先不提交（静默等用户填完），免得半截输入就把共享改坏；
    成功后只有「端口冲突」和「链接已变」还值得出声，普通改动只在状态行更新。 */
 const form=card.querySelector('form');
 async function persist(){
  if(!form.checkValidity())return;
  enabled.disabled=password.disabled=sharePort.disabled=true;
  try{
   const data=await api({enabled:enabled.checked,password:password.value,sharingPort:Number(sharePort.value)});
   render(data);await loadClients();
   const warning=data.error||data.portConflict?'分享端口不可用，本机仍可使用':data.portChanged?'分享链接已更新，请重新分享给其他人':'';
   if(warning)toast(warning);
  }catch(e){status.textContent=e.message;}
  finally{enabled.disabled=password.disabled=sharePort.disabled=false;}
 }
 // 返回 persist 的 Promise：浏览器会忽略返回值，但测试（和任何调用方）能等它真正写完再断言。
 form.onsubmit=event=>{event.preventDefault();return persist();};
 for(const field of [enabled,password,sharePort])field.addEventListener('change',persist);
 return {card,load,check:()=>api()};
}
