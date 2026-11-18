import test from 'node:test';
import assert from 'node:assert/strict';
import {saveOriginal} from '../src/library/card-context-menu.js';

test('original save downloads a checked proxy response as a named local blob',async t=>{
 let clicked=false,removed=false,scheduled=false;
 const link={click(){clicked=true;},remove(){removed=true;}};
 t.mock.method(globalThis,'fetch',async url=>{
  assert.match(url,/full=1/);
  return new Response(new Blob(['image'],{type:'image/jpeg'}));
 });
 t.mock.method(URL,'createObjectURL',()=> 'blob:original');
 t.mock.method(globalThis,'setTimeout',()=>{scheduled=true;return 1;});
 const oldDoc=globalThis.document,oldLoc=globalThis.location;
 globalThis.document={createElement:()=>link,body:{appendChild(){}}};
 globalThis.location={origin:'http://localhost',href:'http://localhost/'};
 try{
  await saveOriginal('https://live.staticflickr.com/1/photo.jpg','Mila');
  assert.equal(link.href,'blob:original');assert.equal(link.download,'Mila.jpg');
  assert.ok(clicked&&removed&&scheduled);
  clicked=false;
  globalThis.fetch=async()=>new Response('denied',{status:403});
  await assert.rejects(saveOriginal('https://example.com/a.jpg','Mila'),/403/);
  assert.equal(clicked,false,'failed responses must not be saved as images');
 }finally{globalThis.document=oldDoc;globalThis.location=oldLoc;}
});
