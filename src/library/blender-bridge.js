/**
 * 设置面板里的「Blender 连接」。
 *
 * 桥接这套东西以前全靠用户自己猜：装没装？要不要重启 Blender？为什么点了没反应？
 * 这里把三件事摊开 —— 脚本装到哪些版本目录、Blender 开着没有、端口是不是真的能应答。
 *
 * 判定顺序很重要：端口能应答才算「连上」；装了脚本但 Blender 是启动前装的，
 * 只能提示重启，不能谎报成功。
 *
 * 流程本体（检测 → 安装任务 → 轮询 → 分步进度 → 收尾横幅）住在 install-panel.js，
 * 与「运行环境 · 后台浏览器」共用同一份；这里只负责说 Blender 自己的话。
 */
import {createInstallPanel, MARK} from './install-panel.js';

const ROUTE = '/api/downloads/blender-bridge';

export function createBlenderBridgePanel({ $, esc, icon, toast }) {
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

  /** 每个版本目录一枚小标签：当前 / 待更新 / 未安装。 */
  function renderChips(data) {
    const targets = data?.targets || [];
    if (!targets.length) return '';
    return targets.map(t => {
      const label = t.state === 'current' ? t.version : t.state === 'stale' ? `${t.version} 待更新` : `${t.version} 未安装`;
      return `<span class="bridge-chip ${t.state}" title="${esc(t.path)}">${esc(label)}</span>`;
    }).join('');
  }

  /** 收尾横幅：成功给装到哪儿，失败把原因原文摆出来。 */
  function renderBanner(job) {
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

  /** 一步可能带多条备注（例如某个版本目录被占用时给出的替代路径）。 */
  function renderStepExtra(step) {
    if (!step.notes || !step.notes.length) return '';
    return `<ul class="bridge-step-notes">${step.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
  }

  return createInstallPanel({
    $, esc, icon, toast,
    route: ROUTE,
    // 后端每步停留 260ms，140ms 足够跟上，又不会把事件循环压满。
    pollMs: 140,
    // 装几个小文件而已，超过一分半就是卡住了，不能永远显示「安装中」。
    timeoutMs: 90000,
    ids: {
      status: '#blender-bridge-status',
      chips: '#blender-bridge-versions',
      button: '#install-blender-bridge',
      progress: '#blender-bridge-progress',
    },
    describe,
    renderChips,
    renderBanner,
    renderStepExtra,
    headTitles: { running: '正在安装桥接脚本', ok: '安装完成', partial: '部分完成', failed: '安装失败' },
    buttonFor: ({ phase }) => phase === 'retry'
      ? { icon: 'rotate', text: '重试安装' }
      : { icon: 'cube', text: '安装 / 更新' },
    copy: {
      errDefault: 'Blender 连接请求失败',
      detecting: '读取桥接脚本与端口状态',
      detectError: '无法读取 Blender 状态',
      busy: { title: '正在安装桥接脚本', detail: '准备把启动脚本写进 Blender 配置目录' },
      busyButton: '正在安装…',
      timeout: '安装任务超时，后端一直没给出结果',
      noJobId: '后端没有返回安装任务编号',
      failure: {
        head: '安装失败',
        title: '没有装上',
        toast: '安装失败',
        hint: '确认本地服务还在运行；若刚换过电脑，请先打开一次 Blender 让它生成配置目录。',
      },
      okToast: job => job.message || '桥接脚本安装完成',
      failToast: job => `${job.state === 'partial' ? '部分位置写入失败' : '安装失败'}：${job.error || job.message || '原因未知'}`,
    },
  });
}
