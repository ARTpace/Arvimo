import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskCard,formatBadge,sizeText} from '../src/library/download-card.js';

// The card is a pure string builder, so the layout contract is testable without a browser:
// whatever is not on the "face" (everything before the first disclosure) costs one click.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<i data-icon="${name}"></i>`;
const card=createTaskCard({esc,icon});
const face=html=>html.split('<details')[0];
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

test('nothing is lost: steps, path, checksum and the final bar wait inside the disclosure',()=>{
 const html=card(job());
 const detail=disclosure(html,'details');
 assert.ok(detail.includes('data-kind="details"')&&detail.includes('data-id="job-1"'),'详情块要能被单独记住展开状态');
 assert.ok(!/\sopen(\s|>)/.test(detail),'详情默认折叠');
 assert.ok(detail.includes('job-path')&&detail.includes('H:\\out\\Scifi.zip'),'保存位置收在详情里');
 assert.ok(detail.includes('SHA-256')&&detail.includes('f'.repeat(16)),'校验指纹收在详情里');
 assert.ok(detail.includes('progress-steps')&&detail.includes('1 准备')&&detail.includes('6 完成'),'六个阶段收在详情里');
 assert.ok(detail.includes('<progress max="100" value="100"'),'完成后的 100% 进度条仍可取到');
 assert.ok(detail.includes('100.5 KB')&&detail.includes('完成 45/45 个资源请求'),'接收明细收在详情里');
 assert.ok(disclosure(html,'log').includes('任务日志 · 2 条'),'日志是另一个独立折叠块');
});

test('a live task wears only its bar and the number that changes',()=>{
 const html=card(job({state:'running',stage:'converting',finishedAt:undefined,fileExists:false,filePath:undefined,
  network:{received:2097152,completed:12,requests:45,failed:0,active:2,activeTotal:1000,activeReceived:300,rate:524288,updatedAt:Date.now()}}));
 const top=face(html);
 assert.ok(top.includes('<progress'),'进行中必须在正面看到进度条');
 assert.ok(top.includes('network-facts')&&top.includes('已接收 2.0 MB'),'实时字节数留在正面');
 assert.ok(top.includes('task-running'),'进行中卡片要有活动态样式');
 for(const folded of ['progress-steps','job-path','此百分比不是整个任务进度'])
  assert.ok(!top.includes(folded),`「${folded}」不该占着卡片正面`);
 assert.ok(disclosure(html,'details').includes('progress-steps'),'阶段表仍在详情里');
});

test('a queued task draws no progress bar before it starts',()=>{
 const top=face(card(job({state:'queued',stage:'queued',finishedAt:undefined,attempts:0,fileExists:false,filePath:undefined,message:'等待后台处理'})));
 assert.ok(top.includes('等待下载'));
 assert.ok(!top.includes('<progress')&&!top.includes('progress-rest'),'排队时不该出现空进度条');
 assert.ok(top.includes('等待后台处理'),'等待说明留在正面');
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

test('the disclosure and the log remember their open state independently',()=>{
 const alone=card(job(),{openDetails:true});
 assert.ok(/\sopen(\s|>)/.test(disclosure(alone,'details')),'详情可按状态恢复展开');
 assert.ok(!/\sopen(\s|>)/.test(disclosure(alone,'log')),'展开详情不该连带展开日志');
 const both=card(job(),{openDetails:true,openLog:true});
 assert.ok(/\sopen(\s|>)/.test(disclosure(both,'details'))&&/\sopen(\s|>)/.test(disclosure(both,'log')),'两者都可记住');
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
