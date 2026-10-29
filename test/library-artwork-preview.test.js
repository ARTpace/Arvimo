import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {collectImageAssets} from '../server/image-sources.mjs';
import {createLibraryView} from '../src/library/library-view.js';

test('artwork preview returns ordered full images and author details',async()=>{
 const project={title:'作品',description:'<p>作者说明</p>',user:{username:'artist',full_name:'Artist Name'},tags:['environment'],assets:[
  {id:2,position:2,asset_type:'image',image_url:'https://cdna.artstation.com/p/assets/images/images/000/000/002/large/artist-two.jpg',width:1000,height:800},
  {id:1,position:1,asset_type:'image',image_url:'https://cdna.artstation.com/p/assets/images/images/000/000/001/large/artist-one.jpg',width:800,height:1000}
 ]};
 const data=await collectImageAssets('artstation',{url:'https://www.artstation.com/artwork/abcd12'},{open:async()=>({status:200,stream:Readable.from([Buffer.from(JSON.stringify(project))])})});
 assert.equal(data.author,'Artist Name');
 assert.equal(data.authorUrl,'https://www.artstation.com/artist');
 assert.equal(data.description,'<p>作者说明</p>');
 assert.deepEqual(data.items.map(item=>item.id),['1','2']);
 assert.deepEqual(data.tags,['environment']);
});

test('artwork preview preserves every scene in author order without adding embeds to image downloads',async()=>{
 const assets=[
  {id:1,asset_type:'image',image_url:'https://cdna.artstation.com/p/assets/images/images/000/000/001/large/image.jpg'},
  {position:3,asset_type:'marmoset',player_embedded:'<iframe src="https://www.artstation.com/embed/333"></iframe>'},
  {position:1,asset_type:'marmoset',player_embedded:'<iframe src="https://www.artstation.com/embed/111"></iframe>'},
  {asset_type:'marmoset',player_embedded:'<iframe src="https://evilartstation.com/embed/999"></iframe>'}
 ];
 const resolve=()=>collectImageAssets('artstation',{url:'https://www.artstation.com/artwork/abcd12'},{open:async()=>({status:200,stream:Readable.from([Buffer.from(JSON.stringify({assets}))])})});
 const data=await resolve();
 assert.deepEqual(data.scenes.map(item=>item.id),['111','333']);
 assert.equal(data.items.length,1);
 assets.shift();
 assert.equal((await resolve()).items.length,0);
});

test('ArtStation discovery opens one resolved gallery with all scenes before images',async t=>{
 let resolveFetch;
 const response=new Promise(resolve=>{resolveFetch=resolve;});
 t.mock.method(globalThis,'fetch',()=>response);
 const originalParser=Object.getOwnPropertyDescriptor(globalThis,'DOMParser');
 globalThis.DOMParser=class {parseFromString(){return {body:{textContent:''}};}};
 t.after(()=>{if(originalParser)Object.defineProperty(globalThis,'DOMParser',originalParser);else delete globalThis.DOMParser;});
 for(const [name,value] of Object.entries({MutationObserver:class {observe(){}},ResizeObserver:class {observe(){}},requestAnimationFrame:()=>1,window:{addEventListener(){}}})){
  const original=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  t.after(()=>{if(original)Object.defineProperty(globalThis,name,original);else delete globalThis[name];});
 }
 const model={uid:'art',platform:'artstation',name:'Artwork',artworkUrl:'https://www.artstation.com/artwork/abcd12'};
 const opened=[];
 const aside={dataset:{},innerHTML:'',querySelector:()=>null};
 const state={route:'discover',favorites:new Set()};
 const view=createLibraryView({$:selector=>selector==='#preview-dialog'?{open:false}:selector==='#file-preview-details'?aside:{addEventListener(){}},state,icon:name=>`<i>${name}</i>`,esc:value=>String(value??''),sendControl:()=>'<button data-action="export-go" data-id="saved-art">导出</button>',downloadsUI:()=>({jobs:[]}),findModel:()=>model,artstationUI:()=>({isArt:()=>true}),toast:()=>{},openImageGallery:options=>opened.push(options)});
 const pending=view.preview('art');
 assert.equal(opened.length,0,'must not display a temporary cover gallery');
 resolveFetch({ok:true,json:async()=>({scenes:[{id:'1',type:'3d',embedUrl:'https://www.artstation.com/embed/1'},{id:'2',type:'3d',embedUrl:'https://www.artstation.com/embed/2'}],items:[{url:'https://cdna.artstation.com/image.jpg'}]})});
 await pending;
 assert.equal(opened.length,1);
 assert.deepEqual(opened[0].images.map(item=>item.type||'image'),['3d','3d','image']);
 assert.equal(opened[0].index,0);
 for(const [index,item] of opened[0].images.entries()){
  opened[0].onChange(item,index,3);
  assert.match(aside.innerHTML,/data-action="favorite" data-uid="art"/);
  assert.match(aside.innerHTML,/data-action="download" data-uid="art"/);
  assert.match(aside.innerHTML,/data-action="export-go"/);
  assert.doesNotMatch(aside.innerHTML,/打开 3D 场景|打开原图|>原页面</);
 }
 state.favorites.add('art');
 opened[0].onChange(opened[0].images[0],0,3);
 assert.match(aside.innerHTML,/aria-pressed="true"/);
});

