import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantDownloads} from '../src/library/assistant-downloads.js';

const job=(id,state)=>({id,state});
test('initial snapshot is silent; queued batch starts once, not once per execution stage',()=>{
 const events=[],accept=createAssistantDownloads(event=>events.push(event));
 accept([job('old','saved')]);assert.deepEqual(events,[]);
 accept([job('a','queued'),job('b','queued')]);
 accept([job('a','running'),job('b','held')]);
 accept([job('a','saving'),job('b','retry_wait')]);
 assert.deepEqual(events,[{type:'download',phase:'started',count:2}]);
});
test('batch completion counts merge across polls; repeated snapshots stay silent',()=>{
 const events=[],accept=createAssistantDownloads(event=>events.push(event));
 accept([job('a','running'),job('b','running')]);
 accept([job('a','saved'),job('b','running')]);
 accept([job('a','saved'),job('b','saved')]);
 accept([job('a','saved'),job('b','saved')]);
 assert.deepEqual(events.map(e=>[e.phase,e.count]),[['completed',1],['completed',2]]);
});
test('failure is observed once; retry starts again and cancellation is not completion',()=>{
 const events=[],accept=createAssistantDownloads(event=>events.push(event));
 accept([job('a','running')]);accept([job('a','failed')]);accept([job('a','failed')]);
 accept([job('a','queued')]);accept([job('a','cancelling')]);accept([job('a','cancelled')]);
 assert.deepEqual(events.map(e=>e.phase),['failed','started']);
});
