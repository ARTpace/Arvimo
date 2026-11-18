import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createLibraryShortcutSettings} from '../src/library/library-shortcut-settings.js';
import {libraryShortcut} from '../src/library/library-shortcuts.js';

test('click binding records immediately, rejects conflicts and restores defaults',()=>{
 const {document,window}=parseHTML('<html><body></body></html>');let saved={};
 const card=createLibraryShortcutSettings({doc:document,getBindings:()=>saved,setBindings:value=>{saved=value;}});document.body.append(card);
 const click=id=>card.querySelector(`[data-shortcut-record="${id}"]`).click();
 const press=(id,key,ctrlKey=false)=>{const event=new window.Event('keydown',{bubbles:true});Object.assign(event,{key,ctrlKey});card.querySelector(`[data-shortcut-record="${id}"]`).dispatchEvent(event);};
 click('search');press('search','l',true);
 assert.deepEqual(saved.search,['Ctrl+L']);assert.equal(libraryShortcut({key:'l',ctrlKey:true},saved),'search');
 click('preview');press('preview','l',true);assert.equal(saved.preview,undefined);assert.match(card.textContent,/已用于/);
 click('preview');press('preview','Escape');assert.equal(saved.preview,undefined);
 card.querySelector('[data-shortcut-reset="search"]').click();assert.equal(saved.search,undefined);
 click('search');press('search','l',true);card.querySelector('[data-shortcut-defaults]').click();assert.deepEqual(saved,{});
 const search=card.querySelector('.shortcut-search');search.value='Ctrl+I';search.dispatchEvent(new window.Event('input',{bubbles:true}));
 assert.equal(card.querySelectorAll('[data-shortcut-entry]').length,8);
 assert.deepEqual([...card.querySelectorAll('[data-shortcut-entry]')].filter(row=>!row.hidden).map(row=>row.querySelector('[data-shortcut-record]').dataset.shortcutRecord),['import']);
 search.value='不存在';search.dispatchEvent(new window.Event('input',{bubbles:true}));assert.equal(card.querySelector('.shortcut-empty').hidden,false);
});
