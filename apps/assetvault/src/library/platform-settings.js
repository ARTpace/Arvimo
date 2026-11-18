import {platformModules,PICTURE_SITE_GROUPS,PLATFORM_TAG,PLATFORM_HOME,PLATFORM_IMAGE_CAPS,pictureSiteLoginable} from './platforms.js';
import {esc} from './html-esc.js';
import {icon} from './icon-set.js';
/** 徽标：优先用注册表里给的单字，否则取标签里每个词的首字母（Sketchfab→S、Poly Haven→PH）。 */
const markOf=(label,mark)=>mark||label.split(' ').map(word=>word[0]).join('').toUpperCase();
/** 图站的「官网」直接从示例链接推 origin，避免再维护一份容易过期的主页清单。 */
const homeOf=site=>{
 try{return new URL(site.example||`https://${(site.hosts||[])[0]||''}/`).origin;}
 catch{return `https://${(site.hosts||[])[0]||''}/`;}
};
/** 登录按钮的归属域名：卡片主页压成主机名，用来和 cookie 仓库里的域名对账。 */
const hostOf=value=>{try{return new URL(value).hostname;}catch{return '';}};
const bareHost=value=>String(value||'').replace(/^\./,'').toLowerCase().replace(/^www\./,'');
/** `zcool.com.cn` 与 `www.zcool.com.cn` 算同一家，cookie 域比卡片主机名短一级是常态。 */
const sameSite=(cookieHost,cardHost)=>{
 const a=bareHost(cookieHost),b=bareHost(cardHost);
 if(!a||!b)return false;
 return a===b||a.endsWith(`.${b}`)||b.endsWith(`.${a}`);
};
// 卡片动作全部图标化：文字收进 title / aria-label，卡片宽度不再随文案长短抖动。
// 一个动作 = 一个图标键：官网→external、登录→user、复制 cookie→copy、测试→pulse。
const ACTION_ICON={home:'external',login:'user',copy:'copy',test:'pulse'};
/** 图标键：方钮；悬停浮出底色，处理中把图标换成转圈，结果用右下角状态点表达。 */
const actionButton=(kind,{label,title,dataset='',href='',disabled=false})=>{
 const inner=icon(ACTION_ICON[kind]||'link');
 if(href)return `<a class="platform-icon-btn" data-icon-action="${kind}" ${dataset} href="${esc(href)}" target="_blank" rel="noreferrer noopener" aria-label="${esc(label)}" title="${esc(title)}">${inner}</a>`;
 return `<button type="button" class="platform-icon-btn" data-icon-action="${kind}" ${dataset} aria-label="${esc(label)}" title="${esc(title)}"${disabled?' disabled':''}>${inner}</button>`;
};
export function createPlatformSettingsCard({settings,toast}){
 const modules=platformModules();
 const groups=PICTURE_SITE_GROUPS||[];
 const siteCount=groups.reduce((sum,group)=>sum+group.sites.length,0);
 // 3D 平台与图站共用同一套卡片结构（徽标 / 名称 + 官网键 + 开关 + 短标签 + 图标动作），
 // 也共用同一份开关存储 —— 关掉后对应的检索、解析与下载都会被服务端拒绝。
 // 「登录」只出现在需要登录态才放行的站（名单与服务端 PICTURE_LOGIN_URLS 同源）。
 const moduleCard=({id,name,mark,tag,home,example,checked,attr,tip,login})=>{
  const loginHost=login?hostOf(home||example):'';
  const loginBtn=loginHost?actionButton('login',{label:`登录 ${name}`,title:`打开浏览器窗口登录 ${name}（或过一下人机验证），关掉窗口 cookie 自动保存`,dataset:`data-login="${esc(id)}" data-login-host="${esc(loginHost)}" data-label="${esc(name)}"`}):'';
  // 「复制」和「登录」成对出现：把该站 cookie 头原样拷出去，方便贴到别的工具里复现同样的登录态。
  const copyBtn=loginHost?actionButton('copy',{label:`复制 ${name} 的 cookie`,title:`还没有 ${name} 的 cookie，先登录一次`,dataset:`data-copy="${esc(id)}" data-copy-host="${esc(loginHost)}" data-label="${esc(name)}"`,disabled:true}):'';
  // 「官网」键落在平台名右边（主行），不再占底行位置；底行只留登录 / 复制 / 测试。
  const homeBtn=home?actionButton('home',{label:`打开 ${name} 官网`,title:'在新标签页打开官网',href:home}):'';
  // 测试：图站要带示例链接给服务端当解析入口（没有 example 的站用站点主页兜底）。
  const testBtn=actionButton('test',{label:`测试 ${name} 是否可用`,title:`用官方入口实测 ${name} 的连通性`,dataset:`data-test="${esc(id)}" data-test-url="${esc(example||'')}" data-label="${esc(name)}"`});
  return `<label class="platform-module-card"${tip?` title="${esc(tip)}"`:''}><input type="checkbox" role="switch" aria-label="启用 ${esc(name)}" data-${attr}="${esc(id)}" ${checked?'checked':''}><span class="module-main"><span class="module-mark" aria-hidden="true">${esc(mark)}</span><span class="module-name">${esc(name)}</span>${homeBtn}<span class="platform-module-switch" aria-hidden="true"></span></span><span class="module-main module-foot"><span class="module-tag">${esc(tag)}</span><span class="module-actions">${loginBtn}${copyBtn}${testBtn}</span></span></label>`;
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
 // 图站按分组铺开；分组标题只留组名与数量，说明文字不重复铺一遍。
 const pictureGroupTabs='<div class="platform-group-tabs" role="tablist" aria-label="图站分组">'+['全部',...groups.map(group=>group.name)].map((name,index)=>`<button type="button" role="tab" class="platform-group-tab${index===0?' active':''}" data-group-tab="${esc(name)}" aria-selected="${index===0?'true':'false'}">${esc(name)}<span class="platform-tab-count">${index===0?siteCount:(groups[index-1]?.sites.length||0)}</span></button>`).join('')+'</div>';
 // Pixabay 视频要官方免费 key：在「视频素材」组底部给一行输入。
 // 只提交非空值 —— 空串会把 key 清掉，而用户往往只是没改。
 const pixabayKeyRow=`<div class="platform-key-row"><label><span>Pixabay API key</span><input type="password" data-pixabay-key autocomplete="off" spellcheck="false" placeholder="${settings.pixabayKeySet?'已设置，留空则不改':'免费申请：pixabay.com/api/docs'}"></label><button type="button" class="secondary" data-pixabay-save>保存 key</button><span class="platform-key-hint">只用于 Pixabay 视频检索；没填时该站会提示需要 key，其余视频站不受影响。</span></div>`;
 const picturePanels=pictureGroupTabs+groups.map(group=>`<div class="picture-site-group" data-group="${esc(group.name)}"><h5 class="platform-group-title"><span class="platform-group-dot" aria-hidden="true"></span>${esc(group.name)}<span class="platform-group-count">${group.sites.length} 个</span></h5><div class="platform-module-grid">${group.sites.map(pictureCard).join('')}</div>${group.name==='视频素材'?pixabayKeyRow:''}</div>`).join('');
 // 配图能力不再单独占一个 Tab：按输出拆成两个子分组，并入「3D 平台」一屏。
 // 开关与上方模型卡共用同一个 platform id，切换任一处两边立刻同步。
 const CAP_GROUPS=[
  {name:'PBR 材质',ids:['polyhaven','ambientcg']},
  {name:'作品 / 2D 素材',ids:['artstation','kenney']},
 ];
 const capCard=(id)=>{
  const cap=PLATFORM_IMAGE_CAPS.find(item=>item.id===id);
  const platform=modules.find(item=>item.id===id);
  return platform?moduleCard({
   id,name:platform.label,mark:markOf(platform.label),tag:cap?cap.tag:'配图',
   home:PLATFORM_HOME[id],checked:settings[id]!==false,attr:'platform',tip:platform.description||platform.hint,
   login:pictureSiteLoginable(id),
  }):'';
 };
 const capGroupsHtml=CAP_GROUPS.filter(group=>group.ids.some(id=>modules.some(m=>m.id===id))).map(group=>`<div class="platform-subgroup"><h5 class="platform-group-title"><span class="platform-group-dot" aria-hidden="true"></span>${esc(group.name)}<span class="platform-group-count">${group.ids.length}</span></h5><div class="platform-module-grid">${group.ids.map(capCard).join('')}</div></div>`).join('');
 const tabs=[
  {id:'3d',label:'3D 平台',count:modules.length,note:'开启后参与在线搜索；关闭只影响检索，不影响本地资产和已有任务。',panel:`<div class="platform-module-grid" data-module-grid>${platformCards}</div>${capGroupsHtml}`},
  {id:'picture',label:'图站',count:siteCount,note:'粘作品页或标签页链接即可整站解析入库；关掉即禁止解析与下载。',panel:picturePanels},
 ].filter(tab=>tab.panel);
 const tabBar='<div class="platform-tabs" role="tablist" aria-label="平台分组">'+tabs.map((tab,index)=>`<button type="button" role="tab" class="platform-tab${index===0?' active':''}" data-tab="${tab.id}" id="platform-tab-${tab.id}" aria-controls="platform-panel-${tab.id}" aria-selected="${index===0?'true':'false'}" tabindex="${index===0?'0':'-1'}">${esc(tab.label)}<span class="platform-tab-count">${tab.count}</span></button>`).join('')+'<span class="platform-tab-indicator" aria-hidden="true"></span></div>';
 const panels='<div class="platform-panels">'+tabs.map((tab,index)=>`<section class="platform-panel" data-panel="${tab.id}" id="platform-panel-${tab.id}" role="tabpanel" aria-labelledby="platform-tab-${tab.id}"${index===0?'':' hidden'}><p class="platform-panel-note">${esc(tab.note)}</p>${tab.panel}</section>`).join('')+'</div>';
 // 顶栏：计数在左、平台 Tab 居中、批量测试在最右，和 Tab 切换同一行。
 const topbar='<div class="platform-topbar"><span class="platform-count" data-module-count aria-live="polite">已开启 0 / 0</span>'+tabBar+'<button type="button" class="platform-batch-test" data-batch-test>'+icon('zap')+'<span data-batch-label>批量测试</span></button></div>';
 const batchProgressHtml='<div class="platform-batch-progress" data-batch-progress hidden><span class="pbp-text" data-batch-text></span><span class="pbp-track"><span class="pbp-fill" data-batch-fill></span></span></div>';
 const card=document.createElement('div');card.className='settings-card platform-settings';
 // 不设「保存并应用」—— 开关即改即存（防抖），自动保存后提示一句即可。
 // 标题带一句右侧说明：这一页独立成「平台模块」后，分组行要与 AI 页、软件连接页一样有主标题 + 副说明。
 card.innerHTML='<h3 class="settings-section-title"><span>在线平台</span><small>开关即时生效，改动自动保存</small></h3>'+topbar+batchProgressHtml+panels;

 const tabButtons=[...card.querySelectorAll('.platform-tab')];
 const indicator=card.querySelector('.platform-tab-indicator');
 const panelsByName=new Map([...card.querySelectorAll('.platform-panel')].map(panel=>[panel.dataset.panel,panel]));
 let activeTab=tabButtons[0]?.dataset.tab||'3d';
 let lastIndicator='',wasVisible=false,enterTimer=0;
 const activePanel=()=>panelsByName.get(activeTab);
 const scopeAttr=()=>activeTab==='picture'?'picture-platform':'platform';
 /** 首次进入某屏时卡片按阅读顺序依次出场；重新渲染与恢复状态不重播。 */
 function animatePanel(panel){
  if(!panel||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  panel.classList.remove('is-entering');
  void panel.offsetWidth;
  panel.querySelectorAll('.platform-module-card').forEach((node,index)=>node.style.setProperty('--enter-delay',`${Math.min(index,14)*30}ms`));
  panel.classList.add('is-entering');
  clearTimeout(enterTimer);
  enterTimer=setTimeout(()=>panel.classList.remove('is-entering'),860);
 }
 /** 选中指示是一块底板滑到新位置，而不是旧的熄灭、新的点亮；宽度随选项一起过渡。 */
 function placeIndicator(){
  const button=tabButtons.find(item=>item.dataset.tab===activeTab);
  if(!button||!button.offsetWidth)return;
  card.querySelector('.platform-tabs')?.classList.add('ready');
  if(!wasVisible){wasVisible=true;animatePanel(activePanel());}
  const next=`${button.offsetLeft}|${button.offsetWidth}`;
  if(next===lastIndicator)return;
  lastIndicator=next;
  indicator.style.width=`${button.offsetWidth}px`;
  indicator.style.transform=`translateX(${button.offsetLeft}px)`;
 }
 // 计数只看当前 Tab：3D 只数主网格（配图子分组是同一批开关的镜像，混进来分母会翻倍）。
 function updateCount(){
  const panel=activePanel();
  if(!panel)return;
  const inputs=activeTab==='picture'
   ?[...panel.querySelectorAll('input[data-picture-platform]')]
   :[...panel.querySelectorAll('[data-module-grid] input[data-platform]')];
  const output=card.querySelector('[data-module-count]');
  if(output)output.textContent=`已开启 ${inputs.filter(input=>input.checked).length} / ${inputs.length}`;
 }
 function showTab(id){
  if(!panelsByName.has(id))return;
  activeTab=id;
  for(const button of tabButtons){
   const on=button.dataset.tab===id;
   button.classList.toggle('active',on);
   button.setAttribute('aria-selected',on?'true':'false');
   button.tabIndex=on?0:-1;
  }
  for(const [name,panel] of panelsByName)panel.hidden=name!==id;
  placeIndicator();
  animatePanel(activePanel());
  updateCount();
 }
 card.querySelector('.platform-tabs').addEventListener('keydown',event=>{
  const index=tabButtons.findIndex(button=>button===event.target);
  if(index<0)return;
  const delta={ArrowRight:1,ArrowLeft:-1,ArrowDown:1,ArrowUp:-1}[event.key];
  if(!delta&&event.key!=='Home'&&event.key!=='End')return;
  event.preventDefault();
  const next=event.key==='Home'?tabButtons[0]:event.key==='End'?tabButtons[tabButtons.length-1]:tabButtons[(index+delta+tabButtons.length)%tabButtons.length];
  next.focus();showTab(next.dataset.tab);
 });
 if('ResizeObserver' in window)new ResizeObserver(placeIndicator).observe(card);
 window.addEventListener('resize',placeIndicator);
 requestAnimationFrame(placeIndicator);
 updateCount();
 // ---- 自动保存：开关一拨就存，防抖 500ms 合并连点 ----
 // 保存后不刷新页面（用户还在改）；服务端拿到新开关，后续检索 / 解析 / 下载立即生效。
 let saveTimer=0;
 /** 统一的写入口：开关表与字符串配置（目前只有 Pixabay key）走同一个端点。 */
 async function postSettings(input){
  const response=await fetch('/api/platforms',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify(input)});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.error||'平台配置保存失败');}
 }
 function saveSettings(){
  const input={};
  for(const node of card.querySelectorAll('[data-platform],[data-picture-platform]')){
   const id=node.dataset.platform||node.dataset.picturePlatform;
   if(id)input[id]=node.checked;
  }
  clearTimeout(saveTimer);
  saveTimer=setTimeout(async()=>{
   try{await postSettings(input);toast('平台设置已保存');}
   catch(error){toast(`保存失败：${error.message}`);}
  },500);
 }
 // Pixabay key 单独保存：它会真的打到外部 API，误触发（每敲一个字）没有意义，
 // 所以只在点「保存 key」时提交，且空值不提交。
 card.addEventListener('click',async event=>{
  const button=event.target.closest('[data-pixabay-save]');
  if(!button)return;
  const input=card.querySelector('[data-pixabay-key]');
  const key=String(input?.value||'').trim();
  if(!key){toast('请先填入 Pixabay API key');return;}
  button.disabled=true;
  try{
   await postSettings({pixabayKey:key});
   if(input){input.value='';input.placeholder='已设置，留空则不改';}
   toast('Pixabay key 已保存');
  }catch(error){toast(`保存失败：${error.message}`);}
  finally{button.disabled=false;}
 });
 card.addEventListener('change',event=>{
  const input=event.target.closest('input[data-platform]');
  // 镜像卡开关联动：同一个 platform id 的所有可见开关保持同一状态。
  if(input)for(const other of card.querySelectorAll(`input[data-platform="${input.dataset.platform}"]`))if(other!==input)other.checked=input.checked;
  updateCount();
  saveSettings();
 });
 // ---- 卡片上的「登录」：拿 cookie 的唯一入口 ----
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
  button.removeAttribute('data-state');
  button.title=`打开浏览器窗口登录 ${name}（或过一下人机验证），关掉窗口 cookie 自动保存`;
  return;
 }
 const at=Math.max(...rows.map(row=>Number(row.updatedAt)||0));
 const stamp=at?` · ${new Date(at).toLocaleString()}`:'';
 if(known===false){
  button.dataset.state='warn';
  button.title=`${name}：本地有 ${count} 条 cookie${stamp}，但${name}返回的是未登录状态（多半只是过验证 / 统计 cookie）。点一下真正登录`;
 }else if(known===true){
  button.dataset.state='ok';
  button.title=`${name}：已登录，本地存了 ${count} 条 cookie${stamp}。点一下重新登录 / 换账号`;
 }else{
  button.dataset.state='have';
  button.title=`${name}：本地存了 ${count} 条 cookie${stamp}，但这个站没有登录态判据，无法确认是否真登录。点一下重新登录`;
 }
};
 const watchers=new Map();
 // 登录窗口可能开很久，轮询到「窗口关了」为止再落一次状态，中间每次拿到新 cookie 也立刻回写。
  // Fab 走 Epic OAuth（不是 cookie）：登录态从 /api/fab/session 读，单独染色。
  async function paintFabLogin(button){
   if(!button||button.dataset.login!=='fab')return;
   try{
    const r=await fetch('/api/fab/session',{headers:{'X-SFX-Local':'1'}});
    if(!r.ok)return;
    const d=await r.json().catch(()=>({}));
    const name=button.dataset.label||'Fab';
    if(d.loggedIn){button.dataset.state='ok';button.title=`${name}：已登录${d.displayName?`（${d.displayName}）`:''}。点一下重新登录 / 换账号`;}
    else{button.removeAttribute('data-state');button.title=`打开 Epic 登录窗口登录 ${name}，登录成功后再搜 Fab 资产`;}
   }catch{/* 状态读不到就保持默认可点 */}
  }
  function watchLogin(button){
   const id=button.dataset.login;
   if(watchers.has(id))return;
   const started=Date.now();
   const timer=setInterval(async()=>{
    if(id==='fab'){await paintFabLogin(button);}
    else{const hosts=await readCookieHosts();if(hosts)paintLogin(button,hosts);}
    let open=false;
    try{
     const response=await fetch('/api/browser/login',{headers:{'X-SFX-Local':'1'}});
     open=Boolean((await response.json())?.open);
    }catch{open=false;}
    if(open&&Date.now()-started<15*60*1000)return;
    clearInterval(timer);watchers.delete(id);button.dataset.busy='0';
    if(id==='fab'){await paintFabLogin(button);if(button.dataset.state!=='ok')toast(`${button.dataset.label||'Fab'} 还没登录成功，可以再点一次`);}
    else{const finalHosts=await readCookieHosts();if(finalHosts)paintLogin(button,finalHosts);if(!['ok','have','warn'].includes(button.dataset.state||''))toast(`${button.dataset.label||''} 还没拿到 cookie，可以再点一次登录`);}
   },3000);
   watchers.set(id,timer);
  }
 async function openLogin(button){
  if(button.dataset.busy==='1')return;
  const id=button.dataset.login,name=button.dataset.label||id;
  button.dataset.busy='1';button.dataset.state='busy';button.title=`正在打开 ${name} 登录窗口…`;
  try{
   const response=await fetch('/api/browser/login',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({platform:id})});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||'打不开登录窗口');
   button.title=`${name} 登录窗口已打开：登录（或完成验证）后直接关掉窗口，cookie 会自动保存`;
   toast(`已打开 ${name} 登录窗口：登录（或完成验证）后直接关掉窗口，cookie 会自动保存`);
   watchLogin(button);
  }catch(error){
   const message=String(error?.message||'打不开登录窗口');
   button.dataset.busy='0';button.dataset.state='fail';button.title=`${name} 登录窗口打不开：${message}`;
   toast(`${name} 登录窗口打不开：${message}`);
   setTimeout(async()=>paintLogin(button,await readCookieHosts()||[]),4000);
  }
 }
 // 卡片渲染完先对一次账，把已有 cookie 的站直接标成「已登录」（不点也不影响解析）。
  readCookieHosts().then(hosts=>{if(hosts)card.querySelectorAll('[data-login]').forEach(button=>{if(button.dataset.login!=='fab')paintLogin(button,hosts);});});
  card.querySelectorAll('[data-login="fab"]').forEach(button=>paintFabLogin(button));
 // ---- 卡片上的「测试」：只读一次请求，不写缓存、不入队，也不会因为平台被关掉就拒绝测试（关掉也要能自证好坏）。----
 async function testOne(id,url){
  const response=await fetch('/api/platforms/test',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({id,url:url||''})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'测试请求失败');
  if(!data.ok)throw Error(data.error||'平台无响应');
  return data;
 }
 async function runTest(button,silent=false){
  if(button.dataset.busy==='1')return null;
  const id=button.dataset.test,name=button.dataset.label||id;
  const owner=button.closest('.platform-module-card');
  button.dataset.busy='1';button.dataset.state='busy';button.title=`正在测试 ${name}，请稍候…`;
  if(owner)owner.setAttribute('data-testing','1');
  try{
   const data=await testOne(id,button.dataset.testUrl||'');
   const seconds=(Number(data.ms||0)/1000).toFixed(1);
   button.dataset.state='ok';
   button.title=`${name} 可用 · 耗时 ${seconds}s · ${data.count>0?`取到 ${data.count} 条`:'连接正常但没取到条目'}${data.sample?`\n示例：${data.sample}`:''}`;
   if(!silent)toast(`${name} 可用 · ${seconds}s`);
   return {id,name,ok:true,ms:Number(data.ms||0),count:Number(data.count||0)};
  }catch(error){
   const message=String(error?.message||'连接失败');
   button.dataset.state='fail';button.title=`${name} 测试失败：${message}`;
   if(!silent)toast(`${name} 测试失败：${message}`);
   return {id,name,ok:false,error:message};
  }finally{
   button.dataset.busy='0';
   if(owner)owner.removeAttribute('data-testing');
  }
 }
 // ---- 批量测试：把当前 Tab 里可见的平台一次性跑完，逐张回写结果 ----
 // 图站一屏只显示选中的分组，所以只测可见分组里的卡片。
 // 并发 4 —— 图站解析要开一次浏览器 / 抓页面，串行会把「一批」拉得过久；平台站各自独立，并发也不会互相串扰。
 const batchProgress=card.querySelector('[data-batch-progress]');
 const batchFill=card.querySelector('[data-batch-fill]');
 const batchText=card.querySelector('[data-batch-text]');
 const batchButton=card.querySelector('[data-batch-test]');
 const batchLabel=card.querySelector('[data-batch-label]');
 let batchRunning=false;
 function visibleTestButtons(){
  const panel=activePanel();if(!panel)return [];
  const groups=panel.querySelectorAll('.picture-site-group');
  const scope=groups.length?[...groups].filter(group=>!group.hidden):[panel];
  return [...scope.flatMap(node=>[...node.querySelectorAll('[data-test]')])];
 }
 function setBatchProgress(done,total,ok,fail){
  batchText.textContent=`测试中 ${done} / ${total}${done?` · 正常 ${ok}${fail?` · 异常 ${fail}`:''}`:''}`;
  batchFill.style.width=`${total?Math.round(done/total*100):0}%`;
 }
 async function runBatch(){
  if(batchRunning)return;
  const buttons=visibleTestButtons();
  if(!buttons.length){toast('这个分组没有可测试的平台');return;}
  batchRunning=true;
  batchButton.dataset.running='1';batchLabel.textContent='测试中';
  batchProgress.hidden=false;
  setBatchProgress(0,buttons.length,0,0);
  const queue=buttons.slice();
  let done=0,ok=0,fail=0;
  const worker=async()=>{
   while(queue.length){
    const button=queue.shift();
    const result=await runTest(button,true);
    done++;
    if(result&&result.ok)ok++;else fail++;
    setBatchProgress(done,buttons.length,ok,fail);
   }
  };
  await Promise.all(Array.from({length:Math.min(4,buttons.length)},worker));
  batchRunning=false;
  batchButton.removeAttribute('data-running');batchLabel.textContent='批量测试';
  batchProgress.hidden=true;
  toast(`批量测试完成：${ok} 个正常${fail?` · ${fail} 个异常`:''}`);
 }
