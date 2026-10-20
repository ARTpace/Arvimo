/* 共用启动界面：桌面端等 Rust 确认服务就绪，浏览器端预热接口后进入首页。
 * 桌面端在应用本地协议下运行，不跨源请求后端，也不再导航到第二张加载页。 */
(() => {
  const desktop = location.pathname.endsWith('/waiting.html') && window.__TAURI__?.core;
  const MIN_MS = desktop ? 650 : 1900;
  const RAMP_MS = 1400;   // 第一段自然爬升的时间常数
  const BURST_MS = 420;   // 最后冲满的时长
  const HOLD_MS = 620;    // 冲满之后停留多久再跳转

  const el = id => document.getElementById(id);
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

  function paint(v) {
    fill.style.width = v + '%';
    runner.style.left = v + '%';
    pct.textContent = Math.round(v) + '%';
    let next = -1;
    for (let i = 0; i < LINES.length; i++) if (v >= LINES[i][0]) next = i;
    if (next >= 0 && next !== line) {
      line = next;
      const text = LINES[next][1];
      msg.classList.add('swap');
      setTimeout(() => {
        if (phase !== 'loading') return;
        msg.textContent = desktop && !warm ? '正在启动本地模型库服务…' : text;
        msg.classList.remove('swap');
      }, 220);
    }
  }

  // 预热：这两趟往返本来要等首页打开之后才发生，提前在这里做掉。
  // 最多等 4 秒，免得因为某个接口卡住而让启动画面停在那儿。
  function warmup() {
    const health = fetch('/api/health', { cache: 'no-store' })
      .then(res => res.json())
      .then(data => { if (data && data.version) ver.textContent = 'v' + data.version; })
      .catch(() => {});
    const tasks = fetch('/api/downloads', { headers: { 'X-SFX-Local': '1' }, cache: 'no-store' })
      .catch(() => {});
    Promise.race([
      Promise.all([health, tasks]),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ]).then(() => { warm = true; });
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
          throw new Error('本地服务地址无效，请重新启动 AssetVault。');
        }
        home = target.href;warm = true;
        msg.textContent = '本地服务已就绪，正在准备界面…';
        tip.textContent = '马上就好…';
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
      const goal = Math.min(92, 92 * (1 - Math.exp(-(now - t0) / RAMP_MS)));
      // 按时间插值而不是按帧插值：标签页被切到后台帧率掉到 1fps 时进度也不会落后。
      shown += (goal - shown) * (1 - Math.exp(-dt / 130));
      if (now - t0 >= MIN_MS && warm) { phase = 'burst'; burstAt = now; burstFrom = shown; }
    } else {
      const k = Math.min(1, (now - burstAt) / BURST_MS);
      shown = burstFrom + (100 - burstFrom) * (1 - Math.pow(1 - k, 3));
      if (k >= 1) { paint(100); finish(); return; }
    }
    paint(Math.min(99, shown));
    requestAnimationFrame(frame);
  }

  function finish() {
    phase = 'done';
    card.classList.add('done');
    msg.classList.remove('swap');
    msg.textContent = '准备开门，一起进去吧 ✨';
    tip.textContent = '模型库已就绪，正在进入…';
    paint(100);
    setTimeout(goHome, HOLD_MS);
  }

  // 跳转前先确认服务还活着。后台服务万一已经退出，直接跳到死端口会掉进浏览器的
  // 错误页（还会伴随一串 "Unsafe attempt to load URL ..." 报错）；宁可在这里把话说清楚。
  function goHome(attempt = 0) {
    if (desktop) { location.replace(home); return; }
    fetch('/api/health', { cache: 'no-store' })
      .then(() => location.replace('/'))
      .catch(() => {
        if (attempt < 2) return setTimeout(() => goHome(attempt + 1), 700);
        msg.textContent = '咦，后台服务好像被关掉了';
        tip.textContent = '重新双击 AssetVault 图标就能再启动一次';
        ver.textContent = '';
      });
  }

  if (desktop) {
    msg.textContent = '正在启动本地模型库服务…';
    tip.textContent = '正在唤醒本地服务，模型库准备好后会自动打开…';
    waitForBackend();
  } else warmup();
  requestAnimationFrame(frame);

  // 点一下吉祥物，它会开心地蹦一个大的
  mascot.addEventListener('click', () => {
    hero.style.animation = 'none';
    void hero.offsetWidth;
    hero.style.animation = 'cheer .85s cubic-bezier(.3,1.4,.4,1)';
    setTimeout(() => { hero.style.animation = ''; }, 880);
  });
})();
