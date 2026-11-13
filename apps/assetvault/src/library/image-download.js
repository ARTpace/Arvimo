// Bulk picture downloading: the UI seam.
//
// The grid already knows how to multi-select, and the queue already knows how to run a job — this
// module is only what connects them: decide whether an asset has pictures worth asking for, build the
// button that asks, and turn a list of uids into one `images` enqueue. Keeping those three rules in
// one file is what stops the card template, the selection bar and the preview dialog from drifting
// apart on what "download the pictures" means.
import {esc} from './html-esc.js';

/** Queue-side job kind. The only word the backend needs to route to the picture runner. */
export const IMAGE_KIND='images';
/** Pictures live on the asset's own page, so anything with a source can be asked for them:
 *  an ArtStation artwork always has uploads, and a Sketchfab model has them once it has a cover. */
export const hasImages=model=>!!model?.uid&&(model.platform==='artstation'||!!model.thumbnail);
/** Largest fetchable size per platform, used only for the button's tooltip — never as a promise
 *  about a particular file, since the source decides that at download time. */
const SIZE_HINT=Object.freeze({sketchfab:'最大公开封面（1920px）',artstation:'作者上传的原图',polyhaven:'官方渲染图（多视角）',ambientcg:'官方缩略图（2048px）'});

export function createImageDownloader({icon,toast,downloads=()=>null,findModel,refresh=()=>{}}){
  const sizeHint=model=>SIZE_HINT[model?.platform==='artstation'?'artstation':model?.platform==='polyhaven'?'polyhaven':model?.platform==='ambientcg'?'ambientcg':'sketchfab']||'';
  function button(model,{className='card-icon-action image-button',label='下载高清图'}={}){
    if(!hasImages(model))return '';
    const title=`${label} · ${sizeHint(model)}`;
    return `<button class="${className}" data-action="download-images" data-uid="${esc(model.uid)}" title="${esc(title)}" aria-label="${esc(title)}">${icon('image')}</button>`;
  }
  return {
    button,
    async requestImages(ids,{force=false,note=''}={}){
      const picked=(ids||[]).map(findModel).filter(Boolean).filter(hasImages);
      if(!picked.length){toast('没有可下载图片的资产。');return;}
      const manager=downloads();
      if(!manager?.enqueue){toast('后台服务未连接，无法下载图片。');return;}
      if(picked.length>50){toast('每批最多下载 50 个资产的图片，请减少选择数量。');return;}
      try{
        const result=await manager.enqueue(picked,{output:'folder',imageRendition:'max'},force,undefined,IMAGE_KIND);
        refresh();
        const message=result.added.length?`${note}已加入 ${result.added.length} 个图片下载任务${result.duplicates.length?`，跳过 ${result.duplicates.length} 个已有记录`:''}`:`${note}这些资产的图片已在队列或已下载。`;
        toast(message);
      }catch(e){toast(e.message);refresh();}
    },
  };
}
