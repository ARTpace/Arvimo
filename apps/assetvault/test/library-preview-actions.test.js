import test from 'node:test';
import assert from 'node:assert/strict';
import {previewActions} from '../src/library/preview-actions.js';
import {createSendMenu} from '../src/library/export-targets.js';

const icon=name=>`<i>${name}</i>`;
const esc=s=>s==null?'':String(s);
test('收藏、下载与导出控件共用一行，导出控件保留真实任务与无障碍说明',()=>{
 const exportControl=createSendMenu({icon,esc})({job:{id:'saved-job',kind:'sketchfab',assetType:'models'},className:'secondary preview-blender'});
 const html=previewActions({model:{uid:'a'.repeat(32)},favorite:true,icon,exportControl});
 assert.match(html,/class="preview-actions"/);
 assert.match(html,/data-action="favorite"/);assert.match(html,/aria-pressed="true"/);assert.match(html,/>已收藏</);
 assert.match(html,/>下载</);assert.doesNotMatch(html,/导出到本地|加入我的模型库/);
 // 导出控件是「目标名胶囊 + 图标导出键」这一对，且带着真实任务 id
 assert.match(html,/data-action="export-toggle" data-id="saved-job"/);
 assert.match(html,/data-action="export-go" data-id="saved-job" data-target="blender"/);
 assert.match(html,/aria-label="导出到 Blender"/);
 assert.match(html,/>Blender</);
});
test('未下载资产显示禁用的占位键，不误发下载任务',()=>{
 const html=previewActions({model:{uid:'b'.repeat(32)},favorite:false,icon});
 assert.match(html,/>收藏</);assert.match(html,/disabled title="下载后可发送到其它软件"/);
 assert.doesNotMatch(html,/data-action="export-go"/);
});
