import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createBoardPicker} from '../src/library/board-picker.js';

test('移出直接作用于当前画板，不打开选择器，图集成员不打散', async () => {
  const {document} = parseHTML('<html><body><div id="grid"><article data-uid="album-reference"></article></div></body></html>');
  const calls = [];
  const picker = createBoardPicker({document, esc:String, icon:()=>'', toast:()=>{},
    onRemoved:async id=>{calls.push(['refresh',id]);document.querySelector('[data-uid="album-reference"]').remove();},
    store:{activeId:'current', removeItems:async (...args)=>calls.push(args)}});
  picker.dialog.show = () => { throw Error('不应打开选择器'); };
  assert.equal(await picker.open(['album-reference','album-reference'], {mode:'remove'}), true);
  assert.deepEqual(calls, [['current',['album-reference']],['refresh','current']]);
  assert.equal(document.querySelector('[data-uid="album-reference"]'), null);
});

test('移出失败返回失败，保留原卡片', async () => {
  const {document} = parseHTML('<html><body><div id="grid"><article data-uid="asset"></article></div></body></html>');
  const messages = [];
  const picker = createBoardPicker({document, esc:String, icon:()=>'', toast:message=>messages.push(message),
    store:{activeId:'current', removeItems:async ()=>{throw Error('保存失败');}}});
  assert.equal(await picker.open(['asset'], {mode:'remove'}), false);
  assert.ok(document.querySelector('[data-uid="asset"]'));
  assert.deepEqual(messages, ['保存失败']);
});
