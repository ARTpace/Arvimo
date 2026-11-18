/** Typed, trusted-renderer contract for Settings sections contributed by builtin plugins. */
import type { ComponentType } from 'react';
import type { Contribution, Kernel } from './kernel';
import type { UiLanguage } from './i18n';

/**
 * 语言联合类型收敛到 plugins/i18n 的 UiLanguage（单一真相）。
 * 保留本别名是为了不动既有导入方（menu-contributions / 各 builtin 插件）。
 */
export type SettingsSectionLanguage = UiLanguage;

export interface SettingsSectionProps {
  /** Settings extensions collaborate through services; they never import App or sibling builtins. */
  kernel: Kernel;
  language: SettingsSectionLanguage;
  /** 宿主把 section 并进通用页时为真：此时应渲染扁平结构，不再自带标题条与卡片底。 */
  embedded?: boolean;
}

export interface SettingsSectionContribution {
  label: (language: SettingsSectionLanguage) => string;
  component: ComponentType<SettingsSectionProps>;
  /** 侧栏分组：core=核心设置组（优先展示），extensions=扩展组。缺省 extensions。 */
  navGroup?: 'core' | 'extensions';
  /** Optional destination in the unified Arvimo settings. */
  category?: 'general' | 'assets' | 'canvas' | 'extensions' | 'data';
}

export type SettingsSectionRegistryEntry = Contribution<SettingsSectionContribution>;

/** Stable projection for the generic Settings host and diagnostics. */
export const listSettingsSectionContributions = (kernel: Kernel): readonly SettingsSectionRegistryEntry[] =>
  kernel.contributions.list<SettingsSectionContribution>('settings_sections');