// ---- 卡片上的「复制」：把该站 cookie 头拷到剪贴板 ----
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
 button.dataset.busy='1';button.title=`正在读取 ${name} 的 cookie…`;
 try{
  const response=await fetch(`/api/browser/cookies?domain=${encodeURIComponent(host)}`,{headers:{'X-SFX-Local':'1'}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'取 cookie 失败');
  if(!data.header)throw Error('这个站还没有 cookie，先登录一次');
  await writeClipboard(data.header);
  button.dataset.state='ok';
  button.title=`已复制 ${data.cookies} 条 cookie · ${new Date().toLocaleTimeString()}\n${data.header.slice(0,180)}${data.header.length>180?'…':''}`;
  toast(`已复制 ${name} 的 ${data.cookies} 条 cookie（${data.header.length} 字符）`);
  setTimeout(()=>{button.removeAttribute('data-state');button.title=`复制 ${name} 的 cookie`;},2000);
 }catch(error){
  button.dataset.state='fail';button.title=`复制 ${name} cookie 失败：${error.message}`;
  toast(`复制 ${name} cookie 失败：${error.message}`);
  setTimeout(()=>{button.removeAttribute('data-state');button.title=`复制 ${name} 的 cookie`;},2500);
 }finally{button.dataset.busy='0';}
}
card.addEventListener('click',async event=>{
 const tabButton=event.target.closest('[data-tab]');
 if(tabButton){event.preventDefault();showTab(tabButton.dataset.tab);return;}
 // 图站分组子 Tab：只切换可见分组，不影响平台开关。
 const groupTab=event.target.closest('[data-group-tab]');
 if(groupTab){
  event.preventDefault();event.stopPropagation();
  const panel=activePanel();if(!panel)return;
  const name=groupTab.dataset.groupTab;
  for(const group of panel.querySelectorAll('.picture-site-group'))group.hidden=name!=='全部'&&group.dataset.group!==name;
  for(const button of panel.querySelectorAll('[data-group-tab]')){
   const on=button.dataset.groupTab===name;
   button.classList.toggle('active',on);
   button.setAttribute('aria-selected',on?'true':'false');
  }
  return;
 }
 const login=event.target.closest('[data-login]');
 if(login){event.preventDefault();event.stopPropagation();openLogin(login);return;}
 const copyCookie=event.target.closest('[data-copy]');
 if(copyCookie){event.preventDefault();event.stopPropagation();if(!copyCookie.disabled)copySiteCookie(copyCookie);return;}
 const test=event.target.closest('[data-test]');
 if(test){event.preventDefault();event.stopPropagation();runTest(test);return;}
 const batch=event.target.closest('[data-batch-test]');
 if(batch){event.preventDefault();event.stopPropagation();runBatch();return;}
 // 卡片内的「官网」是外链，点它不能顺带拨动外面的开关。
 if(event.target.closest('a.platform-icon-btn'))event.stopPropagation();
 });
 return card;
}
