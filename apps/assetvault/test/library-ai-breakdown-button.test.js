import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// 2026-11-12 反馈：把搜索栏右侧那颗带「AI 拆解」文字的深色大按钮，改成一颗图标，
// 放进输入框里面的最右端。这几条钉住「位置 + 纯图标 + 运行时不会又把文字写回来」，
// 尤其是 app.js / search-motion.js 里两处历史代码会在点击后重建按钮内容。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const html=read('src/library/index.html');
const app=read('src/library/app.js');
const motion=read('src/library/search-motion.js');
const css=assembleLibraryStyles();
const motionCss=read('src/library/search-motion.css');

test('AI 拆解键搬进 .global-search，且在输入框内的最后一个位置',()=>{
 const field=html.slice(html.indexOf('<div class="global-search">'),html.indexOf('id="search-button"'));
 assert.ok(field.includes('id="theme-breakdown-btn"'),'图标键要在输入区里，而不是 form 顶层的第三颗按钮');
 assert.match(field,/<button class="ai-breakdown" id="theme-breakdown-btn"[\s\S]*?<\/button><\/div>/,
  '图标键应是 .global-search 的最后一个子元素（后面直接收口）');
 assert.ok(html.indexOf('id="theme-breakdown-btn"')<html.indexOf('id="search-button"'),
  '搜索按钮仍在图标键外侧，表单顶层只剩这两个子节点');
});

test('按键只留图标：无文字、无 secondary 大按钮外观、无障碍说明仍在',()=>{
 const button=html.match(/<button class="ai-breakdown" id="theme-breakdown-btn"[\s\S]*?<\/button>/)?.[0]||'';
 assert.ok(button,'要能找到这颗按钮');
 assert.doesNotMatch(button,/>[\s]*AI 拆解/, '不能再出现「AI 拆解」文字节点');
 assert.doesNotMatch(button,/class="[^"]*secondary/,'不要继承 .secondary 的深色大按钮皮肤');
 assert.match(button,/class="sparkle-icon"/,'要保留 ✦ 图标容器');
 assert.match(button,/aria-label="AI 拆解搜索主题"/,'纯图标也要有无障碍名称');
 assert.match(button,/title="AI 拆解/,'鼠标悬停靠 title 说明用途');
 assert.match(button,/type="button"/,'不能变成 submit 误触发检索');
});

test('运行时不会再往按钮里写文字，加载态改用 is-busy 类',()=>{
 assert.ok(!app.includes("button.textContent='拆解中…'"),'文字会把 30px 图标键撑开');
 assert.ok(!app.includes(' AI 拆解`;'),'拆解完不要重建「图标 + 文字」');
 assert.ok(app.includes("button.classList.add('is-busy')"),'加载态交给 class');
 assert.ok(app.includes("button.classList.remove('is-busy')"),'结束要复位');
 assert.ok(!motion.includes("document.createTextNode(' AI 拆解')"),'动效初始化别把文字写回来');
 assert.ok(motion.includes('ai.replaceChildren(sparkle)'),'动效初始化只放回图标');
});

test('两个样式表都把大按钮压成 30px 透明图标键，表单改成两列',()=>{
 for(const [name,text] of [['app.css',css],['search-motion.css',motionCss]]){
  assert.ok(text.includes('#search-panel .global-search>#theme-breakdown-btn'),`${name} 要有高特异性覆盖`);
  assert.ok(text.includes('flex:0 0 30px;width:30px;height:30px'),`${name} 要定死 30px 图标尺寸`);
  assert.ok(text.includes('#theme-breakdown-btn.is-busy .sparkle-icon{animation:spin'),`${name} 要有加载旋转`);
 }
 // 构建时 search-motion.css 追加到 app.css 之后，那份是最终级联，必须也有。
 assert.ok(!/#asset-search-form\{grid-template-columns:minmax\(0,1fr\) auto auto\}/.test(css),'表单不再摆三列');
 assert.ok(!css.includes('#asset-search-form .search-field{grid-column:1/-1}'),'窄屏不必再让搜索框跨两行');
 assert.ok(!motionCss.includes('#search-panel .search-field{grid-column:1/-1}'),'动效样式表里的跨行规则也要撤');
 assert.ok(/body\[data-route="library"\] #theme-breakdown-btn/.test(motionCss),'资产库路由下仍要隐藏这颗键');
});
