// ponytail: reuse existing commands; do not duplicate selection or deletion logic.
export const LIBRARY_BINDINGS=[
 ['search','搜索',['Ctrl+F']],['selectAll','全选',['Ctrl+A']],
 ['deselect','取消选择',['Escape','Ctrl+Shift+A']],['back','返回上级',['Alt+ArrowLeft']],
 ['import','导入',['Ctrl+I']],['newBoard','新建画板',['Ctrl+Shift+N']],
 ['preview','预览',['Space','Enter']],['delete','移入回收站',['Delete']],
];
export const LIBRARY_SHORTCUTS=LIBRARY_BINDINGS.map(([,label,keys])=>[keys.join(' / '),label]);
export function shortcutKey(event){
 if(['Control','Meta','Shift','Alt','Dead','Process'].includes(event.key))return '';
 const key=event.key===' '?'Space':event.key.length===1?event.key.toUpperCase():event.key;
 return [event.ctrlKey||event.metaKey?'Ctrl':'',event.altKey?'Alt':'',event.shiftKey?'Shift':'',key].filter(Boolean).join('+');
}
export const libraryBindingKeys=(id,overrides={})=>Object.hasOwn(overrides,id)&&Array.isArray(overrides[id])?overrides[id]:LIBRARY_BINDINGS.find(row=>row[0]===id)?.[2]||[];

export function libraryShortcut(event,overrides={}){
 if(event.defaultPrevented||event.isComposing||event.repeat)return '';
 if(event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],.ctx-menu,dialog,[role="dialog"]'))return '';
 const key=shortcutKey(event);
 const action=LIBRARY_BINDINGS.find(([id])=>libraryBindingKeys(id,overrides).includes(key))?.[0]||'';
 if(action==='preview'&&event.target?.closest?.('button,a,[role="button"]'))return '';
 return action;
}

export function bindLibraryShortcuts({doc=document,enabled,commands,getBindings=()=>({})}){
 const onKey=event=>{
  if(!enabled()||doc.querySelector('dialog[open],[role="dialog"]:not([hidden]),.ctx-menu:not([hidden])'))return;
  const command=commands[libraryShortcut(event,getBindings())];
  if(!command)return;
  event.preventDefault();command();
 };
 doc.addEventListener('keydown',onKey);
 return ()=>doc.removeEventListener('keydown',onKey);
}
