import test from 'node:test';
import assert from 'node:assert/strict';
import {setupSidebarCollapse} from '../src/library/sidebar-collapse.js';

test('rapid toggles reverse the visible animation and reduced motion settles immediately',t=>{
 const saved=new Map(['document','window','localStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 t.after(()=>{for(const [key,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
 const classes=new Set(),attributes={},animations=[];
 let click,reduced=false,resizes=0;
 const root={classList:{contains:key=>classes.has(key),remove:key=>classes.delete(key),toggle(key,on){if(on)classes.add(key);else classes.delete(key);}}};
 const button={setAttribute:(key,value)=>attributes[key]=value,addEventListener:(_,fn)=>click=fn};
 const main={getBoundingClientRect:()=>({left:classes.has('side-collapsed')?65:208}),animate(frames){const animation={frames,cancelled:false,cancel(){this.cancelled=true;}};animations.push(animation);return animation;}};
 globalThis.document={documentElement:root,querySelectorAll:()=>[],getElementById:()=>button,querySelector:()=>main};
 globalThis.window={matchMedia:()=>({matches:reduced}),dispatchEvent:()=>resizes++};
 globalThis.localStorage={getItem:()=>null,setItem(){}};
 setupSidebarCollapse();
 click();
 assert.equal(attributes['aria-expanded'],'false');
 assert.equal(animations[0].frames[0].transform,'translateX(143px)');
 click();
 assert.equal(animations[0].cancelled,true);
 assert.equal(attributes['aria-expanded'],'true');
 assert.equal(classes.has('side-animating'),true);
 reduced=true;
 click();
 assert.equal(animations[1].cancelled,true);
 assert.equal(classes.has('side-animating'),false);
 assert.equal(resizes,1);
});
