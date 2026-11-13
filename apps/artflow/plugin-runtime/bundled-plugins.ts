/**
 * bundled-plugins.ts —— 随包内置的宿主侧插件资产（可编辑插件 + 声明式皮肤）。
 *
 * Electron 从 userData/plugins/builtin/ 读可编辑插件源码，Tauri 预览随包播种，
 * 纯浏览器（网页版 / AssetVault 内嵌画布）没有宿主目录 —— 三端共用这一份内置清单，
 * 否则缺失的可编辑插件会让依赖它的内置插件被判「requires missing plugin」，
 * 声明式皮肤缺席则整条 UI 主题变量（--bp-ui-*）落空，插件开关看起来全是灰的。
 */
import commandsCoreManifest from '../plugins/builtin.commands-core/manifest.json';
import commandsCoreSource from '../plugins/builtin.commands-core/plugin.js?raw';
import coreExtensionsManifest from '../plugins/builtin.core-extensions/manifest.json';
import coreExtensionsSource from '../plugins/builtin.core-extensions/plugin.js?raw';
import formatsFilesManifest from '../plugins/builtin.formats-files/manifest.json';
import formatsFilesSource from '../plugins/builtin.formats-files/plugin.js?raw';
import formatsImageDocManifest from '../plugins/builtin.formats-image-doc/manifest.json';
import formatsImageDocSource from '../plugins/builtin.formats-image-doc/plugin.js?raw';
import formatsPurerefManifest from '../plugins/builtin.formats-pureref/manifest.json';
import formatsPurerefSource from '../plugins/builtin.formats-pureref/plugin.js?raw';
import formatsReaderManifest from '../plugins/builtin.formats-reader/manifest.json';
import formatsReaderSource from '../plugins/builtin.formats-reader/plugin.js?raw';
import mediaManifest from '../plugins/builtin.media/manifest.json';
import mediaSource from '../plugins/builtin.media/plugin.js?raw';
import projectPortableManifest from '../plugins/builtin.project-portable/manifest.json';
import projectPortableSource from '../plugins/builtin.project-portable/plugin.js?raw';

export type BundledEditablePlugin = {
  manifest: { id: string; name: string; version: string; description?: string };
  source: string;
};

/**
 * 全部内置可编辑插件必须成套提供：少一个，依赖它的插件会被判「requires missing plugin」。
 */
export const BUNDLED_EDITABLE_PLUGINS: readonly BundledEditablePlugin[] = [
  { manifest: commandsCoreManifest, source: commandsCoreSource },
  { manifest: coreExtensionsManifest, source: coreExtensionsSource },
  { manifest: formatsFilesManifest, source: formatsFilesSource },
  { manifest: formatsImageDocManifest, source: formatsImageDocSource },
  { manifest: formatsPurerefManifest, source: formatsPurerefSource },
  { manifest: formatsReaderManifest, source: formatsReaderSource },
  { manifest: mediaManifest, source: mediaSource },
  { manifest: projectPortableManifest, source: projectPortableSource },
];

/** 声明式插件清单（宿主扫描 plugins/ 后给出的形状）。 */
export type BundledDeclarativePlugin = {
  id: string;
  name: string;
  formatAliases: Array<{ extension: string; handlerId: string }>;
  skins?: unknown[];
};

type RawDeclarativeManifest = {
  id: string;
  name: string;
  formatAliases?: unknown[];
  contributes?: { skins?: unknown[] };
};

const toDeclarativePayload = (raw: unknown): BundledDeclarativePlugin => {
  const manifest = raw as RawDeclarativeManifest;
  return {
    id: manifest.id,
    name: manifest.name,
    formatAliases: Array.isArray(manifest.formatAliases) ? (manifest.formatAliases as Array<{ extension: string; handlerId: string }>) : [],
    skins: manifest.contributes?.skins ?? [],
  };
};

/**
 * 声明式皮肤包。动态 import 让 Vite 把大包（abyssal 约 630KB）拆成独立 chunk，
 * 不进主 bundle，首屏解析不受影响。
 */
export const loadBundledDeclarativePlugins = async (): Promise<BundledDeclarativePlugin[]> => {
  const [defaults, aurora, abyssal] = await Promise.all([
    import('../plugins/builtin.skins-default/manifest.json'),
    import('../plugins/builtin.skins-aurora/manifest.json'),
    import('../plugins/builtin.skins-abyssal-serenade/manifest.json'),
  ]);
  return [defaults.default, aurora.default, abyssal.default].map(toDeclarativePayload);
};
