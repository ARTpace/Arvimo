/**
 * web-host.ts —— 纯浏览器宿主桥（网页版 / AssetVault 内嵌画布）。
 *
 * Electron（preload）与 Tauri（invoke）各有自己的宿主桥；纯浏览器两样都没有，
 * 于是插件管理器会报 host bridge unavailable：
 *   - 可编辑插件读不到 → 依赖它们的内置插件（PSD 导入向导）被判 requires missing plugin；
 *   - 声明式皮肤读不到 → 皮肤引擎拿不到默认皮肤 → --bp-ui-* 主题变量整条落空，
 *     插件开关、告警条等一切按状态着色的元素全变成灰白，看起来像「开关点不动」；
 *   - 外部插件清单读不到 → 面板直接显示错误条。
 * 这里补上浏览器能提供的最小宿主能力，其余桌面能力（目录/窗口/字节落盘）仍走浏览器回退。
 */
import { BUNDLED_EDITABLE_PLUGINS, loadBundledDeclarativePlugins } from './bundled-plugins';
import { createPluginStateBridge } from './plugin-state-bridge';

const BROWSER_ONLY_MESSAGE = '网页版没有外部插件宿主；桌面版可安装外部插件。';

export function installWebHostBridge(target: Window = window): boolean {
  // Electron / Tauri 已由各自宿主装好桥：不要覆盖。
  if (target.artflowApp) return false;
  const storage = (() => {
    try {
      return target.localStorage ?? null;
    } catch {
      return null;
    }
  })();

  target.artflowApp = {
    // 可编辑插件：与 Electron/Tauri 同一份内置清单（manifest + 源码）。
    readEditablePlugins: async () => ({
      plugins: BUNDLED_EDITABLE_PLUGINS.map(entry => ({
        id: entry.manifest.id,
        name: entry.manifest.name,
        version: entry.manifest.version,
        description: entry.manifest.description,
        manifest: entry.manifest,
        source: entry.source,
      })),
    }),
    // 声明式插件（皮肤包）：网页版没有用户插件目录，只提供随包内置的那几份。
    listDeclarativePlugins: async () => ({ plugins: await loadBundledDeclarativePlugins() }),
    // 外部插件：网页版没有安装目录，如实返回空清单，别让面板显示「host bridge unavailable」。
    listInstalledPlugins: async () => ({ plugins: [] }),
    installExternalPlugin: async () => ({ ok: false, message: BROWSER_ONLY_MESSAGE }),
    installExternalPluginFromPath: async () => ({ ok: false, message: BROWSER_ONLY_MESSAGE }),
    uninstallExternalPlugin: async () => ({ ok: false, message: BROWSER_ONLY_MESSAGE }),
    notifyRendererReady: () => {},
  } as unknown as NonNullable<Window['artflowApp']>;

  target.artflowPluginState = createPluginStateBridge(
    storage,
    BUNDLED_EDITABLE_PLUGINS.map(entry => entry.manifest),
  ) as unknown as NonNullable<Window['artflowPluginState']>;
  return true;
}

if (typeof window !== 'undefined') installWebHostBridge();
