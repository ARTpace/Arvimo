import test from 'node:test';
import assert from 'node:assert/strict';
import {PICTURE_SITES} from '../server/picture-sites.mjs';
const resolve = (id, url, options) => PICTURE_SITES[id].resolve({url}, options);
const photo = (id, extra = {}) => ({attributes:{id, alt:`Photo ${id}`, image:{download_link:`https://img.test/${id}.jpg`, medium:`https://img.test/${id}-small.jpg`}, user:{id:1234, slug:'alice-1234', first_name:'Alice', last_name:'Lee'}, slug:'landscape', width:1200, height:800, ...extra}});

test('Pexels list entry points preserve requests, filtering, order and complete metadata', async () => {
  for (const [url, base, keyword] of [['nature','/search/photos?query=nature',true],['https://www.pexels.com/search/nature/','/search/photos?query=nature',true],['https://www.pexels.com/@alice-1234/','/users/1234/photos',false],['https://www.pexels.com/1234/','/users/1234/photos',false]]) {
    const calls=[];
    const result=await resolve('pexels',url,{readJson:async path=>{
      calls.push(path);
      return {data:calls.length===1?[photo(1001),photo(1002,{status:'rejected'}),photo(1001),photo(0)]:[photo(1002)],pagination:{total_pages:2,total_results:160}};
    }});
    assert.deepEqual(calls,[`${base}${keyword ? "&" : "?"}per_page=80&page=1`,`${base}${keyword ? "&" : "?"}per_page=80&page=2`]);
    assert.deepEqual(result,{items:[1001,1002].map(id=>({url:`https://img.test/${id}.jpg`,thumb:`https://img.test/${id}-small.jpg`,title:`Photo ${id}`,width:1200,height:800,author:'Alice Lee',authorUrl:'https://www.pexels.com/@alice-1234/',pageUrl:`https://www.pexels.com/photo/landscape-${id}/`,tags:[]})),skipped:[],title:keyword?'Pexels · nature':'Pexels · Alice Lee',author:keyword?'Pexels':'Alice Lee',cover:'https://img.test/1001-small.jpg',source:url,rendition:'original'});
  }
});
test('Pexels single photo aliases keep original fallback and source',async()=>{
  for(const part of ['photo','photos']) {
    const url=`https://www.pexels.com/${part}/landscape-1001/`;
    const result=await resolve('pexels',url,{readJson:async path=>{assert.equal(path,'/photos/1001');return {data:photo(1001,{image:{}})};}});
    assert.equal(result.items[0].url,'https://images.pexels.com/photos/1001/pexels-photo-1001.jpeg?cs=srgb&fm=jpg');
    assert.equal(result.source,url);assert.equal(result.rendition,'original');
  }
});
test('Pexels quantity, page cap, total, empty pages and errors preserve behavior',async()=>{
  for(const [maxItems,pages,total,expected] of [[1,99,9999,1],[Infinity,99,9999,10],[Infinity,99,80,1],[Infinity,1,9999,1]]) {
    let calls=0;const result=await resolve('pexels','nature',{maxItems,readJson:async()=>({data:[photo(++calls)],pagination:{total_pages:pages,total_results:total}})});
    assert.equal(calls,expected);assert.equal(result.items.length,expected);
  }
  const error=new Error('request failed');
  await assert.rejects(resolve('pexels','nature',{readJson:async()=>{throw error;}}),e=>e===error);
  for(const empty of [false,true]) {
    let calls=0;const result=await resolve('pexels','nature',{readJson:async()=>{if(++calls===2){if(empty)return {data:[]};throw error;}return {data:[photo(1001)],pagination:{total_pages:3}};}});
    assert.equal(result.items.length,1);assert.equal(calls,2);
  }
  await assert.rejects(resolve('pexels','nature',{readJson:async()=>({data:[]})}),/没有搜到/);
});
const image={id:1,url:'https://image.civitai.com/original=true/a.jpg',username:'Alice',width:600,height:800,meta:{prompt:'landscape'},tags:['nature']};
test('Civitai cursor, whole-page overflow, duplicate retention and media metadata are preserved',async()=>{
  const calls=[];const url='https://civitai.com/user/Alice';
  const result=await resolve('civitai',url,{maxItems:3,readJson:async api=>{calls.push(api);return {items:calls.length===1?[image,{url:''}]:[image,{...image,id:2,type:'video',url:'https://image.civitai.com/original=true/b.mp4'}],metadata:{nextCursor:'next token'}};}});
  assert.deepEqual(calls,['https://civitai.com/api/v1/images?limit=100&username=Alice','https://civitai.com/api/v1/images?limit=100&username=Alice&cursor=next%20token']);
  const item={url:image.url,thumb:'https://image.civitai.com/width=450/a.jpg',play:'',title:'landscape',width:600,height:800,author:'Alice',authorUrl:'https://civitai.com/user/Alice',pageUrl:'https://civitai.com/images/1',tags:['nature']};
  assert.deepEqual(result,{items:[item,item,{...item,url:'https://image.civitai.com/original=true/b.mp4',thumb:'',play:'https://image.civitai.com/width=450/b.mp4',type:'video',pageUrl:'https://civitai.com/images/2'}],skipped:[],title:'Civitai · Alice',author:'Alice',cover:image.url,source:url,rendition:'original'});
  const overflow=await resolve('civitai',url,{maxItems:1,readJson:async()=>({items:[image,image],metadata:{nextCursor:'x'}})});
  assert.equal(overflow.items.length,2);
});
test('Civitai empty, initial zero limit, repeated cursor cap and request failures preserve behavior',async()=>{
  const error=new Error('request failed');
  await assert.rejects(resolve('civitai','https://civitai.com/',{readJson:async()=>{throw error;}}),e=>e===error);
  await assert.rejects(resolve('civitai','https://civitai.com/',{readJson:async()=>({items:[]})}),/没有返回任何图片/);
  for(const [maxItems,expected] of [[Infinity,10],[0,1]]) {
    let calls=0;const result=await resolve('civitai','https://civitai.com/images',{maxItems,readJson:async api=>{assert.ok(!api.includes('username='));calls++;return {items:[image],metadata:{nextCursor:'same'}};}});
    assert.equal(calls,expected);assert.equal(result.items.length,expected);
  }
  for(const empty of [false,true]) {
    let calls=0;const result=await resolve('civitai','https://civitai.com/',{readJson:async()=>{if(++calls===2){if(empty)return {items:[]};throw error;}return {items:[image],metadata:{nextCursor:'x'}};}});
    assert.equal(result.items.length,1);assert.equal(calls,2);
  }
});

