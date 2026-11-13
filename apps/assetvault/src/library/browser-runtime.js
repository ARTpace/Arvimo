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
 *
 * 流程本体（检测 → 下载任务 → 轮询 → 分步进度 → 收尾横幅）住在 install-panel.js，
 * 与「Blender 连接」共用同一份；这里只负责说浏览器运行时自己的话。
 */
import {createInstallPanel, MARK} from './install-panel.js';

const ROUTE = '/api/browser';
const mb = n => (Number(n) || 0) / 1048576;

export function createBrowserRuntimePanel({ $, esc, icon, toast }) {
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

  /** 版本与平台两枚标签，和 Blender 那边同一套样式。 */
  function renderChips(data) {
    const chips = [`chrome-headless-shell ${data?.version}`, data?.platform].filter(Boolean);
    return chips.map(c => `<span class="bridge-chip current" title="${esc(data.root || '')}">${esc(c)}</span>`).join('');
  }

  function renderBanner(job) {
    if (job.state === 'ok') {
      return `<div class="bridge-result ok"><span class="bridge-result-mark">${MARK.check}</span><div>`
        + `<strong>下载完成</strong><small>${esc(job.message || '浏览器运行时已就绪')}</small>`
        + `<small>下次执行 Sketchfab 转换时自动生效，不用重启应用。</small></div></div>`;
    }
    const reason = job.error || job.message || '后端没有给出原因';
    return `<div class="bridge-result ${job.state}"><span class="bridge-result-mark">${MARK.cross}</span><div>`
      + `<strong>没有下成</strong><small>${esc(job.message || '')}</small>`
      + `<small class="reason">原因：${esc(reason)}</small>`
      + `<small>可以过一会儿再点一次；网络受限时会自动换源重试。</small></div></div>`;
  }

  return createInstallPanel({
    $, esc, icon, toast,
    route: ROUTE,
    // 后端每步都会更新，300ms 足够跟上，又不会把事件循环压满。
    pollMs: 300,
    // 二十多兆到两百多兆不等，慢网也要留够时间，免得按钮永远卡在「下载中」。
    timeoutMs: 30 * 60 * 1000,
    ids: {
      status: '#browser-runtime-status',
      chips: '#browser-runtime-meta',
      button: '#install-browser-runtime',
      progress: '#browser-runtime-progress',
    },
    describe,
    renderChips,
    renderBanner,
    // 下载进度里步进带的是「正在下第几个文件」，比步骤名更有信息量。
    nowLabel: active => active.detail || active.label,
    headTitles: { running: '正在下载浏览器运行时', ok: '下载完成', failed: '下载失败' },
    buttonFor: ({ phase, data }) => {
      if (phase === 'retry') return { icon: 'rotate', text: '重试下载' };
      if (phase === 'done') return { icon: 'rotate', text: '重新下载' };
      return data?.installed
        ? { icon: 'rotate', text: '重新下载' }
        : { icon: 'download', text: '下载浏览器' };
    },
    copy: {
      errDefault: '浏览器运行时请求失败',
      detecting: '读取浏览器运行时状态',
      detectError: '无法读取浏览器状态',
      busy: { title: '正在下载后台浏览器', detail: '从国内镜像获取 chrome-headless-shell' },
      busyButton: '正在下载…',
      timeout: '下载任务超时，后端一直没给出结果',
      noJobId: '后端没有返回下载任务编号',
      failure: {
        head: '下载失败',
        title: '没能开始下载',
        toast: '下载失败',
        hint: '确认本地服务还在运行，然后重试。',
      },
      okToast: job => job.message || '浏览器运行时下载完成',
      failToast: job => `下载失败：${job.error || job.message || '原因未知'}`,
    },
  });
}
