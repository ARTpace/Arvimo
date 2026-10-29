import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const tree = readFileSync(new URL('src/library/filter-tree.js', ROOT), 'utf8');
const html = readFileSync(new URL('src/library/index.html', ROOT), 'utf8');
const view = readFileSync(new URL('src/library/library-view.js', ROOT), 'utf8');

// 平台 -> [筛选面板 id, 该面板里应当被搬进树的原生控件 id...]
const PLATFORMS = [
  ['Sketchfab', '#filters-sketchfab', ['#online-category', '#online-sort']],
  ['ArtStation', '#filters-artstation', ['#art-category', '#art-type', '#art-sort', '#art-picked']],
  ['Poly Haven', '#filters-polyhaven', ['#polyhaven-type', '#polyhaven-category']],
  ['ambientCG', '#filters-ambientcg', ['#ambientcg-type', '#ambientcg-category']],
  ['Kenney', '#filters-kenney', ['#kenney-category', '#kenney-series']],
  ['Poly Pizza', '#filters-polypizza', ['#polypizza-cc0']],
  ['FreeStylized', '#filters-freestylized', ['#freestylized-type', '#freestylized-category']],
  ['Polyfork', '#filters-polyfork', ['#polyfork-class', '#polyfork-sort']],
];

test('六个平台的筛选面板全部登记进筛选树，没有平台掉队', () => {
  for (const [name, row] of PLATFORMS) {
    assert.ok(tree.includes(`row:'${row}'`), `${name} 的筛选面板 ${row} 未登记进 filter-tree SPECS`);
  }
  // 反证：html 里每个平台筛选面板都得在 SPECS 里出现，否则就是漏了一个平台。
  // filters-merged（全部平台合并视图，由 merged-filters.js 单独渲染）和
  // filters-all（纯说明文字、无控件）不归这棵树管，必须排除掉。
  const NON_PLATFORM = new Set(['filters-merged', 'filters-all']);
  const panels = [...html.matchAll(/id="(filters-[a-z]+)"/g)].map(m => m[1]).filter(id => !NON_PLATFORM.has(id));
  assert.equal(panels.length, PLATFORMS.length, `html 里有 ${panels.length} 个平台筛选面板，SPECS 应登记同样多`);
  for (const id of panels) {
    assert.ok(tree.includes(`row:'#${id}'`), `html 里的 #${id} 没登记进 SPECS`);
  }
});

test('每个平台的原生控件都被树接管（不再裸奔在下拉框里）', () => {
  for (const [name, , controls] of PLATFORMS) {
    for (const sel of controls) {
      const key = `control:'${sel}'`;
      const check = `selector:'${sel}'`;
      assert.ok(
        tree.includes(key) || tree.includes(check),
        `${name} 的控件 ${sel} 没被任何字段接管，它会退回到裸下拉框`,
      );
    }
  }
});

test('分类清单怎么折写在各字段上：ArtStation 用手工分组表，动态清单用 fold', () => {
  const specs = tree.slice(tree.indexOf('const SPECS'), tree.indexOf('const el='));
  // Sketchfab 与 ArtStation 各有一份手工分组表（前者 5 大主题，后者 6 个用途组），别的平台没有。
  const grouped = [...specs.matchAll(/groups:(GROUPS|ARTSTATION_CATEGORY_GROUPS)/g)].map(m => m[1]);
  assert.deepEqual(grouped.sort(), ['ARTSTATION_CATEGORY_GROUPS', 'GROUPS'], '只有带手工分组表的两个分类字段该写 groups');
  // 其余平台的分类来自各自接口：不写 groups，改声明 fold（按官方热度折成长短两截）。
  for (const row of ['#filters-polyhaven', '#filters-ambientcg', '#filters-kenney', '#filters-freestylized']) {
    const at = specs.indexOf(`row:'${row}'`);
    assert.ok(at >= 0, `${row} 不在 SPECS 里`);
    const block = specs.slice(at, specs.indexOf(']},', at));
    assert.ok(!block.includes('groups:'), `${row} 没有手工分组表，不该写 groups`);
    assert.ok(block.includes('fold:true'), `${row} 的分类清单又长又动态，必须声明 fold`);
  }
  // Poly Pizza 只有一个勾选框，什么都不该写。
  const pizza = specs.slice(specs.indexOf("row:'#filters-polypizza'"), specs.indexOf(']},', specs.indexOf("row:'#filters-polypizza'")));
  assert.ok(!pizza.includes('fold:') && !pizza.includes('groups:'), 'Poly Pizza 没有分类清单，两种折叠都不该出现');
});

test('渲染器两种折叠都认，且保留「什么都不写就平铺」的兜底分支', () => {
  assert.ok(
    /if\(!field\.fold\)\{for\(const option of rest\)kids\.append\(makeLeaf\(option\)\);return;\}/.test(tree),
    'buildField 必须保留无分组表 / 无折叠时的平铺分支，否则新平台会渲染成空树',
  );
  assert.ok(/const \[front,tail\]=foldLongList\(rest\);/.test(tree), '声明了 fold 的字段必须走 foldLongList');
  assert.ok(/if\(tail\.length\)kids\.append\(makeGroup\(MORE_GROUP,tail\)\);/.test(tree), '折起来的那些项要进「更多分类」组');
  assert.ok(/group\.match\?group\.match\(option\):\(group\.values\|\|\[\]\)\.includes\(option\.value\)/.test(tree),
    '分组判据要同时认「谓词命中」（ArtStation 按分类名）与「按值命中」（Sketchfab 的 slug）');
  assert.ok(/import \{ARTSTATION_CATEGORY_GROUPS,MORE_GROUP,foldLongList\} from '\.\/filter-groups\.js'/.test(tree),
    '分组 / 折叠表必须来自 filter-groups.js，别再往渲染器里塞第二份清单');
});

test('每个平台的筛选面板都会被搬进左侧栏（FILTER_ROWS 一个不漏）', () => {
  // 树是渲染在面板内部的，面板本身得先搬到 #filter-rows 才看得见。
  // 漏一个的直接后果：宽屏下那个平台的分类还挂在搜索框下面，侧栏里空着。
  const rows = (view.match(/const FILTER_ROWS=\[([\s\S]*?)\];/) || [])[1] || '';
  const listed = new Set([...rows.matchAll(/'#([a-z-]+)'/g)].map(m => m[1]));
  const panels = [...html.matchAll(/class="online-filters" id="(filters-[a-z]+)"/g)].map(m => m[1]);
  assert.ok(panels.length >= 8, 'html 里的平台筛选面板数量不对，正则可能失效了');
  for (const id of panels) {
    assert.ok(listed.has(id), `#${id} 没写进 FILTER_ROWS，宽屏下它会留在搜索卡片里`);
  }
  assert.ok(listed.has('filters-all'), '「全部平台」的说明文字也要跟着搬，不然在搜索框下孤零零一行');
});

test('筛选树的隐藏原生控件约定没被破坏（业务代码仍只认原生 id）', () => {
  assert.ok(tree.includes("el('div','ftree-src');keep.hidden=true"), '原生控件必须被搬进 hidden 盒子继续当值容器');
  for (const [, , controls] of PLATFORMS) {
    for (const sel of controls) {
      assert.ok(html.includes(`id="${sel.slice(1)}"`), `${sel} 必须仍然真实存在于 index.html 里`);
    }
  }
});
