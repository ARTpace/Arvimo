/* AssetVault 启动画面。
 *
 * 这个页面由服务端自己提供 —— 浏览器能把它打开，就说明后台服务已经在 4178 上监听了。
 * 所以这里不做「等服务起来」的轮询，只做三件事：把动效完整走一遍、顺手预热工作台
 * 接下来要用的接口、然后把浏览器交给工作台首页。首页是同一个服务同一个端口，
 * 跳转不可能落空。
 *
 * 进度条有两段：先自然爬到 92%（预热请求没回来就不会进入下一段），
 * 预热完成且动效至少播够 MIN_MS 之后，再从小方块脚下冲满。
 */
(() => {
  const MIN_MS = 1900;    // 动效至少播这么久，否则一闪而过根本看不清
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
      setTimeout(() => { msg.textContent = text; msg.classList.remove('swap'); }, 220);
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
    fetch('/api/health', { cache: 'no-store' })
      .then(() => location.replace('/'))
      .catch(() => {
        if (attempt < 2) return setTimeout(() => goHome(attempt + 1), 700);
        msg.textContent = '咦，后台服务好像被关掉了';
        tip.textContent = '重新双击 AssetVault 图标就能再启动一次';
        ver.textContent = '';
      });
  }

  warmup();
  requestAnimationFrame(frame);

  // 点一下吉祥物，它会开心地蹦一个大的
  mascot.addEventListener('click', () => {
    hero.style.animation = 'none';
    void hero.offsetWidth;
    hero.style.animation = 'cheer .85s cubic-bezier(.3,1.4,.4,1)';
    setTimeout(() => { hero.style.animation = ''; }, 880);
  });
})();
