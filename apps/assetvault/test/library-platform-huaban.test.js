import test from 'node:test';
import assert from 'node:assert/strict';
import {PICTURE_SITES} from '../server/picture-sites.mjs';
const resolve=(url,options)=>PICTURE_SITES.huaban.resolve({url},options);
const pin=id=>({pin_id:id,user_id:7,file:{key:`key${id}`,type:'image/jpeg',width:800,height:600},raw_text:'#nature',link:'https://example.com/item'});
const pins=(start=1)=>Array.from({length:100},(_,i)=>pin(start+i));
const board={title:'Board',user:{user_id:7,username:'Alice',urlname:'alice'}};
test('Huaban board pins preserve max cursor, signed images, metadata and duplicate filtering',async()=>{
 const calls=[];const signal=new AbortController().signal;
 const first=pins();first[0].file.url='https://gd-hbimg-edge.huaban.com/key1?auth_key=KEEP';
 const result=await resolve('https://huaban.com/boards/123',{signal,readJson:async(api,options)=>{assert.equal(options.signal,signal);calls.push(api);return calls.length===1?{pins:first,board}:{pins:[pin(100),pin(101)],board:{title:'ignored'}};}});
 assert.deepEqual(calls,['https://api.huaban.com/v3/boards/123/pins?limit=100','https://api.huaban.com/v3/boards/123/pins?limit=100&max=100']);assert.equal(result.items.length,101);
 assert.deepEqual(result.items[0],{url:'https://gd-hbimg-edge.huaban.com/key1?auth_key=KEEP',thumb:'https://gd-hbimg.huaban.com/key1_fw480',title:'#nature',width:800,height:600,author:'Alice',authorUrl:'https://huaban.com/user/alice',pageUrl:'https://huaban.com/pins/1',sourceUrl:'https://example.com/item',tags:['Board','example.com','nature'],board:'Board',hashtags:['nature'],sourceHost:'example.com'});
 assert.equal(result.title,'Board');assert.equal(result.author,'Alice');assert.equal(result.authorUrl,'https://huaban.com/user/alice');assert.equal(result.source,'https://huaban.com/boards/123');assert.deepEqual(result.skipped,[]);assert.equal(result.cover,result.items[0].url);
});
test('Huaban search keeps page requests, three-page ceiling, repeated-page stop and quantity semantics',async()=>{
 for(const url of ['nature','https://huaban.com/search?q=nature']) {
  let calls=0;const result=await resolve(url,{readJson:async api=>{assert.equal(api,`https://api.huaban.com/v3/search/pins?q=nature&per_page=100&page=${++calls}`);return {pins:[pin(calls)]};}});assert.equal(calls,3);assert.equal(result.items.length,3);
 }
 let calls=0;const duplicate=await resolve('nature',{readJson:async()=>{calls++;return {pins:[pin(1)]};}});assert.equal(calls,2);assert.equal(duplicate.items.length,1);
 for(const maxItems of [0,1,101]) {
  calls=0;const result=await resolve('nature',{maxItems,readJson:async()=>({pins:pins(1+100*calls++)})});assert.equal(result.items.length,maxItems===0?1:maxItems);assert.equal(calls,maxItems===101?2:1);
 }
});
test('Huaban filters invalid media and throws on first or later request/API failures',async()=>{
 const error=new Error('failure');
 for(const url of ['nature','https://huaban.com/boards/123']) {
  for(const failAt of [1,2]) {
   let calls=0;await assert.rejects(resolve(url,{readJson:async()=>{if(++calls===failAt)throw error;return {pins:pins()};}}),e=>e===error);
  }
  await assert.rejects(resolve(url,{readJson:async()=>({err:403,msg:'private'})}),/private/);
  await assert.rejects(resolve(url,{readJson:async()=>({pins:[{file:{key:'bad/key'}},{file:{key:'video',type:'video/mp4'}}]})}),/没有|没有可抓取/);
 }
});
const card=id=>({board_id:id,title:`Board ${id}`,pin_count:1,seq:id,pins:[pin(id)]});
test('Huaban board discovery keeps profile routes, seq cursor, empty filtering and board-only result',async()=>{
 for(const url of ['https://huaban.com/user/alice','https://huaban.com/u/7']) {
  const calls=[];const result=await resolve(url,{readProfile:async(name)=>{assert.equal(name,'alice');return {user:{user_id:7,username:'Alice',urlname:'alice'}};},readJson:async api=>{
   calls.push(api);if(api.endsWith('/users/7'))return {user_id:7,username:'Alice',urlname:'alice'};
   return {boards:calls.filter(x=>x.includes('/boards?')).length===1?Array.from({length:100},(_,i)=>card(i+1)):[card(100),card(101),{board_id:102,pin_count:0}]};
  }});
  assert.ok(calls.includes('https://api.huaban.com/v3/users/7/boards?limit=100&max=100'));assert.equal(result.mode,'boards');assert.deepEqual(result.items,[]);assert.equal(result.boards.length,101);assert.deepEqual(result.user,{id:'7',name:'Alice',urlname:'alice'});assert.equal(result.boards[0].thumb,'https://gd-hbimg.huaban.com/key1_fw236');
 }
});
test('Huaban board discovery stops on repeat, respects twenty-page ceiling and propagates errors',async()=>{
 const options={readProfile:async()=>({user:{user_id:7}})};
 let calls=0;const result=await resolve('https://huaban.com/alice',{...options,readJson:async()=>{calls++;return {boards:Array.from({length:100},(_,i)=>card(i+1))};}});assert.equal(calls,2);assert.equal(result.boards.length,100);
 calls=0;await resolve('https://huaban.com/alice',{...options,readJson:async()=>({boards:Array.from({length:100},(_,i)=>card(++calls))})});assert.equal(calls,2000);
 const error=new Error('failure');let pages=0;
 await assert.rejects(resolve('https://huaban.com/alice',{...options,readJson:async()=>{if(++pages===2)throw error;return {boards:Array.from({length:100},(_,i)=>card(i+1))};}}),e=>e===error);
});
test('Huaban mine lists followed boards and followed users, and asks for login',async()=>{
 const me={urlname:'alice',username:'Alice',user_id:7};
 const calls=[];
 const result=await resolve('https://huaban.com/me/boards',{readJson:async api=>{
  calls.push(api);
  if(api.endsWith('/users/me'))return {user:me};
  return {boards:[card(9)]};
 }});
 assert.deepEqual(calls,['https://api.huaban.com/v3/users/me','https://api.huaban.com/v3/alice/following/boards?per_page=100&page=1']);
 assert.equal(result.mode,'boards');
 assert.equal(result.boards[0].url,'https://huaban.com/boards/9');
 const people=await resolve('https://huaban.com/me/following',{readJson:async api=>{
  if(api.endsWith('/users/me'))return me;
  return {users:[{user_id:8,username:'Bob',urlname:'bob',board_count:3,seq:1,avatar:{key:'ava',bucket:'hbimg'}}]};
 }});
 assert.equal(people.boards[0].url,'https://huaban.com/user/bob');
 assert.equal(people.boards[0].unit,'个画板');
 assert.equal(people.boards[0].count,3);
 await assert.rejects(resolve('https://huaban.com/me/boards',{readJson:async()=>({err:404,msg:'用户不存在'})}),/请先登录花瓣/);
});
