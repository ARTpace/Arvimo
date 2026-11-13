// 独立外观演示：模拟加载进度，不请求后台，不跳转页面。
(() => {
  const $ = id => document.getElementById(id);
  const card = $('card'), msg = $('msg'), pct = $('pct'), fill = $('fill');
  const runner = $('runner'), tip = $('tip'), hero = $('hero');
  const lines = [
    [0, '正在唤醒小方块…'],
    [13, '正在检查引擎补丁…'],
    [32, '正在搬砖搭模型库…'],
    [50, '正在清点模型抽屉…'],
    [66, '正在擦亮每一颗立方体…'],
    [82, '正在拉开卷帘门…'],
  ];
  const settings = { loadingMs: 4600, rampMs: 1400, burstMs: 420, replayMs: 2200 };
  let started = performance.now(), previous = started, shown = 0;
  let phase = 'loading', burstAt = 0, burstFrom = 0, line = -1, generation = 0;
  $('ver').textContent = '· 外观动画演示';

  function paint(value) {
    fill.style.width = `${value}%`;
    runner.style.left = `${value}%`;
    pct.textContent = `${Math.round(value)}%`;
    if (phase !== 'loading') return;
    const next = lines.findLastIndex(([threshold]) => value >= threshold);
    if (next === line) return;
    line = next;
    const token = generation;
    msg.classList.add('swap');
    setTimeout(() => {
      if (token !== generation || phase !== 'loading') return;
      msg.textContent = lines[next][1];
      msg.classList.remove('swap');
    }, 220);
  }

  function replay() {
    generation++;
    started = previous = performance.now();
    shown = 0; line = -1; phase = 'loading';
    card.classList.remove('done');
    msg.classList.remove('swap');
    tip.textContent = '正在准备模型库，马上就好…';
    requestAnimationFrame(frame);
  }

  function frame(now) {
    const dt = now - previous;
    previous = now;
    if (phase === 'loading') {
      const goal = Math.min(92, 92 * (1 - Math.exp(-(now - started) / settings.rampMs)));
      shown += (goal - shown) * (1 - Math.exp(-dt / 130));
      if (now - started >= settings.loadingMs) {
        phase = 'burst'; burstAt = now; burstFrom = shown;
      }
    } else {
      const k = Math.min(1, (now - burstAt) / settings.burstMs);
      shown = burstFrom + (100 - burstFrom) * (1 - Math.pow(1 - k, 3));
      if (k === 1) {
        phase = 'done'; paint(100);
        card.classList.add('done'); msg.classList.remove('swap');
        msg.textContent = '准备开门，一起进去吧 ✨';
        tip.textContent = '界面已就绪 · 动画即将重新播放';
        setTimeout(replay, settings.replayMs);
        return;
      }
    }
    paint(Math.min(99, shown));
    requestAnimationFrame(frame);
  }

  $('mascot').addEventListener('click', () => {
    hero.style.animation = 'none';
    void hero.offsetWidth;
    hero.style.animation = 'cheer .85s cubic-bezier(.3,1.4,.4,1)';
    setTimeout(() => { hero.style.animation = ''; }, 880);
  });
  replay();
})();
