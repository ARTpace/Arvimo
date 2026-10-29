import {isPictureSite} from './platforms.js';
// 图片平台共用视图判据，模型平台保留原有网格与紧凑视图。
//
// ArtStation 与图站共用按原图比例排列的瀑布流。
// Sketchfab 是 3D 模型，卡片上的面数、动画、许可是有用信息，不该被极简掉。
// 「按钮显不显示」和「视图生不生效」共用同一个判据，两者不可能说不一致。

/** 画廊请求的封面档位。A 站的等比档只有 small/medium/large，
 *  small 固定宽 800 且比 medium 轻约三分之一，正合适二三百像素的瀑布流列宽。 */
export const GALLERY_RENDITION='small';

/** 画廊是否可用：发现页上的图片平台。 */
export function galleryAvailable({route,platform}={}){
 return route==='discover'&&(platform==='artstation'||isPictureSite(platform));
}

/** 当前是否真的按画廊渲染：可用之外还要用户主动切过来。 */
export function galleryActive(state={}){
 return !!state.gallery&&galleryAvailable(state);
}

export function displayGridClass(state={}){
 return `model-grid${galleryActive(state)?' gallery':state.compact?' compact':''}`;
}

/** 请求封面时要带的档位。非画廊（或不是 A 站）返回空串，交给图片代理用它自己的默认档。 */
export function coverRendition({platform,gallery}={}){
 return gallery&&platform==='artstation'?GALLERY_RENDITION:'';
}

/** 搜索结果不带宽高，图片解码后才知道真实比例；用它把瀑布流里的方形占位纠正成原图比例。
 *  拿不到宽高时返回空串，卡片就保持占位比例，不会塌成零高度。 */
export function aspectRatioStyle(width,height){
 const w=Number(width),h=Number(height);
 return Number.isFinite(w)&&Number.isFinite(h)&&w>0&&h>0?`${w} / ${h}`:'';
}
