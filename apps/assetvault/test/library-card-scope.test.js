import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {favoriteUid} from '../src/library/favorite-targets.js';
import {albumFolderView} from '../src/library/image-albums.js';
const app=readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8');
const local=readFileSync(new URL('../src/library/local-files.js',import.meta.url),'utf8');
test('图集目录内部只展示当前层图集与子目录，不混入模型材质',()=>{
 const context={albumFolder:'图片/贴花',albumHistory:[],albumFolderView,document:{getElementById:()=>null}};
 vm.createContext(context);vm.runInContext(local.slice(local.indexOf(' function organizePackages('),local.indexOf(' function searchPackageImages(')),context);
 const album={category:'images',rel:'图片/贴花/符号'},other={category:'material',rel:'材质/石头'};
 assert.deepEqual(Array.from(context.organizePackages([album,other]),row=>row.pkg),[album]);
 context.albumFolder='';assert.equal(context.organizePackages([album,other]).some(row=>row.pkg===other),true);
});
test('空画板不追加全库磁盘卡片，查询刷新期间也保持隔离',()=>{
 const context={localFiles:{},state:{filter:'all'},boardHub:{store:{activeId:'empty-board'}}};vm.createContext(context);
 vm.runInContext(app.slice(app.indexOf('function extraCards(){'),app.indexOf('/** 远程收藏卡上的')),context);
 assert.equal(context.extraCards().length,0);
});
test('图集目录不追加普通资产，进入画板后使用画板成员范围',()=>{
 const context={boardHub:{store:{activeId:''}},localFiles:{albumFolderActive:()=>true},state:{filter:'all',search:'',route:'library',options:{},queryUids:null}};
 vm.createContext(context);vm.runInContext(app.slice(app.indexOf('  const restrict=rows=>{'),app.indexOf('  // 语义模式（ADR-15）'))+'\nglobalThis.restrict=restrict;',context);
 const rows=[{uid:'member'},{uid:'other'}];assert.equal(context.restrict(rows).length,0);
 context.boardHub.store.activeId='board';context.state.queryUids=new Set(['member']);
 assert.deepEqual(Array.from(context.restrict(rows),row=>row.uid),['member']);
 context.state.queryUids=new Set();assert.equal(context.restrict(rows).length,0);
});
test('目录视图不追加全库零散文件和序列',()=>{
 const start=app.indexOf(" if(state.filter==='favorites'||localFiles.albumFolderActive()&&!query)return packages;");
 assert.ok(start>app.indexOf('function extraCards(){'));
 assert.ok(start<app.indexOf(' const members=localFiles.sequenceMembers();'));
});

test('筛选无结果保留当前目录，不回退并泄露全库卡片',()=>{
 const context={albumFolder:'图片/贴花',albumHistory:[],albumFolderView,document:{getElementById:()=>null}};vm.createContext(context);
 vm.runInContext(local.slice(local.indexOf(' function organizePackages('),local.indexOf(' function searchPackageImages(')),context);
 assert.equal(context.organizePackages([{category:'material',rel:'石头'}]).length,0);
 assert.equal(context.albumFolder,'图片/贴花');
});
test('目录状态不遮蔽回收站，画板范围刷新时清除目录导航',()=>{
 let cleared=0;const context={boardHub:{store:{activeId:''}},localFiles:{albumFolderActive:()=>true,resetAlbumFolder:()=>cleared++},state:{filter:'trash',search:'',route:'library',options:{},queryUids:null}};vm.createContext(context);
 vm.runInContext(app.slice(app.indexOf('  const restrict=rows=>{'),app.indexOf('  // 语义模式（ADR-15）'))+'\nglobalThis.restrict=restrict;',context);
 assert.equal(context.restrict([{uid:'trash'}]).length,1);
 vm.runInContext(app.slice(app.indexOf('function extraCards(){'),app.indexOf('/** 远程收藏卡上的')),context);
 context.boardHub.store.activeId='board';assert.equal(context.extraCards().length,0);assert.equal(cleared,1);
});
test('收藏页只显示已收藏的磁盘图集，不追加普通文件',()=>{
 const context={favoriteUid,boardHub:{store:{activeId:''}},state:{filter:'favorites',favorites:new Set([favoriteUid('package','R|a')]),models:[],folders:[],sort:'recent'},downloads:null,
 localFiles:{resetAlbumFolder(){},packages:()=>[{uid:'saved',root:'R',rel:'a'},{uid:'other',root:'R',rel:'b'}],matchesPackage:()=>true,searchPackageImages:()=>[],organizePackages:rows=>rows.map(pkg=>({pkg}))},
 activeLocalKind:()=>'',tagFilterActive:()=>false,formatFilter:{matcher:()=>null},modeAllowsLocalKind:()=>true};
 vm.createContext(context);vm.runInContext(app.slice(app.indexOf('function extraCards(){'),app.indexOf('/** 远程收藏卡上的')),context);
 const cards=context.extraCards();assert.equal(cards.length,1);assert.equal(cards[0].key,'pkg|R|a');
});
