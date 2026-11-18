// 资产物理目录的唯一真相源：资产 → 「分组/子类型」两级中文目录。
//
// 对应资产库左侧类型树（src/library/mode-presets.js + local-type-tree.js:120）：
//   图片 / 3D资产 / UI / 文本 / 视频 / 音频 / 待分类 分组，各挂自己的子类型。
//   图片的子类型再按用途细分（图片/参考图、图片/纹理贴图…），词表见 image-subcategories.js。
// 下载与导入（拖入 / 本地复制 / Eagle）共用这一张表，避免再出现「界面一套分类、
// 磁盘另一套分类」的历史问题（旧 asset-storage.mjs 的 图片/环境/材质/资源包/模型-题材
// 与界面名字和层级都不一致）。
//
// 约定：
//   - 资产落在「资产根」（archiveRoot，默认跟着库名走）下，按下面的两级中文目录摆放；
//     平台的下载产物与导入副本最终共用同一套层级（imports 是历史落点，已由
//     scripts/migrate-imports-to-archive.mjs 搬到资产根）。
//   - 目录名用中文，与界面完全一致；无法判定的一律进「待分类/待分类」。
//   - 只有两级：分组/子类型，没有日期层，也没有题材三级目录。
import fs from 'node:fs/promises';
import path from 'node:path';
import {kindOf} from './asset-kind.mjs';
import {imageSubcategoryOf} from '../src/library/image-subcategories.js';

/** content kind（kindOf/classifyAsset 的值域）→ [分组, 子类型]，目录名与界面文案一致。 */
export const KIND_FOLDER = Object.freeze({
  // 图片子类型不是固定值：按用途动态算（参考图/纹理贴图/…），这里的「其他图片」只是兜底。
  images:    Object.freeze(['图片', '其他图片']),
  models:    Object.freeze(['3D资产', '3D模型']),
  textures:  Object.freeze(['3D资产', '材质']),
  hdris:     Object.freeze(['3D资产', 'HDRI']),
  packs:     Object.freeze(['3D资产', '资源包']),
  uielement: Object.freeze(['UI', 'UI元素']),
  documents: Object.freeze(['文本', '文本']),
  // 视频 / 音频从「影音」母类拆出来了：新落盘直接进各自的一级目录。
  // 旧的「影音/视频」「影音/音频」不迁移，靠 GROUP_NAMES 的历史名继续识别（见下）。
  videos:    Object.freeze(['视频', '视频']),
  audio:     Object.freeze(['音频', '音频']),
  unknown:   Object.freeze(['待分类', '待分类']),
});

/** 未知 / 无法判定 / 异常值都收敛到「待分类/待分类」，绝不落到空路径或越界。 */
const FALLBACK = KIND_FOLDER.unknown;

/** 六个分组名：磁盘扫描靠它认出「这一层是分类目录，不是资产包」。
 *  「影音」是历史名（视频 / 音频拆分前的母类），保留在这里只为了继续认出旧目录，
 *  新落盘不再写入。删掉它会让老库里的影音文件被当成普通资产包扫描。 */
const LEGACY_GROUP_NAMES = ['影音'];
export const GROUP_NAMES = new Set([...Object.values(KIND_FOLDER).map(pair => pair[0]), ...LEGACY_GROUP_NAMES]);

/**
 * 算出一个资产应落在哪个相对目录（分组/子类型）。
 * @param {object} model 资产对象；kindOf 会读 kind/assetType/platform/文件名等判定。
 * @returns {string} 形如「3D资产/3D模型」的相对路径（系统分隔符）。
 */
export function assetFolder(model = {}) {
  let kind = 'unknown';
  try { kind = kindOf(model) || 'unknown'; } catch { kind = 'unknown'; }
  const pair = KIND_FOLDER[kind] || FALLBACK;
  // 图片第二级是用途子类（参考图/纹理贴图/…），不是 kind 名字的复读。
  const child = kind === 'images' ? imageSubcategoryOf(model) : pair[1];
  return path.join(pair[0], child);
}

/** 只有文件名时（拖入文件流）也能分类：classifyAsset 会从 filename 读名字并按扩展名判定。 */
export function assetFolderFromName(name = '') {
  return assetFolder({filename: String(name || '')});
}

export const UNKNOWN_FOLDER = path.join(FALLBACK[0], FALLBACK[1]);

/**
 * 分类目录是多个批次共用的，同名文件绝不能覆盖：目标已存在就加序号。
 * 下载落盘与拖入导入共用这一份，避免同一条规则在两个模块里各写一遍还写得不一样。
 */
export async function uniqueTarget(target) {
  const ext = path.extname(target), stem = target.slice(0, target.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? target : `${stem} (${i})${ext}`;
    try { await fs.access(candidate); } catch { return candidate; }
  }
  throw Object.assign(Error('同名文件太多，请分几次导入'), {status: 400});
}

/** 删掉文件后自底向上收拾空目录，最多往上 3 层（子类型 / 分组），到根就停。 */
export async function pruneEmptyDirs(from, stopAt) {
  let dir = from;
  for (let i = 0; i < 3; i++) {
    if (!stopAt || path.resolve(dir) === path.resolve(stopAt)) return;
    try { await fs.rmdir(dir); } catch { return; }
    dir = path.dirname(dir);
  }
}
