/**
 * 设置面板里的「运行环境 · 后台浏览器」。
 *
 * Sketchfab 模型转换（export-worker）和 ArtStation 页面读取都要一个真实的 Chromium
 * 在后台渲染网页。它以前是随安装包分发的 —— 解压后 236MB，占了安装包九成体积，
 * 但只有真正执行转换/抓取时才用得上。现在改成装完再下：安装包小了一大截，
 * 浏览器也只在需要时占磁盘，下载走国内镜像（淘宝 npmmirror），锁一个已验证的稳定版。
 *
 * 面板要回答的只有三件事：装没装、装在哪、下到哪一步了。
 * 没装时不能装作没事：上层会回落到系统 Chrome/Edge，但那可能被杀软拦掉，
 * 所以「点一下就能补上」要摆在明面上。
 */
const ROUTE = '/api/browser';
/** 下载任务在后端每步都会更新，300ms 足够跟上，又不会把事件循环压满。 */
const POLL_MS = 300;
/** 二十多兆到两百多兆不等，慢网也要留够时间，免得按钮永远卡在「下载中」。 */
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
/** 成功动效保留多久再收起来。 */
const SUCCESS_HOLD_MS = 5600;
/** 勾 / 叉自己画，配合描边动画（与「Blender 连接」面板同一套）。 */
const MARK = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
};
const mb = n => (Number(n) || 0) / 1048576;

