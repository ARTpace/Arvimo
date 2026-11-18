import {esc} from './html-esc.js';

/** 预览面板底部的动作行：收藏 / 下载 / 导出目标。
 *  exportControl 是「目标名胶囊 + 图标导出键」这一对（已下载才有），没有可用任务时不显示占位键。 */
export function previewActions({model,favorite,icon,exportControl=''}){
 const local=!!(model.localRoot&&model.localRel);
 const openUrl=local?`/api/local/file?root=${encodeURIComponent(model.localRoot)}&rel=${encodeURIComponent(model.localRel)}`:'';
 const openLabel=/image|picture/.test(model.assetType||model.kind||'')?'打开原图':'打开文件';
 const source=/^https?:\/\//i.test(model.url||'')?model.url:'';
 return `<div class="preview-actions"><button type="button" class="secondary${favorite?' is-favorite':''}" data-action="favorite" data-uid="${esc(model.uid)}" aria-pressed="${!!favorite}" aria-label="${favorite?'取消收藏':'收藏'}" title="${favorite?'取消收藏':'收藏到我的资产库'}">${icon('heart')}<span>${favorite?'已收藏':'收藏'}</span></button>${local?`<a class="primary" href="${esc(openUrl)}" target="_blank" rel="noopener noreferrer" title="打开原文件" aria-label="打开原文件">${icon('external')}<span>${openLabel}</span></a><button type="button" class="secondary" data-action="preview-folder" data-uid="${esc(model.uid)}" title="打开所在文件夹" aria-label="打开所在文件夹">${icon('folder')}<span>文件夹</span></button>`:`<button type="button" class="primary" data-action="download" data-uid="${esc(model.uid)}" title="下载" aria-label="下载">${icon('download')}<span>下载</span></button>`}${exportControl||''}${source?`<a class="source-link" href="${esc(source)}" target="_blank" rel="noopener noreferrer" title="查看原网页" aria-label="查看原网页">${icon('external')}<span>原网页</span></a>`:''}</div>`;
}
