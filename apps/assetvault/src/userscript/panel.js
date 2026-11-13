// Floating download panel. Shadow DOM so page CSS cannot break it.

const CSS = [
  ":host { all: initial; }",
  ".sfx-toggle { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;",
  "  width: 46px; height: 46px; border-radius: 50%; border: none; cursor: pointer;",
  "  font-size: 22px; background: #1caad9; color: #fff;",
  "  box-shadow: 0 2px 10px rgba(0,0,0,.35); }",
  ".sfx-panel { position: fixed; right: 18px; bottom: 74px; z-index: 2147483647;",
  "  width: 340px; max-height: 62vh; display: none; flex-direction: column;",
  "  background: #1e2a32; color: #e8eef2; border-radius: 10px;",
  "  font: 13px/1.5 system-ui, sans-serif;",
  "  box-shadow: 0 4px 24px rgba(0,0,0,.5); overflow: hidden; }",
  ".sfx-panel.open { display: flex; }",
  ".sfx-head { padding: 10px 12px; background: #1caad9; color: #fff; font-weight: 600; }",
  ".sfx-body { padding: 10px 12px; display: flex; flex-direction: column;",
  "  gap: 8px; overflow-y: auto; }",
  ".sfx-row { display: flex; align-items: center; gap: 12px; }",
  ".sfx-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; }",
  ".sfx-row select { background: #0f171d; color: #e8eef2;",
  "  border: 1px solid #3a4a55; border-radius: 4px; padding: 2px 4px; }",
  ".sfx-dl { padding: 8px; border: none; border-radius: 6px;",
  "  background: #1caad9; color: #fff; font-weight: 600; cursor: pointer; }",
  ".sfx-dl:disabled { opacity: .55; cursor: default; }",
  ".sfx-log { margin: 0; padding: 8px; background: #0f171d; border-radius: 6px;",
  "  height: 150px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;",
  "  font: 11px/1.5 monospace; }",
  ".sfx-hint { font-size: 11px; color: #9fb3c0; }",
  ".sfx-time { font-weight: 400; opacity: .85; }",
].join("\n");

export function createPanel({ version, onDownload }) {
  const host = document.createElement("div");
  host.id = "sfx-exporter-host";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML =
    "<style>" + CSS + "</style>" +
    '<button class="sfx-toggle" title="Sketchfab 导出">\u2b07</button>' +
    '<div class="sfx-panel">' +
    '  <div class="sfx-head">Sketchfab 导出 <span class="sfx-ver"></span><span class="sfx-time"></span></div>' +
    '  <div class="sfx-body">' +
    '    <div class="sfx-row">' +
    '      <label><input type="checkbox" class="sfx-tex" checked> 下载贴图</label>' +
    '      <label><input type="checkbox" class="sfx-dev"> 调试日志</label>' +
    '      <label><input type="checkbox" class="sfx-fast" checked> 快速打包</label>' +
    '      <label><input type="checkbox" class="sfx-png" checked> 贴图存PNG</label>' +
    "    </div>" +
    '    <div class="sfx-row">' +
    '      <label>打包 <select class="sfx-pack">' +
    '        <option value="full">完整包</option>' +
    '        <option value="glb">仅 GLB</option>' +
    "      </select></label>" +
    '      <label>贴图 <select class="sfx-edge">' +
    '        <option value="0">原尺寸</option>' +
    '        <option value="4096">\u22644K</option>' +
    '        <option value="2048">\u22642K</option>' +
    "      </select></label>" +
    "    </div>" +
    '    <button class="sfx-dl">下载当前模型</button>' +
    '    <pre class="sfx-log"></pre>' +
    '    <div class="sfx-hint">仅用于自有或已获授权的模型；动画/骨骼随 GLB 导出，' +
    "    大模型处理时页面可能短暂卡顿。</div>" +
    "  </div>" +
    "</div>";
  const $ = (sel) => shadow.querySelector(sel);
  $(".sfx-ver").textContent = "v" + version;
  const panel = $(".sfx-panel");
  const logEl = $(".sfx-log");
  const dlBtn = $(".sfx-dl");
  const timeEl = $(".sfx-time");
  let timer = null;
  let busySince = 0;
  function startTimer() {
    stopTimer();
    busySince = Date.now();
    timer = setInterval(() => {
      timeEl.textContent = " · " + ((Date.now() - busySince) / 1000).toFixed(0) + "s";
    }, 1000);
  }
  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
    timeEl.textContent = "";
  }
  $(".sfx-toggle").addEventListener("click", () => panel.classList.toggle("open"));
  dlBtn.addEventListener("click", () => {
    try {
      onDownload();
    } catch (e) {
      append("失败: " + ((e && e.message) || e));
    }
  });

  function append(msg) {
    const line = String(msg || "");
    logEl.textContent += (logEl.textContent ? "\n" : "") + line;
    while (logEl.textContent.split("\n").length > 400) {
      logEl.textContent = logEl.textContent.slice(logEl.textContent.indexOf("\n") + 1);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  document.documentElement.appendChild(host);
  return {
    log: append,
    setBusy(busy) {
      dlBtn.disabled = !!busy;
      dlBtn.textContent = busy ? "处理中…" : "下载当前模型";
      if (busy) startTimer();
      else stopTimer();
    },
    getOptions() {
      return {
        downloadTextures: $(".sfx-tex").checked === true,
        devMode: $(".sfx-dev").checked === true,
        fastZip: $(".sfx-fast").checked === true,
        pngOnly: $(".sfx-png").checked === true,
        packMode: $(".sfx-pack").value === "glb" ? "glb" : "full",
        maxTextureEdge: Number($(".sfx-edge").value) || 0,
      };
    },
  };
}
