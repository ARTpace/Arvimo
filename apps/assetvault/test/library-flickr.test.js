import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../server/picture-sites.mjs',import.meta.url),'utf8');
const start=source.indexOf('const resolveFlickr =');
const resolverSource=source.slice(start,source.indexOf('// 500px',start));

test('Flickr author paging passes 1000 photos and stops at the actual last page',async()=>{
 const pages=[];
 const resolver=vm.runInNewContext(`${resolverSource};resolveFlickr`,{
  URL,MAX_PAGES:10,FLICKR_EXTRAS:'',
  flickrItem:p=>({url:p.id}),
  flickrCall:async(method,params)=>{
   assert.equal(method,'flickr.people.getPhotos');
   const page=Number(params.page);pages.push(page);
   return {photos:{pages:23,photo:Array.from({length:page===23?17:100},(_,i)=>({id:String((page-1)*100+i)}))}};
  },
 });
 const result=await resolver.resolve({url:'https://www.flickr.com/photos/144312453@N08/'});
 assert.equal(result.items.length,2217);
 assert.equal(pages.length,23);
 pages.length=0;
 const preview=await resolver.resolve({url:'https://www.flickr.com/photos/144312453@N08/'},{maxItems:72});
 assert.equal(preview.items.length,72);
 assert.equal(pages.length,1,'first screen still fetches only one page');
});
