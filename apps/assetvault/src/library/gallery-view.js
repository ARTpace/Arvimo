// 网格 / 瀑布流对所有有卡片的页面开放。
//
// ArtStation 与图站共用按原图比例排列的瀑布流。
// Sketchfab 是 3D 模型，卡片上的面数、动画、许可是有用信息，不该被极简掉。
// 「按钮显不显示」和「视图生不生效」共用同一个判据，两者不可能说不一致。

/** 画廊请求的封面档位。A 站的等比档只有 small/medium/large，
 *  small 固定宽 800 且比 medium 轻约三分之一，正合适二三百像素的瀑布流列宽。 */
export const GALLERY_RENDITION='small';

/** 网格和瀑布流在发现页、资产库、收藏都能切。下载页没有卡片网格。 */
export function galleryAvailable({route}={}){
 return route!=='downloads';
}

/** 当前是否真的按画廊渲染：可用之外还要用户主动切过来。 */
export function galleryActive(state={}){
 return !!state.gallery&&galleryAvailable(state);
}

/** 网格 / 瀑布流二选一，与平台和内容类别无关。 */
export function displayGridClass(state={}){
 return galleryActive(state)?'model-grid gallery':'model-grid';
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

/** 横版跨列的判定线：宽高比 ≥ 1.25（约 5:4）算横版。
 *  再扁一点（2:1 那种宽条）也不跨 —— 跨了会变成一条又宽又扁的横幅，反而更难看。 */
export const LANDSCAPE_RATIO=1.25;

/** 卡片显示比例。取值顺序跟页面里的一致：
 *  ① 条目自带的原始宽高（data-w/data-h）—— 站方给的缩略图常常是定宽裁档
 *     （Wallhaven 的 small 实测全是 300×200），拿缩略图尺寸会把千姿百态的比例全抹成 3:2；
 *  ② 内联写死的 aspect-ratio（页面已经按原始比例纠正过占位）；
 *  ③ 都拿不到才用解码后的真实尺寸。 */
export function cardAspectRatio(card){
  const img=card?.querySelector?.('img.thumbnail,img.model-thumb,.card-media img');
  if(!img)return 0;
  const w=Number(img.dataset.w)||0,h=Number(img.dataset.h)||0;
  if(w>0&&h>0)return w/h;
  const inline=/([\d.]+)\s*\/\s*([\d.]+)/.exec(img.style?.aspectRatio||'');
  if(inline){const iw=Number(inline[1]),ih=Number(inline[2]);if(iw>0&&ih>0)return iw/ih;}
  const nw=img.naturalWidth||0,nh=img.naturalHeight||0;
  return nw>0&&nh>0?nw/nh:0;
}

/** 卡片占几列：横版图占两列（宽度翻倍，看着明显更大），竖版 / 方形仍占一列，尺寸不变。
 *  比例还没量出来（图片没解码）时先按一列算，图片 load 之后会再排一次。 */
export function cardSpan(card){
  const ratio=cardAspectRatio(card);
  return ratio>=LANDSCAPE_RATIO?2:1;
}
