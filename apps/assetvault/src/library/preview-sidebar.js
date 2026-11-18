import {esc} from './html-esc.js';
import {icon} from './icon-set.js';
import {sizeText} from './download-card.js';
import {platformLabel} from './platforms.js';

export function previewHeader(model, {width=model.width,height=model.height,index=0,count=1}={}){
 const name=model.name||model.title||'未命名资产';
 const ext=String(model.ext||name.match(/\.([a-z0-9]+)$/i)?.[1]||'').replace(/^\./,'').toUpperCase();
 const kind=model.assetType||model.kind||'images';
 const glyph=/model|3d/.test(kind)?'cube':/video/.test(kind)?'play':'image';
 const fact=(glyph,text,label)=>text?`<span title="${esc(label)}" aria-label="${esc(label+': '+text)}">${icon(glyph)}${esc(text)}</span>`:'';
 const local=model.platform==='local'||!!model.localRoot;
 const source=local?'本地':model.platform?platformLabel(model.platform):'';
 return `<header class="pv-heading"><h2 title="${esc(name)}">${esc(name)}</h2></header><div class="pv-facts">${fact(glyph,ext||(/model|3d/.test(kind)?'3D':'图片'),'类型')}${fact('scan',width&&height?`${width} × ${height}`:'','尺寸')}${fact('file',model.bytes?sizeText(model.bytes):'','大小')}${count>1?fact('image',`${index+1} / ${count}`,'当前图片'):''}</div><div class="pv-origin">${icon(local?'folder':'globe')}<span>${esc([source,model.author].filter(Boolean).join(' · '))}</span></div>`;
}

/** 保留平台渲染器及参数事件，只将低频介绍和参数归入同一结构。 */
export function compactPreview(root,model){
 if(!root||!model)return;
 root.classList.add('pv-sidebar');
 const old=root.querySelector('.pv-heading');
 if(!old){
  root.querySelectorAll(':scope > .eyebrow,:scope > h2,:scope > .author-name').forEach(el=>el.remove());
  root.insertAdjacentHTML('afterbegin',previewHeader(model));
  const info=root.ownerDocument.createElement('details');info.className='pv-extra';
  info.innerHTML=`<summary>${icon('help')}<span>详细信息</span></summary>`;
  root.querySelectorAll(':scope > .details-stats,:scope > .detail-license,:scope > .picture-description').forEach(el=>info.append(el));
  if(info.children.length>1)root.append(info);
 }
 const sourceLinks=new Set();
 root.querySelectorAll('.source-link').forEach(link=>{
  const href=link.getAttribute('href');if(sourceLinks.has(href)){link.remove();return;}sourceLinks.add(href);
  if(!/^https?:\/\//i.test(link.getAttribute('href')||'')){link.remove();return;}
  link.title='查看原网页';link.setAttribute('aria-label','查看原网页');link.innerHTML=icon('external')+'<span>原网页</span>';
  root.querySelector('.preview-actions')?.append(link);
 });
 root.querySelectorAll('.preview-actions button,.preview-actions a').forEach(el=>{
  const label=el.getAttribute('aria-label')||el.title||el.textContent.trim();
  if(label){el.title=label;el.setAttribute('aria-label',label);}
 });
 const dialog=root.closest('dialog');
 const layout=dialog?.querySelector('.preview-layout');
 if(!layout)return;
 let anchor=layout.querySelector('.pv-info-anchor');
 if(!anchor){
  anchor=root.ownerDocument.createElement('div');anchor.className='pv-info-anchor';
  anchor.innerHTML=`<div class="pv-info-panel pv-sidebar" hidden></div><button type="button" class="pv-info-button" title="资产信息" aria-label="资产信息" aria-expanded="false"><i><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg></i></button>`;
  layout.append(anchor);
  const button=anchor.querySelector('button'),panel=anchor.querySelector('.pv-info-panel');
  button.onclick=()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));};
 }
 const panel=anchor.querySelector('.pv-info-panel');
 const key=model.uid||model.name||model.title||'';
 if(panel.dataset.assetKey!==key){
  panel.replaceChildren();panel.hidden=true;panel.dataset.assetKey=key;
  anchor.querySelector('.pv-info-button').setAttribute('aria-expanded','false');
 }
 if(root.querySelector('.gallery-summary')){
  panel.querySelector('.gallery-asset-meta')?.remove();
  const meta=root.ownerDocument.createElement('div');meta.className='gallery-asset-meta';
  meta.innerHTML=previewHeader(model);panel.prepend(meta);
  const actions=root.querySelector('.gallery-image-actions');
  if(actions){panel.querySelector('.gallery-image-actions')?.remove();panel.append(actions);}
 }
 for(const node of root.querySelectorAll(':scope > .asset-tags,:scope > .pv-extra')){
  panel.querySelector(node.matches('.asset-tags')?'.asset-tags':'.pv-extra')?.remove();
  panel.append(node);
 }
 anchor.hidden=!panel.children.length;
}

/** Only an outside press followed by an outside release dismisses the preview. */
export function setupPreviewDismiss(dialog){
 if(!dialog||dialog.dataset.dismissReady)return;
 dialog.dataset.dismissReady='1';
 let outside=false;
 const isOutside=event=>{
  if(event.target!==dialog)return false;
  const r=dialog.getBoundingClientRect();
  return event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom;
 };
 dialog.addEventListener('pointerdown',event=>{outside=event.button===0&&isOutside(event);});
 dialog.addEventListener('pointerup',event=>{const close=outside&&isOutside(event);outside=false;if(close)dialog.close();});
 dialog.addEventListener('pointercancel',()=>{outside=false;});
 // 模态弹窗会让 body 的其他子节点 inert；桌面窗口按钮需成为当前弹窗的后代。
 const syncChrome=()=>{
  const chrome=dialog.ownerDocument.getElementById('arvimo-window-chrome');
  if(!chrome)return;
  if(dialog.open)dialog.append(chrome);
  else if(chrome.parentElement===dialog)dialog.ownerDocument.body.append(chrome);
  try{if(chrome.matches(':popover-open'))chrome.hidePopover();chrome.showPopover?.();}catch{}
 };
 if(typeof MutationObserver!=='undefined')new MutationObserver(syncChrome).observe(dialog,{attributes:true,attributeFilter:['open']});
 dialog.addEventListener('close',syncChrome);
}

export function setupPreviewSidebarToggle(dialog){
 const close=dialog?.querySelector('.dialog-header [data-close]');
 if(!close||dialog.querySelector('[data-preview-sidebar-toggle]'))return;
 const button=dialog.ownerDocument.createElement('button');
 button.type='button';button.className='icon-button pv-sidebar-toggle';
 button.setAttribute('data-preview-sidebar-toggle','');button.setAttribute('aria-expanded','true');
 button.title='显示 / 隐藏信息栏';button.setAttribute('aria-label',button.title);
 button.innerHTML=dialog.id==='file-preview-dialog'?'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M9 4v16"/></svg>':icon('list');close.before(button);
 button.onclick=()=>{const hidden=dialog.classList.toggle('pv-sidebar-hidden');button.setAttribute('aria-expanded',String(!hidden));};
}
