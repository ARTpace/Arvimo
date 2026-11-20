import test from 'node:test';
import assert from 'node:assert/strict';
import {PICTURE_SITES} from '../server/picture-sites.mjs';
const resolve=(url,options)=>PICTURE_SITES['500px'].resolve({url},options);
const photo=id=>({id:String(id),title:`Photo ${id}`,width:2000,height:1000,category:'landscape',urls:{size_1024:`https://img.test/photo/${id}/image.jpg?s=2&sig=KEEP`,size_600:`https://img.test/photo/${id}/small.jpg?s=1&sig=KEEP`},uploader:{username:'alice',displayName:'Alice'}});
const user=async()=>({getUser:{id:'user1',username:'alice',displayName:'Alice'}});
test('500px home variants preserve filters, cursor, deduplication and signed item fields',async()=>{
 for(const fresh of [false,true]) {
  const calls=[];const signal=new AbortController().signal;
  const url=`https://500px.com/${fresh?'fresh':'editors'}?categories=landscape,bad&equipments=PHONE,bad&quality=1`;
  const result=await resolve(url,{signal,queryPhoto:async(query,vars,op,s)=>{
   assert.equal(s,signal);assert.ok(query.includes('category'));assert.equal(op,fresh?'freshResources':'editorsChoices');calls.push(vars);
   const node=fresh?photo(1):{resource:photo(1)};
   return {[op]:{edges:[{node,cursor:'next'},{node,cursor:'next'}]}};
  }});
  const filters=fresh?{categories:['landscape'],equipments:['PHONE'],qualityEnabled:true}:{categories:['landscape']};
  assert.deepEqual(calls,[{first:24,after:null,...filters},{first:24,after:'next',...filters}]);
  const item={url:photo(1).urls.size_1024,thumb:photo(1).urls.size_600,title:'Photo 1',width:1024,height:512,author:'Alice',authorUrl:'https://500px.com/alice',pageUrl:'https://500px.com/photo/1',tags:['landscape'],category:'landscape'};
  assert.deepEqual(result,{items:[item],skipped:[],title:`500px · ${fresh?'最新上架':'编辑精选'}`,author:'500px',cover:item.url,source:url,rendition:'original'});
 }
});
test('500px user list keeps profile lookup, pageInfo, twenty-page ceiling and quantity limit',async()=>{
 let calls=0;const signal=new AbortController().signal;
 const result=await resolve('https://500px.com/alice',{signal,queryUser:async(body,s)=>{assert.equal(s,signal);assert.deepEqual(body.variables,{username:'alice'});return user();},queryPhoto:async(_,vars,op)=>{
  assert.equal(op,'pageResources');assert.deepEqual(vars,{userId:'user1',first:50,after:calls?String(calls):null});calls++;
  return {pageResources:{edges:[{node:photo(calls)}],pageInfo:{hasNextPage:true,endCursor:String(calls)}}};
 }});
 assert.equal(calls,20);assert.equal(result.items.length,20);assert.equal(result.authorUrl,'https://500px.com/alice');assert.equal(result.title,'500px · Alice');
 const limited=await resolve('https://500px.com/alice',{maxItems:1,queryUser:user,queryPhoto:async()=>({pageResources:{edges:[{node:photo(1)},{node:photo(2)}],pageInfo:{hasNextPage:true,endCursor:'x'}}})});assert.equal(limited.items.length,1);
 for(const info of [{hasNextPage:false,endCursor:'x'},{hasNextPage:true},{}]) {
  calls=0;await resolve('https://500px.com/alice',{queryUser:user,queryPhoto:async()=>{calls++;return {pageResources:{edges:[{node:photo(1)}],pageInfo:info}};}});assert.equal(calls,1);
 }
});
test('500px both list families throw on later errors and preserve zero/empty behavior',async()=>{
 for(const url of ['https://500px.com/','https://500px.com/alice']) {
  const home=url.endsWith('/');const error=new Error('failure');
  for(const failAt of [1,2]) {
   let calls=0;await assert.rejects(resolve(url,{queryUser:user,queryPhoto:async(_,vars,op)=>{
    if(++calls===failAt)throw error;
    return {[op]:{edges:[{node:home?{resource:photo(1)}:photo(1),cursor:'x'}],pageInfo:{hasNextPage:true,endCursor:'x'}}};
   }}),e=>e===error);
  }
  await assert.rejects(resolve(url,{maxItems:0,queryUser:user,queryPhoto:async()=>{throw Error('must not request');}}),/没有/);
  await assert.rejects(resolve(url,{queryUser:user,queryPhoto:async()=>({})}),/没有/);
 }
 let calls=0;const capped=await resolve('https://500px.com/',{queryPhoto:async(_,vars,op)=>{calls++;return {[op]:{edges:[{node:{resource:photo(calls)},cursor:String(calls)}]}};}});assert.equal(capped.items.length,10);
});
test('500px single photo retains numeric/node operations and signed URLs',async()=>{
 for(const id of ['123456','abc_X']) {
  const result=await resolve(`https://500px.com/photo/${id}`,{queryPhoto:async(_,vars,op)=>{assert.equal(op,id==='123456'?'getPhotoByLegacyId':'getPhotoById');assert.deepEqual(vars,id==='123456'?{legacyId:id}:{id});return {[op]:photo(1)};}});
  assert.equal(result.items[0].url,photo(1).urls.size_1024);assert.equal(result.source,`https://500px.com/photo/${id}`);
 }
});
