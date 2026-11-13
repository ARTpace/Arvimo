/**
 * 设置面板里「可安装依赖」的共用引擎。
 *
 * 「Blender 连接」和「后台浏览器」是同一个东西的两种说法：一块状态灯 + 一排版本标签 +
 * 一个安装按钮 + 一个分步进度条。判定逻辑、轮询节奏、成功动效、超时兜底、失败横幅
 * 全都可以一样 —— 之前两份代码连函数名都是同名复制，改一处忘另一处只是时间问题。
 *
 * 这里只留下「流程」：检测 → 点按钮 → 建任务 → 按 id 轮询 → 画进度 → 收尾。
 * 所有「说什么话」的部分都由调用方通过回调提供（describe / renderBanner / copy），
 * 因为那才是两个面板真正的区别。
 *
 * 外壳提供的能力：
 *   - 只有端口真的应答才算「连上」，装完没生效不能谎报成功（describe 负责说清）
 *   - 安装按钮在整个任务期间锁死，超时按失败处理，避免永远卡在「安装中」
 *   - 任务建不起来（401/网络断）时也在面板里留一句原因，而不是只闪一条 toast
 *   - 结果横幅落在可视区外时自动带进视野，否则用户会以为点了没反应
 */

/** 勾 / 叉自己画，为的是能配合描边动画（内置图标集里没有可动画的版本）。
 *  调用方的收尾横幅也要用这两枚，所以导出。 */
export const MARK = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>',
};

/** 一个步骤前面的标记：待办是空心点，进行中转圈，完成打勾，失败打叉。 */
export function stepMark(state) {
  if (state === 'done') return `<i class="bridge-step-ok">${MARK.check}</i>`;
  if (state === 'error') return `<i class="bridge-step-bad">${MARK.cross}</i>`;
  if (state === 'active') return '<i class="spinner"></i>';
  return '<i class="bridge-step-idle"></i>';
}

/**
 * 进度条骨架：标题 + 百分比 + 轨道 + 当前动作 + 步骤列表 + 收尾横幅。
 * Blender 面板、后台浏览器面板、依赖准备向导用的都是这一份 DOM。
 * 调用方只决定「标题说什么」「收尾横幅长什么样」「步骤下面还有没有备注」。
 */
export function progressMarkup({
  job, esc, headTitle = '处理中',
  nowLabel = active => active.label,
  resultHtml = '', stepExtra,
}) {
  const steps = job.steps || [];
  const percent = Math.max(2, Math.min(100, Math.round(job.percent || 0)));
  const active = steps.find(s => s.state === 'active');
  return `<div class="bridge-progress-head"><span>${esc(headTitle)}</span><b>${percent}%</b></div>`
    + `<div class="bridge-progress-track"><span class="bridge-progress-fill" style="width:${percent}%"></span></div>`
    + (job.state === 'running' && active ? `<p class="bridge-progress-now"><i class="spinner"></i>${esc(nowLabel(active, job))}…</p>` : '')
    + `<ul class="bridge-steps">${steps.map(step => `<li class="${step.state}">${stepMark(step.state)}<div>`
      + `<span>${esc(step.label)}</span>`
      + (step.detail ? `<small>${esc(step.detail)}</small>` : '')
      + (stepExtra ? stepExtra(step) : '')
      + `</div></li>`).join('')}</ul>`
    + (job.state === 'running' ? '' : resultHtml);
}

/**
 * @param {object} o
 * @param {string} o.route            面板对应的后端前缀，如 '/api/browser'
 * @param {number} o.pollMs           轮询间隔
 * @param {number} o.timeoutMs        任务最长等待
 * @param {object} o.ids              {status, chips, button, progress} 选择器
 * @param {Function} o.describe       data => {tone,title,detail}
 * @param {Function} o.renderChips    data => innerHTML（可空）
 * @param {Function} o.renderBanner   job => innerHTML
 * @param {Function} [o.renderStepExtra] step => innerHTML（步骤下额外说明，可空）
 * @param {Function} [o.nowLabel]     active => 进行中那一句的主语
 * @param {object} o.headTitles       {running, ok, failed, ...} 进度条标题
 * @param {Function} o.buttonFor      ({phase, data}) => {icon, text}；phase: idle/retry/done
 * @param {Function} [o.onStatus]     data => void，供调用方缓存自己的状态位
 * @param {object} o.copy             文案：errDefault/detecting/detectError/busy/busyButton/
 *                                    timeout/noJobId/failure{head,title,hint}/okToast/failToast
 */
