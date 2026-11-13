import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// 2026-11-12 反馈：模式轨展开时文字显示不全（「UI」被裁成「U.」）。
// 根因是 --label-w 在字体还没稳定时用 scrollWidth 量，拉丁字母按更窄的 fallback 字体
// 量出 11px，而真实渲染是 17px；展开时 max-width 卡在 11px，text-overflow 就画了省略号。
// 中文标签（图片 / 模型 / 文本 / 视频）因为字形宽度稳定恰好没露馅。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const js=read('src/library/content-kind-tabs.js');
const css=read('src/library/content-kind-tabs.css');

test('量宽度时先解除裁切，拿真实排版宽度',()=>{
 assert.ok(js.includes("label.style.maxWidth = 'none'"),'要临时解除 max-width:0 再量');
 assert.ok(js.includes('label.getBoundingClientRect().width'),'用实际渲染宽度，而不是收起态的 scrollWidth');
 assert.ok(js.includes("label.style.maxWidth = previous"),'量完要还原，收起态布局不能被改');
 assert.ok(js.includes('Math.ceil(label.getBoundingClientRect().width) + 1'),'向上取整并留 1px 余量，防止亚像素舍入画出省略号');
});

test('字体晚到时会补量一次，不只依赖 fonts.ready',()=>{
 assert.ok(js.includes("document.fonts?.ready?.then(measureLabelWidths)"),'@font-face 就绪要重测');
 assert.ok(js.includes("readyState === 'complete'")&&js.includes("addEventListener?.('load'"),'系统字体回退切换不触发 fonts.ready，load 后再补一次');
});

test('展开宽度的兜底不能是写死的小数值',()=>{
 assert.ok(css.includes('max-width:var(--label-w,max-content)'),'没量到宽度时要按内容撑开，而不是退回 32px 把「UI」裁掉');
 assert.ok(!css.includes('var(--label-w,32px)'),'旧的 32px 兜底会再次造成截断');
 assert.ok(css.includes('max-width:0')&&css.includes('transition:max-width'),'收起态与宽度过渡保持不变');
});
