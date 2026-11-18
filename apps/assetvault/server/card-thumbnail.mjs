import sharp from 'sharp';

/** 卡片只需 384 像素；大图预览不走此分支，保留原始分辨率。
 *
 *  为什么是 384 而不是 512：卡片列宽 `minmax(218px,1fr)`（app.css .model-grid），
 *  高分屏按 device-scale-factor=1.5 折算是 327 物理像素起步，384 够用且有富余。
 *  512→384 后单张位图面积剩 56%，几百张封面同时挂在瀑布流上时省下来的就是几百 MB ——
 *  解码后的位图按像素面积占内存，这是界面进程体积的主要来源。
 *  与本地缩略图 LIST_THUMB_SIZE(384) 统一，卡片上的远端 / 本地封面不再是两种清晰度。 */
export async function cardThumbnail(bytes){
 const output=await sharp(bytes,{limitInputPixels:64*1024*1024,animated:false})
  .rotate().resize({width:384,height:384,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toBuffer();
 return {bytes:output,mime:'image/webp'};
}
