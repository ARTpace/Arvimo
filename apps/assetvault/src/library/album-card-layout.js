/** 保留已加载的图片节点；切换宫格只增补新格、隐藏多余格、更新数量。 */
export function updateAlbumTiles(collage, html) {
  const template = collage.ownerDocument.createElement('template');
  template.innerHTML = html;
  const incoming = [...template.content.querySelectorAll('.pkg-tile')];
  const existing = [...collage.children];
  incoming.forEach((tile, index) => {
    const current = existing[index];
    if (!current) { collage.append(tile); return; }
    current.hidden = false;
    current.querySelector('.pkg-tile-plus')?.remove();
    const badge = tile.querySelector('.pkg-tile-plus');
    if (badge) current.append(badge);
  });
  existing.slice(incoming.length).forEach(tile => { tile.hidden = true; });
}
/** 每次最多切一档；进入六宫后必须继续拖足距离，不能因一次快速移动跳过它。 */
export function albumDragStep(mode, distance) {
  const modes = [4,6,9], index = modes.indexOf(mode);
  const threshold = mode === 6 ? 110 : 65;
  if (Math.abs(distance) < threshold) return mode;
  return modes[Math.max(0,Math.min(2,index + Math.sign(distance)))];
}

export function albumDragLayout(mode, wide, dx, dy) {
  if (Math.abs(dx) >= 65 && Math.abs(dx) > Math.abs(dy)) {
    return {mode:6, wide:dx > 0};
  }
  return {mode:albumDragStep(mode,dy), wide};
}
