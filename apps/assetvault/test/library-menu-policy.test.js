import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeContextMenu} from '../src/library/menu-policy.js';
import {assetMenuItems,pictureMenuItems} from '../src/library/card-context-menu.js';
import {libraryBackgroundItems} from '../src/library/library-background-menu.js';

const rows=spec=>normalizeContextMenu(spec).items.filter(row=>row.label);

test('shared menu wording keeps callbacks, confirmation and action payloads intact',()=>{
 const run=()=>{};
 const result=rows({items:[{group:'整理'},
  {label:'复制官方链接',run},
  {label:'打开预览',action:'preview',attrs:{uid:'a'}},
  {label:'删除资产及本地文件…',confirm:'confirm',danger:true,run},
  {label:'收藏',action:'favorite'},
 ]});
 assert.deepEqual(result.map(row=>row.label),['预览','收藏','复制链接','删除本地文件…']);
 assert.deepEqual(result[0].attrs,{uid:'a'});
 assert.equal(result[2].run,run);
 assert.equal(result[3].confirm,'confirm');assert.equal(result[3].danger,true);
 assert.ok(result[3].hint);
});

test('asset and picture menus use the same preview name, with source actions below frequent actions',()=>{
 const asset=rows(assetMenuItems({model:{name:'a',platform:'flickr',url:'https://flickr.com'},uid:'a',realm:'discover',canDownload:true}));
 const picture=rows(pictureMenuItems({card:{querySelector:()=>null},img:{dataset:{url:'https://example.com/a.jpg',pageUrl:'https://flickr.com'}}}));
 assert.equal(asset[0].label,'预览');assert.equal(picture[0].label,'预览');
 assert.ok(asset.findIndex(row=>row.label==='收藏')<asset.findIndex(row=>row.label==='作品页'));
});

test('background menu keeps every display choice, with import ahead of creation',()=>{
 const result=rows(libraryBackgroundItems({}));
 assert.deepEqual(result.map(row=>row.label),['导入资产','新建画板','智能画板','网格','瀑布流','全部卡片','仅画板','仅资产']);
});

test('unknown actions remain available and null menu remains null',()=>{
 assert.equal(normalizeContextMenu(null),null);
 const run=()=>{};
 const result=rows({items:[{group:'整理'},{label:'已有操作',run}]});
 assert.equal(result[0].run,run);
});
