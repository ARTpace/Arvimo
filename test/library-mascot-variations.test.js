import test from 'node:test';
import assert from 'node:assert/strict';
import {MASCOT_VARIATIONS,createMascotVariations} from '../src/library/mascot-variations.js';
import {MASCOT_EXPRESSIONS,MASCOT_EFFECTS} from '../src/library/mascot-assistant.js';
import {MASCOT_MOTIONS,MASCOT_SCENE_MOTIONS} from '../src/library/mascot-motions.js';

test('each scene has valid combinations; every round covers all with no adjacent repeat',()=>{
 for(const [scene,options] of Object.entries(MASCOT_VARIATIONS)){
  assert.ok(options.length>=4);assert.equal(new Set(options.map(value=>JSON.stringify(value))).size,options.length);
  for(const [expression,effect] of options){assert.ok(MASCOT_EXPRESSIONS[expression]);assert.ok(MASCOT_EFFECTS[effect]);}
  for(const random of [()=>0,()=>.999,Math.random]){
   const choose=createMascotVariations(random);let previous;
   for(let round=0;round<5;round++){
    const seen=new Set();for(let i=0;i<options.length;i++){const result=choose(scene),next=JSON.stringify([result.expression,result.effect]);assert.ok(MASCOT_MOTIONS[result.motion]);assert.ok(MASCOT_SCENE_MOTIONS[scene].includes(result.motion));assert.notEqual(next,previous);seen.add(next);previous=next;}
    assert.equal(seen.size,options.length);
   }
  }
 }
});
test('click greetings offer twelve looks with gentle body motions',()=>{
 assert.equal(MASCOT_VARIATIONS.greeting.length,12);
 assert.ok(MASCOT_SCENE_MOTIONS.greeting.every(motion=>['nod','tilt','ears','sway','peek','duck','stretch'].includes(motion)));
});
test('polling a stable update phase retains its combination without consuming the next choice',()=>{
 const choose=createMascotVariations(()=>0),first=choose('update:downloading','v1');
 assert.deepEqual(choose('update:downloading','v1'),first);
 assert.notDeepEqual(choose('update:downloading','v2'),first);
 assert.deepEqual(choose('unknown'),{});
});
