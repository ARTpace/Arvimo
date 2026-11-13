// 画板的三个写动作：新建 / 改名 / 删除。
// 单独一层是为了让「卡片区只画界面、store 只存状态」—— 提示词与确认框都留在这里，
// 别处（工具栏、右键菜单、规则对话框）想建板也走同一份实现，不各自 prompt 一遍。
export function createBoardActions({store, win = globalThis.window, toast, openBoard} = {}) {
  if (!store) throw Error('画板动作缺少 store');

  /** 名字为空就是取消：不做「未命名画板」这种垃圾数据。 */
  const askName = (title, value = '') => {
    const next = win?.prompt?.(title, value);
    if (next === null || next === undefined) return '';
    return String(next).trim().slice(0, 80);
  };

  return {
    async createManual() {
      const name = askName('新建画板名称（建好后把卡片拖进来，或右键「加入画板」）');
      if (!name) return '';
      try {
        const id = await store.create({name, smart: false});
        if (id) {
          store.setActive(id);
          await openBoard?.(id);
        }
        toast?.(`已新建画板「${name}」`);
        return id;
      } catch (error) { toast?.(error.message || '新建画板失败'); return ''; }
    },

    async rename(id) {
      const row = store.byId(id);
      if (!row) return;
      const name = askName('重命名画板', row.name);
      if (!name || name === row.name) return;
      try {
        await store.rename(row.id, {name});
        toast?.(`已重命名为「${name}」`);
      } catch (error) { toast?.(error.message || '重命名失败'); }
    },

    async remove(id) {
      const row = store.byId(id);
      if (!row) return;
      if (!win?.confirm?.(`删除画板「${row.name}」？画板里的卡片仍会保留在资产库，不会被删除。`)) return;
      const wasActive = store.activeId === row.id;
      try {
        await store.remove(row.id);
        toast?.(`已删除画板「${row.name}」`);
        return {removed: true, wasActive};
      } catch (error) { toast?.(error.message || '删除失败'); return {removed: false}; }
    },
  };
}
