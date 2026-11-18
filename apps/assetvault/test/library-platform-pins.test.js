import test from 'node:test';
import assert from 'node:assert/strict';
import {readPins,writePins,togglePin,sortByPins} from '../src/library/platform-pins.js';

const store = (initial=null) => {
  let value=initial;
  return {getItem:()=>value,setItem:(_k,v)=>{value=v;}};
};

test('readPins：空存储 / 非数组 / 脏数据都退化成空列表',()=>{
 assert.deepEqual(readPins(store(null)),[]);
 assert.deepEqual(readPins(store('{}')),[]);
 assert.deepEqual(readPins(store('not json')),[]);
});

test('readPins：只收字符串 id、去重、保序',()=>{
 assert.deepEqual(readPins(store('["sketchfab","artstation","sketchfab",7,null,""]')) ,['sketchfab','artstation']);
});

test('writePins：写回后能读回，去重；不改动入参',()=>{
 const s=store();
 const list=['fab','sketchfab','fab'];
 writePins(list,s);
 assert.deepEqual(readPins(s),['fab','sketchfab']);
 assert.deepEqual(list,['fab','sketchfab','fab']);
});

test('writePins：存储抛异常时静默失败，不冒泡',()=>{
 const bad={getItem:()=>null,setItem:()=>{throw new Error('quota');}};
 assert.doesNotThrow(()=>writePins(['fab'],bad));
});

test('togglePin：新增追加到末尾，再点取消，非法 id 不变',()=>{
 assert.deepEqual(togglePin([],'fab'),['fab']);
 assert.deepEqual(togglePin(['sketchfab'],'fab'),['sketchfab','fab']);
 assert.deepEqual(togglePin(['sketchfab','fab'],'sketchfab'),['fab']);
 assert.deepEqual(togglePin(['fab'],''),['fab']);
 assert.deepEqual(togglePin(['fab'],null),['fab']);
});

test('sortByPins：firstId 永远第一且不参与置顶',()=>{
 const items=[{id:'sketchfab'},{id:'all'},{id:'fab'}];
 assert.deepEqual(sortByPins(items,['fab'],'all').map(x=>x.id),['all','fab','sketchfab']);
 // 即使把 firstId 写进 pins 也不动它的位置
 assert.deepEqual(sortByPins(items,['all'],'all').map(x=>x.id),['all','sketchfab','fab']);
});

test('sortByPins：置顶项按 pins 顺序在前，未置顶保持原相对顺序',()=>{
 const items=[{id:'all'},{id:'a'},{id:'b'},{id:'c'},{id:'d'}];
 const ordered=sortByPins(items,['c','a'],'all').map(x=>x.id);
 assert.deepEqual(ordered,['all','c','a','b','d']);
 // 纯函数：入参未被改动
 assert.deepEqual(items.map(x=>x.id),['all','a','b','c','d']);
});

test('sortByPins：置顶列表里已不存在的 id 不影响顺序',()=>{
 const items=[{id:'all'},{id:'a'},{id:'b'}];
 assert.deepEqual(sortByPins(items,['ghost'],'all').map(x=>x.id),['all','a','b']);
});

test('sortByPins：当前选中平台紧随 firstId 之后，排到置顶项前面',()=>{
 const items=[{id:'all'},{id:'a'},{id:'b'},{id:'c'},{id:'flickr'}];
 // 选中 flickr，即使 c 已置顶，flickr 也排在 c 之前
 assert.deepEqual(sortByPins(items,['c'],'all','flickr').map(x=>x.id),['all','flickr','c','a','b']);
});

test('sortByPins：currentId 为空或等于 firstId 时退回纯置顶顺序',()=>{
 const items=[{id:'all'},{id:'a'},{id:'b'},{id:'c'}];
 assert.deepEqual(sortByPins(items,['b'],'all','').map(x=>x.id),['all','b','a','c']);
 assert.deepEqual(sortByPins(items,['b'],'all','all').map(x=>x.id),['all','b','a','c']);
});

test('sortByPins：选中项已置顶时只出现一次且位置最靠前',()=>{
 const items=[{id:'all'},{id:'a'},{id:'b'},{id:'c'}];
 assert.deepEqual(sortByPins(items,['c','b'],'all','c').map(x=>x.id),['all','c','b','a']);
});
