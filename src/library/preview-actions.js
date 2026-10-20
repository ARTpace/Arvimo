import {esc} from './html-esc.js';

export function previewActions({model,favorite,icon,blenderButton=''}){
 return `<div class="preview-actions"><button type="button" class="secondary${favorite?' is-favorite':''}" data-action="favorite" data-uid="${esc(model.uid)}" aria-pressed="${!!favorite}" title="${favorite?'取消收藏':'收藏到我的资产库'}">${icon('heart')}<span>${favorite?'已收藏':'收藏'}</span></button><button type="button" class="primary" data-action="download" data-uid="${esc(model.uid)}">${icon('download')}<span>下载</span></button>${blenderButton||`<button type="button" class="secondary preview-blender" disabled title="下载后可发送到 Blender" aria-label="下载后可发送到 Blender">${icon('blender')}</button>`}</div>`;
}
