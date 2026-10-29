import {esc} from './html-esc.js';

/** 预览面板底部的动作行：收藏 / 下载 / 导出目标。
 *  exportControl 是「目标名胶囊 + 图标导出键」这一对（已下载才有），没有时给一枚灰掉的占位键。 */
export function previewActions({model,favorite,icon,exportControl=''}){
 return `<div class="preview-actions"><button type="button" class="secondary${favorite?' is-favorite':''}" data-action="favorite" data-uid="${esc(model.uid)}" aria-pressed="${!!favorite}" title="${favorite?'取消收藏':'收藏到我的资产库'}">${icon('heart')}<span>${favorite?'已收藏':'收藏'}</span></button><button type="button" class="primary" data-action="download" data-uid="${esc(model.uid)}">${icon('download')}<span>下载</span></button>${exportControl||`<button type="button" class="secondary preview-blender" disabled title="下载后可发送到其它软件" aria-label="下载后可发送到其它软件">${icon('blender')}</button>`}</div>`;
}
