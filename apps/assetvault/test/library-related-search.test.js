import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelatedSearch} from '../src/library/related-search.js';

test('related terms reuse expansion, filter duplicates/current query and cache submitted phrases',async()=>{
 let calls=0;const related=createRelatedSearch({expand:async()=>{calls++;return {expansions:['boat','Ship','ship','sailboat','https://invalid']};}});
 assert.deepEqual((await related('boat')).terms,['ship','sailboat']);
 await related(' BOAT ');assert.equal(calls,1);
 assert.deepEqual((await related('https://example.com')).terms,[]);assert.equal(calls,1);
});
test('Chinese queries reuse combined translation and expansion',async()=>{
 const related=createRelatedSearch({translate:async(query,options)=>{assert.equal(query,'船');assert.equal(options.expand,true);return {english:'boat',expansions:['ship','sailboat']};}});
 assert.deepEqual((await related('船')).terms,['boat','ship','sailboat']);
});
test('unavailable suggestions expose reason and can retry without cached failure',async()=>{
 let calls=0;const related=createRelatedSearch({expand:async()=>{calls++;return {expansions:[],reason:'AI 未启用'};}});
 assert.equal((await related('boat')).reason,'AI 未启用');await related('boat');assert.equal(calls,2);
});
