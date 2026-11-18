import {withRemovalMotion} from './removal-motion.js';
// 画板的三个写动作：新建 / 改名 / 删除。
// 单独一层是为了让「卡片区只画界面、store 只存状态」—— 提示词与确认框都留在这里，
// 别处（工具栏、右键菜单、规则对话框）想建板也走同一份实现，不各自弹框一遍。
import {askText, askConfirm} from './ask-dialog.js';

export function createBoardActions({store, toast, openBoard, ask = askText, approve = askConfirm, document:doc=globalThis.document} = {}) {
  if (!store) throw Error('画板动作缺少 store');

  /** 名字为空就是取消：不做「未命名画板」这种垃圾数据。 */
  const askName = async (title, message, value = '') => {
    const next = await ask({title, message, value, maxLength: 80, placeholder: '给画板起个名字'});
    if (!next) return '';
    return next.slice(0, 80);
  };

  function inlineName(row){
    return new Promise(resolve=>{
      const anchor=[...(doc.querySelectorAll('[data-bd-open]')||[])].find(node=>node.dataset.bdOpen===row.id);
      const box=doc.createElement('form');box.className='bd-inline-editor';box.setAttribute('aria-label','编辑画板');
      const title=doc.createElement('strong');title.textContent='画板名称';
      const input=doc.createElement('input');input.value=row.name;input.maxLength=80;input.setAttribute('aria-label','画板名称');
      const actions=doc.createElement('div');const cancel=doc.createElement('button');cancel.type='button';cancel.textContent='取消';
      const save=doc.createElement('button');save.type='submit';save.textContent='保存';actions.append(cancel,save);box.append(title,input,actions);
      const rect=anchor?.getBoundingClientRect();const win=doc.defaultView;
      box.style.left=Math.max(12,Math.min(rect?.left||24,(win?.innerWidth||800)-332))+'px';
      box.style.top=Math.max(12,Math.min((rect?.top||24)+40,(win?.innerHeight||600)-180))+'px';
      const done=value=>{doc.removeEventListener('pointerdown',outside,true);box.remove();resolve(value);};
      const outside=event=>{if(!box.contains(event.target))done('');};
      cancel.onclick=()=>done('');box.onsubmit=event=>{event.preventDefault();if(input.value.trim())done(input.value.trim());};
      box.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation();done('');}};
      doc.body.append(box);doc.addEventListener('pointerdown',outside,true);input.focus();input.select?.();
    });
  }

  return {
    async createManual() {
      const name = await askName('新建画板', '建好后把卡片拖进来，或右键「加入画板」');
      if (!name) return '';
      try {
        const id = await store.create({name, smart: false});

        toast?.(`已新建画板「${name}」`);
        return id;
      } catch (error) { toast?.(error.message || '新建画板失败'); return ''; }
    },

    async rename(id) {
      const row = store.byId(id);
      if (!row) return;
      const name = ask!==askText?await askName('重命名画板','',row.name):await inlineName(row);
      if (!name || name === row.name) return;
      try {
        await store.rename(row.id, {name});
        toast?.(`已重命名为「${name}」`);
      } catch (error) { toast?.(error.message || '重命名失败'); }
    },

    async remove(id) {
      const row = store.byId(id);
      if (!row) return;
      if (!await approve({title: '删除画板', message: `删除画板「${row.name}」？画板里的卡片仍会保留在资产库，不会被删除。`, confirmText: '删除', danger: true})) return;
      const wasActive = store.activeId === row.id;
      try {
        const cards=[...(doc?.querySelectorAll('[data-bd-open]')||[])].filter(node=>node.dataset.bdOpen===row.id);
        await withRemovalMotion(cards,()=>store.remove(row.id));
        toast?.(`已删除画板「${row.name}」`);
        return {removed: true, wasActive};
      } catch (error) { toast?.(error.message || '删除失败'); return {removed: false}; }
    },
  };
}
