// 桌面版「开机自启」开关。
//
// 为什么不在前端存一个偏好就完事：自启是操作系统状态，不是页面偏好。用户可能在
// 任务管理器 → 启动 里把它禁用掉，也可能把程序搬了位置（注册表里还指着旧路径）。
// 所以每次打开设置都去问原生层要真实状态，勾选态永远反映「Windows 现在会不会拉起它」。
//
// 浏览器里打开资产库（非桌面版）时拿不到 Tauri 桥，直接返回 null —— 这个卡片不出现，
// 不留一个点了没反应的开关。

const nativeInvoke = () => globalThis.window?.__TAURI__?.core?.invoke || null;

export function createAutostartCard({ toast = () => {} } = {}) {
  const invoke = nativeInvoke();
  if (!invoke) return null;

  const card = document.createElement('section');
  card.className = 'settings-card';
  card.innerHTML = `
    <div class="settings-section-title"><span>启动与后台</span><small>登录 Windows 后自动运行，窗口收在托盘里</small></div>
    <label class="check-row autostart-row">
      <input type="checkbox" id="autostart-toggle" aria-describedby="autostart-note" disabled>
      <span>开机时自动启动 Arvimo · 艺团</span>
    </label>
    <p class="compact-note" id="autostart-note">开机只启动后台服务，不弹主窗口；点任务栏托盘图标即可打开。关闭窗口默认也是收到托盘，不中断下载。</p>`;
  const toggle = card.querySelector('#autostart-toggle');
  const note = card.querySelector('#autostart-note');
  let busy = false, supported = false, enabled = false;

  function paint(status) {
    if (!status) return;
    supported = status.supported !== false;
    enabled = !!status.enabled;
    toggle.disabled = !supported || busy;
    toggle.checked = !!status.enabled;
    if (!supported) {
      note.hidden = false;
      note.textContent = '当前系统不支持开机自启，只能手动启动。';
      return;
    }
    note.hidden = !status.command;
    if (status.command) {
      // 注册表里指向的可能是旧安装位置：如实显示，别让用户以为「开了但其实指不到」。
      note.textContent = `启动项：${status.command}`;
    }
  }

  async function refresh() {
    if (busy) return;
    busy = true;toggle.disabled = true;
    try {
      paint(await invoke('autostart_status'));
    } catch (error) {
      note.hidden = false;
      supported = false;
      note.textContent = `读取开机自启状态失败：${String(error?.message || error)}。请重启开发版后重试。`;
    } finally {
      busy = false;toggle.disabled = !supported;
    }
  }

  toggle.addEventListener('change', async () => {
    if (busy) return;
    const wanted = toggle.checked;
    busy = true;
    toggle.disabled = true;
    try {
      const status = await invoke('autostart_set', { enabled: wanted });
      paint(status);
      // 写注册表成功不等于真的会被拉起：以返回的真实状态为准，别按用户点击的意图报成功。
      if (wanted && status && status.enabled === false) {
        throw Error('注册表写入后回读仍是未启用');
      }
      toast(wanted ? '已设置开机自启（只在托盘运行）' : '已取消开机自启');
    } catch (error) {
      toggle.checked = enabled;
      note.hidden = false;
      note.textContent = `设置失败：${String(error?.message || error)}`;
      toast(`设置开机自启失败：${String(error?.message || error)}`);
    } finally {
      busy = false;
      toggle.disabled = !supported;
    }
  });

  refresh();
  return { card, refresh };
}
