import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {compactPreview,previewHeader,setupPreviewDismiss} from '../src/library/preview-sidebar.js';
import {createDragPayload} from '../src/library/drag-payload.js';

test('预览平移区域不生成资产拖出数据',()=>{
 const {document}=parseHTML('<div data-preview-pan><img class="local-gallery-photo" data-drag-root="R" data-drag-rel="a.png"></div>');
 assert.equal(createDragPayload().sourceOf(document.querySelector('img')),null);
});

test('打开模态预览时窗口控制进入弹窗，关闭后归还主界面',t=>{
 const {document,window}=parseHTML('<html><body><div id="arvimo-window-chrome"></div><dialog></dialog></body></html>');
 const original=globalThis.MutationObserver;let changed;
 globalThis.MutationObserver=class{constructor(callback){changed=callback;}observe(){}};
 t.after(()=>{if(original===undefined)delete globalThis.MutationObserver;else globalThis.MutationObserver=original;});
 const dialog=document.querySelector('dialog'),chrome=document.getElementById('arvimo-window-chrome');
 let raised=0;chrome.matches=()=>false;chrome.showPopover=()=>raised++;
 setupPreviewDismiss(dialog);dialog.open=true;changed();
 assert.equal(chrome.parentElement,dialog);assert.equal(raised,1);
 dialog.open=false;dialog.dispatchEvent(new window.Event('close'));
 assert.equal(chrome.parentElement,document.body);assert.equal(raised,2);
});

test('图集当前图片的信息与标签复用同一个信息面板，保留输入事件',()=>{
 const {document,window}=parseHTML('<dialog><div class="preview-layout"><aside></aside></div></dialog>');
 const root=document.querySelector('aside');let changes=0;
 const paint=name=>{
  root.innerHTML=`<div class="gallery-summary">${previewHeader({name})}</div><div class="gallery-image-actions"><input data-gallery-tags></div><details class="pv-extra">路径</details>`;
  const input=root.querySelector('input');input.addEventListener('change',()=>changes++);
  compactPreview(root,{uid:name,name,platform:'local',assetType:'images'});
  assert.equal(document.querySelector('.pv-info-panel input'),input);
  input.dispatchEvent(new window.Event('change'));
 };
 paint('a.png');paint('b.png');
 assert.equal(changes,2);
 assert.equal(document.querySelectorAll('.gallery-asset-meta').length,1);
 assert.match(document.querySelector('.gallery-asset-meta').textContent,/b.png/);
});

test('仅在外部按下并外部松开时关闭预览，内部拖动不误关',()=>{
 const {document,window}=parseHTML('<dialog></dialog>');const dialog=document.querySelector('dialog');let closed=0;
 dialog.getBoundingClientRect=()=>({left:10,right:100,top:10,bottom:100});dialog.close=()=>closed++;
 setupPreviewDismiss(dialog);setupPreviewDismiss(dialog);
 const pointer=(type,x)=>{const event=new window.Event(type);Object.assign(event,{button:0,clientX:x,clientY:x});dialog.dispatchEvent(event);};
 pointer('pointerdown',50);pointer('pointerup',0);assert.equal(closed,0);
 pointer('pointerdown',0);pointer('pointerup',50);assert.equal(closed,0);
 pointer('pointerdown',0);pointer('pointerup',0);assert.equal(closed,1);
});
