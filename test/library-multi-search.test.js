import test from 'node:test';
import assert from 'node:assert/strict';
import {splitSearchTerms,fetchSearchPage} from '../src/library/multi-search.js';
test('multiple phrases retain spaces, remove repeated terms, merge independent pagination',async()=>{
 assert.deepEqual(splitSearchTerms('wooden house，tree;wooden house'),['wooden house','tree']);
 const calls=[];
 const fetchImpl=async(_url,options)=>{
  const query=JSON.parse(options.body);calls.push(query);
  return {ok:true,status:200,json:async()=>({models:[{uid:query.q||'more'}],next:query.q==='tree'?'tree-page-2':null})};
 };
 const first=await fetchSearchPage('/search',{q:'wooden house, tree',category:'nature'},{fetchImpl});
 assert.equal(first.data.models.length,2);
 assert.equal(calls[0].category,'nature');
 await fetchSearchPage('/search',{cursor:first.data.next},{fetchImpl});
 assert.deepEqual(calls[2],{cursor:'tree-page-2'});
});
test('partial failures preserve results; Chinese terms translate separately; abort propagates',async()=>{
 const calls=[];
 const fetchImpl=async(_url,options)=>{
  const query=JSON.parse(options.body);calls.push(query.q);
  return {ok:query.q!=='broken',status:query.q==='broken'?500:200,json:async()=>query.q==='broken'?{error:'failed'}:{models:[{uid:'ok'}]}};
 };
 const result=await fetchSearchPage('/search',{q:'房子, broken'},{fetchImpl,translate:async query=>({translated:true,english:'house'})});
 assert.deepEqual(calls.sort(),['broken','house']);assert.equal(result.data.models.length,1);assert.deepEqual(result.data.warnings,['failed']);
 await assert.rejects(fetchSearchPage('/search',{q:'a,b,c,d,e,f,g,h,i'},{fetchImpl}),/8/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(fetchSearchPage('/search',{q:'a,b'},{signal:controller.signal,fetchImpl:async()=>{throw Error('cancelled');}}));
});
