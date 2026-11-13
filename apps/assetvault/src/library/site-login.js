// 图站登录入口：把「开一个可见登录窗口 → 轮询到窗口关闭 → 回来重跑刚才那一次解析」
// 收成一处，登录入口出现在几个地方（展示区空状态卡 / 解析失败卡 / 结果工具条）都调它。
//
// 为什么不各自内联一段：登录窗口可能开很久（扫码、过人机验证），「窗口还开着吗」这件事
// 只能靠轮询问服务端；每加一个入口就复制一遍 POST + 轮询，早晚会长成几套不一致的行为。
//
// 服务端约定（见 server/browser-session.mjs）：
//   POST /api/browser/login {platform} → 打开可见窗口，窗口里每 2.5 秒同步一次 cookie
//   GET  /api/browser/login            → {open:boolean}
// 用户关掉窗口就等于「登录完成」（不需要点任何「完成」键），所以轮询到 open:false 再重试。
const POLL_MS = 2500;
// 一轮登录最长等 15 分钟：超过就当作「这次不登了」，别让定时器在后台永远转。
const MAX_WAIT_MS = 15 * 60 * 1000;

/**
 * 打开某个图站的登录窗口，并在窗口关闭后回调。
 * @param {string} platform 图站 id（也是服务端 PICTURE_LOGIN_URLS 的键）
 * @param {{onClosed?:() => void, toast?:(message:string)=>void}} options
 * @returns {Promise<boolean>} 窗口是否成功打开（打开失败会抛错，由调用方 toast）
 */
export async function openSiteLogin(platform,{onClosed,toast}={}){
 if(!platform)return false;
 const response=await fetch('/api/browser/login',{
  method:'POST',
  headers:{'Content-Type':'application/json','x-sfx-local':'1'},
  body:JSON.stringify({platform}),
 });
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(data.error||'打开登录窗口失败');
 toast?.('已打开登录窗口：登录（或完成验证）后直接关掉窗口，cookie 会自动保存');
 const started=Date.now();
 let timer=0;
 const poll=async()=>{
  let open=false;
  try{
   const status=await fetch('/api/browser/login',{headers:{'x-sfx-local':'1'}});
   open=Boolean((await status.json())?.open);
  }catch{ open=false; }
  // 还开着（且没超时）就继续等；窗口没了 = 用户登完了。
  if(open&&Date.now()-started<MAX_WAIT_MS)return;
  clearInterval(timer);
  onClosed?.();
 };
 timer=setInterval(()=>{poll().catch(()=>{});},POLL_MS);
 return true;
}

/**
 * 绑一颗「登录」按钮：点一下开窗口，窗口关掉后跑 callback。
 * 按钮在等待期间禁用，避免连点开出第二个窗口；失败时立刻恢复可点并把原因说出来。
 */
const bareHost=value=>String(value||'').replace(/^\./,'').toLowerCase().replace(/^www\./,'');
const sameSite=(cookieHost,cardHost)=>{
 const a=bareHost(cookieHost),b=bareHost(cardHost);
 return !!a&&!!b&&(a===b||a.endsWith('.'+b)||b.endsWith('.'+a));
};

/** 给登录键标上当前站点的登录态：ok 已登录，have 只有 cookie，warn 明确未登录。 */
export async function markSiteLogin(button,host){
 if(!button||!host)return;
 try{
  const response=await fetch('/api/browser/cookies',{headers:{'x-sfx-local':'1'}});
  if(!response.ok)return;
  const data=await response.json();
  const rows=(data.hosts||[]).filter(row=>sameSite(row.domain,host));
  const known=rows.some(row=>row.login===true)?true:(rows.some(row=>row.login===false)?false:null);
  const count=rows.reduce((sum,row)=>sum+Number(row.count||0),0);
  button.dataset.state=known===true?'ok':known===false&&count?'warn':count?'have':'';
  const name=button.dataset.label||'这个站';
  button.title=known===true?`${name} 已登录，点一下可换账号`:count?`${name} 还没确认登录，点一下登录`:`登录 ${name}`;
 }catch{/* 登录态读不到就保持默认可点 */}
}

export function bindSiteLogin(button,platform,{onClosed,toast}={}){
 if(!button)return;
 button.onclick=async()=>{
  button.disabled=true;
  try{
   await openSiteLogin(platform,{onClosed:()=>{button.disabled=false;onClosed?.();},toast});
  }catch(error){
   button.disabled=false;
   toast?.(error.message||'打开登录窗口失败');
  }
 };
}
