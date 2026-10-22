// 卡片骨架：一份 DOM，所有资产类型共用。
//
// 之前远端模型、本地素材包各写一套模板，结果下载键一个在底部、一个在右上角，缩略图裁切、
// 标题行、角标位置也各不相同。现在两边都只往这个骨架里填内容：封面、角标、标题行、底部操作区，
// 结构固定，样式自然就统一了。新增一类资产时只需要传字段，不要再拼 HTML 结构。
//
// 参数：
//   keyName/keyValue  卡片的主键属性（远端用 uid，本地包用 package）
//   className         额外样式类（selected / thumb-contain 等）
//   media             封面内容（img 或占位块）
//   overlay           叠在封面上的角标与快捷键（预览热区、类型标签、收藏、复选框…）
//   title/titleAttrs  标题文本与它所在 button 的属性
//   byline            标题右侧的作者或统计
//   side              标题行最右的提示键（许可以及同类信息）
//   actions           底部主操作区（标签、下载、Blender、移除…）
export function assetCard({
  keyName = 'uid',
  keyValue = '',
  className = '',
  media = '',
  overlay = '',
  title = '',
  titleAttrs = '',
  byline = '',
  side = '',
  actions = '',
} = {}) {
  const classes = ['model-card', className].filter(Boolean).join(' ');
  return `<article class="${classes}" data-${keyName}="${keyValue}"><div class="card-media">${media}${overlay}</div><div class="card-meta"><button class="card-title" ${titleAttrs}>${title}</button>${byline}${side}</div><div class="card-bottom"><div class="card-primary-actions">${actions}</div></div></article>`;
}

/** 封面：有图给 img，没图给占位块。裁切由卡片上的 thumb-contain 决定，这里不做判断。 */
export function cardMedia({src = '', alt = '', icon = '', text = '暂无缩略图', className = 'thumbnail'} = {}) {
  if (src) return `<img class="${className}" src="${src}" alt="${alt}" loading="lazy">`;
  return `<div class="image-placeholder">${icon}<span>${text}</span></div>`;
}

/** 标题行右侧那颗说明键：全文塞进 title，悬停才显示（长许可、路径、更新时间都用它）。 */
export function cardNote(label, icon, esc) {
  if (!label) return '';
  return `<div class="card-license"><button type="button" class="license-hint" title="${esc(label)}" aria-label="${esc(label)}">${icon('help')}</button></div>`;
}