export function createInstallPanel({
  $, esc, icon, toast,
  route,
  pollMs = 200,
  timeoutMs = 90000,
  successHoldMs = 5600,
  ids,
  describe,
  renderChips,
  renderBanner,
  renderStepExtra,
  nowLabel = active => active.label,
  headTitles,
  buttonFor,
  onStatus,
  copy,
}) {
  const statusBox = $(ids.status);
  const chipsBox = $(ids.chips);
  const installButton = $(ids.button);
  const progressBox = $(ids.progress);
  let busy = false, holdTimer = null, token = 0, shownState = '';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function request(path = '', body) {
    const get = body === undefined;
    const response = await fetch(route + path, {
      method: get ? 'GET' : 'POST',
      cache: 'no-store',
      headers: { 'X-SFX-Local': '1', ...(get ? {} : { 'Content-Type': 'application/json' }) },
      ...(get ? {} : { body: JSON.stringify(body || {}) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Error((data && data.error) || copy.errDefault);
    return data || {};
  }

  /** 把后端状态翻译成一句人话 + 一个颜色。 */
  function paint(state) {
    if (!statusBox) return;
    statusBox.dataset.tone = state.tone;
    statusBox.innerHTML = `<span class="bridge-dot ${state.tone}"></span><div class="bridge-copy"><strong>${esc(state.title)}</strong><small>${esc(state.detail)}</small></div>`;
  }

  function paintChips(data) {
    if (!chipsBox) return;
    chipsBox.innerHTML = renderChips ? renderChips(data) || '' : '';
  }

  /** 按钮文案由调用方决定；进行中的「转圈 + 动宾短语」是两家一致的。 */
  function paintButton(phase, data) {
    if (!installButton) return;
    if (phase === 'busy') {
      installButton.innerHTML = `<i class="spinner"></i>${esc(copy.busyButton)}`;
      return;
    }
    const view = buttonFor({ phase, data });
    installButton.innerHTML = view.icon ? `${icon(view.icon)}${esc(view.text)}` : esc(view.text);
  }

  function renderProgress(job) {
    if (!progressBox) return;
    progressBox.hidden = false;
    progressBox.classList.remove('closing');
    progressBox.dataset.state = job.state;
    progressBox.innerHTML = progressMarkup({
      job, esc,
      headTitle: headTitles[job.state] || '处理中',
      nowLabel,
      stepExtra: renderStepExtra,
      resultHtml: renderBanner(job),
    });
    // 结果横幅可能落在对话框可视区外：刚跑完时把它带进视野，否则用户会以为点了没反应。
    if (job.state !== 'running' && shownState === 'running') {
      const banner = progressBox.querySelector('.bridge-result');
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      banner?.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }
    shownState = job.state;
  }

  /** 任务都没起来时（后端 401 / 网络断）也要在面板里留下一句原因。 */
  function renderLocalFailure(reason) {
    if (!progressBox) return;
    progressBox.hidden = false;
    progressBox.classList.remove('closing');
    progressBox.dataset.state = 'failed';
    progressBox.innerHTML = `<div class="bridge-progress-head"><span>${esc(copy.failure.head)}</span><b>—</b></div>`
      + `<div class="bridge-result failed"><span class="bridge-result-mark">${MARK.cross}</span><div>`
      + `<strong>${esc(copy.failure.title)}</strong><small class="reason">原因：${esc(reason)}</small>`
      + `<small>${esc(copy.failure.hint)}</small></div></div>`;
  }

  function clearProgress() {
    if (!progressBox) return;
    progressBox.hidden = true;
    progressBox.innerHTML = '';
    progressBox.dataset.state = '';
    progressBox.classList.remove('closing');
  }

  function collapseProgress(owner) {
    if (!progressBox || busy || owner !== token) return;
    progressBox.classList.add('closing');
    setTimeout(() => {
      if (!progressBox || busy || owner !== token) return;
      clearProgress();
    }, 260);
  }

  /** 按 id 轮询任务，直到它不再是 running。 */
  async function follow(jobId) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await request(`/install?id=${encodeURIComponent(jobId)}`);
      renderProgress(job);
      if (job.state !== 'running') return job;
      if (Date.now() > deadline) throw Error(copy.timeout);
      await sleep(pollMs);
    }
  }

  async function refresh() {
    if (!busy) {
      clearTimeout(holdTimer);
      clearProgress();
    }
    paint({ tone: 'idle', title: '正在检测…', detail: copy.detecting });
    paintChips(null);
    try {
      const data = await request();
      onStatus?.(data);
      paint(describe(data));
      paintChips(data);
      paintButton('idle', data);
    } catch (e) {
      paint({ tone: 'warn', title: copy.detectError, detail: String(e.message || e) });
    }
  }

  async function install() {
    if (busy) return;
    busy = true;
    clearTimeout(holdTimer);
    const owner = ++token;
    if (installButton) installButton.disabled = true;
    paintButton('busy');
    paint({ tone: 'busy', title: copy.busy.title, detail: copy.busy.detail });
    try {
      const { jobId } = await request('/install', {});
      if (!jobId) throw Error(copy.noJobId);
      const job = await follow(jobId);
      if (job.status) {
        onStatus?.(job.status);
        paint(describe(job.status));
        paintChips(job.status);
      }
      if (job.state === 'ok') {
        toast(copy.okToast(job));
        holdTimer = setTimeout(() => collapseProgress(owner), successHoldMs);
        paintButton('done', job.status);
      } else {
        toast(copy.failToast(job));
        paintButton('retry', job.status);
      }
    } catch (e) {
      const reason = String(e.message || e);
      renderLocalFailure(reason);
      paint({ tone: 'warn', title: copy.failure.title, detail: reason });
      toast((copy.failure.toast || copy.failure.title) + '：' + reason);
      paintButton('retry');
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
