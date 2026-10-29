import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCardView} from '../src/library/card-view.js';
import {createSendMenu,exportMenuHtml,applicableTargets,setSelectedTarget,selectedTargetFor,effectiveTarget,targetById} from '../src/library/export-targets.js';
import {platformLabel} from '../src/library/platforms.js';

const css=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'..','src','library','app.css'),'utf8');
const icon=name=>`<i class="${name}"></i>`;
const esc=s=>s==null?'':String(s);

// 一条「已保存到本地」的模型任务：只有这种资产才有导出入口。
const modelJob={id:'job-1',uid:'u'.repeat(32),state:'saved',fileExists:true,kind:'sketchfab',assetType:'models'};

const build=(state={favorites:new Set(),models:[],selected:new Set(),tasks:[]},jobs=[modelJob],isVisitor=false)=>createCardView({
 icon,esc,
 fmt:n=>(n??0).toLocaleString('en-US'),
 state,
 queuePulse:new Map(),
 imageDownload:{button:()=>''},
 sendControl:createSendMenu({icon,esc}),
 platformLabel,
 artstationUI:()=>({has3dScene:()=>false}),
 downloadsUI:()=>({jobs}),
 isVisitor,
});

const cardModel={uid:'u'.repeat(32),name:'Robot',author:'stud',platform:'sketchfab',thumbnail:'',license:'CC0',downloadable:true};

test('导出控件是两步式：目标名胶囊 + 纯图标导出键，选目标不导出',()=>{
 const html=build().card(cardModel);
 // 控件在缩略图下方的常驻行里（与「标签」同行），不在封面上
 assert.match(html,/card-meta-actions[^]*export-control/,'导出控件应在缩略图下方的信息行');
 assert.doesNotMatch(html,/card-bottom[^]*export-control/,'导出控件不该再叠在封面底栏');
 // 左边是显示软件名的下拉，右边是纯图标的导出键
 assert.match(html,/data-action="export-toggle"[^>]*>\s*<i[^>]*><\/i>\s*<span>Blender<\/span>/,'下拉键应显示当前目标软件名');
 const go=html.match(/<button class="export-go"[^>]*>([\s\S]*?)<\/button>/);
 assert.ok(go,'应有导出键');
 assert.equal(go[1].replace(/<[^>]+>/g,'').trim(),'','导出键必须纯图标、不带文字');
 assert.match(go[0],/data-action="export-go"/);
 assert.match(go[0],/data-target="blender"/,'导出键应带上当前目标');
 // 菜单项是「挑目标」，不是「直接发送」
 assert.doesNotMatch(html,/data-action="export-send"/,'不再有一步到位的发送动作');
});

test('已下载的卡片封面完全干净：不再渲染空的底栏',()=>{
 const html=build().card(cardModel);
 // 下载键消失后底栏没内容了，就不该留一个空壳（会显示成一条空的渐变斜角）
 assert.doesNotMatch(html,/card-bottom/,'没有动作时整块底栏都不该渲染');
});

test('未下载的卡片仍有下载键，且底栏不是空的',()=>{
 const html=build(undefined,[]).card(cardModel);
 assert.match(html,/data-action="download"/,'未下载的卡片要有下载键');
 assert.match(html,/card-bottom/);
});

test('换目标后下拉键改名，导出键跟着换目标',()=>{
 const sendControl=createSendMenu({icon,esc});
 const first=sendControl({job:modelJob});
 assert.match(first,/<span>Blender<\/span>/,'默认目标是 Blender');
 assert.match(first,/data-target="blender"/);
 // 记住选择后重新渲染，按键要显示新名字
 setSelectedTarget(modelJob.id,'unity');
 const second=sendControl({job:modelJob});
 assert.match(second,/<span>Unity<\/span>/,'选中后应显示 Unity');
 assert.match(second,/data-target="unity"/,'导出键应指向 Unity');
 assert.equal(selectedTargetFor(modelJob.id).id,'unity');
 setSelectedTarget(modelJob.id,'blender');
});

test('菜单列出所有适用目标，并给当前目标打勾',()=>{
 const targets=applicableTargets(modelJob);
 const html=exportMenuHtml(targets.map(t=>({...t,jobId:modelJob.id})),{icon,esc});
 assert.match(html,/export-menu-head[^>]*>选择导出软件/);
 assert.match(html,/data-action="export-pick"/,'菜单项是挑目标');
 for(const label of ['Blender','Unity','Unreal Engine','Godot','Maya','3ds Max','Houdini','Cinema 4D']){
  assert.ok(html.includes(label),`菜单应列出 ${label}`);
 }
 assert.match(html,/export-item on/,'当前目标应打勾');
});

test('HDRI 只有 Blender 可选，访客只能发到本机 Blender',()=>{
 const hdri={id:'job-h',uid:'h'.repeat(32),state:'saved',fileExists:true,kind:'polyhaven',assetType:'hdris'};
 assert.deepEqual(applicableTargets(hdri).map(t=>t.id),['blender'],'HDRI 只能进 Blender');
 // 访客：只有模型能推到自己电脑的 Blender
 const visitorTargets=applicableTargets(modelJob,{isVisitor:true});
 assert.deepEqual(visitorTargets.map(t=>t.id),['blender']);
 // 访客看材质/HDRI 时没有目标 → 控件整块不渲染
 assert.equal(applicableTargets(hdri,{isVisitor:true}).length,0);
});

test('生效目标有默认值：没选过时用清单里的第一个，导出键永远可点',()=>{
 const targets=applicableTargets(modelJob);
 assert.equal(effectiveTarget('never-picked',targets).id,'blender');
 assert.equal(effectiveTarget('never-picked',[]),null);
 assert.equal(targetById('unity').label,'Unity');
 assert.equal(targetById('nope'),null);
});

test('样式：导出控件靠右，导出键是圆形图标键',()=>{
 assert.ok(/\.export-control\{[^}]*margin-left:auto/.test(css),'导出控件应推到信息行最右');
 assert.ok(/\.card-meta-actions \.export-go\{[^}]*border-radius:50%/.test(css),'导出键应是圆形');
 assert.ok(/\.export-menu \.export-item\.on/.test(css),'当前目标要有打勾样式');
});
