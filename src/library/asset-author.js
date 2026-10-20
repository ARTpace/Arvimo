import {esc} from './html-esc.js';
export function authorButton(model,className=''){
 const supported=['sketchfab','artstation'].includes(model.platform||'sketchfab');
 return supported&&model.username?`<button type="button" class="${className} asset-author" data-author-uid="${esc(model.uid)}" title="查看 ${esc(model.author||model.username)} 的全部资产">${esc(model.author||model.username)}</button>`:`<span class="${className}">${esc(model.author||'未知作者')}</span>`;
}
