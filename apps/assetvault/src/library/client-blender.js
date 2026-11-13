// 局域网访客点「导入 Blender」时，模型必须落进访客**自己**电脑上的 Blender：主机那支桥接
// 只认主机磁盘上的文件，对它无能为力。所以浏览器直接跟访客本机 127.0.0.1:47752 上的同款
// 桥接对话（插件 v2 起自带极简 HTTP 入口），把整包 ZIP 推过去，由插件解压后交给 bpy 导入。
//
// 探活与导入都必须走 cors：这是跨源请求，插件只对私网/本机来源回 Access-Control-Allow-Origin。
import {fetchBrowserAsset} from './browser-delivery.js';
import {icon} from './icon-set.js';

const BRIDGE = 'http://127.0.0.1:47752';

/** 探测访客本机桥接：没装插件、Blender 没开、或插件版本太旧，都只会拿到 null。 */
export async function probeLocalBridge(timeout = 1600) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${BRIDGE}/ping`, {signal: controller.signal, cache: 'no-store', mode: 'cors'});
    if (!response.ok) return null;
    const info = await response.json();
    return info?.bridge === 'assetvault' ? info : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 把主机上已保存的成品 ZIP 推给本机桥接：不落访客磁盘、不重新抓取，导入完临时目录会被插件删掉。 */
export async function importIntoLocalBlender(jobId) {
  const {blob, filename} = await fetchBrowserAsset(jobId);
  const response = await fetch(`${BRIDGE}/import-upload?name=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/zip'},
    body: blob,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw Error(data.error || `本机 Blender 导入失败（HTTP ${response.status}）`);
  return data;
}

/** 探不到桥接时的安装引导：插件要在访客自己的 Blender 里装一次，主机代劳不了。 */
export function createLocalBlenderGuide({toast}) {
  let dialog = document.getElementById('client-blender-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'client-blender-dialog';
    dialog.className = 'path-dialog client-blender-dialog';
    dialog.innerHTML = `<div class="dialog-header"><span>${icon('blender')}在自己电脑上导入 Blender</span><button class="icon-button" data-close="client-blender-dialog" aria-label="关闭">${icon('close')}</button></div>
     <div class="dialog-body">
      <p class="compact-note">浏览器没有权限直接打开你电脑上的 Blender。先在自己的 Blender 里装一次桥接插件（只需一次），之后点卡片上的 Blender 键就会直接导入当前场景。</p>
      <ol class="client-blender-steps">
       <li>下载插件：<a href="/api/lan/blender-addon" download="assetvault_blender_bridge.py">assetvault_blender_bridge.py</a></li>
       <li>Blender ▸ 编辑 ▸ 偏好设置 ▸ 插件 ▸ 右上角 <b>▾</b> ▸ 从磁盘安装，选刚下载的文件</li>
       <li>在插件列表里勾选 <b>AssetVault Bridge</b> 启用它</li>
       <li>保持 Blender 开着，回到这里点「重新检测」</li>
      </ol>
      <p class="compact-note" data-guide-status role="status"></p>
      <div class="client-blender-actions"><button class="secondary" type="button" data-guide-check>重新检测</button></div>
     </div>`;
    document.body.append(dialog);
    const status = dialog.querySelector('[data-guide-status]');
    const check = dialog.querySelector('[data-guide-check]');
    check.onclick = async () => {
      check.disabled = true;
      status.textContent = '正在检测本机桥接…';
      try {
        const info = await probeLocalBridge();
        if (info) {
          status.textContent = `已连接${info.blender ? `：Blender ${info.blender}` : ''}（桥接 v${info.version}）`;
          toast('本机桥接已就绪，可以导入 Blender 了');
          setTimeout(() => dialog.close(), 900);
        } else {
          status.textContent = '还是没检测到。确认 Blender 正在运行、插件已勾选启用；刚启用时最好重启一次 Blender。';
        }
      } finally {
        check.disabled = false;
      }
    };
  }
  return {open() {if (!dialog.open) dialog.showModal();}};
}
