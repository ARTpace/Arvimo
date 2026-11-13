// 资产类型归一：查询层、派生层、AI 候选词注入必须用同一套判断。
//
// 之前这段逻辑私有在 library-query.mjs 里，派生层（library-blob.mjs）需要把 kind 列化时
// 只能复制一遍 —— 复制就意味着两边会漂移。抽成独立模块，改动只有一处。
//
// 平台差异不是特例判断，是「平台自带的事实字段」：
//   artstation 用 hasMarmoset 区分图片与模型；ambientcg 的 assetType 已是 textures 语义；
//   kenney 按资源包计；其余按 assetType，未标注的默认模型。
const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));

/** 采集来的 assetType 是单数（image / texture），筛选条的值域是复数（images / textures）。 */
export const KIND_ALIASES = Object.freeze({
  image: 'images', texture: 'textures', material: 'textures', hdri: 'hdris',
  skybox: 'hdris', alpha: 'images', alphas: 'images', smart: 'textures',
  model: 'models', pack: 'packs',
});

export function kindOf(model = {}) {
  if (model.platform === 'artstation') return model.hasMarmoset === false ? 'images' : 'models';
  if (model.platform === 'ambientcg') return text(model.assetType) || 'textures';
  if (model.platform === 'kenney') return 'packs';
  const raw = text(model.assetType) || 'models';
  return KIND_ALIASES[raw] || raw;
}
