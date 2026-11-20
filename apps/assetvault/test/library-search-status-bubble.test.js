import test from 'node:test';
import assert from 'node:assert/strict';
import {createStatusRotation,compactSearchStatus} from '../src/library/search-status-bubble.js';
test('long search details become concise bubble copy',()=>{
 assert.equal(compactSearchStatus('“木板材质” → wood plank material + plywood material'),'关键词已翻译，正在搜索');
 assert.equal(compactSearchStatus('AI 解析：类型=模型，主题=木板'),'搜索条件已解析');
 assert.equal(compactSearchStatus('正在翻译中文关键词…'),'正在翻译中文关键词…');
 assert.ok(compactSearchStatus('长'.repeat(100)).length<=44);
});

test('status messages rotate every two seconds, deduplicate, and stop when cleared',()=>{
 const seen=[];let callback,delay,cleared=0;
 const rotation=createStatusRotation({publish:text=>seen.push(text),clear:()=>cleared++,setTimer:(fn,ms)=>{callback=fn;delay=ms;return 1;},clearTimer:()=>{callback=null;}});
 rotation.update(['翻译中','检索中','翻译中']);
 assert.deepEqual(seen,['翻译中']);assert.equal(delay,2000);
 callback();assert.deepEqual(seen,['翻译中','检索中']);
 rotation.update(['翻译中','检索中']);
 callback();assert.equal(seen.at(-1),'翻译中');
 rotation.update(['检索中']);assert.equal(callback,null);
 rotation.update([]);assert.equal(cleared,1);assert.equal(callback,null);
 rotation.dispose();
});
