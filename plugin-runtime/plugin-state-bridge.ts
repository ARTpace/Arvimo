/**
 * plugin-state-bridge.ts —— 插件偏好存储桥（宿主契约，与 Electron preload 同名同形）。
 *
 * Electron 把偏好写在 userData 的 JSON 文件里，Tauri 预览写在 localStorage，
 * 纯浏览器没有用户目录：只能落在 localStorage。三端用同一套契约，
 * profile 解析（resolveStartupPluginProfile）与设置页读写不用为宿主分叉。
 */
import { PROFILE_PATCH_STORAGE_KEY } from './profile';
import { PROFILE_MIGRATION_MARKER_KEY } from './plugin-state-storage';

const readPatches = (storage: Storage | null): unknown[] | null => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PROFILE_PATCH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const patches = (parsed as { patches?: unknown }).patches;
    return Array.isArray(patches) ? patches : null;
  } catch {
    return null;
  }
};

export const createPluginStateBridge = (
  storage: Storage | null,
  editableManifests: readonly unknown[] = [],
) => ({
  readSync: () => {
    const patches = readPatches(storage);
    if (!patches) return { ok: true, patches: null, source: 'none' as const };
    return { ok: true, patches, source: 'file' as const, schemaVersion: 1 };
  },
  writeSync: (patches: unknown[]) => {
    if (!storage) return { ok: false, message: 'localStorage unavailable' };
    try {
      storage.setItem(PROFILE_PATCH_STORAGE_KEY, JSON.stringify({ patches }));
      return { ok: true, count: patches.length };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
  clearSync: () => {
    if (!storage) return { ok: false, message: 'localStorage unavailable' };
    try {
      storage.removeItem(PROFILE_PATCH_STORAGE_KEY);
      storage.removeItem(PROFILE_MIGRATION_MARKER_KEY);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
  /** 只回 manifest，不回源码 —— 源码体积大且只有渲染层执行时才需要。 */
  readEditableManifestsSync: () => ({ manifests: [...editableManifests] }),
  reportBoot: () => {},
});
