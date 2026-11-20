import test from 'node:test';
import assert from 'node:assert/strict';
import {PICTURE_SITES} from '../server/picture-sites.mjs';
const resolve=(url,options)=>PICTURE_SITES.flickr.resolve({url},options);
const photo=id=>({id:String(id),url_o:`https://img.test/${id}.jpg`,url_z:`https://img.test/${id}-small.jpg`,width_o:'2000',height_o:'1000',owner:'123@N01',pathalias:'alice',ownername:'Alice',title:`Photo ${id}`,tags:'nature'});
const full=()=>Array.from({length:100},(_,i)=>photo(i+1));
test('Flickr list routes preserve API methods, parameters and metadata',async()=>{
 for(const [url,method,extra] of [['nature','flickr.photos.search',{text:'nature',sort:'relevance'}],['https://www.flickr.com/search/?tags=nature,city','flickr.photos.search',{tags:'nature,city',tag_mode:'any',sort:'interestingness-desc'}],['https://www.flickr.com/explore','flickr.interestingness.getList',{}],['https://www.flickr.com/people/123@N01/','flickr.people.getPhotos',{user_id:'123@N01'}],['https://www.flickr.com/photos/alice/albums/777/','flickr.photosets.getPhotos',{photoset_id:'777'}]]) {
  const calls=[];const signal=new AbortController().signal;
  const result=await resolve(url,{signal,callApi:async(m,p,s)=>{assert.equal(s,signal);calls.push([m,p]);if(m==='flickr.urls.lookupUser')return {user:{id:'123@N01'}};return {photos:{photo:[photo(1)],pages:1}};}});
  const [m,p]=calls.at(-1);assert.equal(m,method);for(const [key,value] of Object.entries(extra))assert.equal(p[key],value);
  assert.equal(p.page,'1');assert.equal(p.per_page,'100');assert.ok(p.extras.includes('url_o'));assert.equal(p.safe_search,method==='flickr.interestingness.getList'?undefined:'1');
  assert.deepEqual(result.items,[{url:'https://img.test/1.jpg',thumb:'https://img.test/1-small.jpg',title:'Photo 1',width:2000,height:1000,author:'Alice',authorUrl:'https://www.flickr.com/photos/alice/',pageUrl:'https://www.flickr.com/photos/alice/1',tags:['nature']}]);
  assert.equal(result.source,url);assert.equal(result.cover,'https://img.test/1-small.jpg');assert.equal(result.rendition,'original');assert.deepEqual(result.skipped,[]);
 }
});
test('Flickr pagination exceeds ten pages, deduplicates, truncates and stops on short pages',async()=>{
 let calls=0;
 const result=await resolve('nature',{callApi:async(_,p)=>{calls++;assert.equal(p.page,String(calls));return {photos:{photo:full().map(it=>({...it,id:`${calls}-${it.id}`})),pages:12}};}});
 assert.equal(calls,12);assert.equal(result.items.length,1200);
 calls=0;
 const limited=await resolve('nature',{maxItems:2,callApi:async()=>{calls++;return {photos:{photo:[photo(1),photo(1),{id:''},photo(2),photo(3)],pages:99}};}});
 assert.equal(calls,1);assert.deepEqual(limited.items.map(it=>it.title),['Photo 1','Photo 2']);
 await assert.rejects(resolve('nature',{maxItems:0,callApi:async()=>{throw Error('must not request');}}),/没有搜到/);
 calls=0;await resolve('nature',{callApi:async()=>{calls++;return {photos:{photo:[photo(1)],pages:99}};}});assert.equal(calls,1);
});
test('Flickr preserves album fallback, initial error wrapping and partial results',async()=>{
 const error=new Error('denied');
 const album='https://www.flickr.com/photos/alice/albums/777/';
 await assert.rejects(resolve(album,{callApi:async()=>{throw error;}}),/这个相册取不到图（777）：denied/);
 await assert.rejects(resolve('nature',{callApi:async()=>{throw error;}}),e=>e===error);
 const result=await resolve(album,{callApi:async method=>{if(method!=='flickr.photosets.getPhotos')throw error;return {photoset:{photo:[photo(1)],pages:1}};}});assert.equal(result.items.length,1);
 for(const empty of [false,true]) {
  let calls=0;const partial=await resolve('nature',{callApi:async()=>{if(++calls===2){if(empty)return {photos:{photo:[]}};throw error;}return {photos:{photo:full(),pages:3}};}});
  assert.equal(partial.items.length,100);assert.equal(calls,2);
 }
});
test('Flickr single photo routes keep size selection and optional metadata fallback',async()=>{
 for(const url of ['https://www.flickr.com/photos/alice/123456/','https://www.flickr.com/photo.gne?id=123456']) {
  const calls=[];const result=await resolve(url,{callApi:async(method,params)=>{calls.push(method);assert.equal(params.photo_id,'123456');if(method.endsWith('getInfo'))throw Error('private');return {sizes:{size:[{label:'Original',source:'original.jpg',width:'2000',height:'1000'},{label:'Medium 640',source:'small.jpg'}]}};}});
  assert.deepEqual(calls,['flickr.photos.getSizes','flickr.photos.getInfo']);assert.equal(result.items[0].url,'original.jpg');assert.equal(result.items[0].thumb,'small.jpg');assert.equal(result.items[0].pageUrl,url);assert.equal(result.items[0].width,2000);
 }
});
