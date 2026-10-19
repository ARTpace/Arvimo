/**
 * 设置面板里的「Blender 连接」。
 *
 * 桥接这套东西以前全靠用户自己猜：装没装？要不要重启 Blender？为什么点了没反应？
 * 这里把三件事摊开 —— 脚本装到哪些版本目录、Blender 开着没有、端口是不是真的能应答。
 *
 * 判定顺序很重要：端口能应答才算「连上」；装了脚本但 Blender 是启动前装的，
 * 只能提示重启，不能谎报成功。
 *
 * 安装按钮走的是后端的分步任务：点下去先把按钮锁住，再按 id 轮询进度，
 * 每一步（读源文件 / 找版本目录 / 逐个写入 / 回读校验 / 探活端口）都照实显示；
 * 失败时把后端给的原因留在面板里，而不是只弹一条几秒就消失的提示。
 */
const ROUTE = '/api/downloads/blender-bridge';
/** 轮询间隔：后端每步停留 260ms，140ms 足够跟上，又不会把事件循环压满。 */
const POLL_MS = 140;
/** 安装任务最多等这么久，超时按失败处理，免得按钮永远卡在「安装中」。 */
const INSTALL_TIMEOUT_MS = 90000;
/** 成功动效保留多久再收起来。 */
const SUCCESS_HOLD_MS = 5600;
/** 勾 / 叉自己画，为的是能配合描边动画（内置图标集里没有可动画的版本）。 */
const MARK = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
};

