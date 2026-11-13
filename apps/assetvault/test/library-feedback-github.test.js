// 问题反馈页签的行为契约：
// 1) 面板里填的标题 / 描述 / 截图要变成 GitHub 新建 issue 页的可用参数（labels、标题前缀、正文模板）；
// 2) 正文模板带上环境块，才省得用户在 issue 里手写版本号；
// 3) 地址长度有上限，超了 GitHub 直接 414，所以长描述必须被裁剪而不是原样拼上去；
// 4) index.html 的钩子与 feedback.js 监听的 id 不能对不上（对不上就是点了没反应）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {ISSUES_URL,REPO_URL,URL_LIMIT,issueUrl} from '../src/library/feedback.js';
import {currentError,rememberError} from '../src/library/diagnostics.js';

const html=fs.readFileSync(path.join(import.meta.dirname,'..','src','library','index.html'),'utf8');
const env='应用 0.1.15 · 引擎 1.2.3\nWindows 11 · WebView2\n页面 library · 平台 —';

test('反馈地址指向用户自己的仓库',()=>{
 assert.equal(ISSUES_URL,'https://github.com/ARTpace/Arvimo/issues');
});

test('报告问题：labels=bug、标题前缀、正文三段式与环境块都在',()=>{
 const url=new URL(issueUrl({kind:'bug',title:'导出卡在 90%',detail:'点导出后进度不动',env,shotCount:2}));
 assert.equal(url.origin+url.pathname,`${ISSUES_URL}/new`);
 assert.equal(url.searchParams.get('labels'),'bug');
 assert.equal(url.searchParams.get('title'),'[Bug] 导出卡在 90%');
 const body=url.searchParams.get('body');
 assert.match(body,/### 发生了什么/);
 assert.match(body,/点导出后进度不动/);
 assert.match(body,/### 期望结果/);
 assert.match(body,/### 复现步骤/);
 assert.match(body,/### 截图/);
 assert.match(body,/2 张截图/);
 assert.match(body,/### 运行环境（自动填写，可删）/);
 assert.match(body,/应用 0\.1\.15/);
});

test('功能建议：labels=enhancement、正文不问复现步骤',()=>{
 const url=new URL(issueUrl({kind:'feature',title:'支持 USDZ',env}));
 assert.equal(url.searchParams.get('labels'),'enhancement');
 assert.equal(url.searchParams.get('title'),'[Feature] 支持 USDZ');
 const body=url.searchParams.get('body');
 assert.match(body,/### 想要什么/);
 assert.doesNotMatch(body,/### 复现步骤/);
 assert.doesNotMatch(body,/### 截图/);
});

test('标题留空时只带类型前缀，不留一个悬空的 [Bug] 空格',()=>{
 const url=new URL(issueUrl({kind:'bug',title:'   '}));
 assert.equal(url.searchParams.get('title').trim(),'[Bug]');
});

test('拿不到环境信息时不硬塞空的环境块',()=>{
 const body=new URL(issueUrl({kind:'bug',env:''})).searchParams.get('body');
 assert.doesNotMatch(body,/### 运行环境/);
});

test('未知类型退回报告问题，不让参数把地址拼坏',()=>{
 const url=new URL(issueUrl({kind:'nope'}));
 assert.equal(url.searchParams.get('labels'),'bug');
});

test('长描述按链接长度裁剪：不超上限、留下说明、环境块优先保留',()=>{
 const detail='中文描述一段。'.repeat(2000);
 const url=issueUrl({kind:'bug',title:'长正文',detail,env});
 assert.ok(url.length<=URL_LIMIT,`地址长度 ${url.length} 超过上限 ${URL_LIMIT}`);
 const body=new URL(url).searchParams.get('body');
 assert.match(body,/中文描述一段。/);
 assert.match(body,/超出链接长度上限/);
 assert.match(body,/### 运行环境（自动填写，可删）/);
});

test('环境块大到吃掉全部预算时，让位给用户自己写的描述',()=>{
 const hugeEnv='X'.repeat(8000);
 const url=issueUrl({kind:'bug',title:'大环境',detail:'我的描述',env:hugeEnv});
 const body=new URL(url).searchParams.get('body');
 assert.match(body,/我的描述/);
 assert.doesNotMatch(body,/### 运行环境/);
});

test('最近一次报错能被取出来带进正文，用户不用复述',()=>{
 rememberError('预览点开是黑的');
 assert.equal(currentError()?.message,'预览点开是黑的');
 const body=new URL(issueUrl({kind:'bug',detail:currentError().message,env})).searchParams.get('body');
 assert.match(body,/预览点开是黑的/);
});

test('index.html 的钩子齐备，旧的入口卡片已经拿掉',()=>{
 for(const hook of ['data-feedback-kind="bug"','data-feedback-kind="feature"','id="feedback-title"','id="feedback-body"','id="feedback-shots"','id="feedback-shot-list"','id="feedback-shot-input"','id="feedback-submit"','id="feedback-star-repo"','id="feedback-open-list"','id="feedback-status"']){
  assert.ok(html.includes(hook),`缺少钩子 ${hook}`);
 }
 // 面板现在是「面板内填 → 跳 GitHub」，不再是一点就走的两张入口卡。
 for(const gone of ['data-gh-kind','class="gh-entry"','feedback-copy-context','feedback-contact','feedback-honeypot','gh-intro','gh-note']){
  assert.ok(!html.includes(gone),`旧标记 ${gone} 还留在页面里`);
 }
});

test('加 Star 入口指向仓库主页',()=>{
 assert.equal(REPO_URL,'https://github.com/ARTpace/Arvimo');
 assert.match(html,/id="feedback-star-repo"[^>]*>[^<]*<i data-icon="star"><\/i>加 Star 关注仓库/);
});
