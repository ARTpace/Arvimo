import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';
// 原生弹窗守卫：WebView2 会把 window.prompt / confirm / alert 画成
// 「127.0.0.1:xxxx 显示」的系统框，和工具配色不是一套，也会盖住整个窗口。
// 统一走 ask-dialog.js（资产库）与 components/AskDialog.tsx（画布）。
//
// 这条测试不测行为，只挡回归：有人顺手写回 window.confirm 就红。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const libraryDir = join(root, 'src/library');
const read = path => readFileSync(join(root, path), 'utf8');

/** 去掉注释再匹配：断言写在文档注释里不算真调用。 */
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const NATIVE = /(^|[^A-Za-z0-9_.])(window\.)?(prompt|confirm|alert)\s*\(/;

test('资产库前端不再直接调用原生 prompt / confirm / alert', () => {
  const offenders = [];
  for (const name of readdirSync(libraryDir)) {
    if (!name.endsWith('.js') || name === 'ask-dialog.js') continue;
    const body = stripComments(readFileSync(join(libraryDir, name), 'utf8'));
    if (NATIVE.test(body)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `这些文件绕过了 ask-dialog：${offenders.join(', ')}`);
});

test('ask-dialog 提供四种交互，且样式跟着 dialog 体系走', () => {
  const source = read('src/library/ask-dialog.js');
  for (const name of ['askText', 'askConfirm', 'askNotice', 'askChoice'])
    assert.match(source, new RegExp(`export (async )?function ${name}\\(`), `${name} 缺失`);
  // 复用既有 <dialog> 结构，别自己从零画一套弹窗皮肤。
  assert.match(source, /className = 'av-ask-dialog'/);
  assert.match(source, /class="dialog-header"/);
  assert.match(assembleLibraryStyles(), /\.av-ask-dialog \{|\.av-ask-dialog\{/);
});

test('确认弹窗真实提交返回true，取消返回false，画板删除只在确认后执行',async t=>{
 const {parseHTML}=await import('linkedom');
 const {document,window}=parseHTML('<html><body></body></html>');
 const previous=globalThis.document;globalThis.document=document;
 t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 const {askConfirm,askText,askNotice,askChoice}=await import('../src/library/ask-dialog.js');
 const createElement=document.createElement.bind(document);
 document.createElement=(name,...args)=>{
  const element=createElement(name,...args);
  if(name==='dialog'){
   element.show=()=>{element.open=true;};
   element.showModal=()=>{throw Error('简单操作不应打开模态弹窗');};
   element.close=()=>{element.open=false;element.dispatchEvent(new window.Event('close'));};
  }
  return element;
 };
 const submit=()=>document.querySelector('form').dispatchEvent(new window.Event('submit',{cancelable:true}));
 let pending=askConfirm({title:'删除画板'});submit();assert.equal(await pending,true);
 pending=askConfirm('取消');document.querySelector('[data-ask-cancel]').click();assert.equal(await pending,false);
 pending=askConfirm('关闭');document.querySelector('[data-ask-close]').click();assert.equal(await pending,false);
 pending=askConfirm('Esc');
 const escape=new window.Event('keydown',{cancelable:true});escape.key='Escape';
 document.querySelector('dialog').dispatchEvent(escape);assert.equal(await pending,false);
 document.querySelector('[data-ask-input]').select=()=>{};
 pending=askText({value:'  新画板  '});submit();assert.equal(await pending,'新画板');
 pending=askNotice('提示');submit();assert.equal(await pending,undefined);
 pending=askChoice({choices:[{label:'子类',value:'child'}]});document.querySelector('.av-ask-choice').click();assert.equal(await pending,'child');
 const {createBoardActions}=await import('../src/library/board-actions.js');
 let removed=0;
 const store={activeId:'board-1',byId:id=>({id,name:'参考图'}),remove:async id=>{assert.equal(id,'board-1');removed++;}};
 const actions=createBoardActions({store});
 pending=actions.remove('board-1');document.querySelector('[data-ask-cancel]').click();await pending;assert.equal(removed,0);
 pending=actions.remove('board-1');submit();assert.deepEqual(await pending,{removed:true,wasActive:true});assert.equal(removed,1);
});
