import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('shared canvas preview accepts only its same-origin parent and disposes on exit',()=>{
 const handlers={},loads=[],parent={postMessage:()=>{}},origin='http://localhost:4179';
 let resized=0,closed=0,disconnected=0;
 const preview={loadLocalModel:value=>loads.push(value),resize:()=>resized++,close:()=>closed++};
 const source=fs.readFileSync(new URL('../src/library/model-preview.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'');
 const win={parent,addEventListener:(name,fn)=>handlers[name]=fn};
 new Function('createGltfPreview','document','window','location','ResizeObserver',source)(()=>preview,{body:{},getElementById:()=>({setAttribute:()=>{}})},win,{origin,href:origin+'/model-preview.html'},class{constructor(fn){this.fn=fn;}observe(){this.fn();}disconnect(){disconnected++;}});
 const send=(source,origin,url)=>handlers.message({source,origin,data:{type:'assetvault:model-preview',url,name:'model.glb'}});
 send({},origin,'/model.glb');send(parent,'https://other.test','/model.glb');send(parent,origin,'javascript:alert(1)');
 assert.equal(loads.length,0);
 send(parent,origin,'/model.glb');
 assert.deepEqual(loads,[{url:origin+'/model.glb',name:'model.glb'}]);
 assert.equal(resized,1);handlers.pagehide();assert.equal(closed,1);assert.equal(disconnected,1);
});

test('built canvas page uses the exact library viewer markup and shared module',()=>{
 const index=fs.readFileSync(new URL('../src/library/index.html',import.meta.url),'utf8');
 const page=fs.readFileSync(new URL('../dist/library/model-preview.html',import.meta.url),'utf8');
 const dialog=index.match(/<dialog id="preview-dialog"[\s\S]*?<\/dialog>/)[0];
 assert.ok(page.includes(dialog));
 assert.ok(page.includes('model-preview.js'));
 const entry=fs.readFileSync(new URL('../src/library/model-preview.js',import.meta.url),'utf8');
 assert.ok(entry.includes("from './gltf-preview.js'"));
});
