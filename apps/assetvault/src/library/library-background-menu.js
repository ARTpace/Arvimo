const CARD_TARGETS='.model-card,.local-file-card,.bd-card,[data-package],[data-file],[data-sequence]';

/** 只认资产区空白，不接管卡片、工具栏、弹窗和可编辑内容。 */
export function libraryBackgroundTarget(target,route){
 if(route!=='library'||!target?.closest?.('main'))return null;
 if(target.closest(`${CARD_TARGETS},button,a,input,textarea,select,[contenteditable],dialog,[role="dialog"],.ctx-menu`))return null;
 return target.closest('#grid,#board-deck,#empty')||(target.matches('main,main>.content')?target:null);
}

// ponytail: 复用已有操作入口，菜单只负责列出动作，不维护第二份视图状态。
export function libraryBackgroundItems({gallery=false,cards='all',canCreate=true,onCreate,onSmart,onImport,onDisplay,onCards}){
 const items=[];
 if(canCreate)items.push(
  {label:'新建画板',icon:'plus',run:onCreate},
  {label:'新建智能画板',icon:'zap',run:onSmart},
  {label:'导入资产',icon:'folder',run:onImport},
  {separator:true},
 );
 items.push({group:'显示模式'},
  ...[['grid','网格','grid'],['gallery','瀑布流','masonry']].map(([key,label,icon])=>({label,icon:(key==='gallery')===gallery?'check':icon,run:()=>onDisplay(key)})),
  {separator:true},{group:'显示内容'},
  ...[['all','全部卡片','grid'],['boards','仅画板','layers'],['assets','仅资产','image']].map(([key,label,icon])=>({label,icon:cards===key?'check':icon,run:()=>onCards(key)})),
 );
 return {items};
}
