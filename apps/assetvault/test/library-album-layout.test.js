import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {updateAlbumTiles,albumDragStep,albumDragLayout} from '../src/library/album-card-layout.js';

test('四宫直接右拖进入横六宫，方向切换无需先上下选六宫',()=>{
 assert.deepEqual(albumDragLayout(4,false,70,4),{mode:6,wide:true});
 assert.deepEqual(albumDragLayout(4,false,30,4),{mode:4,wide:false});
 assert.deepEqual(albumDragLayout(6,true,-70,4),{mode:6,wide:false});
 assert.deepEqual(albumDragLayout(6,true,4,110),{mode:9,wide:true});
 assert.deepEqual(albumDragLayout(4,false,70,140),{mode:6,wide:false});
});

test('快速拖动最多切一档，六宫具有更宽停留区间',()=>{
 assert.equal(albumDragStep(4,200),6);
 assert.equal(albumDragStep(6,50),6);
 assert.equal(albumDragStep(6,109),6);
 assert.equal(albumDragStep(6,110),9);
 assert.equal(albumDragStep(6,-110),4);
 assert.equal(albumDragStep(9,-200),6);
 assert.equal(albumDragStep(4,-200),4);
});

test('反复切换宫格保留同一图片节点和地址，不重复淡入',()=>{
 const {document}=parseHTML('<html><body><div class="pkg-collage"></div></body></html>');
 const collage=document.querySelector('.pkg-collage');
 const html=count=>`<div class="pkg-collage">${Array.from({length:count},(_,i)=>`<div class="pkg-tile"><img src="${i}.png">${i===count-1?'<span class="pkg-tile-plus">+10</span>':''}</div>`).join('')}</div>`;
 updateAlbumTiles(collage,html(4));const first=collage.firstElementChild.firstElementChild;
 updateAlbumTiles(collage,html(9));const ninth=collage.lastElementChild.firstElementChild;
 updateAlbumTiles(collage,html(4));assert.equal(collage.lastElementChild.hidden,true);
 updateAlbumTiles(collage,html(9));
 assert.equal(collage.firstElementChild.firstElementChild,first);
 assert.equal(collage.lastElementChild.firstElementChild,ninth);
 assert.equal(collage.querySelectorAll('img').length,9);
 assert.equal(collage.querySelectorAll('.pkg-tile:not([hidden]) .pkg-tile-plus').length,1);
});

test('图集展示按目录独立保存，忽略旧全局设置',()=>{
 const source=readFileSync(new URL('../src/library/local-files.js',import.meta.url),'utf8');
 const values=new Map([['assetvault-pkg-collage','9']]);
 let board='';
 const ctx={albumFolder:'',activeBoardId:()=>board,localStorage:{getItem:key=>values.get(key)},packageKey:pkg=>`${pkg.root}|${pkg.rel}`};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf("const COLLAGE_KEY="),source.indexOf('/** 多图集合卡的媒体区')),ctx);
 values.set(ctx.collageKey({root:'R',rel:'a'}),'6');
 assert.equal(ctx.collageCount({root:'R',rel:'a'}),6);
 assert.equal(ctx.collageCount({root:'R',rel:'b'}),4);
 values.set(ctx.collageKey({root:'R',rel:'b'}),'9');
 assert.equal(ctx.collageCount({root:'R',rel:'a'}),6);
 assert.equal(ctx.collageCount({root:'R',rel:'b'}),9);
 const pkg={root:'R',rel:'a'};
 board='A';assert.equal(ctx.collageCount(pkg),4);values.set(ctx.collageKey(pkg),'9');
 board='B';assert.equal(ctx.collageCount(pkg),4);
 board='A';assert.equal(ctx.collageCount(pkg),9);
 board='';ctx.albumFolder='folderA';assert.equal(ctx.collageCount(pkg),4);values.set(ctx.collageKey(pkg),'9');
 ctx.albumFolder='folderB';assert.equal(ctx.collageCount(pkg),4);
 ctx.albumFolder='folderA';assert.equal(ctx.collageCount(pkg),9);
 ctx.albumFolder='';assert.equal(ctx.collageCount(pkg),6);
});
