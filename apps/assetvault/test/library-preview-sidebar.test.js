import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {previewHeader,compactPreview,setupPreviewSidebarToggle} from '../src/library/preview-sidebar.js';
import {previewActions} from '../src/library/preview-actions.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryServer} from '../server/library.mjs';

test('所有平台共用紧凑结构，本地图片不显示内部地址或3D类型',()=>{
 for(const platform of ['local','artstation','sketchfab','fab','xiaohongshu']){
  const html=previewHeader({name:'image.png',platform,width:1024,height:2048,bytes:1024,assetType:'images'});
  const {document}=parseHTML(`<aside>${html}</aside>`);
  assert.equal(document.querySelectorAll('h2').length,1);
  assert.match(document.querySelector('.pv-facts').textContent,/PNG.*1024 × 2048/);
  assert.doesNotMatch(html,/3D 资产|api\/local/);
 }
});

test('统一侧栏保留参数节点与事件，低频信息可展开，重复刷新不叠加头部或来源',()=>{
 const {document}=parseHTML('<aside><div class="eyebrow">OLD</div><h2>旧名称</h2><p class="author-name">by someone</p><div class="details-stats">统计</div><div class="detail-license">许可</div><select class="material-format"><option>GLB</option></select><div class="preview-actions"><button title="下载">下载</button></div><a class="source-link" href="https://example.com">原网页</a></aside>');
 const root=document.querySelector('aside'),select=root.querySelector('select');
 let changed=false;select.addEventListener('change',()=>{changed=true;});
 compactPreview(root,{name:'新名称',platform:'sketchfab',assetType:'models'});
 compactPreview(root,{name:'新名称',platform:'sketchfab',assetType:'models'});
 assert.equal(root.querySelectorAll('h2').length,1);
 assert.equal(root.querySelectorAll('.pv-extra').length,1);
 assert.equal(root.querySelector('.pv-extra').hasAttribute('open'),false);
 assert.equal(root.querySelector('select'),select);
 select.dispatchEvent(new document.defaultView.Event('change'));
 assert.equal(changed,true);
 assert.equal(root.querySelector('.preview-actions .source-link').getAttribute('aria-label'),'查看原网页');
});

test('本地资产打开与目录直接可达，不再显示下载或无效导出',()=>{
 const html=previewActions({model:{uid:'a',localRoot:'H:/images',localRel:'a.png',url:'/api/local/file?root=secret'},icon:name=>`<i>${name}</i>`});
 assert.match(html,/aria-label="打开原文件"/);
 assert.match(html,/data-action="preview-folder"/);
 assert.doesNotMatch(html,/data-action="download"|preview-blender|class="source-link"/);
});

test('信息栏一次点击收起与恢复，重复初始化不叠加入口',()=>{
 const {document}=parseHTML('<dialog><div class="dialog-header"><span>预览</span><button data-close="preview">关闭</button></div></dialog>');
 const dialog=document.querySelector('dialog');
 setupPreviewSidebarToggle(dialog);setupPreviewSidebarToggle(dialog);
 const button=dialog.querySelector('[data-preview-sidebar-toggle]');
 assert.equal(dialog.querySelectorAll('[data-preview-sidebar-toggle]').length,1);
 button.click();assert.equal(button.getAttribute('aria-expanded'),'false');
 assert.equal(dialog.classList.contains('pv-sidebar-hidden'),true);
 button.click();assert.equal(button.getAttribute('aria-expanded'),'true');
});

test('标签与评分移到预览区信息弹层，默认隐藏、点击显示，刷新不重复且换资产清空',()=>{
 const {document}=parseHTML('<dialog><div class="preview-layout"><div class="viewer-wrap"></div><aside><section class="asset-tags"><button data-rate="3">评分</button></section></aside></div></dialog>');
 const root=document.querySelector('aside'),tags=root.querySelector('.asset-tags');
 compactPreview(root,{uid:'one',name:'one.png'});
 const panel=document.querySelector('.pv-info-panel'),button=document.querySelector('.pv-info-button');
 assert.equal(root.querySelector('.asset-tags'),null);
 assert.equal(panel.querySelector('.asset-tags'),tags);
 assert.equal(panel.hidden,true);
 button.click();assert.equal(panel.hidden,false);
 compactPreview(root,{uid:'one',name:'one.png'});
 assert.equal(document.querySelectorAll('.pv-info-anchor').length,1);
 assert.equal(panel.hidden,false);
 compactPreview(root,{uid:'two',name:'two.png'});
 assert.equal(panel.hidden,true);
 assert.equal(panel.querySelector('.asset-tags'),null);
});

test('打开文件夹入口拒绝外部来源、缺少本地标识和未索引目录',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-preview-folder-'));
 const previous=process.env.SFX_DATA_DIR;let server;
 try{process.env.SFX_DATA_DIR=dir;server=createLibraryServer();}
 finally{if(previous===undefined)delete process.env.SFX_DATA_DIR;else process.env.SFX_DATA_DIR=previous;}
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${server.address().port}/api/local/reveal`;
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403);
 assert.equal((await fetch(url,{method:'POST',headers:{'X-SFX-Local':'1',Origin:'https://example.com'},body:'{}'})).status,403);
 assert.equal((await fetch(url,{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify({root:path.join(dir,'not-indexed'),rel:'a.png'})})).status,403);
});