async function request(route = '', body) {
  const get = body === undefined;
  const response = await fetch(ROUTE + route, {
    method: get ? 'GET' : 'POST',
    cache: 'no-store',
    headers: { 'X-SFX-Local': '1', ...(get ? {} : { 'Content-Type': 'application/json' }) },
    ...(get ? {} : { body: JSON.stringify(body || {}) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Error((data && data.error) || 'Blender 连接请求失败');
  return data || {};
}

export function createBlenderBridgePanel({ $, esc, icon, toast }) {
  const statusBox = $('#blender-bridge-status');
  const versionsBox = $('#blender-bridge-versions');
  const installButton = $('#install-blender-bridge');
  const progressBox = $('#blender-bridge-progress');
  let busy = false, holdTimer = null, token = 0, shownState = '';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  /** 把后端状态翻译成一句人话 + 一个颜色。 */
  function describe(data) {
    const targets = data.targets || [];
    const installed = targets.filter(t => t.state !== 'missing');
    const stale = targets.filter(t => t.state === 'stale');
    const versions = installed.map(t => t.version).join(' / ');

    if (!data.sourceReady) {
      return { tone: 'idle', title: '缺少桥接脚本源文件', detail: `找不到 ${data.source || 'server/blender-bridge.py'}，请检查安装是否完整。` };
    }
    if (data.bridgeOnline) {
      return {
        tone: 'ok',
        title: `已连接 Blender${installed.length ? ' · ' + versions : ''}`,
        detail: `端口 ${data.port} 已应答。在卡片上点「Blender」即可把模型送进当前场景。`,
      };
    }
    if (stale.length) {
      return {
        tone: 'warn',
        title: '桥接脚本有更新',
        detail: `${stale.map(t => t.version).join(' / ')} 还是旧版本，点下面的按钮更新，然后重启 Blender。`,
      };
    }
    if (installed.length && data.blenderRunning) {
      return {
        tone: 'warn',
        title: 'Blender 已打开，但桥接还没生效',
        detail: `脚本已装到 ${versions}，但这次启动没加载到。请关掉 Blender 再重新打开一次。`,
      };
    }
    if (installed.length) {
      return {
        tone: 'idle',
        title: '脚本已就绪，等 Blender 启动',
        detail: `已装到 ${versions}；打开 Blender 后会自动连接，不用再做别的。`,
      };
    }
    if (!targets.length) {
      return {
        tone: 'idle',
        title: '没有找到 Blender 配置目录',
        detail: '这台电脑还没装过 Blender，或装了但从未启动过。先打开一次 Blender，再点下面的按钮。',
      };
    }
    return {
      tone: 'idle',
      title: '还没有安装桥接脚本',
      detail: '点下面的按钮安装，装完重启 Blender 即可使用。平时点卡片上的「Blender」也会自动安装。',
    };
  }

  function renderVersions(data) {
    if (!versionsBox) return;
    const targets = data.targets || [];
    if (!targets.length) { versionsBox.innerHTML = ''; return; }
    versionsBox.innerHTML = targets.map(t => {
      const label = t.state === 'current' ? t.version : t.state === 'stale' ? `${t.version} 待更新` : `${t.version} 未安装`;
      return `<span class="bridge-chip ${t.state}" title="${esc(t.path)}">${esc(label)}</span>`;
    }).join('');
  }

  function paint(state) {
    if (!statusBox) return;
    statusBox.dataset.tone = state.tone;
    statusBox.innerHTML = `<span class="bridge-dot ${state.tone}"></span><div class="bridge-copy"><strong>${esc(state.title)}</strong><small>${esc(state.detail)}</small></div>`;
  }

  /** 一个步骤前面的标记：待办是空心点，进行中是转圈，完成打勾，失败打叉。 */
  function stepMark(state) {
    if (state === 'done') return `<i class="bridge-step-ok">${MARK.check}</i>`;
    if (state === 'error') return `<i class="bridge-step-bad">${MARK.cross}</i>`;
    if (state === 'active') return '<i class="spinner"></i>';
    return '<i class="bridge-step-idle"></i>';
  }

  const HEAD_TITLE = { running: '正在安装桥接脚本', ok: '安装完成', partial: '部分完成', failed: '安装失败' };

  /** 收尾横幅：成功给动效 + 装到哪儿；失败把原因原文摆出来。 */
  function renderResult(job) {
    const status = job.status || {};
    if (job.state === 'ok') {
      const written = status.written || [];
      const restart = !status.bridgeOnline && status.blenderRunning;
      return `<div class="bridge-result ok"><span class="bridge-result-mark">${MARK.check}</span><div><strong>安装成功</strong>`
        + `<small>${esc(job.message || '桥接脚本已写入')}</small>`
        + (restart ? '<small>Blender 正开着：关掉它再重新打开一次，脚本才会加载。</small>' : '')
        + (written.length ? `<ul class="bridge-result-list">${written.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '')
        + '</div></div>';
    }
    const errors = status.errors || [];
    const reason = job.error || job.message || '后端没有给出原因';
    return `<div class="bridge-result ${job.state}"><span class="bridge-result-mark">${MARK.cross}</span><div>`
      + `<strong>${job.state === 'partial' ? '部分位置失败' : '安装失败'}</strong>`
      + `<small>${esc(job.message || '')}</small><small class="reason">原因：${esc(reason)}</small>`
      + (errors.length > 1 ? `<ul class="bridge-result-list">${errors.slice(0, 5).map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : '')
      + '</div></div>';
  }

  function renderProgress(job) {
    if (!progressBox) return;
    const steps = job.steps || [];
    const percent = Math.max(2, Math.min(100, Math.round(job.percent || 0)));
    const active = steps.find(s => s.state === 'active');
    progressBox.hidden = false;
    progressBox.classList.remove('closing');
    progressBox.dataset.state = job.state;
    progressBox.innerHTML = `<div class="bridge-progress-head"><span>${esc(HEAD_TITLE[job.state] || '安装中')}</span><b>${percent}%</b></div>`
      + `<div class="bridge-progress-track"><span class="bridge-progress-fill" style="width:${percent}%"></span></div>`
      + (job.state === 'running' && active ? `<p class="bridge-progress-now"><i class="spinner"></i>${esc(active.label)}…</p>` : '')
      + `<ul class="bridge-steps">${steps.map(step => `<li class="${step.state}">${stepMark(step.state)}<div>`
        + `<span>${esc(step.label)}</span>`
        + (step.detail ? `<small>${esc(step.detail)}</small>` : '')
        + (step.notes && step.notes.length ? `<ul class="bridge-step-notes">${step.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '')
        + `</div></li>`).join('')}</ul>`
      + (job.state === 'running' ? '' : renderResult(job));
    // 结果横幅可能落在对话框可视区外：刚跑完时把它带进视野，否则用户会以为点了没反应。
    if (job.state !== 'running' && shownState === 'running') {
      const banner = progressBox.querySelector('.bridge-result');
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      banner?.scrollIntoView?.({block: 'nearest', behavior: reduce ? 'auto' : 'smooth'});
    }
    shownState = job.state;
  }

  /** 安装失败且连任务都没起来时，也要在面板里留下一句原因。 */
  function renderLocalFailure(reason) {
    if (!progressBox) return;
    progressBox.hidden = false;
    progressBox.classList.remove('closing');
    progressBox.dataset.state = 'failed';
    progressBox.innerHTML = `<div class="bridge-progress-head"><span>安装失败</span><b>—</b></div>`
      + `<div class="bridge-result failed"><span class="bridge-result-mark">${MARK.cross}</span><div>`
      + `<strong>没有装上</strong><small class="reason">原因：${esc(reason)}</small>`
      + '<small>确认本地服务还在运行；若刚换过电脑，请先打开一次 Blender 让它生成配置目录。</small></div></div>';
  }

  function collapseProgress(owner) {
    if (!progressBox || busy || owner !== token) return;
    progressBox.classList.add('closing');
    setTimeout(() => {
      if (!progressBox || busy || owner !== token) return;
      progressBox.hidden = true;
      progressBox.innerHTML = '';
      progressBox.dataset.state = '';
      progressBox.classList.remove('closing');
    }, 260);
  }

  /** 按 id 轮询安装任务，直到它不再是 running。 */
  async function follow(jobId) {
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    for (;;) {
      const job = await request(`/install?id=${encodeURIComponent(jobId)}`);
      renderProgress(job);
      if (job.state !== 'running') return job;
      if (Date.now() > deadline) throw Error('安装任务超时，后端一直没给出结果');
      await sleep(POLL_MS);
    }
  }

  async function refresh() {
    if (!busy) {
      clearTimeout(holdTimer);
      if (progressBox) { progressBox.hidden = true; progressBox.innerHTML = ''; progressBox.dataset.state = ''; progressBox.classList.remove('closing'); }
    }
    paint({ tone: 'idle', title: '正在检测…', detail: '读取桥接脚本与端口状态' });
    if (versionsBox) versionsBox.innerHTML = '';
    try {
      const data = await request();
      paint(describe(data));
      renderVersions(data);
    } catch (e) {
      paint({ tone: 'warn', title: '无法读取 Blender 状态', detail: String(e.message || e) });
    }
  }

  async function install() {
    if (busy) return;
    busy = true;
    clearTimeout(holdTimer);
    const owner = ++token;
    const original = installButton ? installButton.innerHTML : '';
    if (installButton) { installButton.disabled = true; installButton.innerHTML = '<i class="spinner"></i>正在安装…'; }
    paint({ tone: 'busy', title: '正在安装桥接脚本', detail: '准备把启动脚本写进 Blender 配置目录' });
    try {
      const { jobId } = await request('/install', {});
      if (!jobId) throw Error('后端没有返回安装任务编号');
      const job = await follow(jobId);
      const status = job.status;
      if (status) { paint(describe(status)); renderVersions(status); }
      if (job.state === 'ok') {
        toast(job.message || '桥接脚本安装完成');
        holdTimer = setTimeout(() => collapseProgress(owner), SUCCESS_HOLD_MS);
      } else {
        toast(`${job.state === 'partial' ? '部分位置写入失败' : '安装失败'}：${job.error || job.message || '原因未知'}`);
      }
      if (installButton) installButton.innerHTML = job.state === 'ok' ? original : `${icon('rotate')}重试安装`;
    } catch (e) {
      const reason = String(e.message || e);
      renderLocalFailure(reason);
      paint({ tone: 'warn', title: '安装失败', detail: reason });
      toast('安装失败：' + reason);
      if (installButton) installButton.innerHTML = `${icon('rotate')}重试安装`;
    } finally {
      busy = false;
      if (installButton) installButton.disabled = false;
    }
  }

  function setup() {
    if (installButton) installButton.onclick = install;
  }

  return { setup, refresh };
}