async function request(route = '', body) {
  const get = body === undefined;
  const response = await fetch(ROUTE + route, {
    method: get ? 'GET' : 'POST',
    cache: 'no-store',
    headers: { 'X-SFX-Local': '1', ...(get ? {} : { 'Content-Type': 'application/json' }) },
    ...(get ? {} : { body: JSON.stringify(body || {}) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Error((data && data.error) || '浏览器运行时请求失败');
  return data || {};
}

export function createBrowserRuntimePanel({ $, esc, icon, toast }) {
  const statusBox = $('#browser-runtime-status');
  const metaBox = $('#browser-runtime-meta');
  const installButton = $('#install-browser-runtime');
  const progressBox = $('#browser-runtime-progress');
  let busy = false, holdTimer = null, token = 0, shownState = '', installed = false;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  /** 把后端状态翻译成一句人话 + 一个颜色。 */
  function describe(data) {
    if (data.installed) {
      return {
        tone: 'ok',
        title: `后台浏览器已就绪 · ${data.version}`,
        detail: data.bytes
          ? `占用 ${mb(data.bytes).toFixed(0)} MB，装在 ${data.path}`
          : `装在 ${data.path}`,
      };
    }
    const fallback = data.system?.found
      ? `检测到系统已装 ${data.system.name}，可以临时顶替；但它可能被安全软件拦下。`
      : '本机也没检测到系统 Chrome/Edge，转换会直接失败。';
    return {
      tone: 'warn',
      title: '还没有下载后台浏览器',
      detail: `Sketchfab 模型转换和 ArtStation 页面读取需要它。${fallback}`,
    };
  }

  function renderMeta(data) {
    if (!metaBox) return;
    const chips = [`chrome-headless-shell ${data.version}`, data.platform].filter(Boolean);
    metaBox.innerHTML = chips.map(c => `<span class="bridge-chip current" title="${esc(data.root || '')}">${esc(c)}</span>`).join('');
  }

  function paint(state) {
    if (!statusBox) return;
    statusBox.dataset.tone = state.tone;
    statusBox.innerHTML = `<span class="bridge-dot ${state.tone}"></span><div class="bridge-copy"><strong>${esc(state.title)}</strong><small>${esc(state.detail)}</small></div>`;
  }

  function stepMark(state) {
    if (state === 'done') return `<i class="bridge-step-ok">${MARK.check}</i>`;
    if (state === 'error') return `<i class="bridge-step-bad">${MARK.cross}</i>`;
    if (state === 'active') return '<i class="spinner"></i>';
    return '<i class="bridge-step-idle"></i>';
  }

  const HEAD_TITLE = { running: '正在下载浏览器运行时', ok: '下载完成', failed: '下载失败' };

  function renderResult(job) {
    if (job.state === 'ok') {
      return `<div class="bridge-result ok"><span class="bridge-result-mark">${MARK.check}</span><div>`
        + `<strong>下载完成</strong><small>${esc(job.message || '浏览器运行时已就绪')}</small>`
        + `<small>下次执行 Sketchfab 转换时自动生效，不用重启应用。</small></div></div>`;
    }
    const reason = job.error || job.message || '后端没有给出原因';
    return `<div class="bridge-result ${job.state}"><span class="bridge-result-mark">${MARK.cross}</span><div>`
      + `<strong>没有下成</strong><small>${esc(job.message || '')}</small>`
      + `<small class="reason">原因：${esc(reason)}</small>`
      + '<small>可以过一会儿再点一次；网络受限时会自动换源重试。</small></div></div>';
  }

  function renderProgress(job) {
    if (!progressBox) return;
    const steps = job.steps || [];
    const percent = Math.max(2, Math.min(100, Math.round(job.percent || 0)));
    const active = steps.find(s => s.state === 'active');
    progressBox.hidden = false;
    progressBox.classList.remove('closing');
    progressBox.dataset.state = job.state;
    progressBox.innerHTML = `<div class="bridge-progress-head"><span>${esc(HEAD_TITLE[job.state] || '下载中')}</span><b>${percent}%</b></div>`
      + `<div class="bridge-progress-track"><span class="bridge-progress-fill" style="width:${percent}%"></span></div>`
      + (job.state === 'running' && active ? `<p class="bridge-progress-now"><i class="spinner"></i>${esc(active.detail || active.label)}…</p>` : '')
      + `<ul class="bridge-steps">${steps.map(step => `<li class="${step.state}">${stepMark(step.state)}<div>`
        + `<span>${esc(step.label)}</span>`
        + (step.detail ? `<small>${esc(step.detail)}</small>` : '')
        + `</div></li>`).join('')}</ul>`
      + (job.state === 'running' ? '' : renderResult(job));
    if (job.state !== 'running' && shownState === 'running') {
      const banner = progressBox.querySelector('.bridge-result');
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      banner?.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }
    shownState = job.state;
  }

  function renderLocalFailure(reason) {
    if (!progressBox) return;
    progressBox.hidden = false;
    progressBox.classList.remove('closing');
    progressBox.dataset.state = 'failed';
    progressBox.innerHTML = `<div class="bridge-progress-head"><span>下载失败</span><b>—</b></div>`
      + `<div class="bridge-result failed"><span class="bridge-result-mark">${MARK.cross}</span><div>`
      + `<strong>没能开始下载</strong><small class="reason">原因：${esc(reason)}</small>`
      + '<small>确认本地服务还在运行，然后重试。</small></div></div>';
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

  function labelButton(text) {
    if (!installButton) return;
    installButton.innerHTML = `${icon(installed ? 'rotate' : 'download')}${text}`;
  }

  /** 按 id 轮询下载任务，直到它不再是 running。 */
  async function follow(jobId) {
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    for (;;) {
      const job = await request(`/install?id=${encodeURIComponent(jobId)}`);
      renderProgress(job);
      if (job.state !== 'running') return job;
      if (Date.now() > deadline) throw Error('下载任务超时，后端一直没给出结果');
      await sleep(POLL_MS);
    }
  }

  async function refresh() {
    if (!busy) {
      clearTimeout(holdTimer);
      if (progressBox) { progressBox.hidden = true; progressBox.innerHTML = ''; progressBox.dataset.state = ''; progressBox.classList.remove('closing'); }
    }
    paint({ tone: 'idle', title: '正在检测…', detail: '读取浏览器运行时状态' });
    if (metaBox) metaBox.innerHTML = '';
    try {
      const data = await request();
      installed = !!data.installed;
      paint(describe(data));
      renderMeta(data);
      labelButton(installed ? '重新下载' : '下载浏览器');
    } catch (e) {
      paint({ tone: 'warn', title: '无法读取浏览器状态', detail: String(e.message || e) });
    }
  }

  async function install() {
    if (busy) return;
    busy = true;
    clearTimeout(holdTimer);
    const owner = ++token;
    if (installButton) { installButton.disabled = true; installButton.innerHTML = '<i class="spinner"></i>正在下载…'; }
    paint({ tone: 'busy', title: '正在下载后台浏览器', detail: '从国内镜像获取 chrome-headless-shell' });
    try {
      const { jobId } = await request('/install', {});
      if (!jobId) throw Error('后端没有返回下载任务编号');
      const job = await follow(jobId);
      if (job.status) { installed = !!job.status.installed; paint(describe(job.status)); renderMeta(job.status); }
      if (job.state === 'ok') {
        toast(job.message || '浏览器运行时下载完成');
        holdTimer = setTimeout(() => collapseProgress(owner), SUCCESS_HOLD_MS);
        labelButton('重新下载');
      } else {
        toast(`下载失败：${job.error || job.message || '原因未知'}`);
        labelButton('重试下载');
      }
    } catch (e) {
      const reason = String(e.message || e);
      renderLocalFailure(reason);
      paint({ tone: 'warn', title: '下载失败', detail: reason });
      toast('下载失败：' + reason);
      labelButton('重试下载');
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
