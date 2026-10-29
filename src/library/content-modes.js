/**
 * 内容模式快捷键：模型模式 / 图片模式。
 *
 * 平台下拉里那三个选项回答的是「问哪个站」，可用户心里的问题往往是「我现在想看什么」：
 * 想看能拿来用的模型、还是想看参考图。这两件事各给一个按键，代价是零（平台 + 类型 + 视图）。
 *
 *   模型模式 → 停在全部平台，把 ArtStation 源锁到「Marmoset（可转 3D）」：
 *              Sketchfab 的模型和 A 站的 3D 资产都进来，纯图片作品出不去。
 *   图片模式 → ArtStation，并切到按原图比例排的瀑布流（`galleryAvailable` 本来就只认 A 站）。
 *             平台下拉同时只列「能出图的平台 + 全部图站」（platformsForMode），模型平台整条不出现；
 *             选图站时没有检索流，靠粘链接解析（见 picturePlatformById）。
 *
 * 再点一次当前模式＝退出。「A 站只要 3D」由 app.js 落地：进入时把 #art-type 拨到 marmoset、
 * 退出时还原用户的选择，本模块只负责算出「该点亮谁 / 点了之后要去哪」。
 *
 * 高亮只由 state 推出（平台 + modelOnly + gallery），和三种展示视图同一套做法：
 * 点击处理里不各写一遍图标状态。
 */
import {ALL,isPictureSite} from './platforms.js';

export const CONTENT_MODES=[
 {id:'model',platform:ALL,gallery:false,modelOnly:true},
 {id:'image',platform:'artstation',gallery:true},
];

export const modeById=id=>CONTENT_MODES.find(mode=>mode.id===id)||null;

/** 当前状态落在哪个模式上：模型模式=全部平台且只要 3D；图片模式=A 站瀑布流，或选中的是一个图站。 */
export const activeMode=state=>{
 if(!state)return '';
 if(state.route==='library')return state.libraryMode||'';   // 资产库内：模型/图片键用来筛本地资产（见 app.js applyContentMode）
 if(state.platform===ALL&&state.modelOnly)return 'model';
 if(state.platform==='artstation'&&state.gallery)return 'image';
 if(isPictureSite(state.platform))return 'image';
 return '';
};

/** 点一下某个模式要做什么：去哪个平台、要不要瀑布流、要不要锁 A 站类型。再点当前那个＝退出回全部平台。 */
export function modeTarget(id,state){
 const mode=modeById(id);
 if(!mode)return null;
 const off=activeMode(state)===id;
 return {platform:off?ALL:mode.platform,gallery:!off&&mode.gallery,modelOnly:!off&&!!mode.modelOnly};
}

export function createContentModes({state,onPick,buttons=[]}){
 const list=[...buttons];
 const render=()=>{
  const active=activeMode(state);
  for(const button of list){
   const on=button.dataset.contentMode===active;
   button.classList.toggle('active',on);
   button.setAttribute('aria-pressed',String(on));
  }
 };
 for(const button of list)button.addEventListener('click',()=>onPick(button.dataset.contentMode));
 render();
 return {render};
}
