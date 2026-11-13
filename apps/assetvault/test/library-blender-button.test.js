import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findLocalJob,createBlenderButton} from '../src/library/blender-send.js';
const icon=name=>`<i>${name}</i>`;
const job=(over={})=>({id:'job-1',uid:'u'.repeat(32),state:'saved',filePath:'H:/models/a',...over});
test('只有已保存、文件还在的任务算作本地资产',()=>{
 const jobs=[job({id:'old',state:'saved'}),job({id:'new',state:'saved'})];
 assert.equal(findLocalJob(jobs,'u'.repeat(32)).id,'new');
 assert.equal(findLocalJob([job({fileExists:false})],'u'.repeat(32)),null);
 assert.equal(findLocalJob([job({state:'queued'})],'u'.repeat(32)),null);
 assert.equal(findLocalJob([job({state:'saved'})],'other'),null);
 assert.equal(findLocalJob(undefined,'u'.repeat(32)),null);
 assert.equal(findLocalJob([job()],undefined),null);
});
test('没有本地文件就不渲染按钮',()=>{
 const button=createBlenderButton({icon});
 assert.equal(button({job:null}),'');
 assert.equal(button({job:{}}),'');
 assert.equal(button({job:job()}).includes('data-action="blender-send"'),true);
});
test('按钮带任务编号、文案与无障碍标题',()=>{
 const html=createBlenderButton({icon})({job:job({id:'abc-1'}),label:'发送到 Blender'});
 assert.match(html,/data-id="abc-1"/);
 assert.match(html,/发送到 Blender/);
 assert.match(html,/aria-label="[^"]*Blender[^"]*"/);
 assert.match(html,/<i>blender<\/i>/);
 assert.match(html,/class="secondary"/);
});
test('卡片变体换的是样式与短文案，判定逻辑不变',()=>{
 const html=createBlenderButton({icon})({job:job(),className:'card-download blender-download',label:'Blender'});
 assert.match(html,/class="card-download blender-download"/);
 assert.match(html,/<span>Blender<\/span>/);
});
test('Blender 键与下载键同底色，logo 用 Blender 橙',()=>{
 // 2026-10-16：原先是一块紫底，和下载键并排很跳；现在底色走 .card-download，
 // 只把图标颜色换成 Blender 官方橙。
 const css=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'..','src','library','app.css'),'utf8');
 assert.equal(/\.blender-download\{background:#3/.test(css),false,'不再自带深色背景（改用下载键的淡绿底）');
 assert.ok(/\.blender-download\{color:#e87d2b!important\}/.test(css),'logo 为 Blender 橙');
 assert.ok(/\.blender-download:hover:not\(:disabled\)\{color:#ffa14d!important\}/.test(css),'悬停亮一档');
});
