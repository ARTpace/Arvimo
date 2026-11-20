/**
 * 内容模式契约层：一个图标 = 一整套上下文。
 *
 * 之前「模式」是从平台反推出来的（content-modes.js 的 activeMode 靠 platform/modelOnly/gallery 猜），
 * 于是点图标只拨了几个零散开关：下拉池没换、结果流没换，手动选个平台还会把模式挤掉。
 * 这里把模式提升为显式主状态，并把每个模式的四个侧面收进一张表：
 *
 *   platformKind                → 平台下拉里列谁（platformsForMode 的入参）
 *   defaultPlatform + 模式记忆   → 切进去先停在哪一站
 *   gallery / modelOnly         → 展示区布局与 A 站请求形状
 *   localKind / localOnly       → 资产库页按哪类本地文件筛
 *   linkOnly                    → 没有在线聚合源，发现页只给「链接解析」这一条入口
 *
 * 文本 / 视频没有可搜关键词的在线源，但它们也不再把人踢去资产库：
 * localOnly 只保留「资产库页筛本地类型」的语义，发现页走 linkOnly ——
 * 平台下拉换成「链接解析」，粘视频页 / 文档页 / 直链就出卡片（见 platforms.js 的 LINK_PLATFORM）。
 * UI 模式相反，只有 Uiverse 一站，它是真实在线源，所以 localOnly / linkOnly 都是 false。
 * 以后接了在线源，只要填 platformKind、去掉 localOnly + linkOnly，UI 一行都不用改（配置缝）。
 */
import {ALL, LINK_PLATFORM, platformsForMode} from './platforms.js';

export const MODE_PRESETS = Object.freeze([
  {
    id: 'images', groupId: 'image-assets', localKinds: Object.freeze(['images']), label: '图片', icon: 'image', legacyMode: 'image',
    platformKind: 'image', allLabel: '', defaultPlatform: 'artstation',
    gallery: true, modelOnly: false, localOnly: false, localKind: 'images',
  },
  {
    id: 'models', groupId: 'three-d', localKinds: Object.freeze(['models', 'textures', 'hdris', 'packs']), label: '3D 资产', icon: 'cube', legacyMode: 'model',
    // 默认停在纯 3D 站：点「模型」立刻看到模型卡片，不会因某个两栖平台先返回而混进作品图。
    // 「全部 3D 平台」仍在下拉里，用户要跨站检索可主动选。
    platformKind: 'model', allLabel: '全部 3D 平台', defaultPlatform: 'sketchfab',
    gallery: false, modelOnly: true, localOnly: false, localKind: 'models',
  },
  {
    // UI 元素是第三类产物：不是 3D 模型也不是图片，落盘是 index.html + style.css。
    // 单开一档而不是塞进模型 / 图片 —— 塞进去就会出现「选了 Uiverse 却搜不到模型」的困惑。
    id: 'ui', groupId: 'ui-assets', localKinds: Object.freeze(['uielement']), label: 'UI', icon: 'layout', legacyMode: '',
    platformKind: 'ui', allLabel: '', defaultPlatform: 'uiverse',
    gallery: false, modelOnly: false, localOnly: false, localKind: 'uielement',
  },
  {
    // 视频 / 文本：没有可搜关键词的公开聚合源，但发现页仍留在原地 —— 只给「链接解析」一枚入口。
    // localOnly 仍为 true，因为它在资产库页还要按本地文件类型筛（documents / videos），
    // 两者不冲突：路由决定走哪一面，见 app.js 的 applyModeTab。
    id: 'documents', groupId: 'document-assets', localKinds: Object.freeze(['documents']), label: '文档', icon: 'type', legacyMode: '',
    platformKind: '', allLabel: '', defaultPlatform: '',
    gallery: false, modelOnly: false, localOnly: true, linkOnly: true, localKind: 'documents',
  },
  {
    // 视频：已在线的四站（Pexels / Coverr / Civitai / Pixabay）→ 正常平台池，能搜词、能逐站浏览。
    // 资产库页仍按本地文件类型筛（localKind:'videos'），那一面与 localOnly 无关。
    id: 'videos', groupId: 'video-assets', localKinds: Object.freeze(['videos']), label: '视频', icon: 'play', legacyMode: '',
    platformKind: 'video', allLabel: '', defaultPlatform: 'pexels-video',
    gallery: false, modelOnly: false, localOnly: false, localKind: 'videos',
  },
  {
    // 音乐平台按单曲分享链接解析；资产库按本地音频类型筛选。
    id: 'audio', groupId: 'audio-assets', localKinds: Object.freeze(['audio']), label: '音频', icon: 'music', legacyMode: '',
    platformKind: 'audio', allLabel: '', defaultPlatform: 'netease',
    gallery: false, modelOnly: false, localOnly: false, localKind: 'audio',
  },
].map(Object.freeze));

export const modePresetById = id => MODE_PRESETS.find(preset => preset.id === id) || null;

/** 没有激活任何模式时：3D 平台 + 全部图站，去重，保留「全部平台」。 */
export function fullPlatformPool({enabled = () => true} = {}) {
  const seen = new Set(), out = [];
  for (const item of [...platformsForMode(''), ...platformsForMode('image')]) {
    if (!item || seen.has(item.id)) continue;
    if (item.id !== ALL && !enabled(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * 某个模式该在平台下拉里列谁。
 * linkOnly 给且只给「链接解析」这一枚 —— 它没有站可切，但下拉必须有个名字，
 * 否则 select.value 会落空、左边显示成第一项（看上去就像平台没生效）。
 * localOnly 返回空数组：那是纯本地类型筛，由宿主放一枚「本地资产库」占位。
 */
export function platformPoolFor(preset, {enabled = () => true} = {}) {
  if (!preset) return fullPlatformPool({enabled});
  if (preset.linkOnly) return [LINK_PLATFORM];
  if (preset.localOnly) return [];
  return platformsForMode(preset.platformKind)
    .filter(item => item.id === ALL || enabled(item.id))
    .map(item => item.id === ALL && preset.allLabel ? {...item, label: preset.allLabel} : item);
}

/** 模式各自记住上次选的站：切回「模型」不该被「图片」选的花瓣带跑。 */
export const MODE_PLATFORM_KEY = 'av:mode-platform:v1';

const store = () => {
  try { return globalThis.localStorage; } catch { return null; }
};

export function loadModePlatforms(storage) {
  try {
    const raw = (storage || store())?.getItem?.(MODE_PLATFORM_KEY);
    const data = raw ? JSON.parse(raw) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([id, platform]) => {
      const preset = modePresetById(id);
      return preset && !preset.localOnly && !preset.linkOnly && typeof platform === 'string' && platform;
    }));
  } catch { return {}; }
}

export function rememberModePlatform(storage, id, platform) {
  const preset = modePresetById(id);
  if (!preset || preset.localOnly || preset.linkOnly || !platform) return;
  try {
    const target = storage || store();
    if (!target?.setItem) return;
    const data = loadModePlatforms(target);
    target.setItem(MODE_PLATFORM_KEY, JSON.stringify({...data, [id]: platform}));
  } catch { /* 隐私模式存不了，只在本次会话生效 */ }
}

/** 记住的站若已关掉 / 不在池子里，退回该模式的默认站，绝不落到空结果。 */
export function pickModePlatform(preset, remembered, pool = []) {
  if (!preset) return ALL;
  const ids = new Set(pool.map(item => item.id));
  if (remembered && ids.has(remembered)) return remembered;
  if (ids.has(preset.defaultPlatform)) return preset.defaultPlatform;
  return pool[0]?.id || preset.defaultPlatform || ALL;
}
