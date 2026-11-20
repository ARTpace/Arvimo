import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskCard,formatBadge,sizeText} from '../src/library/download-card.js';

// The card is a pure string builder, so the layout contract is testable without a browser:
// whatever is not on the "face" (everything before the first disclosure) costs one click.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<i data-icon="${name}"></i>`;
const card=createTaskCard({esc,icon});
const face=html=>html.split('<template')[0];
const disclosure=(html,kind)=>html.match(new RegExp(`<details class="task-${kind}"[\\s\\S]*?</details>`))[0];

const job=extra=>Object.assign({
 id:'job-1',uid:'a'.repeat(32),name:'Scifi Girl v.01',author:'patrix',kind:'sketchfab',
 state:'saved',stage:'saved',options:{packMode:'full',format:'glb',output:'zip'},
 attempts:1,createdAt:0,startedAt:0,finishedAt:86000,logs:['开始','完成'],
 message:'已保存到本机，文件完整性校验通过',downloadDir:'H:\\out',filePath:'H:\\out\\Scifi.zip',fileExists:true,bytes:41914269,
 network:{received:102900,completed:45,requests:45,failed:0,active:0,activeTotal:1000,activeReceived:300,rate:0,updatedAt:Date.now()},
 verification:{entries:8,sha256:'f'.repeat(64),bytes:41914269}
},extra);

test('a finished download states itself in one line on the card face',()=>{
 const html=card(job());
 const top=face(html);
 assert.ok(top.includes('Scifi Girl v.01'),'模型名必须留在正面');
 assert.ok(top.includes('完整包 · GLB ZIP'),'徽章必须留在正面');
 assert.ok(top.includes('下载完成'),'状态必须留在正面');
 assert.ok(top.includes('40.0 MB'),'体积必须留在正面');
 for(const folded of ['已保存到本机','progress-steps','job-path','SHA-256','<progress'])
  assert.ok(!top.includes(folded),`「${folded}」不该占着卡片正面`);
});

test('one icon-and-text detail action opens compact content with recent logs',()=>{
 const html=card(job());
 assert.equal((face(html).match(/data-task-disclosure=/g)||[]).length,1);
 assert.ok(!html.includes('download-local'));
 assert.ok(!html.includes('<details'));
 assert.ok(html.includes('<template data-task-detail>'));
 assert.ok(html.includes('H:\\out\\Scifi.zip'));
 assert.ok(html.includes('最近日志')&&html.includes('开始\n完成'));
 assert.ok(!html.includes('SHA-256')&&!html.includes('progress-steps'));
 for(const action of ['reveal','remove'])assert.match(html,new RegExp('data-dm-action="'+action+'"[^>]*><i data-icon='));
});

test('a live task wears only its bar and the number that changes',()=>{
 const html=card(job({state:'running',stage:'converting',finishedAt:undefined,fileExists:false,filePath:undefined,
  network:{received:2097152,completed:12,requests:45,failed:0,active:2,activeTotal:1000,activeReceived:300,rate:524288,updatedAt:Date.now()}}));
 const top=face(html);
 assert.ok(top.includes('<progress'),'进行中必须在正面看到进度条');
 assert.ok(!top.includes('network-facts'),'过程明细不占正面空间');
 assert.ok(top.includes('task-running'),'进行中卡片要有活动态样式');
 for(const folded of ['progress-steps','job-path','此百分比不是整个任务进度'])
  assert.ok(!top.includes(folded),`「${folded}」不该占着卡片正面`);
 assert.ok(html.includes('<template data-task-detail>'),'详情由浮层展示');
});

test('a queued task draws no progress bar before it starts',()=>{
 const top=face(card(job({state:'queued',stage:'queued',finishedAt:undefined,attempts:0,fileExists:false,filePath:undefined,message:'等待后台处理'})));
 assert.ok(top.includes('等待下载'));
 assert.ok(!top.includes('<progress')&&!top.includes('progress-rest'),'排队时不该出现空进度条');
 assert.ok(!top.includes('等待后台处理'),'排队过程提示不占行高');
});

