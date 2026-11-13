/* 共用启动界面：桌面端等 Rust 确认服务就绪，浏览器端预热接口后进入首页。
 * 桌面端在应用本地协议下运行，不跨源请求后端，也不再导航到第二张加载页。 */
(async () => {
  const startupScreen=document.getElementById('startup-screen');
  let root=document;
  if(startupScreen){
    if(startupScreen.shadowRoot)root=startupScreen.shadowRoot;
    else try{
      const response=await fetch('/splash.html');
      if(!response.ok)throw Error('启动界面加载失败');
      const template=new DOMParser().parseFromString(await response.text(),'text/html');
      root=startupScreen.attachShadow({mode:'open'});
      root.innerHTML=`<style>${template.querySelector('style').textContent.replaceAll('body',':host')}</style>${template.querySelector('main').outerHTML}`;
      startupScreen.style.background='';
    }catch{
      const reveal=()=>startupScreen.remove();
      if(document.documentElement.dataset.uiReady)reveal();
      else window.addEventListener('assetvault:ui-ready',reveal,{once:true});
      return;
    }
  }
  const desktop = location.pathname.endsWith('/waiting.html') && window.__TAURI__?.core;
  const interfaceStage = !!startupScreen;
  const MIN_MS = interfaceStage || desktop ? 0 : 650;
  const RAMP_MS = 1400;   // 第一段自然爬升的时间常数
  const BURST_MS = 420;   // 最后冲满的时长
  const HOLD_MS = 180;    // 等完成弹跳与粒子动画展示后进入界面。

  const el = id => root.getElementById(id);
  const bits=[...(root.querySelectorAll?.('.bit')||[])];
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const card = el('card'), msg = el('msg'), pct = el('pct'), fill = el('fill'),
        runner = el('runner'), tip = el('tip'), ver = el('ver'),
        mascot = el('mascot'), hero = el('hero');

  const LINES = [
    [0, '正在唤醒小方块…'],
    [13, '正在检查引擎补丁…'],
    [32, '正在搬砖搭模型库…'],
    [50, '正在清点模型抽屉…'],
    [66, '正在擦亮每一颗立方体…'],
    [82, '正在拉开卷帘门…'],
  ];

  const t0 = Date.now();
  let shown = 0, line = -1, phase = 'loading', burstAt = 0, burstFrom = 0, warm = false, last = t0;
  let home = '/';
  let shownPct=-1,lastSpark=0;

  function sparksAt(container,x,y,count){
    if(reduced||!container)return;
    for(let i=0;i<count;i++){
      const p=document.createElement('i'),streak=Math.random()<.3;
      p.className=streak?'spark streak':'spark';
      const angle=Math.random()*Math.PI*2,speed=26+Math.pow(Math.random(),1.6)*46;
      p.style.setProperty('--s',`${(3+Math.random()*4.5).toFixed(1)}px`);
      p.style.setProperty('--dx',`${(Math.cos(angle)*speed).toFixed(1)}px`);
      p.style.setProperty('--dy',`${(Math.sin(angle)*speed).toFixed(1)}px`);
      p.style.setProperty('--rot',`${(angle*180/Math.PI).toFixed(1)}deg`);
      p.style.setProperty('--dur',`${(.65+Math.random()*.5).toFixed(2)}s`);
      if(streak)p.style.width=`${(8+Math.random()*8).toFixed(1)}px`;
      p.style.left=`${x}px`;p.style.top=`${y}px`;container.appendChild(p);
      setTimeout(()=>p.remove(),1200);
    }
  }

  function paint(v) {
    fill.style.width = v + '%';
    runner.style.left = v + '%';
    const rounded=Math.round(v),p=Math.min(1,v/100);
    for(const [i,bit] of bits.entries()){
      bit.style.opacity=p>=i/(bits.length+1)?(.18+.5*p).toFixed(2):.05;
      bit.style.animationDuration=`${(6.4-3.4*p).toFixed(2)}s`;
    }
    if(rounded!==shownPct){shownPct=rounded;pct.textContent=rounded+'%';pct.classList.remove('bump');void pct.offsetWidth;pct.classList.add('bump');}
    let next = -1;
    for (let i = 0; i < LINES.length; i++) if (v >= LINES[i][0]) next = i;
    if (next >= 0 && next !== line) {
      line = next;
      const text = interfaceStage ? '正在准备分类、配置与界面布局…' : LINES[next][1];
      msg.classList.add('swap');
      setTimeout(() => {
        if (phase !== 'loading') return;
        msg.textContent = desktop && !warm ? '正在启动本地模型库服务…' : text;
        msg.classList.remove('swap');
        msg.classList.remove('unswap');void msg.offsetWidth;msg.classList.add('unswap');
      }, 220);
    }
  }

  // 预热：这两趟往返本来要等首页打开之后才发生，提前在这里做掉。
  // 最多等 4 秒，免得因为某个接口卡住而让启动画面停在那儿。
  function warmup() {
    const health = fetch('/api/health', { cache: 'no-store' })
      .then(res => res.json())
      .then(data => { if (ver && data && data.version) ver.textContent = 'v' + data.version; })
      .catch(() => {});
    const tasks = fetch('/api/downloads', { headers: { 'X-SFX-Local': '1' }, cache: 'no-store' })
      .catch(() => {});
    Promise.race([
      Promise.all([health, tasks]),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ]).then(() => { phase='done';goHome(); });
  }

  async function waitForBackend() {
    try {
      const [error, url] = await Promise.all([
        desktop.invoke('backend_startup_error'), desktop.invoke('backend_ready_url'),
      ]);
      if (error) throw new Error(error);
      if (url) {
        const target = new URL(url);
        if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/') {
          throw new Error('本地服务地址无效，请重新启动 Arvimo。');
        }
        home = target.href;
        msg.textContent = '本地服务已就绪，正在准备界面…';
        tip.textContent = '马上就好…';
        phase='done';goHome();
        return;
      }
      setTimeout(waitForBackend, 200);
    } catch (error) {
      phase = 'done';
      card.classList.remove('done');msg.classList.remove('swap');
      msg.textContent = '启动未完成';pct.textContent = '未就绪';
      tip.textContent = error.message || String(error);
    }
  }

  function frame() {
    if (phase === 'done') return;
    const now = Date.now();
    const dt = Math.max(0, now - last);
    last = now;
    if (phase === 'loading') {
      const goal = interfaceStage ? 70 + 22 * (1 - Math.exp(-(now - t0) / RAMP_MS)) : Math.min(68, 68 * (1 - Math.exp(-(now - t0) / RAMP_MS)));
      // 按时间插值而不是按帧插值：标签页被切到后台帧率掉到 1fps 时进度也不会落后。
      shown += (goal - shown) * (1 - Math.exp(-dt / 130));
      if (now - t0 >= MIN_MS && warm) { phase = 'burst'; burstAt = now; burstFrom = shown; }
    } else {
      const k = Math.min(1, (now - burstAt) / BURST_MS);
      shown = burstFrom + (100 - burstFrom) * (1 - Math.pow(1 - k, 3));
      if(now-lastSpark>90){lastSpark=now;sparksAt(fill.parentElement,runner.offsetLeft,4,1+(Math.random()<.35?1:0));}
      if (k >= 1) { paint(100); finish(); return; }
    }
    paint(Math.min(99, shown));
    requestAnimationFrame(frame);
  }

  function finish() {
    phase = 'done';
    sparksAt(fill.parentElement,runner.offsetLeft,2,12);
    card.classList.add('done');
    msg.classList.remove('swap');
    msg.textContent = '准备开门，一起进去吧';
    msg.classList.remove('unswap');void msg.offsetWidth;msg.classList.add('unswap');
    tip.textContent = '模型库已就绪，正在进入…';
    paint(100);
    setTimeout(goHome, HOLD_MS);
  }

  // 跳转前先确认服务还活着。后台服务万一已经退出，直接跳到死端口会掉进浏览器的
  // 错误页（还会伴随一串 "Unsafe attempt to load URL ..." 报错）；宁可在这里把话说清楚。
  function goHome(attempt = 0) {
    if (interfaceStage) {
      startupScreen.remove();
      return;
    }
    if (desktop) {
      desktop.invoke('open_ready_library').catch(error => {
        msg.textContent = '无法打开模型库';
        tip.textContent = error.message || String(error);
      });
      return;
    }
    fetch('/api/health', { cache: 'no-store' })
      .then(() => location.replace('/'))
      .catch(() => {
        if (attempt < 2) return setTimeout(() => goHome(attempt + 1), 700);
        msg.textContent = '咦，后台服务好像被关掉了';
        tip.textContent = '重新双击 Arvimo 图标就能再启动一次';
        if(ver)ver.textContent = '';
      });
  }

  if (interfaceStage) {
    shown=70;paint(shown);
    msg.textContent='正在准备分类、配置与界面布局…';
    tip.textContent='';
    warm=!!document.documentElement.dataset.uiReady;
    window.addEventListener('assetvault:ui-ready',()=>{warm=true;},{once:true});
    window.addEventListener('assetvault:ui-error',event=>{
      phase='done';msg.classList.remove('swap');msg.textContent='界面初始化失败';tip.textContent=`${event.detail}；请刷新页面重试`;
    },{once:true});
    setTimeout(()=>{
      if(!warm){msg.textContent='界面准备时间较长';tip.textContent='请检查本地服务，或刷新页面重试';}
    },20000);
  } else if (desktop) {
    msg.textContent = '正在启动本地模型库服务…';
    tip.textContent = '正在唤醒本地服务，模型库准备好后会自动打开…';
    waitForBackend();
  } else warmup();
  requestAnimationFrame(frame);

  // 点一下吉祥物，它会开心地蹦一个大的
  mascot.addEventListener('click', event => {
    hero.style.animation = 'none';
    void hero.offsetWidth;
    hero.style.animation = 'cheer .85s cubic-bezier(.3,1.4,.4,1)';
    const rect=mascot.getBoundingClientRect();sparksAt(mascot,event.clientX-rect.left,event.clientY-rect.top,6);
    setTimeout(() => { hero.style.animation = ''; }, 880);
  });
})();