test('image URL dispatch preserves video routes and options without requesting image lists',async()=>{
  for(const [id,videoId,paths] of [['pexels','pexels-video',['video','videos']],['civitai','civitai-video',['video','videos']]]) {
    const original=PICTURE_SITES[videoId].resolve;
    const signal=new AbortController().signal;
    const result={items:[{type:'video',url:'https://media.test/video.mp4'}]};
    try {
      PICTURE_SITES[videoId].resolve=async(args,options)=>{assert.equal(options.signal,signal);assert.equal(options.maxItems,7);assert.ok(paths.includes(new URL(args.url).pathname.split('/')[1]));return result;};
      for(const path of paths) assert.equal(await resolve(id,`https://${id}.com/${path}/`,{signal,maxItems:7,readJson:async()=>{throw new Error('must not request image list');}}),result);
    } finally {PICTURE_SITES[videoId].resolve=original;}
  }
});
test('request injection receives signal; abort errors preserve first/next-page policy',async()=>{
  for(const id of ['pexels','civitai']) {
    const signal=new AbortController().signal;
    const error=new DOMException('cancelled','AbortError');
    for(const failAt of [1,2]) {
      let calls=0;
      const request=resolve(id,id==='pexels'?'nature':'https://civitai.com/',{signal,readJson:async(_,options)=>{
        assert.equal(id==='pexels'?options:options.signal,signal);
        if(++calls===failAt)throw error;
        return id==='pexels'?{data:[photo(1001)],pagination:{total_pages:3}}:{items:[image],metadata:{nextCursor:'next'}};
      }});
      if(failAt===1)await assert.rejects(request,e=>e===error);
      else assert.equal((await request).items.length,1);
    }
  }
});
