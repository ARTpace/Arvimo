import {materialSets} from './asset-classification.js';
/**
 * 资产类型启发式：补上「扩展名判不出、又没采到 assetType」的三类资产
 * —— 材质（PBR 贴图）/ 资源包（归档与 kit）/ UI 元素（html + css 组合）。
 *
 * 为什么单独成模块：这三类的判定在登记资产（contentKindsOf）、磁盘零散文件
 * （typeIdsOfFile）、扫描建包（assetCategory）三处都要用。写三遍必然漂移，
 * 于是抽出「一张规则表 + 一个纯函数」，前后端（含 Node 扫描器）共用同一份。
 *
 * 三条纪律：
 *   1) 只做加法、不做覆盖：命中只在原有类型之外补一个 id，永不把已判定的类型改写；
 *   2) 宁可漏判不可误判：普通图库（01-Civitai.jpg）不含 PBR token，绝不因路径有
 *      images/ 就被算成材质；模型的附属贴图也不把模型拖进材质（whenOwner 白名单）；
 *   3) 数据驱动可扩展：加线索只改 DEFAULT_KIND_RULES，createKindHeuristics 支持
 *      extraRules / overrides，调用点一行不用动（与 format-registry 同一套扩展风格）。
 *
 * 纯数据 + 纯函数：无 DOM、无 node 内置依赖，浏览器 bundle 与 Node 服务端共用。
 */

/** 每条规则：目标 id、允许的基础 kind、允许的主类型、命中条件（any 任一 / all 全中）。 */
export const DEFAULT_KIND_RULES = Object.freeze([
  {
    id: 'textures',
    kinds: ['image', 'env'],
    // 只给「散图」补材质；已判成模型 / 资源包的资产，其附属贴图不再另算材质。
    whenOwner: ['', 'images', 'image', 'other'],
    any: [
      /(^|[^a-z])(base_?color|albedo|diffuse|normal|roughness|metallic|metalness|ao|arm|orm|height|bump|displacement|emissive|specular|gloss|opacity|mask|cavity|detail)([^a-z]|$)/i,
      /(^|\/)(textures?|materials?|maps?|pbr|贴图|材质)(\/|$)/i,
    ],
  },
  {
    id: 'packs',
    // 只认 kind='other'（.zip 归档）。图片 / 模型名字里带 pack 不算资源包 —— 宁可漏判。
    kinds: ['other'],
    whenOwner: ['', 'other'],
    any: [
      /\.zip$/i,
      /(^|[^a-z])(asset[_-]?pack|pack|bundle|megapack|资源包|素材包|合集)([^a-z]|$)/i,
    ],
  },
  {
    id: 'uielement',
    kinds: ['document', 'other'],
    whenOwner: ['', 'document', 'documents', 'other'],
    // 单文件不算 UI（会把普通文档全拖进 UI）：要同一批里同时有 html 与 css。
    all: [/\.html?$/i, /\.css$/i],
  },
]);

const norm = value => String(value || '').replace(/\\/g, '/').toLowerCase();

/**
 * 规则引擎。files 是 [{name, kind}] 的批次（bundle）：
 *  - any 规则：任一「kind 合格」的文件名命中任一 any 正则 → 命中；
 *  - all 规则：all 里每个正则都能在某个「kind 合格」的文件名上找到 → 命中（html+css 组合）。
 */
export function createKindHeuristics({ extraRules = [], overrides = {} } = {}) {
  const rules = [...DEFAULT_KIND_RULES, ...extraRules].map(rule => overrides[rule.id] ? {...rule, ...overrides[rule.id]} : rule);
  return {
    rules,
    hintsFor({ files = [], owner = '' } = {}) {
      const rows = [...files]
        .filter(row => row && (row.name || row.rel))
        .map(row => ({path: norm(row.name || row.rel), kind: norm(row.kind)}));
      const ownerId = String(owner || '');
      const out = [];
      for (const rule of rules) {
        if (rule.whenOwner && rule.whenOwner.length && !rule.whenOwner.includes(ownerId)) continue;
        const eligible = rule.kinds && rule.kinds.length
          ? rows.filter(row => rule.kinds.includes(row.kind)) : rows;
        if (!eligible.length) continue;
        const paths = eligible.map(row => row.path);
        if(rule.id==='textures' && !overrides.textures && !materialSets(paths))continue;
        if (rule.any && rule.any.length && !paths.some(path => rule.any.some(re => re.test(path)))) continue;
        if (rule.all && rule.all.length && !rule.all.every(re => paths.some(path => re.test(path)))) continue;
        if (!out.includes(rule.id)) out.push(rule.id);
      }
      return out;
    },
  };
}

export const kindHeuristics = createKindHeuristics();

/** 便捷入口：给一组本地文件名（可带 kind）与主类型，返回要追加的类型 id。 */
export function inferKindHints(names, owner = '', kindsOf = null) {
  const files = (Array.isArray(names) ? names : [names]).filter(Boolean).map(name => {
    if (name && typeof name === 'object') return name;
    return {name, kind: kindsOf ? kindsOf(name) : ''};
  });
  return kindHeuristics.hintsFor({files, owner});
}
