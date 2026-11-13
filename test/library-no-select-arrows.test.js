import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// 2026-11-12 反馈：「所有下拉菜单有箭头标志的都去掉」。
// 箭头有三个来源，必须一起处理，否则换一个下拉又会冒出来：
//   1. picker.js 给每颗自绘下拉生成的 .chevron；
//   2. 筛选工具条排序下拉里手写的 icon('chevron')；
//   3. 没被 enhanceSelects 覆盖到的原生 <select> 的系统箭头。
// 同时要防止误伤：树形展开、侧栏折叠、升降序、文件夹进入这些「方向 / 展开」箭头不是下拉菜单。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const picker=read('src/library/picker.js');
const dock=read('src/library/filter-dock.js');
const css=read('src/library/app.css');
const motionCss=read('src/library/search-motion.css');

test('自绘下拉不再生成箭头节点',()=>{
 assert.ok(!picker.includes("className='chevron'"),'picker.js 不该再创建 .chevron');
 assert.ok(!picker.includes('data-icon=\'arrow-down\''),'也不该再塞 arrow-down 图标');
 assert.ok(picker.includes('trigger.append(caption)'),'按钮里只留文字');
});

test('筛选工具条的排序下拉去掉手写箭头',()=>{
 const trigger=dock.match(/fd-sort-trigger[\s\S]*?<\/button>/)?.[0]||'';
 assert.ok(trigger,'要能找到排序下拉按钮');
 assert.ok(!trigger.includes("icon('chevron')"),'排序下拉按钮不再带展开箭头');
 assert.ok(trigger.includes('fd-sort-label'),'排序文字仍在');
});

test('两个样式表都兜住残留箭头与原生 select 系统箭头',()=>{
 for(const [name,text] of [['app.css',css],['search-motion.css',motionCss]]){
  assert.ok(text.includes('.picker-trigger>.chevron'),`${name} 要隐藏残留的 .chevron`);
  assert.ok(text.includes('.picker-trigger>[data-icon="arrow-down"]'),`${name} 要隐藏 arrow-down 图标`);
  assert.ok(text.includes('.select-arrow'),`${name} 要隐藏历史 .select-arrow`);
  assert.match(text,/select\{appearance:none;-webkit-appearance:none/,`${name} 要关掉原生 select 的系统箭头`);
  assert.ok(text.includes('select::-ms-expand{display:none}'),`${name} 要处理旧 Edge 的展开键`);
 }
});

test('不误伤非下拉的方向箭头',()=>{
 // 树形展开 / 折叠靠 .ftree-caret；侧栏折叠与排序方向另有图标。这些不在清理范围内。
 assert.ok(css.includes('.ftree-caret'),'筛选树的展开箭头要保留');
 assert.ok(read('src/library/filter-tree.js').includes("icon('chevron')"),'树节点仍用 chevron 表示展开');
 assert.ok(read('src/library/filter-panel-basic.js').includes("icon: 'chevron-up'"),'升降序箭头要保留');
 assert.ok(read('src/library/folder-picker.js').includes("icon('chevron-right')"),'文件夹进入箭头要保留');
});
