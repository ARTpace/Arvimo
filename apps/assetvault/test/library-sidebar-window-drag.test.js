import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';

test('sidebar blank space drags the window without hijacking controls',()=>{
  const {document,window}=parseHTML('<html><body><aside id="sidebar"><div class="side-spacer"></div><button><i></i></button><a href="/">Home</a><div id="side-filters"><span>Category</span></div></aside><main></main></body></html>');
  const calls=[];
  window.__TAURI__={core:{invoke(command,args){calls.push([command,args]);return Promise.resolve();}}};
  runInNewContext(readFileSync(new URL('../sketchfab-exporter-tauri/src-tauri/src/desktop-chrome.js',import.meta.url),'utf8'),{document,window,console});
  function down(selector,button=0){
    const event=new window.Event('mousedown',{bubbles:true,cancelable:true});
    event.button=button;
    document.querySelector(selector).dispatchEvent(event);
    return event.defaultPrevented;
  }
  assert.equal(down('.side-spacer'),true);
  assert.deepEqual(calls.map(([,args])=>args.action),['drag']);
  for(const selector of ['button i','a','#side-filters span','main']) assert.equal(down(selector),false);
  assert.equal(down('.side-spacer',2),false);
  assert.equal(calls.length,1);
});
