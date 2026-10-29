import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assetMenuItems,packageMenuItems,fileMenuItems,copyText} from '../src/library/card-context-menu.js';

const css=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'..','src','library','app.css'),'utf8');
const icons=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'..','src','library','icon-set.js'),'utf8');

const uid='u'.repeat(32);
const model={uid,name:'Robot',author:'stud',platform:'sketchfab',url:'https://sketchfab.com/models/abc'};
const labels=items=>items.filter(i=>!i.separator).map(i=>i.label);

test('远端资产卡菜单：预览/下载/收藏/标签/加入模型库都在',()=>{
 const spec=assetMenuItems({card:{},model,uid,canDownload:true,revealId:'',canExport:false,favorite:false,inLibrary:false,isTrash:false,isVisitor:false});
 const names=labels(spec.items);
 assert.ok(names.includes('打开预览'));
 assert.ok(names.includes('下载到本地'));
 assert.ok(names.includes('收藏'));
 assert.ok(names.includes('标签与评分'));
 assert.ok(names.includes('加入模型库'));
 assert.equal(spec.title,'Robot');
});

test('已下载的卡片：给「打开下载文件夹」而不是「下载到本地」',()=>{
 const spec=assetMenuItems({card:{},model,uid,canDownload:false,revealId:'job-9',canExport:true,favorite:true,inLibrary:true,isTrash:false,isVisitor:false});
 const names=labels(spec.items);
 assert.ok(names.includes('打开下载文件夹'),'已下载应给打开文件夹');
 assert.ok(!names.includes('下载到本地'),'已下载不该再给下载');
 assert.ok(names.includes('取消收藏'),'已收藏时文案应变成取消收藏');
 assert.ok(names.includes('从模型库移除'),'已在库中应给移除');
 assert.ok(names.includes('发送到其它软件…'),'已下载才有导出');
 // 打开文件夹要用 reveal-download + data-id，和卡片上的按钮同一套动作
 const reveal=spec.items.find(i=>i.label==='打开下载文件夹');
 assert.equal(reveal.action,'reveal-download');
 assert.equal(reveal.attrs.id,'job-9');
});

test('菜单项沿用卡片的 data-action 约定，不另写一套执行逻辑',()=>{
 const spec=assetMenuItems({card:{},model,uid,canDownload:true,revealId:'',canExport:false,favorite:false,inLibrary:false,isTrash:false,isVisitor:false});
 const actions=spec.items.filter(i=>i.action).map(i=>i.action);
 for(const action of actions)assert.ok(['preview','download','reveal-download','favorite','collect','asset-tags','remove','restore','purge'].includes(action),`未知动作 ${action}`);
 // 每个 action 项都要带 uid（除了按任务号定位的 reveal-download）
 for(const item of spec.items.filter(i=>i.action&&i.action!=='reveal-download'))assert.ok(item.attrs.uid,`${item.label} 应带 uid`);
});

test('访客不给「加入模型库 / 从模型库移除」',()=>{
 const spec=assetMenuItems({card:{},model,uid,canDownload:true,revealId:'',canExport:false,favorite:false,inLibrary:false,isTrash:false,isVisitor:true});
 const names=labels(spec.items);
 assert.ok(!names.includes('加入模型库'));
 assert.ok(!names.includes('从模型库移除'));
 assert.ok(names.includes('收藏'),'收藏是本机行为，访客可以有');
});

test('回收站里的卡片：给「放回模型库」和「彻底删除」',()=>{
 const spec=assetMenuItems({card:{},model,uid,canDownload:false,revealId:'',canExport:false,favorite:false,inLibrary:false,isTrash:true,isVisitor:false});
 const names=labels(spec.items);
 assert.ok(names.includes('放回模型库'));
 assert.ok(names.includes('彻底删除记录'));
 assert.ok(!names.includes('收藏'),'回收站里不需要收藏');
 const purge=spec.items.find(i=>i.label==='彻底删除记录');
 assert.equal(purge.danger,true,'删除类动作应标 danger');
});

test('有官方链接时给「复制链接」和「打开官方页面」',()=>{
 const spec=assetMenuItems({card:{},model,uid,canDownload:true,revealId:'',canExport:false,favorite:false,inLibrary:false,isTrash:false,isVisitor:false});
 const names=labels(spec.items);
 assert.ok(names.includes('复制官方链接'));
 assert.ok(names.includes('在浏览器打开官方页面'));
 // ArtStation 的作品链接在 artworkUrl 上
 const art=assetMenuItems({card:{},model:{...model,url:'',artworkUrl:'https://x/art/1'},uid,canDownload:true,revealId:'',canExport:false,favorite:false,inLibrary:false,isTrash:false,isVisitor:false});
 assert.ok(labels(art.items).includes('复制官方链接'),'artworkUrl 也应被认作官方链接');
 // 没有链接就不给这两项
 const none=assetMenuItems({card:{},model:{...model,url:'',artworkUrl:''},uid,canDownload:true,revealId:'',canExport:false,favorite:false,inLibrary:false,isTrash:false,isVisitor:false});
 assert.ok(!labels(none.items).includes('复制官方链接'));
});

test('素材包菜单：打开素材包 / 下载 ZIP / 复制路径',()=>{
 const spec=packageMenuItems({card:{},pkg:{title:'Pack',rel:'assets/pack'},canRegister:false});
 const names=labels(spec.items);
 assert.ok(names.includes('打开素材包'));
 assert.ok(names.includes('下载为 ZIP'));
 assert.ok(names.includes('复制路径'));
 assert.equal(spec.title,'Pack');
 const withReg=packageMenuItems({card:{},pkg:{title:'Pack',rel:'assets/pack'},canRegister:true});
 assert.ok(labels(withReg.items).includes('登记 info.json'));
});

test('零散文件菜单：打开文件 / 复制路径',()=>{
 const spec=fileMenuItems({card:{click(){}},file:{name:'a.png',rel:'a.png'}});
 const names=labels(spec.items);
 assert.ok(names.includes('打开文件'));
 assert.ok(names.includes('复制路径'));
 assert.equal(spec.title,'a.png');
});

test('样式：菜单挂在 body 上（fixed），且有危险项配色',()=>{
 assert.match(css,/\.ctx-menu\{position:fixed[^}]*z-index:\d+/,'右键菜单应固定定位并有层级');
 assert.match(css,/\.ctx-item\.danger\{[^}]*color:/,'危险动作应有单独配色');
 assert.match(css,/\.model-card\.context-target\{/, '被右击的卡片应有高亮');
});

test('图标集里有 trash 图标（删除用垃圾桶，不是叉）',()=>{
 assert.match(icons,/trash:'/,'icon-set 应含 trash 图标');
});

test('copyText 对空值返回 false，不抛错',async()=>{
 assert.equal(await copyText(''),false);
 assert.equal(await copyText(null),false);
});