test('a failure keeps its reason on the face, not behind a click',()=>{
 const top=face(card(job({state:'failed',stage:'failed',finishedAt:9000,fileExists:false,filePath:undefined,message:'TEST failure: 转换器退出码 1'})));
 assert.ok(top.includes('下载失败')&&top.includes('task-status error'),'失败状态必须显眼');
 assert.ok(top.includes('TEST failure: 转换器退出码 1'),'失败原因必须直接可见');
 assert.ok(!top.includes('job-path'),'失败任务的路径仍收在详情里');
});

test('attempts only take space once a retry really happened',()=>{
 assert.ok(!face(card(job({attempts:1}))).includes('尝试'),'首次下载不显示尝试次数');
 assert.ok(face(card(job({attempts:3}))).includes('尝试 3 次'),'重试过才显示次数');
});

test('the badge names content, model format and delivery in one line',()=>{
 assert.equal(formatBadge({kind:'sketchfab',options:{packMode:'full',format:'glb',output:'zip'}}),'完整包 · GLB ZIP');
 assert.equal(formatBadge({kind:'sketchfab',options:{packMode:'model',format:'fbx',output:'folder'}}),'模型+贴图 · GLB + FBX 文件夹');
 assert.equal(formatBadge({kind:'sketchfab',options:{packMode:'glb',format:'glb',output:'folder'}}),'仅 GLB · GLB 文件夹');
 assert.equal(formatBadge({kind:'artstation',options:{format:'fbx',output:'zip'}}),'MARMOSET → GLB + FBX ZIP');
 // A scene-less artwork has no mesh to convert, so the badge must not promise a GLB.
 assert.equal(formatBadge({kind:'artstation',hasMarmoset:false,options:{format:'fbx',output:'folder'}}),'作品图片 文件夹');
 assert.equal(formatBadge({kind:'artstation',hasMarmoset:true,options:{format:'glb',output:'zip'}}),'MARMOSET → GLB ZIP');
 assert.equal(sizeText(undefined),'—');
 assert.equal(sizeText(1536000),'1.5 MB');
});


test('active download shows only its bar without repetitive processing text',()=>{
 const html=face(card(job({state:'running',stage:'converting',message:'正在识别作品中的 Marmoset 场景',warning:'临时过程提示'})));
 assert.ok(html.includes('<progress'));
 assert.ok(!html.includes('正在识别作品中的 Marmoset 场景'));
 assert.ok(!html.includes('临时过程提示'));
 assert.ok(!html.includes('progress-heading')&&!html.includes('network-facts'));
});

test('saved GLB folder offers one-click FBX conversion and keeps progress separate from downloading',()=>{
 const t=job({options:{format:'glb',output:'folder'},verification:{folder:true,glbs:[{name:'model.glb'}]}});
 assert.match(face(card(t)),/data-dm-action="convert-fbx"/);
 assert.match(face(card({...t,fbx:{state:'running',message:'正在转换'}})),/data-dm-action="convert-fbx"[^>]*disabled/);
 assert.match(face(card({...t,fbx:{state:'failed',message:'转换失败'}})),/GLB 已保留/);
 assert.doesNotMatch(face(card({...t,verification:{folder:true,images:[{}]}})),/data-dm-action="convert-fbx"/);
});


test('real transfer percentage is visible and conversion does not invent a percentage',()=>{
 const transfer=face(card(job({state:'transferring',bytesWritten:25,totalBytes:100})));
 assert.ok(transfer.includes('task-progress-percent">25%'));
 const converting=face(card(job({state:'running',stage:'converting',network:null})));
 assert.ok(converting.includes('转换 / 打包中'));
 assert.ok(!converting.includes('后台转换中')&&!converting.includes('task-progress-percent'));
});
