import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {rangeSelectionArea} from '../src/library/range-select.js';
import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';

test('分类、搜索和操作栏属于同一个固定顶部区域，卡片位于其外',()=>{
 const html=readFileSync(new URL('../src/library/index.html',import.meta.url),'utf8');
 const {document}=parseHTML(html),sticky=document.querySelector('.search-sticky');
 for(const id of ['content-kind-tabs','search-panel','local-toolbar'])assert.ok(sticky.contains(document.getElementById(id)),id);
 assert.equal(sticky.contains(document.getElementById('grid')),false);
 assert.match(assembleLibraryStyles(),/\.search-sticky\{position:sticky;/);
});

test('顶部容器及顶部空白禁止框选，滚动后仍不从固定栏下方穿透',()=>{
 const {document}=parseHTML('<main><div class="content"><div class="search-sticky"><nav id="content-kind-tabs"><span></span></nav><div id="local-toolbar"></div></div><div id="grid"><article class="model-card"></article></div></div></main>');
 const grid=document.getElementById('grid'),sticky=document.querySelector('.search-sticky'),content=document.querySelector('.content');
 grid.getBoundingClientRect=()=>({top:260});sticky.getBoundingClientRect=()=>({bottom:250});
 assert.equal(rangeSelectionArea(document.querySelector('nav span'),grid,100),false);
 assert.equal(rangeSelectionArea(sticky,grid,160),false);
 assert.equal(rangeSelectionArea(content,grid,200),false);
 assert.equal(rangeSelectionArea(grid,grid,280),true);
 grid.getBoundingClientRect=()=>({top:-400});
 assert.equal(rangeSelectionArea(content,grid,100),false);
 assert.equal(rangeSelectionArea(grid,grid,280),true);
 assert.equal(rangeSelectionArea(grid.firstElementChild,grid,280),false);
});
