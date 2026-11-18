// 小型操作面板共用非模态展示；不锁住资产库，也不改变原有提交逻辑。
const installed = new WeakSet();
export function showActionCard(dialog) {
  const doc = dialog.ownerDocument;
  dialog.classList.add('av-action-card');
  if (!installed.has(dialog)) {
    installed.add(dialog);
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      const cancel = new (doc.defaultView?.Event || Event)('cancel', {cancelable:true});
      if (dialog.dispatchEvent(cancel)) dialog.close();
    });
  }
  const rect = doc.activeElement?.getBoundingClientRect?.();
  if (!dialog.open) dialog.show();
  const win = doc.defaultView;
  const width = win?.innerWidth || 800, height = win?.innerHeight || 600;
  const box = dialog.getBoundingClientRect?.() || {width:360,height:240};
  dialog.style.left = Math.max(12, Math.min(rect?.left || width - box.width - 24, width - box.width - 12)) + 'px';
  dialog.style.top = Math.max(12, Math.min(rect?.bottom ? rect.bottom + 8 : 80, height - box.height - 12)) + 'px';
}
