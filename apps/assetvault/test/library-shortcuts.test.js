import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryShortcut,bindLibraryShortcuts} from '../src/library/library-shortcuts.js';

test('custom keys replace defaults immediately, including Escape aliases',()=>{
 const overrides={search:['Ctrl+L'],deselect:['x'],preview:['P']};
 assert.equal(libraryShortcut({key:'f',ctrlKey:true},overrides),'');
 assert.equal(libraryShortcut({key:'l',ctrlKey:true},overrides),'search');
 assert.equal(libraryShortcut({key:'Escape'},overrides),'');
 assert.equal(libraryShortcut({key:'Enter'},overrides),'');
 assert.equal(libraryShortcut({key:'p'},overrides),'preview');
 assert.equal(libraryShortcut({key:'f',ctrlKey:true},{}),'search');
});

test('library shortcuts follow familiar search, select, import and preview keys',()=>{
 for(const [event,action] of [
  [{key:'f',ctrlKey:true},'search'],[{key:'a',ctrlKey:true},'selectAll'],
  [{key:'A',ctrlKey:true,shiftKey:true},'deselect'],[{key:'i',ctrlKey:true},'import'],
  [{key:'N',ctrlKey:true,shiftKey:true},'newBoard'],[{key:' '},'preview'],
  [{key:'Enter'},'preview'],[{key:'Delete'},'delete'],
  [{key:'Escape'},'deselect'],[{key:'ArrowLeft',altKey:true},'back'],
 ])assert.equal(libraryShortcut(event),action);
});
test('typing, composition, repeated keys and modified delete stay untouched',()=>{
 for(const event of [
  {key:'Delete',target:{closest:()=>true}}, {key:'Delete',repeat:true},
  {key:'Delete',isComposing:true},{key:'Delete',ctrlKey:true},
  {key:'Delete',shiftKey:true},{key:'Delete',defaultPrevented:true},
  {key:'ArrowLeft',altKey:true,ctrlKey:true},{key:'Escape',target:{closest:()=>true}},
 ])assert.equal(libraryShortcut(event),'');
});
test('shortcuts only run in library with no open dialog or menu',()=>{
 let handler,enabled=true,blocked=false,calls=0,prevented=0;
 const doc={addEventListener(_,fn){handler=fn;},removeEventListener(){handler=null;},querySelector:()=>blocked};
 const dispose=bindLibraryShortcuts({doc,enabled:()=>enabled,commands:{search:()=>calls++}});
 const event={key:'f',ctrlKey:true,preventDefault(){prevented++;}};
 handler(event);assert.equal(calls,1);assert.equal(prevented,1);
 enabled=false;handler(event);enabled=true;blocked=true;handler(event);
 assert.equal(calls,1);dispose();assert.equal(handler,null);
});
