import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8');
const start=app.indexOf('async function enqueueImmediate(');
const source=app.slice(start,app.indexOf('\nasync function requestDownload(',start));

test('download submits before repainting cards and collects only after acceptance',async()=>{
 const events=[],model={uid:'a'.repeat(32),platform:'artstation'};
 let accept;
 const state={models:[],options:{},selected:new Set()};
 const context=vm.createContext({
  state,queuePulse:new Map(),artstation:{maxBatch:10},
  jobKindOf:()=> 'artstation',toast:()=>{},
  downloads:{enqueue:()=>{events.push('enqueue');return new Promise(resolve=>accept=resolve);}},
  collectModels:()=>{events.push('collect');return {models:[model]};},
  persist:()=>{},renderGrid:()=>events.push('render'),counts:()=>{},
 });
 vm.runInContext(source,context);
 const pending=context.enqueueImmediate([model]);
 assert.deepEqual(events,['enqueue'],'UI painting must not block submission');
 assert.equal(state.models.length,0,'unaccepted assets must not be collected');
 accept({added:['job'],duplicates:[]});
 await pending;
 assert.deepEqual(events,['enqueue','collect','render']);
});

test('live image polling includes the local request header',async()=>{
 const calls=[];
 const context=vm.createContext({
  pollRunning:false,pollTimer:null,pollSteady:false,liveImageKey:'',
  document:{hidden:false},schedulePoll:()=>{},
  fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({jobs:[]})};},
 });
 const pollStart=app.indexOf('async function runPoll(){');
 vm.runInContext(app.slice(pollStart,app.indexOf('\nschedulePoll();',pollStart)),context);
 await context.runPoll();
 assert.equal(calls[0].url,'/api/downloads');
 assert.equal(calls[0].options.headers['X-SFX-Local'],'1');
});

test('model downloads never send collection and library settings in their options',async()=>{
 for(const kind of ['artstation','sketchfab']){
  let sent;
  const context=vm.createContext({
   state:{models:[],selected:new Set(),options:{packMode:'full',maxTextureEdge:2048,cardGroups:[{summary:'x'.repeat(70000)}],customCategories:['private']}},
   queuePulse:new Map(),artstation:{maxBatch:10},jobKindOf:()=>kind,toast:()=>{},
   downloads:{enqueue:async(models,options)=>{sent=options;return {added:['job'],duplicates:[]};}},
   collectModels:()=>({models:[]}),persist:()=>{},renderGrid:()=>{},counts:()=>{},
  });
  vm.runInContext(source,context);
  await context.enqueueImmediate([{uid:'a'.repeat(32),platform:kind}]);
  assert.equal(sent.cardGroups,undefined,kind);
  assert.equal(sent.customCategories,undefined,kind);
  assert.equal(sent.packMode,'full');
  assert.equal(sent.maxTextureEdge,2048);
  assert.ok(JSON.stringify(sent).length<1024);
 }
});
