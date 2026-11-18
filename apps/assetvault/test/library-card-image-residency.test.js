import test from 'node:test';
import assert from 'node:assert/strict';
import {bindCardImageResidency} from '../src/library/card-image-residency.js';
import {thumbSrc} from '../src/library/image-src.js';
import {readFileSync} from 'node:fs';

test('网格只由离场回收管理图片，禁止再次装配会清空在场封面的视口卸载器',()=>{
 const view=readFileSync(new URL('../src/library/library-view.js',import.meta.url),'utf8');
 const app=readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8');
 assert.doesNotMatch(view,/createCardImageWindow/);
 assert.match(app,/bindCardImageResidency\(\$\('#grid'\)\)/);
});

test('switching pages preserves cover sources; only removed cards release images',()=>{
 let mutate,disconnected=0;
 class Observer{constructor(){assert.fail('viewport unloading must not reset masonry image sizes');}}
 class Mutations{constructor(fn){mutate=fn;}observe(){}disconnect(){disconnected++;}}
 const image={src:'/cover',getAttribute(){return this.src;},hasAttribute(){return this.src!==null;},setAttribute(key,value){this.src=value;},removeAttribute(){this.src=null;}};
 const nodes=[image];
 const dispose=bindCardImageResidency({contains:image=>nodes.includes(image),querySelectorAll:()=>nodes},{Observer,Mutations});
 mutate();assert.equal(image.src,'/cover');
 image.src='/fallback';
 mutate();assert.equal(image.src,'/fallback');
 nodes.length=0;mutate();assert.equal(image.src,null);
 dispose();assert.equal(disconnected,1);
});

test('board covers request compressed cards while full previews retain original quality',()=>{
 assert.match(thumbSrc('https://example.com/image',{card:true}),/card=1/);
 assert.match(thumbSrc('https://example.com/image',{card:true,full:true}),/full=1$/);
 assert.equal(thumbSrc('/api/local/thumb?rel=a',{card:true}),'/api/local/thumb?rel=a');
});
