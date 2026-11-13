import { installFetchFallback, canUseGM } from "./net.js";
import { createPanel } from "./panel.js";
import { downloadModel } from "../../vendor/upstream-src/lib/pipeline.js";
import { saveZip } from "../../vendor/upstream-src/lib/save.js";

const VERSION = typeof SFX_VERSION !== "undefined" ? SFX_VERSION : "dev";

// patched(14): self-identifying logs + JS speed probe.
// The export log had no version/browser line, and a descramble map phase at
// ~2.8us/pixel is either a heavy loop or a very slow JS host. The probe runs
// the same typed-array shapes the descramble uses: sequential copy (MB/s) and
// tile-scattered reads (Mops/s). It also warms up the JIT for those loops.
const SFX_UA = typeof navigator !== "undefined" ? navigator.userAgent : "?";

function sfxProbe() {
  try {
    const n = 1 << 21;
    const a = new Uint8ClampedArray(n * 4);
    const b = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < a.length; i++) a[i] = i & 255;
    let t = performance.now();
    for (let i = 0; i < a.length; i++) b[i] = a[i];
    const seq = a.length / 1048576 / Math.max(1e-3, (performance.now() - t) / 1000);
    t = performance.now();
    let acc = 0;
    let idx = 0;
    const len = a.length;
    for (let i = 0; i < 8000000; i++) {
      idx += 7919;
      if (idx >= len) idx -= len;
      acc += a[idx];
    }
    const rnd = 8 / Math.max(1e-3, (performance.now() - t) / 1000);
    return `seq=${seq.toFixed(0)}MB/s rnd=${rnd.toFixed(1)}Mops/s`;
  } catch (e) {
    return "n/a";
  }
}
// end patched(14)

function boot() {
  if (!/sketchfab\.com\/3d-models\//i.test(location.href)) return;
  if (document.getElementById("sfx-exporter-host")) return;
  installFetchFallback();
  const ui = createPanel({ version: VERSION, onDownload: run });

  async function run() {
    const flags = ui.getOptions();
    ui.setBusy(true);
    const t0 = Date.now();
    try {
      ui.log("开始导出当前模型…");
      ui.log("提示：解密/转换是大计算量步骤，页面可能短暂无响应，请勿关闭。");
      ui.log(
        canUseGM()
          ? "GM通道：可用（跨域自动回退）"
          : "GM通道：不可用（若跨域失败请检查脚本管理器的授权）"
      );
      await new Promise((r) => setTimeout(r, 50));
      ui.log(`脚本 v${VERSION} · ${SFX_UA}`);
      ui.log(`JS探针: ${sfxProbe()}`);
      globalThis.__sfxFastZipBytes = flags.fastZip ? 1048576 : 0;
      globalThis.__sfxPngOnly = flags.pngOnly !== false;
      const timed = (m) => ui.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
      const res = await downloadModel(location.href, timed, flags);
      ui.log(
        `打包完成: ${res.zipName}（${res.fileCount} 个文件` +
          `${res.hasGlb ? "，含 GLB" : "，无 GLB"}）`
      );
      await saveZip(res.zip, res.zipName);
      ui.log(`已触发浏览器下载（总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）。`);
    } catch (e) {
      ui.log(`失败（已用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）: ${(e && e.message) || e}`);
    } finally {
      ui.setBusy(false);
    }
  }
}

if (typeof window === "undefined") {
  // Node smoke test: the bundle must at least parse and evaluate.
  console.log(`sketchfab-exporter userscript bundle v${VERSION} (no DOM, nothing to do)`);
} else {
  boot();
}
