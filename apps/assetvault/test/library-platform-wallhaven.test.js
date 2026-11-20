import test from 'node:test';
import assert from 'node:assert/strict';
import {PICTURE_SITES} from '../server/picture-sites.mjs';
const resolve=(url,options)=>PICTURE_SITES.wallhaven.resolve({url},options);
const photo=(id,extra={})=>({id,path:`https://w.wallhaven.cc/full/${id}.jpg`,thumbs:{small:`https://th.wallhaven.cc/${id}.jpg`},dimension_x:1920,dimension_y:1080,category:'general',...extra});
test('Wallhaven follows live current_page/last_page metadata and stops at the last page',async()=>{
 const pages=[];
 const result=await resolve('landscape',{readJson:async api=>{
  const page=Number(new URL(api).searchParams.get('page'));pages.push(page);
  return {data:[photo(String(page))],meta:{current_page:page,last_page:3,next_page:true}};
 }});
 assert.deepEqual(pages,[1,2,3]);assert.equal(result.items.length,3);
});
test('Wallhaven entry points preserve requests, filtering and complete metadata',async()=>{
 for(const [url,q] of [['city night','city night'],['https://wallhaven.cc/search?q=city%20night','city night'],['https://wallhaven.cc/','']]) {
  const calls=[];const signal=new AbortController().signal;
  const result=await resolve(url,{signal,readJson:async(api,options)=>{
   assert.equal(options.signal,signal);assert.equal(options.headers.Referer,'https://wallhaven.cc/');calls.push(api);
   return calls.length===1?{data:[photo('a'),photo('a'),{id:'missing'}],meta:{next_page:'ignored-url'}}:{data:[photo('b',{thumbs:{large:'large.jpg'},url:'https://wallhaven.cc/w/custom'})]};
  }});
  assert.deepEqual(calls,[1,2].map(page=>`https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(q)}&page=${page}`));
  const item={url:'https://w.wallhaven.cc/full/a.jpg',thumb:'https://th.wallhaven.cc/a.jpg',title:q||'Wallhaven',width:1920,height:1080,pageUrl:'https://wallhaven.cc/w/a',tags:q?['general',q]:['general'],category:'general'};
  assert.deepEqual(result,{items:[item,{...item,url:'https://w.wallhaven.cc/full/b.jpg',thumb:'large.jpg',pageUrl:'https://wallhaven.cc/w/custom'}],skipped:[],title:q||'Wallhaven',author:'Wallhaven',cover:item.url,source:url,rendition:'original'});
 }
});
test('Wallhaven retains whole-page overflow, zero limit, filtered pages and page cap',async()=>{
 let calls=0;
 const result=await resolve('nature',{maxItems:1,readJson:async()=>{calls++;return {data:[photo('a'),photo('b')],meta:{next_page:true}};}});
 assert.equal(result.items.length,2);assert.equal(calls,1);
 await assert.rejects(resolve('nature',{maxItems:0,readJson:async()=>{throw Error('must not request');}}),/没有返回任何图片/);
 calls=0;
 const filtered=await resolve('nature',{readJson:async()=>({data:++calls===1?[{id:'missing'}]:[photo('a')],meta:{next_page:calls===1}})});
 assert.equal(filtered.items.length,1);assert.equal(calls,2);
 calls=0;
 const cap=await resolve('nature',{readJson:async()=>({data:[photo(String(++calls))],meta:{next_page:true}})});
 assert.equal(cap.items.length,10);assert.equal(calls,10);
 await assert.rejects(resolve('nature',{readJson:async()=>({data:[]})}),/关键词「nature」/);
});
test('Wallhaven retains initial errors and partial results after empty or failed pages',async()=>{
 const error=new Error('request failed');
 await assert.rejects(resolve('nature',{readJson:async()=>{throw error;}}),e=>e===error);
 for(const empty of [false,true]) {
  let calls=0;
  const result=await resolve('nature',{readJson:async()=>{if(++calls===2){if(empty)return {data:[]};throw error;}return {data:[photo('a')],meta:{next_page:true}};}});
  assert.equal(result.items.length,1);assert.equal(calls,2);
 }
});
