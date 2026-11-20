#!/usr/bin/env node
/**
 * 抓一份 Fab 的产品分类树，生成前端只读模块 src/library/fab-categories.js。
 *
 * 数据源：GET https://www.fab.com/i/taxonomy/categories/tree
 *   → { results: { "3d-model": [节点…], material: [节点…], … } }
 *   节点形如 { name, path, slug, children[] }，最多三层（母类 / 子类 / 子子类）。
 *
 * 只保留前端渲染要用的四个字段（name / path / slug / children），去掉 uid 等冗余，
 * 体积从 ~164KB 压到几十 KB。分类体系变化时重跑本脚本即可：
 *   node scripts/fetch-fab-categories.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPublic} from '../server/public-http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'https://www.fab.com/i/taxonomy/categories/tree';
const OUT = path.join(ROOT, 'src/library/fab-categories.js');

/**
 * 中文包里没翻的条目会带一个 `__zh_cn__ ` 前缀（如 "__zh_cn__ Asphalt"），
 * 直接把前缀摘掉，留英文名当兜底，别把这串东西显示给用户。
 */
function cleanName(value) {
  return String(value || '').replace(/^__[a-z]{2}_[a-z]{2}__\s*/i, '').trim();
}

function slim(node) {
  const item = {
    name: cleanName(node?.name),
    path: String(node?.path || '').trim(),
    slug: String(node?.slug || '').trim(),
  };
  const children = Array.isArray(node?.children) ? node.children.filter(child => child?.path) : [];
  if (children.length) item.children = children.map(slim);
  return item;
}

function count(nodes) {
  return nodes.reduce((sum, node) => sum + 1 + count(node.children || []), 0);
}

async function main() {
  // Fab 的分类名跟站点语言走：不带 Accept-Language 拿到的是英文名，
  // 而 fab.com 中文界面显示的是中文名，两边对不上。这里固定要中文包。
  const response = await openPublic(SOURCE, {
    timeout: 60000,
    headers: {Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9'},
  });
  if (response.status !== 200) throw new Error(`Fab 分类树返回 HTTP ${response.status}`);
  const payload = JSON.parse((await new Response(response.stream).text()));
  const results = payload?.results || {};

  // bundle 是「捆绑包」的分类树（407 个节点），Fab 的产品类型面板里并没有这一项，
  // 前端下拉也选不到它，留着只会把模块撑大一倍，直接丢掉。
  const SKIP = new Set(['bundle']);
  const groups = Object.entries(results)
    .filter(([type, nodes]) => !SKIP.has(type) && Array.isArray(nodes) && nodes.length)
    .map(([type, nodes]) => ({type, nodes: nodes.map(slim)}));

  const total = groups.reduce((sum, group) => sum + count(group.nodes), 0);
  const body = `// 由 scripts/fetch-fab-categories.mjs 从 Fab 官方分类树生成，请勿手改。
// 来源：https://www.fab.com/i/taxonomy/categories/tree （抓取于 ${new Date().toISOString().slice(0, 10)}）
// 结构：按产品类型分组的树，节点 {name, path, slug, children?}，最多三层。
// 请求参数用 slug 拼：path 的 "/" 换成 "--"，如 buildings-architecture--components--balconies。
export const FAB_CATEGORY_GROUPS=${JSON.stringify(groups)};
export const FAB_CATEGORY_TOTAL=${total};
`;
  fs.writeFileSync(OUT, body, 'utf8');
  const size = fs.statSync(OUT).size;
  console.log(`已生成 ${path.relative(ROOT, OUT)}`);
  console.log(`  类型 ${groups.length} 组 / 节点 ${total} 个 / ${(size / 1024).toFixed(1)} KB`);
  for (const group of groups) console.log(`  - ${group.type}: ${count(group.nodes)} 个节点`);
}

main().catch(error => {
  console.error('抓取失败：', error.message);
  process.exit(1);
});
