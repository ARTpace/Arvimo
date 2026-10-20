import test from 'node:test';
import assert from 'node:assert/strict';
import {previewActions} from '../src/library/preview-actions.js';
import {createBlenderButton} from '../src/library/blender-send.js';

const icon=name=>`<i>${name}</i>`;
test('收藏、下载与 Blender 共用一行，图标操作保留真实发送任务与无障碍说明',()=>{
 const blenderButton=createBlenderButton({icon})({job:{id:'saved-job',kind:'sketchfab'},className:'secondary preview-blender'});
 const html=previewActions({model:{uid:'a'.repeat(32)},favorite:true,icon,blenderButton});
 assert.match(html,/class="preview-actions"/);
 assert.match(html,/data-action="favorite"/);assert.match(html,/aria-pressed="true"/);assert.match(html,/>已收藏</);
 assert.match(html,/>下载</);assert.doesNotMatch(html,/导出到本地|加入我的模型库/);
 assert.match(html,/data-action="blender-send" data-id="saved-job"/);
 assert.match(html,/aria-label="把已下载的模型发送到已打开的 Blender 场景"/);
});
test('未下载资产显示禁用的 Blender 图标，不误发下载任务',()=>{
 const html=previewActions({model:{uid:'b'.repeat(32)},favorite:false,icon});
 assert.match(html,/>收藏</);assert.match(html,/disabled title="下载后可发送到 Blender"/);
 assert.doesNotMatch(html,/data-action="blender-send"/);
});
