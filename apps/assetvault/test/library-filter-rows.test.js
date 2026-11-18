import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {readFileSync, readdirSync} from 'node:fs';

const read = name => readFileSync(new URL(`../src/library/${name}`, import.meta.url), 'utf8');
const app = read('app.js');
const html = read('index.html');

/** FILTER_ROWS 存的是裸 id，$ 是 querySelector；漏写 '#' 会返回 null 并让整个界面初始化失败。 */
test('筛选行：全部平台分支必须用 #id 查询，且逐行判空', () => {
  const body = app.slice(app.indexOf('function renderFilters('), app.indexOf('function setPlatform('));
  assert.ok(body.includes("$('#'+row)"), '统一树分支必须用 $("#"+row) 查节点');
  assert.ok(body.includes('if(node)node.hidden'), '逐行判空，缺节点不能让启动崩掉');
  assert.ok(!/\$\(\s*row\s*\)\s*\.hidden\s*=/.test(body), '禁止裸 id 选择器：$(row) 会被当成标签名');
});

test('筛选行：所有模块里都没有「裸 id 选择器直接设 hidden」', () => {
  const offenders = [];
  for (const name of readdirSync(new URL('../src/library/', import.meta.url))) {
    if (!name.endsWith('.js')) continue;
    const source = read(name);
    for (const match of source.matchAll(/\$\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.hidden\s*=/g)) {
      offenders.push(`${name}:${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], '$ 是 querySelector，裸标识符会被当成标签名返回 null');
});

test('筛选行：注册表里的每个 id 在 index.html 都有对应节点', () => {
  const view = read('library-view.js');
  const list = view.match(/export const FILTER_ROWS=\[([^\]]+)\]/);
  assert.ok(list, 'FILTER_ROWS 清单应能被定位');
  const ids = [...list[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(ids.length >= 8);
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺 #${id}`);
  }
});


test('发现页：全部平台显示统一分类，单平台只显示自己的分类，无分类时不能留白', () => {
 const ids=[...read('library-view.js').match(/export const FILTER_ROWS=\[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(match=>match[1]);
 const nodes=new Map(ids.map(id=>[id,{hidden:true,textContent:''}]));
 const state={platform:'all'};
 const source=app.match(/function renderFilters\(platform\)\{[\s\S]*?\n\}/)[0];
 const render=runInNewContext('('+source+')',{$:selector=>nodes.get(selector.slice(1)),FILTER_ROWS:ids,state,ALL:'all',mergedFilters:{refresh(){},release(){}}});
 render({filters:['filters-merged']});
 assert.equal(nodes.get('filters-merged').hidden,false);
 state.platform='artstation';render({label:'ArtStation',filters:'filters-artstation'});
 assert.equal(nodes.get('filters-artstation').hidden,false);
 assert.equal(nodes.get('filters-merged').hidden,true);
 assert.equal(nodes.get('filters-platform-empty').hidden,true);
 state.platform='civitai';render({label:'Civitai',picture:true,filters:[]});
 assert.equal(nodes.get('filters-platform-empty').hidden,false);
 assert.match(nodes.get('filters-platform-empty').textContent,/Civitai.*未接入原站分类/);
 assert.equal(nodes.get('filters-artstation').hidden,true);
});
