import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {esc} from '../src/library/html-esc.js';
import {localAssetCategories} from '../src/library/local-filters.js';
import {filterTagEntries,tagHitLabel} from '../src/library/tag-search.js';
import {orderedCategories} from '../src/library/category-order.js';
import {syncLocalFilterMarkup} from '../src/library/local-filter-dom.js';
import {customCategoryFacets} from '../src/library/custom-categories.js';

test('entering the library paints once with restored search; downloads do not paint hidden cards',()=>{
 const source=readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8');
 const ids=['asset-query','search-panel','theme-results','local-feature','library-view','canvas-view','downloads-view','search-button','search-clear'];
 const {document,window}=parseHTML(`<html><body>${ids.map(id=>`<div id="${id}"></div>`).join('')}</body></html>`);
 const $=s=>document.querySelector(s);$('#asset-query').value='';
 let paints=0,searches=0;
 const context={$,document,window:{scrollY:0},CustomEvent:window.CustomEvent,
  state:{route:'discover',selected:new Set(),platform:'all'},searchMotionToken:0,routeQueries:new Map([['library','stone']]),routeScroll:new Map(),
  imageSearch:null,semanticSearch:null,searchHistory:null,downloads:null,
  galleryAvailable:()=>true,displayFor:()=> 'grid',platformById:()=>({placeholder:''}),icon:()=>'',refreshTopicStrip(){},renderStatus(){},counts(){},restoreRouteScroll(){},enterCanvas(){},
  cancelPictureRequests(){},pageScroller:()=>({scrollTop:0}),
  renderGrid(){paints++;},localSearch:{reset(){},search(){searches++;assert.equal($('#asset-query').value,'stone');paints++;}}};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('function route(name){'),source.indexOf('/** 平台决定')),context);
 context.route('library');assert.equal(paints,1);assert.equal(searches,1);
 context.route('discover');assert.equal(paints,2);
 context.route('library');assert.equal(paints,3);assert.equal(searches,2);
 context.route('downloads');assert.equal(paints,3);
 context.route('canvas');assert.equal(paints,3,'opening the canvas must not render the hidden library grid');
});

test('only the selected filter pane computes its contents; unchanged refresh preserves DOM nodes',()=>{
 const source=readFileSync(new URL('../src/library/library-view.js',import.meta.url),'utf8');
 const {document}=parseHTML('<html><body><div id="filter-rows"></div><select id="local-kind"></select></body></html>');
 const $=s=>document.querySelector(s);let tags=0,types=0;
 const context={$,document,esc,icon:()=>'',TYPE_GROUPS:[],state:{route:'library',models:[{uid:'a',platform:'local',assetType:'image'}],selected:new Set()},
  ctx:{localPackages:()=>[],localEntries:()=>[],localTags:()=>{tags++;return ['wood'];}},
  ensureFacetVocab:()=>Promise.resolve(null),activeLocalTypeId:()=>'',
  orderedCategories,syncLocalFilterMarkup,customCategoryFacets,
  localTypeFacets:()=>{types++;return [];},localAssetCategories,filterTagEntries,tagHitLabel,groupTagEntries:()=>[],renderGrid(){}};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('const openTypeGroups='),source.indexOf('function placeFilters()')),context);
 context.renderLocalFilters();const panel=$('#library-filters'),tabs=panel.firstElementChild;
 assert.equal(tags,0,'type view must not scan all asset tags');
 assert.equal(types,1);assert.equal(panel.querySelector('#local-tag-query'),null);
 context.renderLocalFilters();assert.equal(panel.firstElementChild,tabs,'unchanged sidebars must not replace their children');
 panel.dataset.tab='tags';context.renderLocalFilters();
 assert.equal(tags,1);assert.equal(types,2,'tag view must not rebuild hidden type facets');
 const input=panel.querySelector('#local-tag-query');assert.ok(input);
 context.renderLocalFilters();assert.equal(panel.querySelector('#local-tag-query'),input);
 assert.match(panel.querySelector('[data-tag-chips]').textContent,/wood/);
});

 test('forced asset scan refreshes server query scope before painting imported cards',async()=>{
 const source=readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8');
 const calls=[];const context={visitor:false,collectModelFolders:()=>false,state:{route:'library',options:{},models:[],onRemoteRefresh:async()=>calls.push('query')},$:()=>null,localFiles:{scan:async({force})=>{calls.push(force?'forced scan':'scan');return {packages:[],files:[]};}},renderGrid:()=>calls.push('paint')};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function scanLibraryFiles('),source.indexOf('// 阶段 3：本地库大批量')),context);
 await context.scanLibraryFiles(true);assert.deepEqual(calls,['query','forced scan','paint']);
 calls.length=0;await context.scanLibraryFiles(false);assert.deepEqual(calls,['scan','paint'],'background scans do not reset the current query page');
 });
