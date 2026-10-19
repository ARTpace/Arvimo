import test from 'node:test';
import assert from 'node:assert/strict';
import {readOptions,selectedIndex,moveIndex,typeahead,isMenuKey,isTypeaheadKey} from '../src/library/picker-model.js';

// 自绘下拉的 DOM 部分由浏览器端到端测试覆盖；这里只测不需要浏览器的两件事：
// 选项快照与键盘索引计算。只要这两件不出错，键盘操作就和原生 select 一样可预期。
const select=rows=>({options:rows.map(row=>({
 value:row.value,
 textContent:row.label,
 dataset:{hint:row.hint||''},
 selected:!!row.selected,
}))});
const three=select([{value:'all',label:'全部平台',hint:'两个平台同时检索',selected:true},{value:'sketchfab',label:'Sketchfab'},{value:'artstation',label:'ArtStation Marmoset'}]);

test('选项快照保留 value、文字、说明与选中态，顺序即索引',()=>{
 assert.deepEqual(readOptions(three),[
  {value:'all',label:'全部平台',hint:'两个平台同时检索',selected:true,index:0},
  {value:'sketchfab',label:'Sketchfab',hint:'',selected:false,index:1},
  {value:'artstation',label:'ArtStation Marmoset',hint:'',selected:false,index:2},
 ]);
});

test('打开菜单时高亮当前选中项；没有选中项就落在第一项',()=>{
 assert.equal(selectedIndex(readOptions(three)),0);
 assert.equal(selectedIndex(readOptions(select([{value:'a',label:'A'},{value:'b',label:'B'}]))),0);
});

test('方向键到底要绕回，索引 -1 时向下落到首项、向上落到末项',()=>{
 assert.equal(moveIndex(0,'ArrowDown',3),1);
 assert.equal(moveIndex(2,'ArrowDown',3),0,'末项再按向下要绕回第一项，不能卡住');
 assert.equal(moveIndex(0,'ArrowUp',3),2,'首项再按向上要绕回最后一项');
 assert.equal(moveIndex(-1,'ArrowDown',3),0);
 assert.equal(moveIndex(-1,'ArrowUp',3),2);
 assert.equal(moveIndex(1,'Home',3),0);
 assert.equal(moveIndex(1,'End',3),2);
 assert.equal(moveIndex(0,'PageDown',3),2,'翻页越过末尾时就停在末尾');
 assert.equal(moveIndex(2,'PageUp',3),0);
});

test('无选项与未知按键都不能把索引算坏',()=>{
 assert.equal(moveIndex(0,'ArrowDown',0),-1,'空列表没有可高亮的项');
 assert.equal(moveIndex(2,'F5',3),2);
 assert.equal(moveIndex(-1,'F5',3),0,'没有高亮时按无关按键，只是补上默认高亮');
});

test('打字定位从当前项的下一个开始找，并可以绕回',()=>{
 const options=readOptions(select([{value:'1',label:'全部平台'},{value:'2',label:'Blender'},{value:'3',label:'ArtStation'}]));
 assert.equal(typeahead(options,'全',-1),0,'中文标签也按包含匹配');
 assert.equal(typeahead(options,'A',-1),2,'大小写不该影响定位');
 assert.equal(typeahead(options,'l',-1),1);
 assert.equal(typeahead(options,'a',2),2,'只有自己匹配时保持不动，不要跳到别人身上');
 assert.equal(typeahead(options,'b',2),1,'从末尾往后找不到要绕回前面');
 assert.equal(typeahead(options,'zzz',1),1,'没有匹配就保持原高亮');
 assert.equal(typeahead(options,'',1),1);
 assert.equal(typeahead([],'a',-1),-1);
});

test('哪些按键归菜单、哪些算打字，必须分清楚',()=>{
 for(const key of ['ArrowDown','ArrowUp','Home','End','PageDown','PageUp'])assert.equal(isMenuKey(key),true,key+' 是菜单导航键');
 for(const key of ['Enter','Escape','Shift','a'])assert.equal(isMenuKey(key),false,key+' 不该被当成导航键');
 assert.equal(isTypeaheadKey('a'),true);
 assert.equal(isTypeaheadKey('中'),true);
 assert.equal(isTypeaheadKey('Enter'),false,'Enter 要用来确认选择');
 assert.equal(isTypeaheadKey(' '),false,'空格要用来展开菜单');
 assert.equal(isTypeaheadKey('ArrowDown'),false);
});
