import test from 'node:test';
import assert from 'node:assert/strict';
import {listPager} from '../server/platform-driver.mjs';
const run = options => listPager({initialState:1,maxPages:10,fetchPage:async state=>state,consume:()=>{},nextState:()=>null,isLimitReached:()=>false,...options});
test('page and cursor state are adapter-owned; empty pages can end the source',async()=>{
  const calls=[];
  assert.deepEqual(await run({fetchPage:async state=>{calls.push(state);return state;},nextState:state=>state===3?null:state+1}),{reason:'source-end',pages:3});
  assert.deepEqual(calls,[1,2,3]);
  const cursors=[];
  await run({initialState:null,fetchPage:async state=>{cursors.push(state);return state===null?'token':null;},nextState:response=>response});
  assert.deepEqual(cursors,[null,'token']);
});
test('quantity and page ceilings are not source exhaustion',async()=>{
  let count=0;
  assert.deepEqual(await run({consume:()=>count++,isLimitReached:()=>count===2,nextState:state=>state+1}),{reason:'item-limit',pages:2});
  assert.deepEqual(await run({maxPages:2,nextState:state=>state+1}),{reason:'page-limit',pages:2});
  assert.deepEqual(await run({maxPages:Infinity,nextState:state=>state===12?null:state+1}),{reason:'source-end',pages:12});
});
test('first errors throw; subsequent errors follow explicit policy and retain cause',async()=>{
  const error=new Error('failure');
  await assert.rejects(run({partialOnError:true,fetchPage:async()=>{throw error;}}),e=>e===error);
  for(const partialOnError of [false,true]) {
    const request=run({partialOnError,fetchPage:async state=>{if(state===2)throw error;return state;},nextState:state=>state+1});
    if(partialOnError) assert.deepEqual(await request,{reason:'partial-error',pages:1,error});
    else await assert.rejects(request,e=>e===error);
  }
});
test('filtered pages and repeated cursors follow adapter policy rather than implicit guards',async()=>{
  let requests=0;
  assert.deepEqual(await run({initialState:'same',maxPages:3,fetchPage:async()=>{requests++;return [];},nextState:()=> 'same'}),{reason:'page-limit',pages:3});
  assert.equal(requests,3);
  assert.deepEqual(await run({initialState:'same',fetchPage:async state=>state,nextState:(response,state)=>response===state?null:response}),{reason:'source-end',pages:1});
});

test('consumer receives current state without swallowing mapping errors',async()=>{
 const state={page:0,cursor:''};const error=new Error('mapping failed');
 await assert.rejects(run({initialState:state,partialOnError:true,consume:(response,current)=>{assert.equal(current,state);throw error;}}),e=>e===error);
});
